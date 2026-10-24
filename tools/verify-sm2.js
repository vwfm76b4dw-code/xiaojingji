/**
 * SM-2 算法验证脚本（2026-09-24 重写）
 *
 * ## 这次重写修掉的两个"假门"缺陷（DEV-P0-3）
 *   ① 旧版验证的是**文件内联的算法副本**，不 require miniprogram/utils/sm2.js
 *      —— 交付的算法改坏了，这道门照样绿（副本给真身背书）。
 *   ② 旧版全文件无 process.exit —— 判定段就算全 FAIL，退出码也是 0，
 *      check_all.sh 永远显示它 "OK 通过"（永不失败的门）。
 *
 * 现在：require 真源（交付物本身），失败退出码 1，可挂在任何 CI/总入口后面。
 * 设计预期表仍以 docs/SM-2算法设计说明.md §4 为准。
 *
 * 运行：node tools/verify-sm2.js
 */
const assert = require('assert');
const path = require('path');
const { sm2, GRADE } = require(path.resolve(__dirname, '..', 'miniprogram', 'utils', 'sm2.js'));

const RECOGNIZE = GRADE.KNOW, VAGUE = GRADE.VAGUE, FORGOT = GRADE.FORGOT;

/*----------------------------- 断言辅助 -----------------------------*/
let pass = 0, fail = 0;
const failed = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else {
    fail++; failed.push(name);
    console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
  }
}

/*----------------------------- 用例 -----------------------------*/

console.log('=== SM-2 算法（require 真实实现）===');
console.log('被测文件: miniprogram/utils/sm2.js\n');

// 固定日期做基准，断言可复现（日期处理红线：本地日期，不用 toISOString）
const T = '2026-09-24';

// 组 1：三档间隔递进（认识 5 次：1 → 6 → 17 → 45 → ...）
{
  let it = { ef: 2.5, reps: 0, interval: 0 };
  const seq = [];
  for (let i = 0; i < 4; i++) { it = sm2(it, RECOGNIZE, T); seq.push(it.interval); }
  check('连续认识间隔为 1 → 6 → 递增 → 递增',
    seq[0] === 1 && seq[1] === 6 && seq[2] > seq[1] && seq[3] > seq[2],
    '实际 ' + JSON.stringify(seq));
  check('第3次间隔为 17（round(6*2.8)）', seq[2] === 17, '实际 ' + seq[2]);
  check('EF 在连续认识后递增', it.ef > 2.5, '实际 ' + it.ef);
}

// 组 2：答错路径
{
  let it = { ef: 2.5, reps: 3, interval: 17 };
  const before = JSON.stringify(it);
  const out = sm2(it, FORGOT, T);
  check('答错后 interval 重置为 1', out.interval === 1, '实际 ' + out.interval);
  check('答错后 reps 归零', out.reps === 0, '实际 ' + out.reps);
  check('答错后 EF 下降', out.ef < 2.5, '实际 ' + out.ef);
  check('sm2 是纯函数（不改动入参）', JSON.stringify(it) === before, '入参被改动');
  check('答错 nextReview = 今天+1', out.nextReview === '2026-09-25', '实际 ' + out.nextReview);
}

// 组 3：EF 下限
{
  let it = { ef: 2.5, reps: 0, interval: 0 };
  const efs = [];
  for (let i = 0; i < 10; i++) { it = sm2(it, FORGOT, T); efs.push(it.ef); }
  check('连续答错 EF 不低于 1.3', it.ef >= 1.3, '实际 ' + it.ef);
  check('EF 下限精确收敛到 1.3（公式 clamp，非近似）', it.ef === 1.3, '实际 ' + it.ef);
  check('EF 两位小数截断（存库口径）', Number.isInteger(it.ef * 100), '实际 ' + it.ef);
}

// 组 4：模糊（q=3）路径
{
  let it = { ef: 2.5, reps: 2, interval: 6 };
  const out = sm2(it, VAGUE, T);
  check('模糊后 EF 下降但仍记住（reps 续接）', out.ef < 2.5 && out.reps === 3, 'ef=' + out.ef + ' reps=' + out.reps);
  check('模糊第 3 次间隔 = round(6*2.4) = 14', out.interval === 14, '实际 ' + out.interval);
}

// 组 5：GRADE 三档与设计文档一致
{
  check('GRADE 映射：认识=5 / 模糊=3 / 不认识=1',
    GRADE.KNOW === 5 && GRADE.VAGUE === 3 && GRADE.FORGOT === 1,
    '实际 ' + JSON.stringify(GRADE));
}

// 组 6：边界 — 畸形输入不崩（读库数据不可信，函数必须自卫）
{
  const out = sm2({ ef: undefined, reps: undefined, interval: undefined }, RECOGNIZE, T);
  check('字段全缺省时不抛错、返回对象（NaN 进 NaN 出，不炸调用方）',
    typeof out === 'object' && out !== null, '未返回对象');
  const out2 = sm2({ ef: 2.5, reps: 1, interval: 1 }, VAGUE, '2026-12-31');
  check('跨年日期：nextReview = 2027-01-06（+6 天跨年）', out2.nextReview === '2027-01-06', '实际 ' + out2.nextReview);
  check('today 未传时用当天本地日期（不抛错即可）',
    (function () { try { sm2({ ef: 2.5, reps: 0, interval: 0 }, RECOGNIZE); return true; } catch (e) { return false; } })(),
    '缺省 today 抛错');
}

/*----------------------------- 汇总 -----------------------------*/

console.log('\n' + '='.repeat(62));
console.log(' >>> ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(62));
if (fail > 0) {
  console.log(' 失败项:');
  failed.forEach(function (f) { console.log('   - ' + f); });
  process.exit(1);
}
process.exit(0);
