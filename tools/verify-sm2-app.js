/**
 * 应用层算法验证 —— 验证 miniprogram/utils 里的真实实现（而非副本）。
 * 覆盖：SM-2 预期行为表（设计说明第 4 节）、模糊档、EF 下限、日期工具、队列筛选。
 * 运行：node tools/verify-sm2-app.js
 */
const assert = require('assert');
const { sm2, GRADE } = require('../miniprogram/utils/sm2.js');
const { pad, addDays, todayStr, formatDate, shortCN, isValidDateStr } = require('../miniprogram/utils/date.js');
const { dueWords, nextDueDate, masteredCount, intervalCurve, pointsOf, selfCheck, MASTERED_INTERVAL } = require('../miniprogram/utils/schedule.js');

const T0 = '2026-09-11'; // 固定基准日，保证测试可复现
let pass = 0, fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}

// ---------- 一、SM-2 预期行为表（8 步逐项核对） ----------
check('步骤1 录入初始 ef=2.5 reps=0 interval=0', () => {
  const it = { ef: 2.5, reps: 0, interval: 0 };
  assert.strictEqual(it.ef, 2.5); assert.strictEqual(it.reps, 0); assert.strictEqual(it.interval, 0);
});

let it = { ef: 2.5, reps: 0, interval: 0 };
check('步骤2 首次认识 → EF 2.60 / reps 1 / interval 1 / 明天到期', () => {
  it = sm2(it, GRADE.KNOW, T0);
  assert.strictEqual(it.ef.toFixed(2), '2.60');
  assert.strictEqual(it.reps, 1);
  assert.strictEqual(it.interval, 1);
  assert.strictEqual(it.nextReview, '2026-09-12');
});

check('步骤3 次日认识 → EF 2.70 / reps 2 / interval 6', () => {
  it = sm2(it, GRADE.KNOW, '2026-09-12');
  assert.strictEqual(it.ef.toFixed(2), '2.70');
  assert.strictEqual(it.reps, 2);
  assert.strictEqual(it.interval, 6);
  assert.strictEqual(it.nextReview, '2026-09-18');
});

check('步骤4 再认识 → EF 2.80 / interval 17 = round(6×2.80)', () => {
  it = sm2(it, GRADE.KNOW, '2026-09-18');
  assert.strictEqual(it.ef.toFixed(2), '2.80');
  assert.strictEqual(it.interval, 17);
  assert.strictEqual(it.nextReview, '2026-10-05');
});

check('步骤5 再认识 → EF 2.90 / interval 49 = round(17×2.90)', () => {
  it = sm2(it, GRADE.KNOW, '2026-10-05');
  assert.strictEqual(it.ef.toFixed(2), '2.90');
  assert.strictEqual(it.interval, 49);
});

check('步骤6 再认识 → EF 3.00 / interval 147 = round(49×3.00)', () => {
  it = sm2(it, GRADE.KNOW, '2026-11-23');
  assert.strictEqual(it.ef.toFixed(2), '3.00');
  assert.strictEqual(it.interval, 147);
});

check('步骤7 不认识 → EF 2.46 / reps 归零 / interval 重置 1', () => {
  it = sm2(it, GRADE.FORGOT, '2027-04-19');
  assert.strictEqual(it.ef.toFixed(2), '2.46');
  assert.strictEqual(it.reps, 0);
  assert.strictEqual(it.interval, 1);
  assert.strictEqual(it.nextReview, '2027-04-20');
});

check('步骤8 再认识 → EF 2.56 / reps 1 / interval 1（回到起点）', () => {
  it = sm2(it, GRADE.KNOW, '2027-04-20');
  assert.strictEqual(it.ef.toFixed(2), '2.56');
  assert.strictEqual(it.reps, 1);
  assert.strictEqual(it.interval, 1);
});

// ---------- 二、模糊档与 EF 下限 ----------
check('模糊(q=3)：ef 2.5→2.36，间隔 6→14，仍算记住', () => {
  const out = sm2({ ef: 2.5, reps: 2, interval: 6 }, GRADE.VAGUE, T0);
  assert.strictEqual(out.ef.toFixed(2), '2.36');
  assert.strictEqual(out.reps, 3);
  assert.strictEqual(out.interval, 14);
});

check('连续 10 次不认识：EF 不低于 1.3', () => {
  let t = { ef: 2.5, reps: 0, interval: 0 };
  for (let i = 0; i < 10; i++) t = sm2(t, GRADE.FORGOT, T0);
  assert.ok(t.ef >= 1.3, 'EF=' + t.ef);
  assert.strictEqual(t.ef, 1.3);
});

// ---------- 三、日期工具（本地时区，禁 UTC） ----------
check('addDays 跨月：2026-09-11 + 20 = 2026-10-01', () => {
  assert.strictEqual(addDays('2026-09-11', 20), '2026-10-01');
});
check('addDays 跨年：2026-12-31 + 1 = 2027-01-01', () => {
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});
check('todayStr 格式为 YYYY-MM-DD 且与系统日期一致', () => {
  const d = new Date();
  assert.strictEqual(todayStr(), formatDate(d));
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});
check('shortCN：2026-09-11 → 9月11日', () => {
  assert.strictEqual(shortCN('2026-09-11'), '9月11日');
});

// ---------- 四、复习队列与统计 ----------
check('队列筛选：只含 nextReview<=今天，先到期在前', () => {
  const list = [
    { id: 'a', word: 'a', nextReview: '2026-09-12', interval: 6 },
    { id: 'b', word: 'b', nextReview: '2026-09-11', interval: 1 },
    { id: 'c', word: 'c', nextReview: '2026-09-11', interval: 0 }
  ];
  const due = dueWords(list, T0);
  assert.deepStrictEqual(due.map(w => w.id), ['c', 'b']);
  assert.strictEqual(nextDueDate(list, T0), '2026-09-12');
});

check('已掌握：间隔 >= 21 天计数', () => {
  const list = [
    { interval: 21 }, { interval: 49 }, { interval: 6 }
  ];
  assert.strictEqual(masteredCount(list), 2);
});

check('间隔曲线：按复习次数取平均间隔', () => {
  const list = [
    { history: [{ q: 5, interval: 1 }, { q: 5, interval: 6 }] },
    { history: [{ q: 5, interval: 1 }] }
  ];
  const curve = intervalCurve(list);
  assert.deepStrictEqual(curve, [{ x: 1, y: 1 }, { x: 2, y: 6 }]);
  assert.deepStrictEqual(intervalCurve([{ history: [] }]), []);
});

// ---------- 五、积分与三项自测指标（附件1 承诺口径） ----------
const demoWords = [
  { ef: 2.9, interval: 49, history: [{ q: 5 }, { q: 5 }] },   // 首答正确、已长期保留
  { ef: 2.0, interval: 1, history: [{ q: 1 }, { q: 5 }] },    // 首答错误
  { ef: 2.5, interval: 0, history: [] }                        // 从未复习
];

check('积分：认识+3 / 模糊+1 / 不认识+0，累计 9 分（3 次认识）', () => {
  assert.strictEqual(pointsOf(demoWords), 9);
  assert.strictEqual(pointsOf([]), 0);
  assert.strictEqual(pointsOf([{ history: [{ q: 3 }, { q: 1 }] }]), 1);
});

check('首答正确率：2 词有记录、1 词首答正确 → 50%', () => {
  assert.strictEqual(selfCheck(demoWords).firstTryRate, 50);
});

check('平均熟练度 EF：全库平均含新词 → 2.47', () => {
  assert.strictEqual(selfCheck(demoWords).avgEF, 2.47);
});

check('长期保留词占比：1/2 → 50%', () => {
  assert.strictEqual(selfCheck(demoWords).retainedRatio, 50);
});

check('无复习记录时 hasData=false（界面显示引导而非 0%）', () => {
  assert.strictEqual(selfCheck([{ ef: 2.5, history: [] }]).hasData, false);
  assert.strictEqual(selfCheck([]).hasData, false);
});

/* ---------- 九、日期工具边界（补充覆盖：补零 / 回退 / 闰年 / 时区） ---------- */

check('pad：个位数补零、两位数原样（0→00 / 9→09 / 10→10 / 31→31）', () => {
  assert.strictEqual(pad(0), '00', 'pad(0) 期望 "00"，实际 ' + pad(0));
  assert.strictEqual(pad(9), '09', 'pad(9) 期望 "09"，实际 ' + pad(9));
  assert.strictEqual(pad(10), '10', 'pad(10) 期望 "10"，实际 ' + pad(10));
  assert.strictEqual(pad(31), '31', 'pad(31) 期望 "31"，实际 ' + pad(31));
});

check('formatDate：个位数月/日必须补零（1月5日 → 2026-01-05）', () => {
  const a = formatDate(new Date(2026, 0, 5));
  assert.strictEqual(a, '2026-01-05', '入参 new Date(2026,0,5) 期望 "2026-01-05"，实际 ' + a);
  const b = formatDate(new Date(2026, 11, 31));
  assert.strictEqual(b, '2026-12-31', '入参 new Date(2026,11,31) 期望 "2026-12-31"，实际 ' + b);
});

check('formatDate：取本地日期而非 UTC（23:59 仍算当天，这是禁用 toISOString 的原因）', () => {
  // 本地时间 2026-09-11 23:59:59，在 UTC+8 下 toISOString 会得到 2026-09-11T15:59:59Z，
  // 若实现改用 UTC 取值就会退成 09-11 或跨成 09-12 —— 本断言把"必须用本地字段"钉死。
  const late = new Date(2026, 8, 11, 23, 59, 59);
  assert.strictEqual(late.getDate(), 11, '构造前提：本地应是 11 日，实际 ' + late.getDate());
  assert.strictEqual(formatDate(late), '2026-09-11',
    '本地 2026-09-11 23:59:59 期望 "2026-09-11"，实际 ' + formatDate(late));
  const early = new Date(2026, 8, 11, 0, 0, 1);
  assert.strictEqual(formatDate(early), '2026-09-11',
    '本地 2026-09-11 00:00:01 期望 "2026-09-11"，实际 ' + formatDate(early));
});

check('addDays：负数回退跨月/跨年（10-01 -1 → 09-30；01-01 -1 → 12-31）', () => {
  const a = addDays('2026-10-01', -1);
  assert.strictEqual(a, '2026-09-30', "addDays('2026-10-01',-1) 期望 2026-09-30，实际 " + a);
  const b = addDays('2027-01-01', -1);
  assert.strictEqual(b, '2026-12-31', "addDays('2027-01-01',-1) 期望 2026-12-31，实际 " + b);
});

check('addDays：0 天原样返回（幂等）', () => {
  assert.strictEqual(addDays(T0, 0), T0, 'addDays(T0,0) 期望 ' + T0 + '，实际 ' + addDays(T0, 0));
});

check('addDays：月末进位（01-31 +1 → 02-01，不出现 02-31）', () => {
  const a = addDays('2026-01-31', 1);
  assert.strictEqual(a, '2026-02-01', "addDays('2026-01-31',1) 期望 2026-02-01，实际 " + a);
});

check('addDays：闰年 2 月（2028-02-28 +1 → 02-29；2027 平年 → 03-01）', () => {
  const leap = addDays('2028-02-28', 1);
  assert.strictEqual(leap, '2028-02-29', '2028 是闰年，期望 2028-02-29，实际 ' + leap);
  const common = addDays('2027-02-28', 1);
  assert.strictEqual(common, '2027-03-01', '2027 是平年，期望 2027-03-01，实际 ' + common);
});

check('addDays：世纪年闰年规则（2000 闰 → 02-29；2100 平 → 03-01）', () => {
  const y2000 = addDays('2000-02-28', 1);
  assert.strictEqual(y2000, '2000-02-29', '2000 能被 400 整除是闰年，期望 2000-02-29，实际 ' + y2000);
  const y2100 = addDays('2100-02-28', 1);
  assert.strictEqual(y2100, '2100-03-01', '2100 是世纪平年，期望 2100-03-01，实际 ' + y2100);
});

check('addDays：整年跨度（2026-01-01 +365 → 2027-01-01）', () => {
  const a = addDays('2026-01-01', 365);
  assert.strictEqual(a, '2027-01-01', "addDays('2026-01-01',365) 期望 2027-01-01，实际 " + a);
});

check('shortCN：个位数月/日不补零（2026-09-01 → 9月1日）', () => {
  const a = shortCN('2026-09-01');
  assert.strictEqual(a, '9月1日', "shortCN('2026-09-01') 期望 9月1日，实际 " + a);
  const b = shortCN('2026-12-25');
  assert.strictEqual(b, '12月25日', "shortCN('2026-12-25') 期望 12月25日，实际 " + b);
});

/* ---------- 十、队列与统计边界（补充覆盖：nextDueDate 此前零覆盖） ---------- */

check('GRADE 三档映射锁定：KNOW=5 / VAGUE=3 / FORGOT=1（改动即破坏算法口径）', () => {
  assert.deepStrictEqual(GRADE, { KNOW: 5, VAGUE: 3, FORGOT: 1 },
    'GRADE 实际为 ' + JSON.stringify(GRADE));
});

check('MASTERED_INTERVAL 常量锁定为 21 天（统计口径依赖它）', () => {
  assert.strictEqual(MASTERED_INTERVAL, 21, '期望 21，实际 ' + MASTERED_INTERVAL);
});

check('dueWords：同日到期时按 interval 升序（间隔短的优先）', () => {
  const list = [
    { word: 'c', nextReview: T0, interval: 3 },
    { word: 'a', nextReview: T0, interval: 1 },
    { word: 'b', nextReview: T0, interval: 2 }
  ];
  const got = dueWords(list, T0).map(w => w.word);
  assert.deepStrictEqual(got, ['a', 'b', 'c'],
    '同日到期应 interval 1→2→3，实际 ' + JSON.stringify(got));
});

check('dueWords：空列表 / 全部未到期 → 空数组（界面走"今天没有要复习的"分支）', () => {
  assert.deepStrictEqual(dueWords([], T0), [], '空列表期望 []，实际 ' + JSON.stringify(dueWords([], T0)));
  const future = [{ word: 'x', nextReview: '2026-09-12', interval: 1 }];
  assert.deepStrictEqual(dueWords(future, T0), [],
    '未到期词不该进队列，实际 ' + JSON.stringify(dueWords(future, T0)));
});

check('dueWords：不修改入参数组（纯函数，页面 data 不被意外重排）', () => {
  const list = [
    { word: 'b', nextReview: '2026-09-11', interval: 2 },
    { word: 'a', nextReview: '2026-09-10', interval: 1 }
  ];
  const before = list.map(w => w.word);
  dueWords(list, T0);
  const after = list.map(w => w.word);
  assert.deepStrictEqual(after, before, 'dueWords 改动了入参顺序：前 ' + before + ' 后 ' + after);
});

check('nextDueDate：返回最近的未来到期日（跳过已到期）', () => {
  const list = [
    { nextReview: '2026-09-11' },  // 已到期，应忽略
    { nextReview: '2026-09-20' },
    { nextReview: '2026-09-15' }
  ];
  const got = nextDueDate(list, T0);
  assert.strictEqual(got, '2026-09-15', '期望最近未来日 2026-09-15，实际 ' + got);
});

check('nextDueDate：无未来词 / 空列表 → 空字符串（界面据此判断"全部复习完"）', () => {
  const allDue = [{ nextReview: '2026-09-01' }, { nextReview: '2026-09-11' }];
  assert.strictEqual(nextDueDate(allDue, T0), '', '全部已到期期望 ""，实际 ' + nextDueDate(allDue, T0));
  assert.strictEqual(nextDueDate([], T0), '', '空列表期望 ""，实际 ' + nextDueDate([], T0));
});

check('masteredCount：边界 20 天不计、21 天计入、22 天计入 → 2', () => {
  const list = [{ interval: 20 }, { interval: 21 }, { interval: 22 }];
  const got = masteredCount(list);
  assert.strictEqual(got, 2, '期望 2（20 天不算掌握），实际 ' + got);
});

check('intervalCurve：空列表 / 全无复习历史 → 空数组（图表走空态）', () => {
  assert.deepStrictEqual(intervalCurve([]), [], '空列表期望 []，实际 ' + JSON.stringify(intervalCurve([])));
  assert.deepStrictEqual(intervalCurve([{ history: [] }, { history: [] }]), [],
    '全无历史期望 []，实际 ' + JSON.stringify(intervalCurve([{ history: [] }, { history: [] }])));
});

check('intervalCurve：历史长度不齐时，短历史不参与后续点（分母只数经历过的词）', () => {
  const list = [
    { history: [{ interval: 1 }] },                            // 只复习过 1 次
    { history: [{ interval: 1 }, { interval: 6 }, { interval: 17 }] }
  ];
  const got = intervalCurve(list);
  assert.deepStrictEqual(got, [{ x: 1, y: 1 }, { x: 2, y: 6 }, { x: 3, y: 17 }],
    '期望第1点(1+1)/2=1、第2点仅1词=6、第3点仅1词=17，实际 ' + JSON.stringify(got));
});

check('pointsOf：档位边界 q=5→3分 / q=4→1分 / q=3→1分 / q=2→0分 / 无历史→0分', () => {
  const list = [{
    history: [{ q: 5 }, { q: 4 }, { q: 3 }, { q: 2 }, { q: 1 }]
  }];
  const got = pointsOf(list);
  assert.strictEqual(got, 5, '期望 3+1+1+0+0=5，实际 ' + got);
  assert.strictEqual(pointsOf([]), 0, '空列表期望 0，实际 ' + pointsOf([]));
  assert.strictEqual(pointsOf([{ history: [] }]), 0, '无历史期望 0，实际 ' + pointsOf([{ history: [] }]));
});

check('selfCheck：空列表 → hasData=false 且四项指标全为 0（不显示 0% 误导）', () => {
  const r = selfCheck([]);
  assert.deepStrictEqual(r, { firstTryRate: 0, avgEF: 0, retainedRatio: 0, hasData: false },
    '空列表期望全 0 + hasData:false，实际 ' + JSON.stringify(r));
});

check('selfCheck：全库都还没复习过 → hasData=false（新装用户走引导页）', () => {
  const list = [{ ef: 2.5, interval: 0, history: [] }, { ef: 2.5, interval: 0, history: [] }];
  const r = selfCheck(list);
  assert.strictEqual(r.hasData, false, '期望 hasData=false，实际 ' + r.hasData);
  assert.strictEqual(r.avgEF, 0, '无数据时 avgEF 期望 0，实际 ' + r.avgEF);
});

check('selfCheck：avgEF 四舍五入到两位（(2.5+2.56+2.6)/3 = 2.5533 → 2.55）', () => {
  const list = [
    { ef: 2.5, interval: 1, history: [{ q: 5, interval: 1 }] },
    { ef: 2.56, interval: 6, history: [{ q: 5, interval: 1 }] },
    { ef: 2.6, interval: 21, history: [{ q: 3, interval: 1 }] }
  ];
  const r = selfCheck(list);
  assert.strictEqual(r.avgEF, 2.55, '期望 2.55，实际 ' + r.avgEF);
  assert.strictEqual(r.firstTryRate, 100, '三词首答都 >=3，期望 100，实际 ' + r.firstTryRate);
  assert.strictEqual(r.retainedRatio, 33, '1/3 → 33.33 向下取整期望 33，实际 ' + r.retainedRatio);
  assert.strictEqual(r.hasData, true, '有复习记录期望 hasData=true，实际 ' + r.hasData);
});

/* ---------- 十一、sm2 分支起点与纯函数契约（审计 P0-1~P0-4 / M7） ---------- */

check('sm2：不传 today 时以当天为基准（today || todayStr() 兜底路径）', () => {
  const out = sm2({ ef: 2.5, reps: 0, interval: 0 }, 5);
  const expected = addDays(todayStr(), 1);
  assert.strictEqual(out.nextReview, expected,
    '缺省基准日时期望次日 ' + expected + '，实际 ' + out.nextReview);
});

check('sm2：EF 触及下限后仍能回升（1.3 是钳制不是锁死，防误写成 <=）', () => {
  const out = sm2({ ef: 1.3, reps: 0, interval: 1 }, 5, T0);
  assert.strictEqual(out.ef, 1.4, 'ef 1.3 + 认识一次期望回升到 1.4，实际 ' + out.ef);
});

check('sm2：EF 已在下限时继续答错，仍钳在 1.3（幂等）', () => {
  const out = sm2({ ef: 1.3, reps: 0, interval: 1 }, 1, T0);
  assert.strictEqual(out.ef, 1.3, '期望保持 1.3，实际 ' + out.ef);
});

check('sm2：独立构造 reps=2 与 reps=3 起点，钉住两个分支（非顺序推进）', () => {
  const from2 = sm2({ ef: 2.5, reps: 2, interval: 6 }, 5, T0);
  assert.strictEqual(from2.reps, 3, 'reps 2→3，实际 ' + from2.reps);
  assert.strictEqual(from2.interval, 16, 'round(6×2.6)=16，实际 ' + from2.interval);

  const from3 = sm2({ ef: 2.5, reps: 3, interval: 6 }, 5, T0);
  assert.strictEqual(from3.reps, 4, 'reps 3→4，实际 ' + from3.reps);
  assert.strictEqual(from3.interval, 16, 'reps>=3 走乘法分支，round(6×2.6)=16，实际 ' + from3.interval);
});

check('sm2：纯函数——不修改入参，且保留记录上的额外字段', () => {
  const item = { ef: 2.5, reps: 0, interval: 0, word: 'ability', history: [] };
  const snapshot = JSON.stringify(item);
  const out = sm2(item, 5, T0);
  assert.strictEqual(JSON.stringify(item), snapshot,
    '入参被就地修改了：前 ' + snapshot + ' 后 ' + JSON.stringify(item));
  assert.notStrictEqual(out, item, '应返回新对象而不是同一个引用');
  assert.strictEqual(out.word, 'ability', 'word 等额外字段应被保留，实际 ' + out.word);
  assert.deepStrictEqual(out.history, [], 'history 应被保留');
});

/* ---------- 十二、审计清单剩余边界 ---------- */

check('addDays：闰日与短月的进位（02-29 +1 → 03-01；08-31 +1 → 09-01）', () => {
  const a = addDays('2028-02-29', 1);
  assert.strictEqual(a, '2028-03-01', "addDays('2028-02-29',1) 期望 2028-03-01，实际 " + a);
  const b = addDays('2026-08-31', 1);
  assert.strictEqual(b, '2026-09-01', "addDays('2026-08-31',1) 期望 2026-09-01，实际 " + b);
});

check('addDays：非法输入不抛异常，且**必须**回落到合法日期串（不得产出 NaN-NaN-NaN）', () => {
  let got;
  let threw = false;
  try { got = addDays('abc', 1); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, "addDays('abc',1) 不该抛异常");
  assert.strictEqual(typeof got, 'string', '应返回字符串而不是 undefined，实际 ' + typeof got);
  // 仅"是字符串"还不够：'NaN-NaN-NaN' 也满足。按字典序 'N'(78) > '2'(50)，
  // 一旦写进 nextReview 该词永远大于任何真实日期 → 永久卡在队列外（静默丢词）。
  assert.strictEqual(isValidDateStr(got), true,
    "addDays('abc',1) 必须返回合法日期串，实际 " + JSON.stringify(got));
  // 非法基准日按"今天"处理、非法天数按 0 处理（这里 days=1，故期望今天+1）
  assert.strictEqual(got, addDays(todayStr(), 1),
    "非法基准日应回落到今天，实际 " + JSON.stringify(got) + "，期望 " + addDays(todayStr(), 1));
  assert.strictEqual(addDays('2026-02-30', 1), addDays(todayStr(), 1),
    "格式对但不存在的日期（02-30）也应回落到今天+1");
  assert.strictEqual(addDays('2026-09-10', 'x'), '2026-09-10',
    "非法天数应按 0 处理，实际 " + JSON.stringify(addDays('2026-09-10', 'x')));
});

check('isValidDateStr：只接受规范 YYYY-MM-DD，1 位月/日必须拒绝（否则字典序比较会静默丢词）', () => {
  // 全项目按字典序比较日期串（dueWords 用 `w.nextReview <= today`）。
  // '2026-1-5' 与 '2026-09-16' 比到第 6 位时 '1'(0x31) > '0'(0x30)，
  // 于是它被当成"还没到期"，且永远大于任何真实日期 → 该词永久进不了队列，
  // 界面无感。所以"格式看着像日期"不够，必须锁死零填充两位。
  assert.strictEqual(isValidDateStr('2026-09-16'), true, '规范格式应通过');
  assert.strictEqual(isValidDateStr('2026-1-5'), false, "isValidDateStr('2026-1-5') 应为 false");
  assert.strictEqual(isValidDateStr('2026-9-16'), false, "isValidDateStr('2026-9-16') 应为 false");
  assert.strictEqual(isValidDateStr('2026-09-1'), false, "isValidDateStr('2026-09-1') 应为 false");
  // 字典序后果：非规范串确实排在真实日期之后（这正是要拒绝它的原因）
  assert.ok('2026-1-5' > '2026-09-16', '非规范串在字典序里大于真实日期 —— 这就是丢词机制');
  // 仍然要挡住"格式对但日子不存在"
  assert.strictEqual(isValidDateStr('2026-02-30'), false, "'2026-02-30' 应被拒绝");
  assert.strictEqual(isValidDateStr('2026-13-01'), false, "'2026-13-01' 应被拒绝");
  assert.strictEqual(isValidDateStr(''), false, '空串应被拒绝');
  assert.strictEqual(isValidDateStr(null), false, 'null 应被拒绝');
});

check('dueWords：nextReview 与 interval 全同时保持入参顺序（稳定排序）', () => {
  const list = [
    { word: 'first', nextReview: T0, interval: 3 },
    { word: 'second', nextReview: T0, interval: 3 },
    { word: 'third', nextReview: T0, interval: 3 }
  ];
  const got = dueWords(list, T0).map(w => w.word);
  assert.deepStrictEqual(got, ['first', 'second', 'third'],
    '全同记录应保持入参顺序，实际 ' + JSON.stringify(got));
});

check('intervalCurve：平均值舍入到 1 位小数（(1+2)/2=1.5、(6+7)/2=6.5）', () => {
  const list = [
    { history: [{ interval: 1 }, { interval: 6 }] },
    { history: [{ interval: 2 }, { interval: 7 }] }
  ];
  const got = intervalCurve(list);
  assert.deepStrictEqual(got, [{ x: 1, y: 1.5 }, { x: 2, y: 6.5 }],
    '期望 1.5 / 6.5，实际 ' + JSON.stringify(got));
});

check('selfCheck：百分比分母是"已复习词"、EF 分母是"全库"（最易搞混的口径）', () => {
  const list = [
    { ef: 2.5, interval: 30, history: [{ q: 5, interval: 1 }] },  // 已复习且已掌握
    { ef: 2.5, interval: 0, history: [] }                          // 未复习的新词
  ];
  const r = selfCheck(list);
  assert.strictEqual(r.retainedRatio, 100,
    '分母应为已复习词数 1（不是全库 2），期望 100，实际 ' + r.retainedRatio);
  assert.strictEqual(r.avgEF, 2.5,
    'EF 分母应为全库 2 词，期望 2.5，实际 ' + r.avgEF);
  assert.strictEqual(r.firstTryRate, 100, '期望 100，实际 ' + r.firstTryRate);
});

// ---------- 汇总 ----------
console.log('\n>>> ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
