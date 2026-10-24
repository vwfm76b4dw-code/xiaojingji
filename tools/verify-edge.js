/**
 * 边界与数据层验证 —— 补上此前没有直接覆盖的部分。
 *
 * 为什么要单独一层：
 *   verify-sm2-app.js 只管纯算法，verify-ai.js 只管 AI 链路，
 *   verify-integration.js 只跑一条"顺利"的闭环。
 *   **store.js（本地存储层）此前没有任何直接断言**，而它是"数据会不会丢"的唯一关口；
 *   真实数据（预置词库 / 课本词库）也没有任何完整性校验。
 *   本文件把这两块补上，并补几条跨模块的真边界（答错、次日到期、统计口径切换）。
 *
 * 分组：
 *   一、本地存储层 store.js —— 读写接口的正常 / 异常路径
 *   二、读取净化层 sanitize —— 存储被外部改坏后的修正契约（含"合法数据零改动"）
 *   三、跨模块真边界 —— 真实 store + 真实算法跑完整闭环
 *   四、真实数据完整性 —— 预置词库 / 课本词库的结构校验
 *   五、教材词库导入（wy7s_2024）
 *   六、单元归属往返 —— 种子/导入 → 落库 → 投影（「按单元学习」的事故盲区）
 *
 * 运行：node tools/verify-edge.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', 'miniprogram');

/*------------ 搭一个可控的内存 wx.Storage 环境（在 require 之前就位） ------------
 * 注意：getStorageSync **必须返回深拷贝**。真实 wx.getStorageSync 每次返回反序列化后的
 * 新对象；若像 verify-integration.js 那样直接返回内部引用，就地修改会被误当成"已落库"，
 * 掩盖"没写盘"一类缺陷，测试保真度低于真实环境。
 */
let store = {};
let toasts = [];
global.wx = {
  getStorageSync: k => (k in store ? JSON.parse(JSON.stringify(store[k])) : ''),
  setStorageSync: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete store[k]; },
  showToast: opts => { toasts.push(opts && opts.title); },
  switchTab: () => {},
  navigateTo: () => {}
};

const storeMod = require(path.join(ROOT, 'utils', 'store.js'));
const { dueWords, selfCheck, pointsOf, masteredCount, MASTERED_INTERVAL,
  unitsOf, UNGROUPED_UNIT } = require(path.join(ROOT, 'utils', 'schedule.js'));
const { sm2, GRADE } = require(path.join(ROOT, 'utils', 'sm2.js'));
const { todayStr, addDays, isValidDateStr } = require(path.join(ROOT, 'utils', 'date.js'));
const aiCore = require(path.join(ROOT, 'utils', 'ai-core.js'));
const PRESET = require(path.join(ROOT, 'data', 'words.js'));
const CURRICULUM = require(path.join(ROOT, 'data', 'curriculum', 'wy7s_2024.json'));

/**
 * 与 pages/curriculum/curriculum.js 里的 toItem 保持同一口径（释义带词性前缀）。
 * 页面本身的行为由 tools/verify-pages.js 直驱覆盖；这里只锁"数据 + store 导入路径"这一层，
 * 重点是证明 18 条多词短语不会被丢弃。
 */
function toItem(w) {
  const pos = String(w.pos || '').trim();
  const meaning = String(w.meaning || '').trim();
  return { word: String(w.word || '').trim(), meaning: pos ? pos + ' ' + meaning : meaning };
}

const TODAY = todayStr();
const TOMORROW = addDays(TODAY, 1);
/**
 * 「一个合法的未来日期」的构造器（2026-09-30 加）。
 *
 * 为什么需要它：造数据时凡是要表达"这个日期还没到期、净化不该碰它"，
 * **一律用 `addDays(TODAY, N)` 算，不得硬编码绝对日期**。
 * 硬编码出来的"未来"会随真实时钟悄悄变成"过去"——
 * `dueWords` 判到期用的是 `nextReview <= today`（字典序），
 * 所以 `'2027-01-01'` 在 2026 年是未来、2027 年之后就是已到期，
 * 届时一个跟当时改动毫无关系的用例会自己变红（实测：
 * 真实时钟下84 项全绿，把时钟冻结到 2027-03-15 立刻炸 `4 !== 3`）。
 *
 * 取 30 天而不是 1 天：留出余量，让"跨天跑"这件事也不会影响语义
 * （1 天太贴边，跨一次午夜就又是一次时钟相关失败）。
 */
const FUTURE = addDays(TODAY, 30);

let pass = 0, fail = 0;
const problems = [];

function check(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n      ' + e.message);
    problems.push(name + ' → ' + e.message);
  }
}

function reset() { store = {}; toasts = []; }

/** 跑一段会故意触发 console.warn / console.error 的代码而不污染输出 */
function quietly(fn) {
  const ow = console.warn, oe = console.error;
  console.warn = function () {};
  console.error = function () {};
  try { return fn(); } finally { console.warn = ow; console.error = oe; }
}

/** 绕过 store 的写入接口，直接往"存储"里塞脏数据（模拟外部篡改 / 跨版本迁移） */
function putRawStorage(value) { store['words'] = value; }

/*======================== 一、本地存储层 store.js ========================*/

check('addWord：正常写入，算法初始态字段完整（ef 2.5 / reps 0 / interval 0 / 当日到期）', () => {
  reset();
  const r = storeMod.addWord({ word: '  ability  ', meaning: '  n. 能力  ' });
  assert.strictEqual(r.ok, true, '应写入成功，实际 ' + JSON.stringify(r));
  assert.ok(r.item.id, 'id 不该为空');
  assert.strictEqual(r.item.word, 'ability', '单词应去首尾空格，实际 ' + JSON.stringify(r.item.word));
  assert.strictEqual(r.item.meaning, 'n. 能力', '释义应去首尾空格，实际 ' + JSON.stringify(r.item.meaning));
  assert.strictEqual(r.item.ef, 2.5, 'ef 初值期望 2.5，实际 ' + r.item.ef);
  assert.strictEqual(r.item.reps, 0, 'reps 初值期望 0，实际 ' + r.item.reps);
  assert.strictEqual(r.item.interval, 0, 'interval 初值期望 0，实际 ' + r.item.interval);
  assert.strictEqual(r.item.nextReview, TODAY, '录入当日即到期，期望 ' + TODAY + '，实际 ' + r.item.nextReview);
  assert.strictEqual(r.item.createdAt, TODAY, 'createdAt 期望 ' + TODAY + '，实际 ' + r.item.createdAt);
  assert.deepStrictEqual(r.item.history, [], 'history 初值期望 []');
  assert.strictEqual(storeMod.loadWords().length, 1, '应已落库 1 条');
});

check('addWord：重复词忽略大小写被拒，且不写入', () => {
  reset();
  storeMod.addWord({ word: 'ability', meaning: 'n. 能力' });
  const r = storeMod.addWord({ word: 'ABILITY', meaning: '另一个释义' });
  assert.strictEqual(r.ok, false, '重复词应被拒，实际 ' + JSON.stringify(r));
  assert.ok(/ABILITY/.test(r.msg), '提示里应回显用户输入的词，实际 ' + r.msg);
  assert.strictEqual(storeMod.loadWords().length, 1, '词库不该被写入第 2 条');
});

check('addWord：缺单词或释义一律拒绝（不允许半条数据）', () => {
  reset();
  const a = storeMod.addWord({ word: '', meaning: 'n. 能力' });
  assert.strictEqual(a.ok, false, '空单词应被拒');
  const b = storeMod.addWord({ word: 'ability', meaning: '   ' });
  assert.strictEqual(b.ok, false, '空释义应被拒');
  const c = storeMod.addWord({});
  assert.strictEqual(c.ok, false, '空对象应被拒，不该抛错');
  assert.strictEqual(storeMod.loadWords().length, 0, '都不该落库');
});

check('addBatch：六类分隔符（\\n , ， 、 ; ；）混排都能切分（7 条全部入库）', () => {
  reset();
  const text = 'apple 苹果\nbanana 香蕉,cherry 樱桃，date 枣、elder 接骨木;fig 无花果；grape 葡萄';
  const r = storeMod.addBatch(text);
  assert.strictEqual(r.added, 7, '应写入 7 条，实际 ' + r.added + '，skipped=' + JSON.stringify(r.skipped));
  assert.strictEqual(r.ok, true, 'ok 应为 true');
  const words = storeMod.loadWords().map(w => w.word).sort();
  assert.deepStrictEqual(words, ['apple', 'banana', 'cherry', 'date', 'elder', 'fig', 'grape'],
    '入库单词不符，实际 ' + JSON.stringify(words));
});

check('addBatch：纯空白 / 纯分隔符输入 → ok:false、added 0、skipped 空', () => {
  reset();
  const r = storeMod.addBatch('  , ,\n\n、；');
  assert.strictEqual(r.ok, false, '全空白应 ok:false，实际 ' + r.ok);
  assert.strictEqual(r.added, 0, 'added 应为 0，实际 ' + r.added);
  assert.deepStrictEqual(r.skipped, [], '纯空白不该被记为 skipped，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 0, '不该有任何写入');
});

check('addBatch：非法行进 skipped 且不写入（数字开头 / 只有单词没有释义）', () => {
  reset();
  const r = storeMod.addBatch('good 好的\n123bad 坏的\nlonely');
  assert.strictEqual(r.added, 1, '只有 good 合法，实际 added=' + r.added);
  assert.strictEqual(r.skipped.length, 2, '应跳过 2 条，实际 ' + JSON.stringify(r.skipped));
  assert.deepStrictEqual(r.skipped.sort(), ['123bad 坏的', 'lonely'].sort(),
    '跳过的内容不符，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 1, '被跳过的行不该落库');
});

check('addBatch：同一批文本内的重复词只写一次（判重对象是增长中的词库）', () => {
  reset();
  const r = storeMod.addBatch('apple 苹果\nAPPLE 苹果（重复）');
  assert.strictEqual(r.added, 1, '期望只写 1 条，实际 ' + r.added);
  assert.deepStrictEqual(r.skipped, ['APPLE'], '重复的那条应进 skipped，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 1, '词库应只有 1 条');
});

check('addBatch：全部非法 → ok:false 且 added=0（界面据此提示"没有识别到"）', () => {
  reset();
  const r = storeMod.addBatch('lonely\n123 bad\n\n   ');
  assert.strictEqual(r.ok, false, '全非法时 ok 应为 false，实际 ' + r.ok);
  assert.strictEqual(r.added, 0, 'added 应为 0，实际 ' + r.added);
  assert.strictEqual(storeMod.loadWords().length, 0, '不该有任何写入');
});

check('addItems（AI 路径）：正常写入并跳过重复，返回 added/skipped', () => {
  reset();
  const r = storeMod.addItems([
    { word: 'apple', meaning: '苹果' },
    { word: 'APPLE', meaning: '苹果（重复）' },
    { word: 'banana', meaning: '香蕉' }
  ]);
  assert.strictEqual(r.added, 2, '期望写入 2 条，实际 ' + r.added);
  assert.deepStrictEqual(r.skipped, ['APPLE'], '重复项应进 skipped，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 2, '词库应 2 条');
});

check('addItems：非数组 / 空数组 → ok:false 且不抛错', () => {
  reset();
  assert.strictEqual(storeMod.addItems([]).ok, false, '空数组应返回 ok:false');
  assert.strictEqual(storeMod.addItems(null).ok, false, 'null 应返回 ok:false 不抛错');
  assert.strictEqual(storeMod.addItems('不是数组').ok, false, '字符串应返回 ok:false 不抛错');
  assert.strictEqual(storeMod.loadWords().length, 0, '都不该落库');
});

check('addItems：缺字段条目进 skipped（AI 返回残条时不能让整批失败）', () => {
  reset();
  const r = storeMod.addItems([{ word: '', meaning: 'x' }, { word: 'cat' }]);
  assert.strictEqual(r.added, 0, '都不完整，实际 added=' + r.added);
  assert.strictEqual(r.skipped.length, 2, '应跳过 2 条，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 0, '不该落库');
});

check('addItems：数组含 null 元素时不崩，合法条目照常写入', () => {
  reset();
  const r = storeMod.addItems([null, { word: 'n2', meaning: 'y' }]);
  assert.strictEqual(r.added, 1, '期望写入 1 条，实际 ' + r.added);
  assert.deepStrictEqual(r.skipped, ['(空)'], 'null 元素应进 skipped，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 1, '词库应 1 条');
});

check('removeWord：不存在的 id 不抛异常且词库长度不变', () => {
  reset();
  storeMod.addBatch('apple 苹果\nbanana 香蕉');
  let threw = false;
  try { storeMod.removeWord('no-such-id'); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, '不存在的 id 不该抛异常');
  assert.strictEqual(storeMod.loadWords().length, 2, '词库长度应不变，实际 ' + storeMod.loadWords().length);
});

check('updateWord：id 不存在时返回 false，且不会新增记录', () => {
  reset();
  storeMod.addWord({ word: 'apple', meaning: '苹果' });
  const before = storeMod.loadWords().length;
  const ok = storeMod.updateWord({ id: '不存在的id', word: 'ghost', meaning: '幽灵' });
  assert.strictEqual(ok, false, '找不到 id 应返回 false，实际 ' + ok);
  assert.strictEqual(storeMod.loadWords().length, before, '不该新增记录，实际 ' + storeMod.loadWords().length);
});

check('updateWord：命中 id 后持久化（重新 loadWords 能看到新值）', () => {
  reset();
  storeMod.addWord({ word: 'apple', meaning: '苹果' });
  const item = storeMod.loadWords()[0];
  item.meaning = 'n. 苹果';
  // 注意：reps 与 interval 必须成对设置。reps>0 而 interval=0 违反净化层的不变式
  // （interval 为 0 意味着从未成功复习过），会被读取净化归零 —— 这是有意为之，见下方净化用例。
  item.reps = 3;
  item.interval = 17;
  assert.strictEqual(storeMod.updateWord(item), true, 'updateWord 应返回 true');
  const reread = storeMod.loadWords()[0];
  assert.strictEqual(reread.meaning, 'n. 苹果', '释义未持久化，实际 ' + reread.meaning);
  assert.strictEqual(reread.reps, 3, 'reps 未持久化，实际 ' + reread.reps);
  assert.strictEqual(reread.interval, 17, 'interval 未持久化，实际 ' + reread.interval);
});

check('removeWord：只删目标 id，其余词条不受影响', () => {
  reset();
  storeMod.addBatch('apple 苹果\nbanana 香蕉\ncherry 樱桃');
  const target = storeMod.loadWords().find(w => w.word === 'banana');
  assert.ok(target, '前提：应能找到 banana');
  storeMod.removeWord(target.id);
  const left = storeMod.loadWords().map(w => w.word).sort();
  assert.deepStrictEqual(left, ['apple', 'cherry'], '删除后应剩 apple/cherry，实际 ' + JSON.stringify(left));
});

check('clearAll：清空后词库为空数组', () => {
  reset();
  storeMod.addBatch('apple 苹果\nbanana 香蕉');
  assert.strictEqual(storeMod.clearAll(), true, 'clearAll 应返回 true');
  assert.deepStrictEqual(storeMod.loadWords(), [], '清空后应为 []，实际 ' + JSON.stringify(storeMod.loadWords()));
});

check('seedWords：载入预置库并覆盖旧数据，返回载入条数', () => {
  reset();
  storeMod.addWord({ word: '手动添加的词', meaning: '应被覆盖' });
  const n = storeMod.seedWords(PRESET.slice(0, 3));
  assert.strictEqual(n, 3, '应返回 3，实际 ' + n);
  const list = storeMod.loadWords();
  assert.strictEqual(list.length, 3, '应覆盖为 3 条，实际 ' + list.length);
  assert.strictEqual(list.some(w => w.word === '手动添加的词'), false, '旧数据应被覆盖掉');
  assert.strictEqual(list.every(w => w.history.length === 0), true, '载入的预置词应无复习记录');
});

/** 跑一段会故意触发 console.error 的代码而不污染输出（store 的兜底路径本身会打日志） */
function quietly(fn) {
  const original = console.error;
  console.error = function () {};
  try { return fn(); } finally { console.error = original; }
}

check('loadWords：底层存储抛异常时返回 []，不让整个页面崩', () => {
  reset();
  const original = global.wx.getStorageSync;
  global.wx.getStorageSync = function () { throw new Error('模拟存储读失败'); };
  const got = quietly(function () {
    try { return storeMod.loadWords(); } catch (e) { return 'THREW: ' + e.message; }
  });
  global.wx.getStorageSync = original;
  assert.deepStrictEqual(got, [], '读失败应兜底成 []，实际 ' + JSON.stringify(got));
});

check('saveWords：底层存储抛异常时返回 false，不让整个页面崩', () => {
  reset();
  const original = global.wx.setStorageSync;
  global.wx.setStorageSync = function () { throw new Error('模拟存储写失败'); };
  const got = quietly(function () {
    try { return storeMod.saveWords([{ word: 'x' }]); } catch (e) { return 'THREW: ' + e.message; }
  });
  global.wx.setStorageSync = original;
  assert.strictEqual(got, false, '写失败应返回 false，实际 ' + JSON.stringify(got));
});

check('addBatch：20 个词一次写入，生成的 id 互不重复', () => {
  reset();
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push('w' + String.fromCharCode(97 + i) + ' 释义' + i);
  const r = storeMod.addBatch(lines.join('\n'));
  assert.strictEqual(r.added, 20, '应写入 20 条，实际 ' + r.added);
  const ids = storeMod.loadWords().map(w => w.id);
  assert.strictEqual(new Set(ids).size, 20, 'id 出现重复：' + JSON.stringify(ids));
});

check('addBatch 短语切分：apple 苹果 → {apple, 苹果}（单词 + 中文释义）', () => {
  reset();
  const r = storeMod.addBatch('apple 苹果');
  assert.strictEqual(r.added, 1, '应写入 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'apple', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, '苹果', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('addBatch 短语切分：all over the world 全世界 → 整体作单词（不得截断成 "all"）', () => {
  reset();
  // 旧实现固定把 parts[0] 当单词：结果是 word='all' / meaning='over the world 全世界'，
  // 词库里凭空多出一个假单词 'all'，界面还提示"已添加"，用户根本发现不了。
  const r = storeMod.addBatch('all over the world 全世界');
  assert.strictEqual(r.added, 1, '应写入 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'all over the world', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, '全世界', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('addBatch 短语切分：look after 照顾 → 双词短语整体作单词', () => {
  reset();
  const r = storeMod.addBatch('look after 照顾');
  assert.strictEqual(r.added, 1, '应写入 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'look after', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, '照顾', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('addBatch 短语切分：全英文无释义 hello world → 回退成 {hello, world}（保持原行为，不得判非法）', () => {
  reset();
  const r = storeMod.addBatch('hello world');
  assert.strictEqual(r.added, 1, '应写入 1 条（回退而非丢弃），实际 ' + r.added + '，skipped=' + JSON.stringify(r.skipped));
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'hello', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, 'world', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('addBatch 短语切分：数字开头 123 数字 → 非法进 skipped，不写入', () => {
  reset();
  const r = storeMod.addBatch('123 数字');
  assert.strictEqual(r.ok, false, 'ok 应为 false，实际 ' + JSON.stringify(r));
  assert.strictEqual(r.added, 0, '不该写入，实际 ' + r.added);
  assert.deepStrictEqual(r.skipped, ['123 数字'], '原文应进 skipped，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(storeMod.loadWords().length, 0, '词库应仍为空');
});

check('addBatch 短语切分：5 词长短语不截断（不得为消歧义引入 token 数量上限）', () => {
  reset();
  // 教材里最长短语 5 词（如 stop someone from doing something）。
  // 回退规则已足够消歧义；一旦加上"最多 N 个 token"的上限，这类短语又会被切成假单词。
  const r = storeMod.addBatch('stop someone from doing something 阻止某人做某事');
  assert.strictEqual(r.added, 1, '应写入 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'stop someone from doing something', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, '阻止某人做某事', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('addBatch 短语切分：撇号 / 连字符 token 与单 token 行的边界', () => {
  const cases = [
    // [输入, 期望 word, 期望 meaning]
    ["don't 不", "don't", '不'],
    ['well-known 著名的', 'well-known', '著名的'],
    ['x-y-z 连字符', 'x-y-z', '连字符'],
    ["it's a test 这是一个测试", "it's a test", '这是一个测试'],
    ['A 一', 'A', '一'],
    ['  junior high   初级中学  ', 'junior high', '初级中学']
  ];
  cases.forEach(function (c) {
    reset();
    const r = storeMod.addBatch(c[0]);
    assert.strictEqual(r.added, 1, JSON.stringify(c[0]) + ' 应写入 1 条，实际 ' + r.added +
      '，skipped=' + JSON.stringify(r.skipped));
    const w = storeMod.loadWords()[0];
    assert.strictEqual(w.word, c[1], JSON.stringify(c[0]) + ' 的 word 实际 ' + JSON.stringify(w.word));
    assert.strictEqual(w.meaning, c[2], JSON.stringify(c[0]) + ' 的 meaning 实际 ' + JSON.stringify(w.meaning));
  });

  // 单 token 行没有释义可退，必须判非法（不能把整行当单词）
  ['apple', 'a', 'No.'].forEach(function (s) {
    reset();
    const r = storeMod.addBatch(s);
    assert.strictEqual(r.ok, false, JSON.stringify(s) + ' 应判非法，实际 ' + JSON.stringify(r));
    assert.deepStrictEqual(r.skipped, [s], JSON.stringify(s) + ' 原文应进 skipped');
  });
});

check('addBatch 短语切分：全英文无中文时按"回退到最后一个 token 当释义"处理（与原行为一致）', () => {
  // 这类输入本来就有歧义（没法知道用户是想录短语还是想录"单词+英文释义"）。
  // 选择的策略是**回退**而不是判非法 —— 判非法会让用户白白丢一条输入，
  // 而回退至少把两个 token 都保留了下来，用户能自己改。
  reset();
  const r = storeMod.addBatch('take care of it');
  assert.strictEqual(r.added, 1, '应写入 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'take care of', 'word 实际 ' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, 'it', 'meaning 实际 ' + JSON.stringify(w.meaning));

  // 加了中文释义就没有歧义了，整串英文应作为单词
  reset();
  storeMod.addBatch('take care of it 照顾它');
  const w2 = storeMod.loadWords()[0];
  assert.strictEqual(w2.word, 'take care of it', 'word 实际 ' + JSON.stringify(w2.word));
  assert.strictEqual(w2.meaning, '照顾它', 'meaning 实际 ' + JSON.stringify(w2.meaning));
});

check('addItems：dupSkipped 与 addBatch 同口径（区分"已在词库"与"缺字段"）', () => {
  reset();
  storeMod.addWord({ word: 'apple', meaning: '苹果' });
  const r = storeMod.addItems([
    { word: 'APPLE', meaning: '苹果' },   // 重复（忽略大小写）
    { word: '', meaning: '缺单词' },        // 缺字段
    { word: 'banana', meaning: '香蕉' }     // 新增
  ]);
  assert.strictEqual(r.added, 1, '应新增 1 条，实际 ' + r.added);
  assert.strictEqual(r.dupSkipped, 1, '重复条数应为 1，实际 ' + r.dupSkipped);
  assert.strictEqual(r.skipped.length, 2, 'skipped 应为 2，实际 ' + JSON.stringify(r.skipped));
  const e = storeMod.addItems([]);
  assert.strictEqual(e.dupSkipped, 0, '空输入应返回 dupSkipped 0，实际 ' + e.dupSkipped);
});

check('addItems：全部重复 → ok:false 且 dupSkipped===skipped.length（界面据此说"都已在词库里"）', () => {
  reset();
  storeMod.addWord({ word: 'apple', meaning: '苹果' });
  const r = storeMod.addItems([{ word: 'apple', meaning: '另一个释义' }]);
  assert.strictEqual(r.ok, false, '全重复时 ok 应为 false，实际 ' + JSON.stringify(r));
  assert.strictEqual(r.added, 0, '不该新增，实际 ' + r.added);
  assert.strictEqual(r.dupSkipped, r.skipped.length,
    'dupSkipped(' + r.dupSkipped + ') 应等于 skipped.length(' + r.skipped.length + ')');
});

check('写盘失败：用显式 saveFailed 标志区分（ok:false 时 added 恒为 0，不能拿 added 当错误码）', () => {
  // 缺陷背景：三个调用方原先都写 `if (r.added > 0) title = '保存失败，请重试'`。
  // 而 store 的三条 ok:false 路径全部返回 added:0，所以那是**恒假的死分支** ——
  // 写盘失败会被说成"没有可识别的词条"，教材页更糟：被说成"这些词都已经在词库里了"，
  // 用户以为早就导过、直接走人，实际一个词都没进去。
  const original = global.wx.setStorageSync;
  global.wx.setStorageSync = function () { throw new Error('模拟存储写失败（配额满）'); };
  let rb, ri;
  try {
    reset();
    rb = quietly(function () { return storeMod.addBatch('apple 苹果\nbanana 香蕉'); });
    ri = quietly(function () { return storeMod.addItems([{ word: 'cherry', meaning: '樱桃' }]); });
  } finally {
    global.wx.setStorageSync = original;
  }

  // ① 写盘失败必须能被区分出来
  assert.strictEqual(rb.ok, false, 'addBatch 写盘失败 ok 应为 false，实际 ' + JSON.stringify(rb));
  assert.strictEqual(rb.saveFailed, true, 'addBatch 写盘失败必须带 saveFailed，实际 ' + JSON.stringify(rb));
  assert.strictEqual(ri.ok, false, 'addItems 写盘失败 ok 应为 false，实际 ' + JSON.stringify(ri));
  assert.strictEqual(ri.saveFailed, true, 'addItems 写盘失败必须带 saveFailed，实际 ' + JSON.stringify(ri));

  // ② added 的语义不变：没落库就是 0 —— 这正是它不能兼职当错误码的原因
  assert.strictEqual(rb.added, 0, '写盘失败时 added 应为 0，实际 ' + rb.added);
  assert.strictEqual(ri.added, 0, '写盘失败时 added 应为 0，实际 ' + ri.added);
  assert.deepStrictEqual(rb.skipped, [], '这一批没有格式问题，skipped 应为空');
  assert.strictEqual(rb.dupSkipped, 0, '这一批没有重复，dupSkipped 应为 0');

  // ③ 反向对照：成功路径不得携带 saveFailed
  reset();
  const okR = storeMod.addBatch('apple 苹果');
  assert.strictEqual(okR.ok, true, '正常写入应 ok:true，实际 ' + JSON.stringify(okR));
  assert.strictEqual(okR.saveFailed, undefined,
    '成功路径不该有 saveFailed，实际 ' + okR.saveFailed);

  // ④ 反向对照（本缺陷的另一半）：全重复是"这些词都已经在词库里了"，
  //    绝不能被标成写盘失败 —— 那是把用户往反方向推（明明该去重试，却被告知没问题）。
  reset();
  storeMod.addWord({ word: 'apple', meaning: '苹果' });
  const dupR = storeMod.addBatch('apple 苹果');
  assert.strictEqual(dupR.ok, false, '全重复应 ok:false，实际 ' + JSON.stringify(dupR));
  assert.strictEqual(dupR.saveFailed, undefined,
    '全重复不是写盘失败，不该带 saveFailed，实际 ' + dupR.saveFailed);
  assert.strictEqual(dupR.dupSkipped, dupR.skipped.length,
    '全重复时 dupSkipped 应等于 skipped.length，界面据此说"都已在词库里"');
});

/*======================== 二、读取净化层 sanitize（loadWords 是唯一数据入口） ========================*/

check('净化：存储值不是数组（字符串 / 对象 / 数字）→ 一律返回 [] 且不抛错', () => {
  const cases = ['"abc"', '{"word":"a"}', '42', 'true'];
  cases.forEach(function (label) {
    reset();
    putRawStorage(label === '"abc"' ? 'abc' : label === '{"word":"a"}' ? { word: 'a' } : label === '42' ? 42 : true);
    const got = quietly(function () {
      try { return storeMod.loadWords(); } catch (e) { return 'THREW: ' + e.message; }
    });
    assert.deepStrictEqual(got, [], '存储值为 ' + label + ' 时应返回 []，实际 ' + JSON.stringify(got));
  });
});

check('净化：word/meaning 缺失的记录被丢弃，合法记录原样保留', () => {
  reset();
  putRawStorage([
    { word: 'keep1', meaning: 'n. 保留1' },
    { meaning: 'n. 缺单词' },
    { word: '缺释义' },
    { word: '   ', meaning: 'n. 空白单词' },
    { word: 'keep2', meaning: '   ' },
    null,
    'not-an-object',
    { word: 'keep3', meaning: 'n. 保留3' }
  ]);
  const got = quietly(() => storeMod.loadWords());
  assert.deepStrictEqual(got.map(w => w.word), ['keep1', 'keep3'],
    '只应保留 word/meaning 都在的记录，实际 ' + JSON.stringify(got.map(w => w.word)));
});

check('净化：ef 非法（非数 / 低于下限 1.3）一律回到新词默认值 2.5', () => {
  reset();
  putRawStorage([
    { word: 'a', meaning: 'm', ef: 'abc' },
    { word: 'b', meaning: 'm', ef: 1.0 },
    { word: 'c', meaning: 'm', ef: null },
    { word: 'd', meaning: 'm', ef: 2.0 }
  ]);
  const got = quietly(() => storeMod.loadWords());
  const byWord = {};
  got.forEach(w => { byWord[w.word] = w.ef; });
  assert.strictEqual(byWord.a, 2.5, "ef='abc' 应回到 2.5，实际 " + byWord.a);
  assert.strictEqual(byWord.b, 2.5, 'ef=1.0 低于下限 1.3，应回到 2.5，实际 ' + byWord.b);
  assert.strictEqual(byWord.c, 2.5, 'ef=null 应回到 2.5，实际 ' + byWord.c);
  assert.strictEqual(byWord.d, 2.0, 'ef=2.0 合法，不该被改动，实际 ' + byWord.d);
});

check('净化：reps / interval 非法（负数 / 小数 / 垃圾串）一律归 0', () => {
  reset();
  putRawStorage([
    { word: 'a', meaning: 'm', reps: -1, interval: 6 },
    { word: 'b', meaning: 'm', reps: 2.5, interval: 6 },
    { word: 'c', meaning: 'm', reps: 'x', interval: -3 },
    { word: 'd', meaning: 'm', reps: 0, interval: 0 }
  ]);
  const got = quietly(() => storeMod.loadWords());
  const byWord = {};
  got.forEach(w => { byWord[w.word] = w; });
  assert.strictEqual(byWord.a.reps, 0, 'reps=-1 应归 0，实际 ' + byWord.a.reps);
  assert.strictEqual(byWord.b.reps, 0, 'reps=2.5 非整数应归 0，实际 ' + byWord.b.reps);
  assert.strictEqual(byWord.c.reps, 0, "reps='x' 应归 0，实际 " + byWord.c.reps);
  assert.strictEqual(byWord.c.interval, 0, 'interval=-3 应归 0，实际 ' + byWord.c.interval);
  assert.strictEqual(byWord.a.interval, 6, 'interval=6 合法，不该被改动，实际 ' + byWord.a.interval);
});

check('净化：字符串型数字字段折算为 number（否则 sm2 里 `ef + ...` 变成字符串拼接）', () => {
  reset();
  putRawStorage([{ word: 'a', meaning: 'm', ef: '2.5', reps: '3', interval: '6', nextReview: TODAY }]);
  const got = quietly(() => storeMod.loadWords());
  const w = got[0];
  assert.strictEqual(typeof w.ef, 'number', "ef 应折算成 number，实际 " + typeof w.ef);
  assert.strictEqual(w.ef, 2.5, 'ef 值应保持 2.5，实际 ' + w.ef);
  assert.strictEqual(typeof w.reps, 'number', "reps 应折算成 number，实际 " + typeof w.reps);
  assert.strictEqual(w.reps, 3, 'reps 值应保持 3，实际 ' + w.reps);
  assert.strictEqual(typeof w.interval, 'number', "interval 应折算成 number，实际 " + typeof w.interval);
  assert.strictEqual(w.interval, 6, 'interval 值应保持 6，实际 ' + w.interval);
});

check('净化：不变式 interval===0 ⟹ reps===0（治"受损数据永远当日到期"）', () => {
  reset();
  // reps>=3 且 interval===0 时，sm2 的 reps>2 分支算出的新间隔恒为 round(0*ef)=0，
  // 该词每次复习完仍是"今天到期"，反复出现在队列里 —— 这就是要兜住的状态。
  putRawStorage([{ word: 'stuck', meaning: 'm', ef: 2.5, reps: 5, interval: 0, nextReview: TODAY }]);
  const got = quietly(() => storeMod.loadWords());
  assert.strictEqual(got[0].interval, 0, 'interval 应保持 0');
  assert.strictEqual(got[0].reps, 0, 'interval 为 0 时 reps 必须归 0，实际 ' + got[0].reps);
  assert.strictEqual(sm2(got[0], GRADE.KNOW, TODAY).nextReview, TOMORROW,
    '净化后复习一次应恢复为次日到期（不再当日循环）');
});

check('净化：nextReview 非法日期串回落到今天（让该词至少能重新进队列）', () => {
  reset();
  putRawStorage([
    { word: 'a', meaning: 'm', nextReview: 'NaN-NaN-NaN' },
    { word: 'b', meaning: 'm', nextReview: '2026-02-30' },
    { word: 'c', meaning: 'm', nextReview: 20260916 },
    /**
     * 词 d 是**对照组**：一个合法的未来日期，净化**不该**碰它。
     *
     * ⚠️ 这里必须用 `addDays(TODAY, N)` 算出来，不能硬编码 '2027-01-01'
     * （2026-09-30 修：这是一枚定时炸弹，2027-01-01 一到就炸）。
     *
     * 失败机理值得记下来，因为它**不是**"今天恰好能过"那么简单：
     * 本条断言 `dueWords(got, TODAY).length === 3` 依赖"d 还没到期"。
     * 而 d 是否到期由 `d.nextReview <= TODAY`（字典序）决定 ——
     * 一旦真实时钟越过 2027-01-01，d 就从"未来"变成"已到期"，
     * due 数量从 3 变 4，这条用例**在未来某天必然失败**。
     * 也就是说：即使净化逻辑一行不改，只要时间走到 2027-01-01 之后，
     * 门禁就会自己变红 —— 报的是一个跟当时改动毫无关系的错。
     *
     * 换成相对 TODAY 计算后，"d 是未来"这件事由构造保证，与真实时钟无关。
     */
    { word: 'd', meaning: 'm', nextReview: FUTURE }
  ]);
  const got = quietly(() => storeMod.loadWords());
  const byWord = {};
  got.forEach(w => { byWord[w.word] = w.nextReview; });
  assert.strictEqual(byWord.a, TODAY, "'NaN-NaN-NaN' 应回落到今天，实际 " + byWord.a);
  assert.strictEqual(byWord.b, TODAY, "'2026-02-30' 格式对但不存在，应回落到今天，实际 " + byWord.b);
  assert.strictEqual(byWord.c, TODAY, '数字型日期应回落到今天，实际 ' + byWord.c);
  assert.strictEqual(byWord.d, FUTURE, '合法未来日期不该被改动，实际 ' + byWord.d);
  assert.strictEqual(dueWords(got, TODAY).length, 3,
    '回落成今天的 3 条应重新进队列（d 未到期不应计入）');
});

check('净化：history 非数组 → []；条目内 date / q / interval 非法各自修正', () => {
  reset();
  putRawStorage([
    { word: 'a', meaning: 'm', history: 'oops' },
    { word: 'b', meaning: 'm', history: null },
    {
      word: 'c', meaning: 'm',
      history: [
        { date: '2026-02-30', q: 'x', interval: -1 },
        null,
        { date: TODAY, q: 5, interval: 6 }
      ]
    }
  ]);
  const got = quietly(() => storeMod.loadWords());
  const byWord = {};
  got.forEach(w => { byWord[w.word] = w; });
  assert.deepStrictEqual(byWord.a.history, [], 'history 为字符串应归 []，实际 ' + JSON.stringify(byWord.a.history));
  assert.deepStrictEqual(byWord.b.history, [], 'history 为 null 应归 []，实际 ' + JSON.stringify(byWord.b.history));
  assert.strictEqual(byWord.c.history.length, 2, '非对象条目应被剔除，实际 ' + byWord.c.history.length);
  assert.strictEqual(byWord.c.history[0].date, TODAY, '非法日期应回落今天，实际 ' + byWord.c.history[0].date);
  assert.strictEqual(byWord.c.history[0].q, 0, "q='x' 应归 0，实际 " + byWord.c.history[0].q);
  assert.strictEqual(byWord.c.history[0].interval, 0, 'interval=-1 应归 0，实际 ' + byWord.c.history[0].interval);
  assert.deepStrictEqual(byWord.c.history[1], { date: TODAY, q: 5, interval: 6 },
    '合法历史条目不该被改动，实际 ' + JSON.stringify(byWord.c.history[1]));
});

check('净化：合法数据零改动（净化前后对正常词条 JSON 完全一致）', () => {
  reset();
  const clean = [
    { id: 'x1', word: 'ability', meaning: 'n. 能力', example: 'She has ability.', mnemonic: '',
      ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, createdAt: TODAY, history: [] },
    { id: 'x2', word: 'brave', meaning: 'adj. 勇敢的', example: '', mnemonic: 'b+rave',
      ef: 1.7, reps: 4, interval: 21, nextReview: '2027-01-01', createdAt: '2026-01-01',
      history: [{ date: '2026-01-01', q: 5, interval: 1 }] }
  ];
  const before = JSON.stringify(clean);
  putRawStorage(clean);
  const got = quietly(() => storeMod.loadWords());
  assert.strictEqual(JSON.stringify(got), before,
    '合法词条一个字节都不该被改动\n  期望 ' + before + '\n  实际 ' + JSON.stringify(got));
});

check('净化：只在内存修正，不回写存储（避免每次读都写盘）', () => {
  reset();
  const dirty = [{ word: 'a', meaning: 'm', ef: 'abc', reps: -1, nextReview: 'bad' }];
  putRawStorage(dirty);
  const snapshot = JSON.stringify(store['words']);
  const got = quietly(() => storeMod.loadWords());
  assert.strictEqual(got[0].ef, 2.5, '内存里应已修正');
  assert.strictEqual(JSON.stringify(store['words']), snapshot,
    'loadWords 不该顺手写盘，实际存储值被改成了 ' + JSON.stringify(store['words']));
});

check('净化：全脏库不会让下游崩溃（dueWords / selfCheck / masteredCount 都能跑通）', () => {
  reset();
  putRawStorage([
    { word: 'a', meaning: 'm', ef: 'x', reps: -5, interval: 'y', nextReview: 'NaN-NaN-NaN', history: 'z' },
    { word: 'b', meaning: 'm' },
    { nonsense: true }
  ]);
  const got = quietly(() => storeMod.loadWords());
  assert.strictEqual(got.length, 2, '应剩 2 条，实际 ' + got.length);
  let threw = null;
  const r = quietly(function () {
    try {
      const due = dueWords(got, TODAY);
      const sc = selfCheck(got);
      return { due: due.length, sc: sc };
    } catch (e) { threw = e.message; return null; }
  });
  assert.strictEqual(threw, null, '下游不该抛异常，实际 ' + threw);
  assert.strictEqual(r.due, 2, '两条都回落到今天到期，应都在队列里，实际 ' + r.due);
  assert.strictEqual(r.sc.hasData, false, '两条都没有复习记录，hasData 应为 false，实际 ' + r.sc.hasData);
  assert.strictEqual(Number.isFinite(r.sc.avgEF), true, 'avgEF 不该是 NaN，实际 ' + r.sc.avgEF);
  assert.strictEqual(r.sc.avgEF, 0, '无复习记录时 selfCheck 走早退分支，avgEF 应为 0，实际 ' + r.sc.avgEF);
  assert.strictEqual(Number.isFinite(r.sc.firstTryRate), true, 'firstTryRate 不该是 NaN，实际 ' + r.sc.firstTryRate);
  assert.strictEqual(masteredCount(got, MASTERED_INTERVAL), 0, '没有词达到掌握阈值，应返回 0');
});

check('净化：记录缺 id 时补发新 id，且互不相同', () => {
  reset();
  putRawStorage([{ word: 'a', meaning: 'm' }, { word: 'b', meaning: 'm' }]);
  const got = quietly(() => storeMod.loadWords());
  got.forEach(function (w) {
    assert.strictEqual(typeof w.id, 'string', 'id 应为字符串，实际 ' + typeof w.id);
    assert.ok(w.id.length > 0, 'id 不该为空字符串');
  });
  assert.notStrictEqual(got[0].id, got[1].id, '两条记录不该拿到同一个 id');
});

check('净化：removeWord(undefined) 不再清空词库（缺 id 曾让 filter 把整库过滤掉）', () => {
  reset();
  // removeWord 是 `filter(w => w.id !== id)`。id 为 undefined 时 `w.id !== undefined` 为 false，
  // 所有缺 id 的记录会被一起过滤掉 —— 删一条 = 清空半张词库，还返回 true 假装成功。
  putRawStorage([{ word: 'a', meaning: 'm' }, { word: 'b', meaning: 'm' }]);
  quietly(function () { storeMod.removeWord(undefined); });
  assert.strictEqual(storeMod.loadWords().length, 2, '缺 id 记录不该被连带删除');
});

check('净化：重复 id 被去重，removeWord 只删目标那一条（不再连带删掉另一条）', () => {
  reset();
  // removeWord 删**所有**同 id 记录，updateWord 只替换**第一个** —— 同一 id 下两者语义不一致。
  putRawStorage([
    { id: 'dup', word: 'a', meaning: 'm' },
    { id: 'dup', word: 'b', meaning: 'm' },
    { id: 'other', word: 'c', meaning: 'm' }
  ]);
  const got = quietly(() => storeMod.loadWords());
  const ids = got.map(function (w) { return w.id; });
  assert.strictEqual(new Set(ids).size, 3, 'id 应互不相同，实际 ' + JSON.stringify(ids));

  quietly(function () { storeMod.removeWord('dup'); });
  const left = storeMod.loadWords();
  assert.strictEqual(left.length, 2, '删 1 条应剩 2 条，实际 ' + left.length);
  assert.strictEqual(left.some(function (w) { return w.word === 'a'; }), false, '目标记录应被删掉');
  assert.strictEqual(left.some(function (w) { return w.word === 'b'; }), true, '撞 id 的另一条不该被连带删除');
});

/*======================== 三、跨模块真边界（真实 store + 真实算法） ========================*/

check('闭环：录入 → 当日进队列 → 认识 → 次日才再进队列', () => {
  reset();
  storeMod.addWord({ word: 'review', meaning: 'n. 复习' });

  const dueToday = dueWords(storeMod.loadWords(), TODAY);
  assert.strictEqual(dueToday.length, 1, '录入当日应进队列，实际 ' + dueToday.length);

  const after = sm2(dueToday[0], GRADE.KNOW, TODAY);
  assert.strictEqual(after.nextReview, TOMORROW,
    '认识一次后应次日到期，期望 ' + TOMORROW + '，实际 ' + after.nextReview);

  assert.strictEqual(dueWords([after], TODAY).length, 0, '当天不该重复出现');
  assert.strictEqual(dueWords([after], TOMORROW).length, 1, '次日应重新出现');
});

check('闭环：答错后间隔重置为 1 天，次日必须再复习（不因历史间隔长而跳过）', () => {
  const mature = { ef: 2.5, reps: 3, interval: 17, history: [] };
  const after = sm2(mature, GRADE.FORGOT, TODAY);
  assert.strictEqual(after.interval, 1, '答错后 interval 应重置为 1，实际 ' + after.interval);
  assert.strictEqual(after.reps, 0, '答错后 reps 应归零，实际 ' + after.reps);
  assert.strictEqual(after.nextReview, TOMORROW,
    '次日应到期，期望 ' + TOMORROW + '，实际 ' + after.nextReview);
});

check('统计口径切换：载入预置库时 hasData=false，复习过 1 个词后转 true', () => {
  reset();
  storeMod.seedWords(PRESET);
  const before = selfCheck(storeMod.loadWords());
  assert.strictEqual(before.hasData, false, '全未复习应 hasData=false，实际 ' + before.hasData);

  const list = storeMod.loadWords();
  const updated = sm2(list[0], GRADE.KNOW, TODAY);
  updated.history = [{ q: GRADE.KNOW, interval: updated.interval }];
  storeMod.updateWord(updated);

  const after = selfCheck(storeMod.loadWords());
  assert.strictEqual(after.hasData, true, '有复习记录后应 hasData=true，实际 ' + after.hasData);
  assert.strictEqual(after.firstTryRate, 100, '唯一复习的词首答正确，期望 100，实际 ' + after.firstTryRate);
  assert.strictEqual(after.retainedRatio, 0,
    '只复习 1 次间隔为 1 天（< ' + MASTERED_INTERVAL + '），占比应为 0，实际 ' + after.retainedRatio);
  assert.ok(after.avgEF > 0, 'avgEF 应为正数，实际 ' + after.avgEF);
});

check('schedule 一致性：history 含 null 条目时不抛错（与 intervalCurve / avgEF 同口径）', () => {
  // 这条数据实际不可达（净化层会剔除非对象的历史条目），但它守的是"一致性"：
  // 同一个文件里 intervalCurve / avgEF 都已守卫脏字段，pointsOf / selfCheck 却直接取 .q，
  // 一旦将来有人在别处放宽净化层，stats 页就会在渲染时白屏 —— 而不是少算一个数。
  assert.doesNotThrow(function () { selfCheck([{ history: [null] }]); });
  assert.strictEqual(pointsOf([{ history: [null] }]), 0);

  // ⭐ 正向对照：只测"脏数据不抛"很容易修成"一律返回 0"（那样也过上面两条），
  // 必须钉住合法路径的积分口径，否则这条断言会变成"把功能删掉就通过"。
  assert.strictEqual(pointsOf([{ history: [{ q: 5 }, { q: 3 }] }]), 4);

  // 同类脏形态一并锁住：history 缺失 / 条目是 undefined / q 不是数字
  assert.doesNotThrow(function () { selfCheck([{ history: [undefined] }]); });
  assert.strictEqual(pointsOf([{}]), 0, '无 history 字段应计 0 分');
  assert.strictEqual(pointsOf([{ history: [{ q: 'x' }, { q: null }] }]), 0,
    'q 非数字时应跳过而非按 0 分之外的方式参与计算');
  assert.strictEqual(pointsOf([{ history: [{ q: 5 }, null, { q: 3 }] }]), 4,
    'null 条目应被跳过，其余合法条目照常计分');
});

/*======================== 四、真实数据完整性 ========================*/

check('预置词库：60 条，且 word / meaning / example / mnemonic 四字段都非空', () => {
  assert.strictEqual(PRESET.length, 60, '预置库应为 60 条，实际 ' + PRESET.length);
  const bad = PRESET.filter(w => !w.word || !w.meaning || !w.example || !w.mnemonic)
    .map(w => w.word || '(无词)');
  assert.deepStrictEqual(bad, [], '这些预置词缺字段，降级兜底会空手：' + bad.join(', '));
});

check('预置词库：每个单词都符合前端 WORD_RE（否则它自己都过不了 AI 录入校验）', () => {
  const bad = PRESET.filter(w => !aiCore.WORD_RE.test(String(w.word))).map(w => w.word);
  assert.deepStrictEqual(bad, [], '不符合 WORD_RE 的预置词：' + bad.join(', '));
});

check('预置词库：无重复词（忽略大小写），PRESET_MAP 索引才不会互相覆盖', () => {
  const seen = Object.create(null);
  const dup = [];
  PRESET.forEach(w => {
    const k = String(w.word).toLowerCase();
    if (seen[k]) dup.push(w.word);
    seen[k] = true;
  });
  assert.deepStrictEqual(dup, [], '重复词：' + dup.join(', '));
});

check('课本词库：json 与注册表一一对应（结构一致，words.length 与 count 字段相符）', () => {
  // 册数的权威是注册表（curriculum-books.js），不是这里的写死数字 ——
  // 2026-09-25 注册表扩到 32 册时本断言被漏改，红了基线（20 !== 32）。
  // 改成动态取注册表 list().length 后，以后加册只需改注册表一处，这道门禁自动跟上。
  const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
  const expected = books.list().length;
  const dir = path.join(ROOT, 'data', 'curriculum');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'missing.json').sort();
  assert.strictEqual(files.length, expected,
    '课本 json 应为 ' + expected + ' 个（与注册表一致），实际 ' + files.length);
  const bad = [];
  files.forEach(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (typeof j.book !== 'string' || !j.book) bad.push(f + ' 缺 book');
    if (typeof j.grade !== 'string' || !j.grade) bad.push(f + ' 缺 grade');
    if (!Array.isArray(j.words)) bad.push(f + ' words 不是数组');
    else if (j.words.length !== j.count) bad.push(f + ' words=' + j.words.length + ' 与 count=' + j.count + ' 不符');
  });
  assert.deepStrictEqual(bad, [], '结构异常：' + bad.join('; '));
});

check('课本词库：每个词条都有非空的 word 与 meaning', () => {
  const dir = path.join(ROOT, 'data', 'curriculum');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'missing.json').sort();
  const bad = [];
  files.forEach(f => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    j.words.forEach((w, i) => {
      if (!w || !String(w.word || '').trim() || !String(w.meaning || '').trim()) {
        bad.push(f + '#' + i);
      }
    });
  });
  assert.deepStrictEqual(bad, [], '这些词条缺 word 或 meaning：' + bad.slice(0, 10).join(', '));
});

/*======================== 五、教材词库导入（wy7s_2024） ========================*/

check('教材词库：295 词 / 7 单元，单元词数与导入页展示口径一致', () => {
  assert.strictEqual(CURRICULUM.words.length, 295,
    '本册应为 295 词，实际 ' + CURRICULUM.words.length);
  assert.strictEqual(CURRICULUM.count, CURRICULUM.words.length,
    'count 字段与 words.length 不符');
  const byUnit = {};
  CURRICULUM.words.forEach(function (w) { byUnit[w.unit] = (byUnit[w.unit] || 0) + 1; });
  assert.deepStrictEqual(byUnit, {
    '7A Starter': 33, '7A Unit 1': 36, '7A Unit 2': 43, '7A Unit 3': 42,
    '7A Unit 4': 49, '7A Unit 5': 46, '7A Unit 6': 46
  }, '单元分布变了，导入页的单元列表与词数会跟着错，实际 ' + JSON.stringify(byUnit));
});

check('教材词库：18 条多词短语能原样导入（不被"最多 3 个词"的 WORD_RE 静默丢弃）', () => {
  reset();
  // 这是本功能最核心的一条：教材导入路径**必须**绕开 normalizeItems()。
  // 那条路上的 WORD_RE 上限是为挡模型把整句英文当单词返回而设的，
  // 套在教材上会让 as dead as a dodo 这类合法短语无声消失（不报错、不进 skipped）。
  const phrases = CURRICULUM.words.filter(function (w) { return /\s/.test(w.word); });
  assert.strictEqual(phrases.length, 18, '本册多词短语应为 18 条，实际 ' + phrases.length);

  const r = storeMod.addItems(phrases.map(toItem));
  assert.strictEqual(r.added, 18, '18 条短语应全部入库，实际 added=' + r.added +
    '，skipped=' + JSON.stringify(r.skipped));

  const words = storeMod.loadWords().map(function (w) { return w.word; });
  ['as dead as a dodo', 'as happy as a clam', 'junior high',
    'information technology', 'get lost', 'no wonder'].forEach(function (p) {
    assert.ok(words.indexOf(p) !== -1, '短语「' + p + '」被丢弃了');
  });
});

check('教材词库：最长 5 词短语原样入库（证明没有隐藏的 token 数量上限）', () => {
  reset();
  const r = storeMod.addItems([toItem({ word: 'as dead as a dodo', pos: '', meaning: '彻底死亡' })]);
  assert.strictEqual(r.added, 1, '应入库 1 条，实际 ' + r.added);
  const w = storeMod.loadWords()[0];
  assert.strictEqual(w.word, 'as dead as a dodo', 'word 被截断了：' + JSON.stringify(w.word));
  assert.strictEqual(w.meaning, '彻底死亡', 'meaning 实际 ' + JSON.stringify(w.meaning));
});

check('教材词库：全册 295 条一次性导入，只丢 1 条（race 同形重复），无格式性丢弃', () => {
  reset();
  const r = storeMod.addItems(CURRICULUM.words.map(toItem));
  assert.strictEqual(r.added + r.skipped.length, 295,
    'added + skipped 应等于 295，实际 ' + (r.added + r.skipped.length));
  assert.strictEqual(r.skipped.length, 1,
    '只应有 race 这一条被跳过（同形重复），实际 ' + JSON.stringify(r.skipped));
  assert.deepStrictEqual(r.skipped, ['race'], '被跳过的应是 race，实际 ' + JSON.stringify(r.skipped));
  assert.strictEqual(r.added, 294, '实际入库应为 294，实际 ' + r.added);
  assert.strictEqual(storeMod.loadWords().length, 294, '落库条数不符');
});

check('教材词库：race 同形两条按 word 查重合并 → Unit 3 实际入库 41 / 跳过 1', () => {
  reset();
  const unit3 = CURRICULUM.words.filter(function (w) { return w.unit === '7A Unit 3'; });
  assert.strictEqual(unit3.length, 42, 'Unit 3 应为 42 条，实际 ' + unit3.length);
  const r = storeMod.addItems(unit3.map(toItem));
  assert.strictEqual(r.added, 41, '实际入库应为 41，实际 ' + r.added);
  assert.strictEqual(r.dupSkipped, 1, 'dupSkipped 应为 1，实际 ' + r.dupSkipped);
  assert.strictEqual(r.skipped.length, r.dupSkipped,
    '这条是重复而非格式非法，dupSkipped 应等于 skipped.length');
});

check('教材词库：释义带词性前缀（pos 非空时），无 pos 的短语不加前缀也不出 undefined', () => {
  const byWord = {};
  CURRICULUM.words.map(toItem).forEach(function (i) { byWord[i.word] = i.meaning; });
  assert.strictEqual(byWord['textbook'], 'n. 教科书, 教材, 课本',
    '实际 ' + JSON.stringify(byWord['textbook']));
  assert.strictEqual(byWord['ready'], 'adj. 准备好(做某事的)',
    '实际 ' + JSON.stringify(byWord['ready']));
  assert.strictEqual(byWord['junior high'], '初级中学',
    '无 pos 时不该加前缀或多余空格，实际 ' + JSON.stringify(byWord['junior high']));
  const bad = Object.keys(byWord).filter(function (k) {
    return /undefined|null|^\s|\s$/.test(byWord[k]);
  });
  assert.deepStrictEqual(bad, [], '这些释义拼坏了：' + bad.slice(0, 10).join(', '));
});

/*======================== 六、单元归属往返（种子/导入 → 落库 → 投影） ========================
 *
 * ## 为什么必须单独加这一节（2026-09-18 事故）
 * 「按单元学习」在真引擎里**完全失效**：295 个词全部显示为「未分组」，一个单元都筛不出来。
 * 根因是同一个模式出现了两次 —— makeItem() 支持 extra.unit，但两个调用方都漏传：
 *   · seedWords()  —— 首页 295 词的来源
 *   · addItems()   —— AI 录入 / 教材导入的路径（最严重：页面层 curriculum.js 的 toItem()
 *                    明明带上了 unit，传到 store.addItems() 被吃掉，页面的修复被静默抵消）
 *
 * ## 为什么原有 13 道门禁全绿却没发现
 * 现有断言用的都是**人造卡片**（直接构造带 unit 的对象喂给 pickCards / unitsOf），
 * 从来没有覆盖「种子 / 导入 → 落库 → 投影成卡片」这条真实往返链路。
 * 字段在 store 层被静默丢弃，只有真引擎端到端才暴露。
 * 这一节把该链路钉在 Node 层：只要 store 再丢一次 unit，这里立刻红。
 *
 * ## 为什么"不触碰 SM-2 状态"是最关键的一条
 * backfillUnits() 会遍历全表并写盘。如果它顺手把 sanitize() 的内存修正一起落盘，
 * 学生的 ef / reps / interval / nextReview / history 就会被静默改写 ——
 * 那比"没分组"严重得多：分组错了用户看得见，进度被改了用户看不见。
 */

/** 落一条"旧版存量词"（没有 unit，且 SM-2 字段齐全）—— 模拟 backfillUnits 要处理的真实形状 */
function legacyItem(id, word, meaning, overrides) {
  const base = {
    id: id, word: word, meaning: meaning,
    ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, createdAt: TODAY, history: []
  };
  return Object.assign(base, overrides || {});
}

function indexBy(list, key) {
  const out = {};
  list.forEach(function (x) { out[x[key]] = x; });
  return out;
}

check('seedWords 往返：种子词的 unit 落库后仍在（首页 295 词的路径）', () => {
  reset();
  const n = storeMod.seedWords([
    { id: 'seed-a', word: 'apple', meaning: 'n. 苹果', unit: '7A Unit 1' },
    { id: 'seed-b', word: 'banana', meaning: 'n. 香蕉', unit: '7A Starter' }
  ]);
  assert.strictEqual(n, 2, '应载入 2 条，实际 ' + n);

  const byWord = indexBy(storeMod.loadWords(), 'word');
  assert.strictEqual(byWord['apple'].unit, '7A Unit 1',
    'seedWords 把 unit 吃掉了（首页 295 词会全落进「未分组」），实际 ' + JSON.stringify(byWord['apple'].unit));
  assert.strictEqual(byWord['banana'].unit, '7A Starter',
    'seedWords 把 unit 吃掉了，实际 ' + JSON.stringify(byWord['banana'].unit));

  // 页面读的是 loadCards() 而不是 loadWords()，投影层也要一并钉住
  const byPrompt = indexBy(storeMod.loadCards(), 'prompt');
  assert.strictEqual(byPrompt['apple'].unit, '7A Unit 1',
    '卡片投影丢了 unit，「按单元学习」筛不出来，实际 ' + JSON.stringify(byPrompt['apple'].unit));
});

check('addItems 往返：带 unit 的词条落库后仍在（教材导入 / AI 录入的路径）', () => {
  reset();
  // 这条与 curriculum.js 的 toItem() 是同一形状：页面层已经带上了 unit，
  // 只要 store.addItems 漏传，页面层的修复就被存储层静默抵消。
  const r = storeMod.addItems([
    { id: 'imp-a', word: 'geography', meaning: 'n. 地理', unit: '7A Unit 1' },
    { id: 'imp-b', word: 'textbook', meaning: 'n. 教科书', unit: '7A Unit 2' }
  ]);
  assert.strictEqual(r.added, 2, '应写入 2 条，实际 ' + r.added);

  const byWord = indexBy(storeMod.loadWords(), 'word');
  assert.strictEqual(byWord['geography'].unit, '7A Unit 1',
    'addItems 把 unit 吃掉了（导入完仍是「未分组」），实际 ' + JSON.stringify(byWord['geography'].unit));
  assert.strictEqual(byWord['textbook'].unit, '7A Unit 2',
    'addItems 把 unit 吃掉了，实际 ' + JSON.stringify(byWord['textbook'].unit));

  const byPrompt = indexBy(storeMod.loadCards(), 'prompt');
  assert.strictEqual(byPrompt['geography'].unit, '7A Unit 1',
    '卡片投影丢了 unit，实际 ' + JSON.stringify(byPrompt['geography'].unit));
});

check('无 unit 的词条落库后不该出现 unit:""（保持"字段不存在"这一种空态）', () => {
  // 为什么较真：curriculum.js 的注释约定"旧版 19 册没有 unit 就不写空串"。
  // 一旦某条路径塞了 ''，"有没有单元"就出现两种空态，下游得同时防 undefined 和 ''。
  const hasOwn = Object.prototype.hasOwnProperty;

  reset();
  storeMod.addItems([{ word: 'dog', meaning: 'n. 狗' }]);
  const viaImport = storeMod.loadWords()[0];
  assert.strictEqual(hasOwn.call(viaImport, 'unit'), false,
    'addItems 给没有 unit 的词塞了空串，实际 ' + JSON.stringify(viaImport.unit));

  reset();
  storeMod.seedWords([{ id: 'seed-e', word: 'egg', meaning: 'n. 蛋' }]);
  const viaSeed = storeMod.loadWords()[0];
  assert.strictEqual(hasOwn.call(viaSeed, 'unit'), false,
    'seedWords 给没有 unit 的词塞了空串，实际 ' + JSON.stringify(viaSeed.unit));

  // 但投影成卡片时必须兜底成 ''，页面才能用 `c.unit || 未分组` 得到唯一空态
  reset();
  storeMod.addItems([{ word: 'dog', meaning: 'n. 狗' }]);
  assert.strictEqual(storeMod.loadCards()[0].unit, '',
    '卡片投影应把缺失的 unit 兜成空串，实际 ' + JSON.stringify(storeMod.loadCards()[0].unit));
});

check('unitsOf：按 unit 正确分组计数，没有 unit 的词归到「未分组」', () => {
  reset();
  storeMod.seedWords([
    { id: 'u1-a', word: 'apple', meaning: 'n. 苹果', unit: '7A Unit 1' },
    { id: 'u1-b', word: 'banana', meaning: 'n. 香蕉', unit: '7A Unit 1' },
    { id: 'u2-a', word: 'cat', meaning: 'n. 猫', unit: '7A Unit 2' },
    { id: 'no-u', word: 'dog', meaning: 'n. 狗' }
  ]);
  const cards = storeMod.loadCards();
  const units = unitsOf(cards, {});
  const byName = indexBy(units, 'unit');

  assert.strictEqual(byName['7A Unit 1'].count, 2,
    'Unit 1 应有 2 条，实际 ' + JSON.stringify(byName['7A Unit 1']));
  assert.strictEqual(byName['7A Unit 2'].count, 1,
    'Unit 2 应有 1 条，实际 ' + JSON.stringify(byName['7A Unit 2']));
  assert.ok(byName[UNGROUPED_UNIT], '没有 unit 的词应归到「' + UNGROUPED_UNIT + '」，实际 ' +
    JSON.stringify(units.map(function (u) { return u.unit; })));
  assert.strictEqual(byName[UNGROUPED_UNIT].count, 1,
    '「未分组」应有 1 条，实际 ' + JSON.stringify(byName[UNGROUPED_UNIT]));

  // 计数之和 = 卡片总数：否则筛选器与顶部"共 N 词"自相矛盾，学生按单元筛会漏词
  const sum = units.reduce(function (a, u) { return a + u.count; }, 0);
  assert.strictEqual(sum, cards.length, '各单元计数之和应等于卡片总数，实际 ' + sum + ' != ' + cards.length);
});

check('unitsOf：排序是数字序不是字典序（Unit 10 必须排在 Unit 2 之后）', () => {
  reset();
  // 真课本的单元数会到 10+，这个坑一定会踩到：字典序下 "Unit 10" < "Unit 2"。
  storeMod.seedWords([
    { id: 'n10', word: 'apple', meaning: 'n. 苹果', unit: 'Unit 10' },
    { id: 'n2', word: 'banana', meaning: 'n. 香蕉', unit: 'Unit 2' },
    { id: 'n1', word: 'cat', meaning: 'n. 猫', unit: 'Unit 1' },
    { id: 'st', word: 'dog', meaning: 'n. 狗', unit: 'Starter' },
    { id: 'ng', word: 'egg', meaning: 'n. 蛋' }
  ]);
  const names = unitsOf(storeMod.loadCards(), {}).map(function (u) { return u.unit; });

  assert.strictEqual(names[0], 'Starter', 'Starter 应排最前，实际 ' + JSON.stringify(names));
  assert.ok(names.indexOf('Unit 1') < names.indexOf('Unit 2'),
    'Unit 1 应排在 Unit 2 之前，实际 ' + JSON.stringify(names));
  assert.ok(names.indexOf('Unit 10') > names.indexOf('Unit 2'),
    'Unit 10 应排在 Unit 2 之后（字典序会反过来），实际 ' + JSON.stringify(names));
  assert.strictEqual(names[names.length - 1], UNGROUPED_UNIT,
    '抽不出数字的单元（未分组）应排最后，实际 ' + JSON.stringify(names));

  // ⭐ 正向对照：字典序确实会把 10 排在 2 前面，证明上面那条不是在测空气。
  assert.ok('Unit 10' < 'Unit 2',
    '（对照）字典序下 Unit 10 本应排在 Unit 2 前面，若此断言失败说明用例前提变了');
});

/* ⚠️ 已知缺口（只记录，本轮不修）—— 上面那条用的是不带年级前缀的 "Unit N"。
 *
 * 本 App 的真实单元名是 "7A Unit N"，而 schedule.js 的 unitRank() 取的是
 * `String(name).match(/(\d+)/)` 的**第一个**数字：对 "7A Unit 10" 会先命中年级里的 "7"，
 * rank 退化成 7，与 "7A Unit 2" 的 rank 相等，再走 `a.unit < b.unit` 字典序兜底 ——
 * 于是 "7A Unit 10" 排在 "7A Unit 2" **前面**，与 unitRank 上方那段
 * "不能用字典序 —— 那会把 Unit 10 排在 Unit 2 前面" 的注释自相矛盾。
 *
 * 实测（本机，2026-09-18）：
 *   unitsOf([...unit:'7A Unit 10','7A Unit 2','7A Unit 1','7A Starter'...])
 *   → ["7A Starter","7A Unit 1","7A Unit 10","7A Unit 2","未分组"]
 *
 * 为什么线上没暴露：当前教材 wy7s_2024 只到 "7A Unit 6"，Unit 1~6 的 rank 恰好单调。
 * 一旦出现 Unit 10（下学期的册很容易到），学生看到的单元列表顺序就会错。
 * 修法是把 unitRank 改成取**最后一个**数字（如 /(\d+)(?!.*\d)/），属于 miniprogram/ 业务代码改动。
 * 本轮任务的红线是"不改 miniprogram/ 且门禁全绿"，因此这里不写红灯断言，把决定权留给作者。
 */
check('unitsOf：真实单元名 "7A Unit 1~6" 在当前数据范围内仍按数字序排', () => {
  reset();
  storeMod.seedWords([
    { id: 'r1', word: 'apple', meaning: 'n. 苹果', unit: '7A Unit 1' },
    { id: 'r2', word: 'banana', meaning: 'n. 香蕉', unit: '7A Unit 2' },
    { id: 'r6', word: 'cat', meaning: 'n. 猫', unit: '7A Unit 6' },
    { id: 'rs', word: 'dog', meaning: 'n. 狗', unit: '7A Starter' }
  ]);
  const names = unitsOf(storeMod.loadCards(), {}).map(function (u) { return u.unit; });
  assert.deepStrictEqual(names, ['7A Starter', '7A Unit 1', '7A Unit 2', '7A Unit 6'],
    '当前教材的单元顺序变了，实际 ' + JSON.stringify(names));
});

check('backfillUnits：id 匹配路径补上 unit，且已有 unit 的词条不被覆盖', () => {
  reset();
  putRawStorage([
    legacyItem('en-001', 'junior high', '初级中学'),
    // 已有 unit 的词条：用户/新版本已经分过组，种子值不能盖掉它
    legacyItem('en-002', 'geography', 'n. 地理', { unit: '7A Unit 9' })
  ]);

  const r = storeMod.backfillUnits([
    { id: 'en-001', word: 'junior high', meaning: '初级中学', unit: '7A Starter' },
    { id: 'en-002', word: 'geography', meaning: 'n. 地理', unit: '7A Unit 1' }
  ]);
  assert.strictEqual(r.backfilled, 1, '只应补 1 条（另一条已有 unit），实际 ' + JSON.stringify(r));

  const byId = indexBy(storeMod.loadWords(), 'id');
  assert.strictEqual(byId['en-001'].unit, '7A Starter',
    '按 id 匹配应补上 unit，实际 ' + JSON.stringify(byId['en-001'].unit));
  assert.strictEqual(byId['en-002'].unit, '7A Unit 9',
    '已有 unit 不该被种子值覆盖，实际 ' + JSON.stringify(byId['en-002'].unit));
});

check('backfillUnits：id 对不上时按 word 小写兜底（教材导入页随机 id 的存量词）', () => {
  reset();
  // 学生此前从教材导入页导入过同一批词，id 是 genId() 随机生成的 —— 内容一样但 id 对不上。
  putRawStorage([legacyItem('m3k9x2a1q', 'Geography', 'n. 地理')]);

  const r = storeMod.backfillUnits([
    { id: 'en-999', word: 'geography', meaning: 'n. 地理', unit: '7A Unit 1' }
  ]);
  assert.strictEqual(r.backfilled, 1, '应按 word 兜底补 1 条，实际 ' + JSON.stringify(r));
  assert.strictEqual(store['words'][0].unit, '7A Unit 1',
    'word 小写兜底路径失效（大小写不同的存量词补不上），实际 ' + JSON.stringify(store['words'][0].unit));
});

check('backfillUnits：幂等 —— 第二次调用不改动任何数据（backfilled===0）', () => {
  reset();
  putRawStorage([legacyItem('en-001', 'junior high', '初级中学')]);
  const seed = [{ id: 'en-001', word: 'junior high', meaning: '初级中学', unit: '7A Starter' }];

  const first = storeMod.backfillUnits(seed);
  assert.strictEqual(first.backfilled, 1, '首次应补 1 条，实际 ' + JSON.stringify(first));

  const snapshot = JSON.stringify(store['words']);
  const second = storeMod.backfillUnits(seed);
  assert.strictEqual(second.backfilled, 0, '第二次不该再补，实际 ' + JSON.stringify(second));
  assert.strictEqual(second.reason, 'already_done', '第二次的 reason 应为 already_done，实际 ' + second.reason);
  assert.strictEqual(JSON.stringify(store['words']), snapshot,
    '第二次调用改动了存储，实际 ' + JSON.stringify(store['words']));
});

check('backfillUnits：绝不触碰 SM-2 状态（回填不能顺手把 sanitize 的修正落盘）', () => {
  reset();
  // 造一条"学了一半"的记录：EF / reps / interval / nextReview / history 全是非默认值。
  // 回填若改动了它们，学生的进度就被静默重置 —— 比"没分组"严重得多（用户看不见）。
  const studyState = {
    ef: 2.1, reps: 4, interval: 17, nextReview: '2026-10-01',
    history: [{ date: '2026-09-01', q: 5, interval: 17 }, { date: '2026-09-10', q: 3, interval: 17 }]
  };
  putRawStorage([
    legacyItem('en-001', 'junior high', '初级中学', studyState),
    // 第二条是 sanitize() 会修正的脏记录（ef 是字符串）。
    // 专门放它，是因为 backfillUnits 的注释声明它"直接读原始存储、不走 loadWords()"，
    // 就是为了不把内存里的修正一并写盘 —— 这条断言把那个设计决定钉住。
    legacyItem('en-002', 'geography', 'n. 地理', { ef: '2.1', reps: 3, interval: 6 })
  ]);

  const r = storeMod.backfillUnits([
    { id: 'en-001', word: 'junior high', meaning: '初级中学', unit: '7A Starter' },
    { id: 'en-002', word: 'geography', meaning: 'n. 地理', unit: '7A Unit 1' }
  ]);
  assert.strictEqual(r.backfilled, 2, '两条都应被补上，实际 ' + JSON.stringify(r));

  const raw = store['words'];
  // 整体比对：回填后记录只应有 unit 一处变化，多出/少掉任何键都算越界
  assert.deepStrictEqual(raw[0], {
    id: 'en-001', word: 'junior high', meaning: '初级中学',
    ef: 2.1, reps: 4, interval: 17, nextReview: '2026-10-01', createdAt: TODAY,
    history: [{ date: '2026-09-01', q: 5, interval: 17 }, { date: '2026-09-10', q: 3, interval: 17 }],
    unit: '7A Starter'
  }, '回填改动了 SM-2 状态或其它字段，实际 ' + JSON.stringify(raw[0]));

  assert.strictEqual(raw[1].unit, '7A Unit 1', 'unit 应被补上，实际 ' + JSON.stringify(raw[1].unit));
  assert.strictEqual(typeof raw[1].ef, 'string',
    'sanitize 的修正被回填顺手落盘了（ef 应仍是字符串 "2.1"），实际 ' + JSON.stringify(raw[1].ef));
  assert.strictEqual(raw[1].ef, '2.1', 'ef 被改写成 ' + JSON.stringify(raw[1].ef));
});

/*======================== 七、拼写判分与错误归类（utils/spelling.js） ========================
 * 2026-09-24 补（DEV-P0-3）：本模块 09-19 落地、09-21 修过 alignNodes 渲染错位
 * （P1 项），但此后**零门禁覆盖** —— 修复无守护、可静默回归。本组用 Node 直测
 * 纯函数：判分四态（对/漏/多/错/顺序）+ 高亮节点对齐（回归 09-21 修复）+ 聚合分析。
 *========================================================================================*/
console.log('\n-- 七、拼写判分（spelling.js）--');

const spellingMod = require(path.join(ROOT, 'utils', 'spelling.js'));

check('judge：拼对 → ok、全字符标 ok', () => {
  const r = spellingMod.judge('apple', 'apple');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errType, '');
  assert.ok(r.nodes.length === 5 && r.nodes.every(n => n.state === 'ok'), '节点状态：' + JSON.stringify(r.nodes));
});

check('judge：大小写与首尾空格归一（Apple == apple）', () => {
  assert.strictEqual(spellingMod.judge('  Apple ', 'apple').ok, true);
});

check('judge：空输入 → 漏写全标 missing、提示可执行', () => {
  const r = spellingMod.judge('', 'apple');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errType, '没有输入');
  assert.ok(r.nodes.every(n => n.state === 'missing'), '空输入应全标 missing：' + JSON.stringify(r.nodes));
  assert.ok(r.hint.length > 0, '提示不该为空');
});

check('judge：字母顺序错（anagram）归类为「字母顺序错了」', () => {
  const r = spellingMod.judge('aplep', 'apple');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errType, '字母顺序错了', '实际 ' + r.errType);
});

check('judge：漏了字母（appl）→ 漏写位置标 missing', () => {
  // 前缀 appl 全对、目标侧还剩 e —— tMid 为空才是「漏」；
  // 若写错在词中（如 appr vs apple：中段 r 对 le），归类是「写错了字母」而非「漏」。
  const r = spellingMod.judge('appl', 'apple');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errType, '漏了字母', '实际 ' + r.errType);
});

check('judge：多了字母（applep）→ 「多了字母」', () => {
  const r = spellingMod.judge('applep', 'apple');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errType, '多了字母', '实际 ' + r.errType);
});

check('judge：写错字母（appla）→ 「写错了字母」', () => {
  const r = spellingMod.judge('appla', 'apple');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errType, '写错了字母', '实际 ' + r.errType);
});

check('alignNodes 回归（09-21 修复）：apple→appla 渲染节点序列正确', () => {
  // P1 修复的原始缺陷：中段下标漏 pre 偏移，apple 渲染成「appl(a重复)」等错词。
  // 目标词 apple，typed appla：前缀 app 共 3 位 ok；中段 l/l ok、e/a 错；
  // 完整节点应为 a p p l e 且仅第 5 位 wrong。
  const r = spellingMod.judge('appla', 'apple');
  const chars = r.nodes.map(n => n.ch).join('');
  assert.strictEqual(chars, 'apple', '渲染出来的应是目标词本身，实际 ' + chars);
  const states = r.nodes.map(n => n.state).join(',');
  assert.strictEqual(states, 'ok,ok,ok,ok,wrong', '仅末位应标 wrong，实际 ' + states);
});

check('alignNodes 回归（09-21 修复）：teacher→teachtr 中段不重复前缀', () => {
  const r = spellingMod.judge('teachtr', 'teacher');
  const chars = r.nodes.map(n => n.ch).join('');
  assert.strictEqual(chars, 'teacher', '渲染应是 teacher，实际 ' + chars);
  const wrongs = r.nodes.filter(n => n.state === 'wrong').map(n => n.ch);
  assert.ok(wrongs.length === 1 && wrongs[0] === 'e', '写错位应标在目标词的 e 上，实际 ' + JSON.stringify(wrongs));
});

check('alignNodes 回归：beautiful→beabtiful 中段错位不串行', () => {
  const r = spellingMod.judge('beabtiful', 'beautiful');
  assert.strictEqual(r.nodes.map(n => n.ch).join(''), 'beautiful');
  assert.strictEqual(r.nodes.filter(n => n.state === 'wrong').length, 1, '应恰好 1 个 wrong');
});

check('judge：连字符与撇号保留（ice-cream 判对）', () => {
  assert.strictEqual(spellingMod.judge('ice-cream', 'ice-cream').ok, true);
  assert.strictEqual(spellingMod.judge('icecream', 'ice-cream').ok, false, '连字符是拼写的一部分，不该归一掉');
});

check('analyze：拼写历史聚合（attempts/rate/errTypes/worst）', () => {
  const records = {
    w1: [{ ok: true, typed: 'apple' }, { ok: false, typed: 'appla', errType: '写错了字母' }],
    w2: [{ ok: false, typed: 'teachtr', errType: '写错了字母' }],
    w3: [{ ok: true, typed: 'geography' }]
  };
  const a = spellingMod.analyze(records, { w1: 'apple', w2: 'teacher', w3: 'geography' });
  assert.strictEqual(a.attempts, 4);
  assert.strictEqual(a.ok, 2);
  assert.strictEqual(a.rate, 50);
  assert.strictEqual(a.hasData, true);
  assert.strictEqual(a.errTypes[0].type, '写错了字母');
  assert.strictEqual(a.errTypes[0].count, 2);
  assert.strictEqual(a.worst[0].word, 'apple', 'fail 数并列时序稳定');
  assert.strictEqual(a.worst.length, 2, '只有失败过的词进 worst');
});

check('analyze：空记录/词条已删的容错', () => {
  const a1 = spellingMod.analyze({}, {});
  assert.strictEqual(a1.hasData, false);
  assert.strictEqual(a1.rate, 0);
  const a2 = spellingMod.analyze({ x: [{ ok: false, typed: 'zz', errType: '漏了字母' }] }, {});
  assert.strictEqual(a2.worst[0].word, '（词条已删除）', '词条已删应给出占位而非 undefined');
});

/**
 * 时钟漂移回归（2026-09-30 加，守住上面那枚修掉的定时炸弹）。
 *
 * ## 它守什么
 *
 * 本文件曾有一条用例靠「硬编码的 future 日期恰好还没到期」而通过：
 * 真实时钟下 84 项全绿，把时钟冻结到 2027-03-15 立刻炸 `4 !== 3`。
 * 也就是说它**不是**当时就错，而是**在未来某天会自己变红**，
 * 报的还是一个跟当时改动毫无关系的错 —— 这类"假绿"最难在评审里被发现。
 *
 * ## 为什么直接测「不变量」而不是重跑整个文件（两次走错路的记录）
 *
 * 最初想「把时钟冻住重跑本文件、比对三次输出是否一致」。两次都不成立：
 *   ① 子进程方案：本机**任何 spawn 都 EBUSY**（连 `echo` 都起不来），
 *      用 `tools/lib/spawn-retry.js` 重试 4 次仍全败 —— 环境限制，不是代码问题。
 *   ② vm 方案：`vm.runInNewContext` 里`require` 仍解析到宿主 require，
 *      被测的 store.js 在**宿主上下文**执行、看不见沙箱里的 `wx`，
 *      副本 57 条用例因 `wx is not defined` 失败 ——
 *      而「三次输出一致」照样成立（**一致地坏也算一致**），门禁报 PASS。
 *      换 `runInThisContext` 又要处理递归防 guard，很容易再次变成静默死代码
 *      （实际就发生过一次：门禁少了一条守护却仍全绿）。
 *
 * 教训：**「多次运行结果一致」不能证明「跑对了」**。
 * 所以改成直接断言那条**真正的不变量**，短、无递归、无子进程：
 *   「非法 nextReview 一定回落到『当天』，且这 3 条当天一定进 due 队列，
 *     而合法的未来日期不��、也不进队列」
 * —— 而「当天」由**注入的 now** 决定，与真实时钟无关。
 *
 * ## 为什么这样就够
 *
 * 定时炸弹的本质是「造出来的『未来』会变成『过去』」。
 * 本用例造数据时用的是 `addDays(注入的今天, 30)`，所以上面那条不变量
 * 在任意 now 下都必须成立 —— 它就是那颗雷的排雷器。
 * 而上面那条 sanitize 用例也正因为改用了相对量，才不再随日历变红。
 *
 * @returns {void}
 */
function clockDriftRegression() {
  const RealDate = Date;
  const MODULES = ['utils/store.js', 'utils/date.js', 'utils/schedule.js'];

  /**
   * 在注入的"今天"下重建被测模块，跑一遍关键不变量。
   *
   * 必须清require 缓存：store.js / date.js 在**模块顶层**就算出了 `todayStr()`，
   * 不重新求值的话拿到的仍是真实时钟下那一份，冻结就等于没冻。
   *
   * @param {string} dateStr 注入的"今天"（YYYY-MM-DD）
   * @returns {{today: string, fellBackTo: string, legalKept: string, future: string, dueCount: number}} 观测结果
   */
  function probeAt(dateStr) {
    const FAKE = new RealDate(dateStr + 'T12:00:00').getTime();
    function FakeDate() {
      const args = Array.prototype.slice.call(arguments);
      if (!args.length) return new RealDate(FAKE);
      return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return FAKE; };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;

    const realDate = global.Date;
    const realWx = global.wx;
    const mem = {};
    global.Date = FakeDate;
    global.wx = {
      getStorageSync: function (k) { return k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''; },
      setStorageSync: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
      removeStorageSync: function (k) { delete mem[k]; }
    };

    /** 清缓存后按需重新 require（冻结/恢复各调一次） */
    function reload() {
      MODULES.forEach(function (m) { delete require.cache[require.resolve(path.join(ROOT, m))]; });
      return {
        st: require(path.join(ROOT, 'utils', 'store.js')),
        dt: require(path.join(ROOT, 'utils', 'date.js')),
        sch: require(path.join(ROOT, 'utils', 'schedule.js'))
      };
    }

    try {
      const mod = reload();
      const today = mod.dt.todayStr();
      const future = mod.dt.addDays(today, 30);
      mem['words'] = [
        { word: 'a', meaning: 'm', nextReview: 'NaN-NaN-NaN' },
        { word: 'b', meaning: 'm', nextReview: '2026-02-30' },
        { word: 'c', meaning: 'm', nextReview: 20260916 },
        { word: 'd', meaning: 'm', nextReview: future }
      ];
      const got = mod.st.loadWords();
      return {
        today: today,
        future: future,
        fellBackTo: got[0].nextReview,
        legalKept: got[3].nextReview,
        dueCount: mod.sch.dueWords(got, today).length
      };
    } finally {
      global.Date = realDate;
      global.wx = realWx;
      reload();   // 恢复真实时钟下的模块，避免污染本文件其余用例
    }
  }

  const DATES = ['2027-03-15', '2026-01-01', '2027-12-31'];
  try {
    DATES.forEach(function (d) {
      const r = probeAt(d);
      assert.strictEqual(r.fellBackTo, r.today,
        '注入 now=' + d + '：非法 nextReview 应回落到该' + d + '，实际 ' + r.fellBackTo);
      assert.strictEqual(r.legalKept, r.future,
        '注入 now=' + d + '：合法未来日期不该被改动，实际 ' + r.legalKept);
      assert.strictEqual(r.dueCount, 3,
        '注入 now=' + d + '：回落到当天的 3 条应进队列（合法未来那条不该进），实际 ' + r.dueCount);
    });
    pass++;
    console.log('PASS  时钟漂移回归：注入 ' + DATES.join(' / ') +
      ' 均为「非法回落到当天 + 3 条到期」');
  } catch (e) {
    fail++;
    problems.push('时钟漂移回归：' + (e && e.message ? e.message : e));
    console.log('FAIL  时钟漂移回归：' + (e && e.message ? e.message : e));
  }
}

clockDriftRegression();

/*======================== 汇总 ========================*/
console.log('\n>>> ' + pass + ' 通过 / ' + fail + ' 失败');
if (problems.length) {
  console.log('\n需修复：');
  problems.forEach(p => console.log('  - ' + p));
}
process.exit(fail > 0 ? 1 : 0);
