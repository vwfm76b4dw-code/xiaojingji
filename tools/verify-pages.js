/**
 * 页面层自动化验证 —— 用 Node 直接驱动 5 个页面的 JS，不需要开发者工具。
 *
 * 为什么需要这一层：tools/verify-*.js 覆盖了 utils/ 与云函数，但 5 个 pages/*.js
 * 一直是零自动化覆盖，只能靠《开发指引》§6.2 的十步人工冒烟。任何一个 setData
 * 字段改名、守卫写反、Toast 文案改错，其余门禁都会全绿，评审现场才炸。
 *
 * 做法：注入小程序运行时替身（Page / Component / getApp / wx / 内存 KV / 可控定时器），
 * 直接 require 页面文件拿到 Page 配置，构造实例后调用其生命周期与事件方法。
 *
 * 运行：node tools/verify-pages.js
 *       node tools/verify-pages.js --allow-pending
 *         ↑ 仅"待修验收项"失败时也返回 0（供缺陷修复期间跑门禁；
 *           修复完成后应去掉该参数跑，退出码必须为 0）
 *
 * 分组说明：
 *   【已通过】   当前源码应当通过，属回归保护
 *   【待修转绿】 工程师正在修复的缺陷所对应的验收标准。修复前 FAIL 是预期的、
 *               有价值的；修复后应全部转 PASS，即为验收通过。
 *               带 --allow-pending 时**只有失败项全部落在 KNOWN_PENDING 白名单里**
 *               才放行（清单外一律 exit 1），并打印醒目警告说明"本次放行了 N 项未校验"。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const ALLOW_PENDING = process.argv.indexOf('--allow-pending') !== -1;

/**
 * 已知待修验收项白名单 —— 与下方 pendingFix 断言的名称必须逐字一致。
 *
 * 为什么需要它：--allow-pending 会把"待修项失败"的退出码放行。若只靠
 * `hardFail.length === 0` 判断，任何人新增一条 pendingFix 断言就能悄悄绕过门禁
 * （把真缺陷标成"待修"即可）。加上白名单后，清单外的失败一律 exit 1。
 *
 * ⚠️ 维护约定（这条比白名单本身更重要）：
 *   **验收项一旦转绿，必须同时做两件事** ——
 *     ① 摘掉它的 `pendingFix` 标记（第三参数），改为普通 check；
 *     ② 从本白名单里删掉它的名字。
 *   只做①不做②，或只做②不做①，都会留下同一个洞：
 *   已修项的**回归**会被 --allow-pending 静默放行 —— 那正是本开关要防的事，
 *   只是入口从"新增 pendingFix"换成了"已修项回归"。
 *   本白名单**只应包含当前仍未修复的项**。转绿后若这里非空，说明有人漏了清理。
 *
 * 当前状态：**空数组** —— 全部验收标准（D1/D2/D3/H2/H4/H5/A1）均已修复转绿，
 * 因此 --allow-pending 已无任何可放行的项，实质失效。新增待修项时才会重新非空。
 */
const KNOWN_PENDING = [];

/*==================================================================
 * 一、小程序运行时替身
 *==================================================================*/

/* ---- 1.1 内存 KV 存储（与 tools/verify-integration.js 同一套风格） ---- */
let memory = {};
let failNextSet = false;   // 一次性开关：让下一次 setStorageSync 抛错
let setCalls = 0;          // 成功的 setStorageSync 次数（用于断言"零写入"）

/* ---- 1.2 调用记录（供断言 Toast / 跳转文案） ---- */
const calls = { toast: [], modal: [], navigateTo: [], switchTab: [] };
let modalDecision = 'confirm';   // 'confirm' | 'cancel'

/* ---- 1.3 可控定时器：只入队，由 flushTimers() 手动推进 ---- */
let timerQueue = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn) { timerQueue.push(fn); return timerQueue.length; };

/* ---- 1.3b 静音预期内的降级日志 ----
 * 本脚本会**故意**触发存储写失败、云函数抛异常等降级路径，
 * store.js / ai.js 会打 console.error / console.warn。那是被测代码的正确行为，
 * 不是测试失败，但会把 PASS/FAIL 列表淹掉。这里临时静音，跑完恢复。 */
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
console.error = function () {};
console.warn = function () {};
function restoreConsole() {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
}

function flushTimers(rounds) {
  let n = 0;
  const max = rounds || 10;
  while (timerQueue.length > 0 && n < max) {
    const batch = timerQueue;
    timerQueue = [];
    batch.forEach(function (f) { f(); });
    n++;
  }
}

/** 等一轮微任务，让 .then() 链跑完（AI 路径是异步的） */
function tick() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

/* ---- 1.4 wx 替身 ---- */
global.wx = {
  // 注意：真实 wx.getStorageSync 每次返回反序列化后的**副本**，这里必须照做。
  // 若返回引用，store.js 里的 list.push 会就地改到"存储"，
  // 从而掩盖"保存失败但内存里已有"一类缺陷（verify-integration 的 mock 有此保真度问题）。
  getStorageSync: function (k) {
    return (k in memory) ? JSON.parse(JSON.stringify(memory[k])) : '';
  },
  setStorageSync: function (k, v) {
    if (failNextSet) { failNextSet = false; throw new Error('storage full'); }
    setCalls++;
    memory[k] = JSON.parse(JSON.stringify(v));
  },
  removeStorageSync: function (k) { delete memory[k]; },

  showToast: function (o) { calls.toast.push(o || {}); },
  showModal: function (o) {
    calls.modal.push(o || {});
    if (o && typeof o.success === 'function') {
      o.success({ confirm: modalDecision === 'confirm', cancel: modalDecision === 'cancel' });
    }
  },
  navigateTo: function (o) { calls.navigateTo.push(o && o.url); },
  switchTab: function (o) { calls.switchTab.push(o && o.url); },
  // stats.js 的 draw() 用得到；桩不执行回调，只保证不抛错
  createSelectorQuery: function () {
    return { select: function () { return { fields: function () { return { exec: function () {} }; } }; } };
  },
  getWindowInfo: function () { return { pixelRatio: 2 }; },
  getSystemInfoSync: function () { return { pixelRatio: 2 }; },
  // 小程序真机上 nextTick 是"下一帧"，stats 页用它等 canvas 节点就绪后再画。
  // 桩里同步执行回调即可（测试关心的是"回调里读到的数据对不对"，不是时序）。
  nextTick: function (fn) { if (typeof fn === 'function') fn(); },
  // cloud 默认不存在 → ai.isAvailable() === false，即"云开发未开通"场景
};

/* ---- 1.5 Page / Component / getApp 替身 ---- */
let captured = null;
global.Page = function (cfg) { captured = cfg; return cfg; };
global.Component = function () { return {}; };
global.getApp = function () { return { globalData: {} }; };

/* ---- 1.6 加载页面配置 + 构造实例 ---- */
function loadPage(rel) {
  const full = require.resolve(path.join(ROOT, rel));
  delete require.cache[full];
  captured = null;
  require(full);
  if (!captured) throw new Error('页面未调用 Page()：' + rel);
  return captured;
}

function instantiate(cfg) {
  const inst = {};
  Object.keys(cfg).forEach(function (k) { inst[k] = cfg[k]; });
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}));
  inst.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) { inst.data[k] = patch[k]; });
    if (typeof cb === 'function') cb();
  };
  return inst;
}

/** 一步到位：加载 + 构造 */
function mount(rel) { return instantiate(loadPage(rel)); }

/* ---- 1.7 场景工具 ---- */
function resetWorld() {
  memory = {};
  failNextSet = false;
  setCalls = 0;
  calls.toast = []; calls.modal = []; calls.navigateTo = []; calls.switchTab = [];
  modalDecision = 'confirm';
  timerQueue = [];
  delete global.wx.cloud;
  invalidateCardsCache();
}

/**
 * 让 utils/cards.js 的模块级缓存失效。
 *
 * 为什么必须在每个用例开头做：cards.js 缓存全量卡片与状态，页面 onShow 靠它的
 * invalidate() 刷新。测试**绕过 store 直接改 memory**，若不通知缓存，
 * 页面会读到上一个用例留下的旧词库 —— 表现为：断言里的 id 在当前存储中找不到，
 * 于是 setState 落库失败、页面弹"保存失败"，而真正的原因与页面逻辑毫无关系。
 *
 * 这条约束对生产代码同样成立：任何绕过 store 直接写 storage 的地方，
 * 都必须负责通知缓存失效。测试踩到它，说明它是个真实存在的契约。
 */
function invalidateCardsCache() {
  try {
    const m = require(path.resolve(__dirname, '..', 'miniprogram', 'utils', 'cards.js'));
    if (m && typeof m.invalidate === 'function') m.invalidate();
  } catch (e) { /* 尚未加载时忽略 */ }
}

function setCloud(mode, result) {
  global.wx.cloud = {
    callFunction: function (o) {
      if (mode === 'fail') return o.fail({ errMsg: 'request:fail' });
      if (mode === 'throw') throw new Error('boom');
      o.success({ result: result });
    }
  };
}

const dateUtil = require(path.join(ROOT, 'utils', 'date.js'));
const schedule = require(path.join(ROOT, 'utils', 'schedule.js'));
const store = require(path.join(ROOT, 'utils', 'store.js'));
const SEED = require(path.join(ROOT, 'data', 'words.js'));
const TODAY = dateUtil.todayStr();

function mkWord(o) {
  return Object.assign({
    id: 'id-' + (o.word || 'x'),
    word: 'w', meaning: 'm',
    example: '', mnemonic: '',
    ef: 2.5, reps: 0, interval: 0,
    nextReview: TODAY, createdAt: TODAY, history: []
  }, o);
}

function seedStore(list) { memory['words'] = JSON.parse(JSON.stringify(list)); }
function storedWords() { return (memory['words'] || []).slice(); }

/*==================================================================
 * 二、断言辅助（async：同步抛错与 Promise 拒绝都会被捕获）
 *==================================================================*/
let pass = 0, fail = 0;
const failedNames = [];
const failedPending = [];

/**
 * @param {string} name 断言名
 * @param {Function} fn 断言体，可返回 Promise
 * @param {boolean} [pendingFix] 是否为"待修验收项"
 */
async function check(name, fn, pendingFix) {
  try {
    await fn();
    pass++;
    console.log((pendingFix ? 'PASS(已修)  ' : 'PASS  ') + name);
  } catch (e) {
    fail++;
    failedNames.push(name);
    if (pendingFix) {
      failedPending.push(name);
      console.log('FAIL(待修)  ' + name + '\n            ' + e.message);
    } else {
      console.log('FAIL  ' + name + '\n      ' + e.message);
    }
  }
}

/** 取最近一条 Toast 文案 */
function lastToast() {
  const t = calls.toast[calls.toast.length - 1];
  return t ? t.title : '(无 Toast)';
}

/*==================================================================
 * 三、主流程
 *==================================================================*/
(async function main() {
  /*----------------- 词库页 deck（原 today + words 合并而来）----------------- */
  console.log('\n===== 词库页 deck =====');

  await check('deck 空词库：overall 全 0、学科为空、不抛错', function () {
    resetWorld();
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.overall.total, 0, 'total 应为 0');
    assert.strictEqual(p.data.overall.fresh, 0, 'fresh 应为 0');
    assert.strictEqual(p.data.dueCount, 0, 'dueCount 应为 0');
    assert.strictEqual(p.data.points, 0, 'points 应为 0');
    assert.deepStrictEqual(p.data.subjects, [], 'subjects 应为空');
  });

  await check('deck 有词库：三态之和等于总数（自洽）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', nextReview: TODAY, interval: 0 }),
      mkWord({ id: 'b', word: 'beta', interval: 21, history: [{ q: 5, interval: 21 }] }),
      mkWord({ id: 'c', word: 'gamma', interval: 6, history: [{ q: 5, interval: 6 }] })
    ]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    const o = p.data.overall;
    assert.strictEqual(o.total, 3, 'total');
    assert.strictEqual(o.mastered + o.learning + o.fresh, o.total,
      '三态之和应等于总数：' + o.mastered + '+' + o.learning + '+' + o.fresh + ' != ' + o.total);
    assert.strictEqual(o.fresh, 1, '未学应为 1（只有 a 没历史）');
    assert.strictEqual(o.mastered, 1, '已掌握应为 1（interval>=21）');
    assert.ok(o.percent >= 0 && o.percent <= 100, 'percent 越界：' + o.percent);
  });

  await check('deck 全新词库：全部算"未学"且全部到期（不被误判成已学）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', nextReview: TODAY, interval: 0 }),
      mkWord({ id: 'b', word: 'beta', nextReview: TODAY, interval: 0 })
    ]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.overall.fresh, 2, '没有历史的词都该是"未学"');
    assert.strictEqual(p.data.overall.learning, 0, '不该有"复习中"');
    assert.strictEqual(p.data.dueCount, 2, '新词随时可学，都该到期');
  });

  await check('deck 到期的词才算入 dueCount（未来的不算）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', nextReview: TODAY, history: [{ q: 5, interval: 1 }] }),
      // b 已学过（有历史）、且未到期 —— 夹具必须自洽：
      // 新模型里"学过"的判据是有复习历史，没有历史却被设成未来到期日是矛盾数据
      mkWord({ id: 'b', word: 'beta', nextReview: dateUtil.addDays(TODAY, 3), interval: 3,
               history: [{ q: 5, interval: 3 }] })
    ]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.dueCount, 1, '只有今天到期的算');
    assert.strictEqual(p.data.nextDue, '', '有到期项时不该显示下一批');
  });

  await check('deck 无到期时显示下一批到期日', function () {
    resetWorld();
    const d1 = dateUtil.addDays(TODAY, 9);
    const d2 = dateUtil.addDays(TODAY, 2);
    seedStore([
      mkWord({ id: 'a', word: 'alpha', nextReview: d1, interval: 9, history: [{ q: 5, interval: 9 }] }),
      mkWord({ id: 'b', word: 'beta', nextReview: d2, interval: 2, history: [{ q: 5, interval: 2 }] })
    ]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.dueCount, 0);
    assert.strictEqual(p.data.nextDue, d2, '应取最早到期日');
  });

  await check('deck 点学科展开卡片列表，再点收起', function () {
    resetWorld();
    seedStore([mkWord({ id: 'a', word: 'alpha', subject: '英语' })]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    p.toggleSubject({ currentTarget: { dataset: { subject: '英语' } } });
    assert.strictEqual(p.data.expanded, '英语', '未展开');
    assert.strictEqual(p.data.cardList.length, 1, '列表应有 1 条');
    assert.notStrictEqual(p.data.cardList[0].hook, undefined, '列表项应带 hook 字段');
    p.toggleSubject({ currentTarget: { dataset: { subject: '英语' } } });
    assert.strictEqual(p.data.expanded, '', '未收起');
  });

  await check('deck 搜索命中 prompt / answer / hook', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'geography', meaning: '地理', mnemonic: 'geo 地球 + graph 画' }),
      mkWord({ id: 'b', word: 'biology', meaning: '生物' })
    ]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    p.onSearchInput({ detail: { value: '地理' } });
    p.doSearch();
    assert.strictEqual(p.data.searchResults.length, 1, '应命中 1 条');
    assert.strictEqual(p.data.searchResults[0].prompt, 'geography');
    p.onSearchInput({ detail: { value: 'graph' } });
    p.doSearch();
    assert.strictEqual(p.data.searchResults.length, 1, 'hook 应可被搜索');
  });

  await check('deck 清空进度：确认后 history 清零但词条保留', function () {
    resetWorld();
    seedStore([mkWord({ id: 'a', word: 'alpha', interval: 21, history: [{ q: 5, interval: 21 }] })]);
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.overall.mastered, 1, '前置：应已掌握');
    modalDecision = 'confirm';
    p.resetProgress();
    assert.strictEqual(storedWords().length, 1, '词条本身不该被删');
    assert.strictEqual(storedWords()[0].history.length, 0, 'history 应被清空');
    assert.strictEqual(p.data.overall.mastered, 0, '掌握数应归零');
  });

  await check('deck 内容管理入口跳转正确（录入/教材是最容易被合并弄丢的功能）', function () {
    resetWorld();
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.goAdd();
    p.goCurriculum();
    assert.deepStrictEqual(calls.navigateTo,
      ['/pages/add/add', '/pages/curriculum/curriculum'],
      '添加页与教材页入口必须存在');
  });

  /*----------------- 复习页 study -----------------*/
  console.log('\n===== 复习页 study =====');

  function seedQueue() {
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', nextReview: TODAY, interval: 0 }),
      mkWord({ id: 'w2', word: 'beta', nextReview: TODAY, interval: 1 }),
      mkWord({ id: 'w3', word: 'gamma', nextReview: TODAY, interval: 2 })
    ]);
  }

  await check('study 未翻卡点评分：不改数据、不写库、不弹 Toast（主动回忆守卫）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.flipped, false, '初始应为未翻卡');
    const before = p.data.current.id;
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    assert.strictEqual(calls.toast.length, 0, '不该弹 Toast');
    assert.strictEqual(p.data.idx, 0, '不该推进队列');
    assert.strictEqual(p.data.current.id, before, '不该换词');
    storedWords().forEach(function (w) {
      assert.strictEqual(w.history.length, 0, w.word + ' 不该被写入复习记录');
    });
  });

  await check('study 翻卡后评分：写入复习记录且 history 追加一条', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    assert.strictEqual(p.data.flipped, true);
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    const w = storedWords().filter(function (x) { return x.id === 'w1'; })[0];
    assert.ok(w, 'w1 应仍在词库');
    assert.strictEqual(w.history.length, 1, 'history 应追加 1 条');
    assert.strictEqual(w.history[0].q, 5);
    assert.strictEqual(w.reps, 1, 'sm2 应已更新 reps');
    assert.strictEqual(w.interval, 1, '新词认识后 interval 应为 1');
  });

  await check('study Toast 文案与新词 interval 一致（「认识 · 1 天后」）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(lastToast(), '认识 · 1 天后', '实际：' + lastToast());
  });

  await check('study Toast 文案与已进阶词的 interval 一致（reps2/interval6 → 16 天）', function () {
    resetWorld();
    // 夹具必须自洽：reps=2 意味着已经复习过 2 次，history 就该有 2 条。
    // 新模型里"学过"的判据是有复习历史，只给 reps 不给 history 会得到矛盾数据。
    seedStore([mkWord({ id: 'w9', word: 'delta', nextReview: TODAY, ef: 2.5, reps: 2, interval: 6,
                        history: [{ q: 5, interval: 1 }, { q: 5, interval: 6 }] })]);
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(lastToast(), '认识 · 16 天后', '实际：' + lastToast());
    assert.strictEqual(storedWords()[0].interval, 16, 'interval 应与 Toast 一致');
  });

  await check('study leaving 期间重复点击被忽略（只写库一次）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    assert.strictEqual(p.data.leaving, true, '评分后应进入 leaving');
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    const w = storedWords().filter(function (x) { return x.id === 'w1'; })[0];
    assert.strictEqual(w.history.length, 1, '连点不该重复计分，实际 ' + w.history.length + ' 条');
    assert.strictEqual(calls.toast.length, 1, '连点不该重复弹 Toast，实际 ' + calls.toast.length + ' 次');
  });

  await check('study 末题评分后进入 done 态且 reviewed 正确', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    for (let i = 0; i < 3; i++) {
      p.flipCard();
      p.onGrade({ currentTarget: { dataset: { q: 5 } } });
      flushTimers();
    }
    assert.strictEqual(p.data.done, true, '应进入完成态');
    assert.strictEqual(p.data.reviewed, 3, '本轮复习数应为 3');
    assert.strictEqual(p.data.current, null, '完成态 current 应为 null');
  });

  await check('study 中途退出再进：队列接续（已复习词不再出现）', function () {
    resetWorld();
    seedQueue();
    const p1 = mount('pages/study/study.js');
    p1.onLoad();
    assert.strictEqual(p1.data.queue.length, 3);
    p1.flipCard();
    p1.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();

    // 模拟"切走再回来"：重新加载页面
    const p2 = mount('pages/study/study.js');
    p2.onLoad();
    assert.strictEqual(p2.data.queue.length, 2, '应只剩 2 个未复习词');
    const ids = p2.data.queue.map(function (w) { return w.id; });
    assert.ok(ids.indexOf('w1') === -1, '已复习的 w1 不该再出现：' + ids.join(','));
  });

  await check('study done 态下 flipCard 无效', function () {
    resetWorld();
    seedStore([mkWord({ id: 'w1', word: 'alpha', nextReview: TODAY })]);
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(p.data.done, true);
    const before = p.data.flipped;
    p.flipCard();
    assert.strictEqual(p.data.flipped, before, '完成态 flipCard 应无任何效果');
  });

  await check('study q 守卫：非法档位一律拦住，且零存储写入、不推进队列', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    [0, 2, 4, 6, 99, -1, 'abc', null, undefined, NaN].forEach(function (bad) {
      p.data.leaving = false;
      p.onGrade({ currentTarget: { dataset: { q: bad } } });
    });
    flushTimers();
    storedWords().forEach(function (w) {
      assert.strictEqual(w.history.length, 0, '非法档位不该写库：' + w.word);
    });
    assert.strictEqual(p.data.idx, 0, '不该推进队列');
    assert.strictEqual(p.data.reviewed, 0, 'reviewed 不该增加');
  });

  await check('study 写库失败：不推进队列、不弹"认识"、存储未变', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    const snapshot = JSON.stringify(storedWords());
    p.flipCard();
    failNextSet = true;                      // 让下一次 setStorageSync 抛错
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(JSON.stringify(storedWords()), snapshot, '写失败时存储必须逐字节未变');
    assert.strictEqual(p.data.idx, 0, '写失败不该推进队列');
    assert.ok(lastToast().indexOf('保存失败') !== -1, '应提示保存失败，实际：' + lastToast());
  });

  await check('study single_practice 被消费且读后即删（不留幽灵状态）', function () {
    resetWorld();
    seedQueue();
    // 模拟从卡详情页"练这一张"
    memory['single_practice'] = 'w2';
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.singleMode, true, '应进入单卡模式');
    assert.strictEqual(p.data.queue.length, 1, '队列应只有指定的这一张');
    assert.strictEqual(p.data.current.id, 'w2', '应是指定的那张');
    const left = memory['single_practice'];
    assert.ok(left === undefined || left === '' || left === null,
      '标记必须被消费掉，否则下次正常进复习页会只出现这一张');
  });

  /*----------------- stats 页 -----------------*/
  /*----------------- stats 页 -----------------*/
  console.log('\n===== stats 页 =====');

  await check('stats 空数据：overall 全 0、self.hasData=false、points=0', function () {
    resetWorld();
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    assert.deepStrictEqual(p.data.overall, { mastered: 0, learning: 0, fresh: 0, total: 0, percent: 0 },
      '空库 overall 应为全 0');
    assert.strictEqual(p.data.points, 0, 'points 应为 0');
    assert.strictEqual(p.data.self.hasData, false, '无记录时 hasData 应为 false');
    assert.strictEqual(p.data.self.firstTryRate, 0, 'firstTryRate 应为 0');
    assert.strictEqual(p.data.self.retainedRatio, 0, 'retainedRatio 应为 0');
    assert.strictEqual(p.data.curveSummary, '还没有复习记录', '应提示还没有记录');
    assert.strictEqual(p.data.ready, true, 'ready 应置位');
  });

  await check('stats 有数据：points / firstTryRate / avgEF / retainedRatio 数值正确', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', ef: 2.9, interval: 49,
               history: [{ q: 5, interval: 1 }, { q: 5, interval: 49 }] }),
      mkWord({ id: 'w2', word: 'beta', ef: 2.0, interval: 1,
               history: [{ q: 1, interval: 1 }, { q: 5, interval: 1 }] }),
      mkWord({ id: 'w3', word: 'gamma', ef: 2.5, interval: 0, history: [] })
    ]);
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    // 2×认识(3+3) + 1×不认识(0) + 1×认识(3) = 9
    assert.strictEqual(p.data.points, 9, '积分应为 9，实际 ' + p.data.points);
    assert.strictEqual(p.data.self.firstTryRate, 50, '2 词有记录、1 词首答正确');
    assert.strictEqual(p.data.self.avgEF, 2.47, '全库平均 (2.9+2.0+2.5)/3');
    assert.strictEqual(p.data.self.retainedRatio, 50, '1/2 已长期保留');
    assert.strictEqual(p.data.self.hasData, true, '有记录时 hasData 应为 true');
    assert.strictEqual(p.data.overall.mastered, 1, '已掌握应为 1（interval>=21）');
    assert.strictEqual(p.data.overall.fresh, 1, '未学应为 1');
  });

  await check('stats 复习量分布：按复习次数正确分档', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', history: [{ q: 5, interval: 1 }] }),
      mkWord({ id: 'b', word: 'beta', history: [{ q: 5, interval: 1 }, { q: 5, interval: 6 }] }),
      mkWord({ id: 'c', word: 'gamma', history: [] }),
      mkWord({ id: 'd', word: 'delta', history: [{ q: 5, interval: 1 }, { q: 5, interval: 6 },
                                                  { q: 5, interval: 17 }, { q: 5, interval: 49 }] })
    ]);
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    const dist = {};
    p.data.reviewDist.forEach(function (d) { dist[d.label] = d.value; });
    assert.strictEqual(dist['未学'], 1, '未学应为 1');
    assert.strictEqual(dist['1 轮'], 1, '1 轮应为 1');
    assert.strictEqual(dist['2 轮'], 1, '2 轮应为 1');
    assert.strictEqual(dist['4 轮+'], 1, '4 轮+ 应为 1');
  });

  await check('stats 曲线摘要：有 2 轮以上记录时给出人话解读', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', interval: 6,
               history: [{ q: 5, interval: 1 }, { q: 5, interval: 6 }] }),
      mkWord({ id: 'b', word: 'beta', interval: 1, history: [{ q: 5, interval: 1 }] })
    ]);
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    assert.ok(p.data.curveSummary.indexOf('平均间隔') !== -1,
      '应给出曲线解读，实际：' + p.data.curveSummary);
  });

  await check('stats onShow 不抛错且进入 ready（canvas 查不到节点也要容错）', function () {
    resetWorld();
    seedStore([mkWord({ id: 'w1', word: 'alpha', interval: 1, history: [{ q: 5, interval: 1 }] })]);
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.ready, true, 'ready 应为 true');
  });

  /*----------------- 已修复的验收标准（已转普通回归断言）-----------------
   * D1/D2/D3/H2/H4/H5 六项验收标准已随 Task #10 / #11 修复转绿，
   * 因此**摘掉了 pendingFix 标记**，失败时走 hardFail → 无论有无 --allow-pending 都 exit 1。
   * 这是防呆闭环的关键：若保留标记，这六项日后的**回归**会被 --allow-pending 静默放行。
   * 仍带 pendingFix 的项只剩 A1，见下方「独立证伪组：阶段 A 新发现」。 */
  console.log('\n===== 已修复的验收标准（回归保护）=====');

  await check('D1 批量粘贴全部重复 → 提示「这些词都已经在词库里了」', function () {
    resetWorld();
    seedStore([mkWord({ id: 'x', word: 'ok', meaning: '好的' })]);
    const p = mount('pages/add/add.js');
    p.setData({ batch: 'ok 重复' });
    p.saveBatch();
    assert.strictEqual(
      lastToast(), '这些词都已经在词库里了',
      '全是重复词时不该说"没有可识别的词条"，实际：' + lastToast()
    );
  });

  await check('H2 updateWord 写失败 → 提示保存失败且不推进队列', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    const beforeWord = p.data.current.word;
    const beforeIdx = p.data.idx;
    p.flipCard();
    failNextSet = true;                      // 让 store.updateWord 的写入失败
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    assert.ok(/保存失败/.test(lastToast()), '应提示保存失败，实际：' + lastToast());
    assert.strictEqual(p.data.idx, beforeIdx, '不该推进队列');
    assert.strictEqual(p.data.current.word, beforeWord, '不该换词');
  });

  await check('D3 addDays 非法日期串 → 返回合法日期，不出现 NaN-NaN-NaN', function () {
    const bad = ['abc', '', null, undefined, '2026/09/11', '2026-13-45'];
    bad.forEach(function (v) {
      let r;
      try {
        r = dateUtil.addDays(v, 1);
      } catch (e) {
        throw new Error('addDays(' + JSON.stringify(v) + ') 抛异常了：' + e.message);
      }
      assert.ok(
        /^\d{4}-\d{2}-\d{2}$/.test(String(r)),
        'addDays(' + JSON.stringify(v) + ') 应返回合法日期，实际：' + JSON.stringify(r)
      );
      assert.ok(String(r).indexOf('NaN') === -1, '不得出现 NaN：' + r);
    });
  });

  await check('H4 缺 ef 字段的记录参与统计 → avgEF 是有限数（页面不得显示 NaN）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', interval: 1, history: [{ q: 5 }] }),
      { id: 'w2', word: 'beta', meaning: 'B', interval: 0, history: [], nextReview: TODAY }  // 故意缺 ef
    ]);
    const p = mount('pages/stats/stats.js');
    p.onShow();
    assert.ok(
      Number.isFinite(Number(p.data.self.avgEF)),
      'avgEF 应为有限数，实际：' + JSON.stringify(p.data.self.avgEF)
    );
    assert.ok(String(p.data.self.avgEF).indexOf('NaN') === -1, '页面不得显示 NaN');
  });

  await check('H5 历史项缺 interval → 曲线点不含 NaN', function () {
    const curve = schedule.intervalCurve([
      { history: [{ q: 5 }, { q: 5, interval: 6 }] },
      { history: [{ q: 3, interval: 2 }] }
    ]);
    assert.ok(curve.length > 0, '应产出曲线点');
    curve.forEach(function (pt) {
      assert.ok(Number.isFinite(pt.y), '曲线点 y 不应是 NaN：' + JSON.stringify(pt));
    });
  });

  await check('D2 ai.js 各返回路径的 code 均为非空字符串', async function () {
    resetWorld();
    const ai = require(path.join(ROOT, 'utils', 'ai.js'));
    const bad = [];
    const record = function (label, r) {
      if (typeof r.code !== 'string' || r.code.length === 0) {
        bad.push(label + ' → code=' + JSON.stringify(r.code));
      }
    };

    record('parseBatch 空输入', await ai.parseBatch('   ', []));
    record('parseBatch 云未开通', await ai.parseBatch('abandon 遗弃', []));
    record('genExample 空词', await ai.genExample('', 'x'));
    record('genMnemonic 空词', await ai.genMnemonic('', ''));

    setCloud('fail');
    record('parseBatch 调用失败', await ai.parseBatch('abandon 遗弃', []));

    setCloud('throw');
    record('parseBatch 同步抛异常', await ai.parseBatch('abandon 遗弃', []));

    setCloud('ok', { ok: true, data: { items: [] } });
    record('parseBatch 无有效词条', await ai.parseBatch('abandon 遗弃', []));

    setCloud('ok', { ok: true, data: { items: [{ word: 'review', meaning: 'v. 复习' }] } });
    record('parseBatch 成功', await ai.parseBatch('review 复习', []));

    setCloud('ok', { ok: true, data: { example: '   ' } });
    record('genExample 空内容+命中预置库', await ai.genExample('ability', 'n. 能力'));

    // 云返回成功但内容为空，且预置库没有这个词 —— 缺陷所在路径
    record('genExample 空内容+预置库无此词', await ai.genExample('zzzznotexist', 'n. 不存在'));

    assert.deepStrictEqual(bad, [],
      '以下返回路径的 code 不是非空字符串：\n        ' + bad.join('\n        '));
  });

  /*==================================================================
   * 独立证伪组（Task #4 阶段 A）
   *
   * 定位：不复跑工程师写过的断言，而是用他没写过的用例去证伪已落地的修复。
   * 每一组都对应一条"修复自己承诺过的纪律"，用正向断言把它钉死 ——
   * 只测"坏数据被修好"是不够的，还得测"好数据没被改坏"。
   *==================================================================*/
  console.log('\n===== 独立证伪组：净化层（Task #4 阶段 A）=====');

  await check('净化层纪律②：完全合法的词条经 loadWords 后逐字节不变', function () {
    resetWorld();
    // 覆盖各条边界：ef 正好等于下限 1.3、已进阶词 reps3/interval6、已掌握 interval49、含撇号的词
    const legal = [
      mkWord({ id: 'L1', word: 'alpha', meaning: 'n. 第一个', example: 'e', mnemonic: 'm' }),
      mkWord({ id: 'L2', word: 'beta', meaning: 'n. 第二个', ef: 1.3, reps: 3, interval: 6,
        history: [{ date: TODAY, q: 5, interval: 1 }, { date: TODAY, q: 3, interval: 6 }] }),
      mkWord({ id: 'L3', word: 'gamma', meaning: 'n. 第三个', ef: 2.6, reps: 9, interval: 49,
        nextReview: dateUtil.addDays(TODAY, 49), history: [{ date: TODAY, q: 5, interval: 49 }] }),
      mkWord({ id: 'L4', word: "don't", meaning: '不', reps: 1, interval: 1,
        history: [{ date: TODAY, q: 1, interval: 1 }] })
    ];
    seedStore(legal);
    const before = JSON.stringify(memory['words']);
    const loaded = store.loadWords();
    assert.strictEqual(loaded.length, legal.length, '条数不该变');
    assert.strictEqual(
      JSON.stringify(loaded), before,
      '合法数据被净化层改动了。before=' + before + '\n      after =' + JSON.stringify(loaded)
    );
  });

  await check('净化层纪律①：16 类脏记录全部被"修正"而非"丢弃"', function () {
    resetWorld();
    const dirty = [
      ['d1', { id: 'd1', word: 'w1', meaning: 'm1', reps: 0, interval: 0, nextReview: TODAY, history: [] }, 'ef 缺失'],
      ['d2', { id: 'd2', word: 'w2', meaning: 'm2', ef: '2.5', reps: 0, interval: 0, nextReview: TODAY, history: [] }, 'ef 是字符串'],
      ['d3', { id: 'd3', word: 'w3', meaning: 'm3', ef: 'abc', reps: 0, interval: 0, nextReview: TODAY, history: [] }, 'ef 非数字'],
      ['d4', { id: 'd4', word: 'w4', meaning: 'm4', ef: 1.0, reps: 0, interval: 0, nextReview: TODAY, history: [] }, 'ef 低于下限'],
      ['d5', { id: 'd5', word: 'w5', meaning: 'm5', ef: 2.5, reps: 0, interval: -5, nextReview: TODAY, history: [] }, 'interval 负数'],
      ['d6', { id: 'd6', word: 'w6', meaning: 'm6', ef: 2.5, reps: 0, interval: 1.5, nextReview: TODAY, history: [] }, 'interval 小数'],
      ['d7', { id: 'd7', word: 'w7', meaning: 'm7', ef: 2.5, reps: 0, interval: 0, nextReview: '2026-02-30', history: [] }, 'nextReview 不存在的日子'],
      ['d8', { id: 'd8', word: 'w8', meaning: 'm8', ef: 2.5, reps: 0, interval: 0, nextReview: 'NaN-NaN-NaN', history: [] }, 'nextReview NaN 串'],
      ['d9', { id: 'd9', word: 'w9', meaning: 'm9', ef: 2.5, reps: 0, interval: 0, history: [] }, 'nextReview 缺字段'],
      ['d10', { id: 'd10', word: 'w10', meaning: 'm10', ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, history: 'oops' }, 'history 非数组'],
      ['d11', { id: 'd11', word: 'w11', meaning: 'm11', ef: 2.5, reps: 1, interval: 1, nextReview: TODAY, history: [null, { date: TODAY, q: 5, interval: 1 }] }, 'history 混入 null'],
      ['d12', { id: 'd12', word: 'w12', meaning: 'm12', ef: 2.5, reps: 1, interval: 1, nextReview: TODAY, history: [{ date: TODAY, interval: 1 }] }, 'history 项缺 q'],
      ['d13', { id: 'd13', word: 'w13', meaning: 'm13', ef: 2.5, reps: 1, interval: 1, nextReview: TODAY, history: [{ date: TODAY, q: 5 }] }, 'history 项缺 interval'],
      ['d14', { id: 'd14', word: 'w14', meaning: 'm14', ef: 2.5, reps: 1, interval: 1, nextReview: TODAY, history: [{ date: '2026-02-30', q: 5, interval: 1 }] }, 'history 项 date 非法'],
      ['d15', { id: 'd15', word: 'w15', meaning: 'm15', ef: 2.5, reps: 3, interval: 0, nextReview: TODAY, history: [] }, 'reps>0 但 interval=0'],
      ['d16', { id: 'd16', word: '  w16  ', meaning: '  m16  ', ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, history: [] }, 'word/meaning 首尾空白']
    ];
    seedStore(dirty.map(function (x) { return x[1]; }));
    const loaded = store.loadWords();
    const byId = {};
    loaded.forEach(function (w) { if (w && w.id) byId[w.id] = w; });

    const dropped = dirty.filter(function (x) { return !byId[x[0]]; });
    assert.deepStrictEqual(dropped.map(function (x) { return x[2]; }), [],
      '这些脏记录被丢弃了（纪律①要求修正而非丢弃）：' + dropped.map(function (x) { return x[2]; }).join('、'));

    // 逐类核对修正结果
    assert.strictEqual(byId.d1.ef, 2.5, 'd1 ef 应回落到 2.5');
    assert.strictEqual(byId.d2.ef, 2.5, 'd2 ef 字符串应折成数字');
    assert.strictEqual(typeof byId.d2.ef, 'number', 'd2 ef 必须是数字，否则 sm2 会变字符串拼接');
    assert.strictEqual(byId.d3.ef, 2.5, 'd3 ef 非数字应回落到 2.5');
    assert.strictEqual(byId.d4.ef, 2.5, 'd4 ef 低于 1.3 应回落到 2.5');
    assert.strictEqual(byId.d5.interval, 0, 'd5 interval 负数应归零');
    assert.strictEqual(byId.d6.interval, 0, 'd6 interval 小数应归零');
    assert.strictEqual(byId.d7.nextReview, TODAY, 'd7 不存在的日子应改为今天（否则字典序恒大于今天 → 永久卡死）');
    assert.strictEqual(byId.d8.nextReview, TODAY, 'd8 NaN 串应改为今天');
    assert.strictEqual(byId.d9.nextReview, TODAY, 'd9 缺字段应补今天');
    assert.deepStrictEqual(byId.d10.history, [], 'd10 非数组 history 应重置为空数组');
    assert.strictEqual(byId.d11.history.length, 1, 'd11 null 项应被剔除，合法项保留');
    assert.strictEqual(byId.d11.history[0].q, 5, 'd11 保留的项内容不该变');
    assert.strictEqual(byId.d12.history[0].q, 0, 'd12 缺 q 应补 0');
    assert.strictEqual(byId.d13.history[0].interval, 0, 'd13 缺 interval 应补 0');
    assert.strictEqual(byId.d14.history[0].date, TODAY, 'd14 非法 date 应改为今天');
    assert.strictEqual(byId.d15.reps, 0, 'd15 interval=0 时 reps 必须归零（否则间隔恒为 0 永远当日到期）');
    assert.strictEqual(byId.d16.word, 'w16', 'd16 word 应去首尾空白');
    assert.strictEqual(byId.d16.meaning, 'm16', 'd16 meaning 应去首尾空白');
  });

  await check('净化层纪律①边界：只有 word/meaning 不可用的记录才允许被丢弃', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'keep1', word: 'alpha', meaning: 'm' }),
      { id: 'drop1', word: '   ', meaning: 'm', ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, history: [] },
      { id: 'drop2', word: 'beta', ef: 2.5, reps: 0, interval: 0, nextReview: TODAY, history: [] },
      null,
      'junk',
      mkWord({ id: 'keep2', word: 'gamma', meaning: 'm' })
    ]);
    const loaded = store.loadWords();
    assert.deepStrictEqual(loaded.map(function (w) { return w.id; }), ['keep1', 'keep2'],
      '应只丢 4 条无 word/meaning 的记录，合法记录一条都不能少');
  });

  await check('净化层：脏库全链路（队列/统计/曲线/三页渲染）都不出现 NaN 或异常', function () {
    resetWorld();
    const dirty = [
      { id: 'x1', word: 'alpha', meaning: 'm', ef: '2.5', reps: 3, interval: 0, nextReview: '2026-02-30',
        history: [null, { date: '2026-02-30', q: '5', interval: -1 }] },
      { id: 'x2', word: '  beta  ', meaning: '  m  ', ef: -1, reps: -2, interval: 2.5,
        nextReview: 'NaN-NaN-NaN', history: 'oops' },
      { id: 'x3', word: 'gamma', meaning: 'm' },
      { id: 'x4', word: '', meaning: 'm' },
      null,
      'junk'
    ];
    seedStore(dirty);
    const list = store.loadWords();
    assert.strictEqual(list.length, 3, '6 条脏输入应净化出 3 条');

    // 上游函数不得抛异常、不得产出 NaN
    assert.strictEqual(schedule.dueWords(list, TODAY).length, 3,
      '净化后 3 个词都该进今日队列（原 nextReview 全是非法串）');
    const sc = schedule.selfCheck(list);
    assert.ok(Number.isFinite(sc.avgEF), 'avgEF 应为有限数，实际 ' + sc.avgEF);
    assert.strictEqual(String(sc.avgEF).indexOf('NaN'), -1, 'avgEF 不得含 NaN');
    schedule.intervalCurve(list).forEach(function (pt) {
      assert.ok(Number.isFinite(pt.y), '曲线点 y 不得为 NaN：' + JSON.stringify(pt));
    });
    assert.ok(Number.isFinite(schedule.masteredCount(list)));
    assert.ok(Number.isFinite(schedule.pointsOf(list)));

    // 三个页面在脏库下都要能渲染
    ['pages/stats/stats.js', 'pages/deck/deck.js', 'pages/study/study.js'].forEach(function (rel) {
      const p = mount(rel);
      p.onShow();
      const nanKeys = Object.keys(p.data).filter(function (k) {
        return String(p.data[k]).indexOf('NaN') !== -1;
      });
      assert.deepStrictEqual(nanKeys, [], rel + ' 的这些字段出现了 NaN：' + nanKeys.join(','));
    });
  });

  console.log('\n===== 独立证伪组：addBatch / addItems 多词短语（Task #11 目标）=====');

  await check('addBatch：多词短语不再被静默截断（教材词库的真实形态）', function () {
    resetWorld();
    const r = store.addBatch('all over the world 全世界');
    assert.strictEqual(r.added, 1, '应加入 1 条');
    assert.deepStrictEqual(r.skipped, [], '不该有跳过项');
    const w = storedWords()[0];
    assert.strictEqual(w.word, 'all over the world',
      '多词短语被截断了：word=' + JSON.stringify(w.word) + '（旧实现会切成 "all"）');
    assert.strictEqual(w.meaning, '全世界', '释义不该带上被截掉的词，实际 ' + JSON.stringify(w.meaning));
  });

  await check('addBatch：5 词短语（教材最长形态）与混合批次都正确', function () {
    resetWorld();
    let r = store.addBatch('stop someone from doing something 阻止某人做某事');
    assert.strictEqual(storedWords()[0].word, 'stop someone from doing something',
      '5 词短语应整体作为单词，实际 ' + JSON.stringify(storedWords()[0].word));
    assert.strictEqual(storedWords()[0].meaning, '阻止某人做某事');

    resetWorld();
    r = store.addBatch('apple 苹果\n123bad 非法\nall over the world 全世界');
    assert.strictEqual(r.added, 2, '应加入 2 条（123bad 格式非法）');
    assert.deepStrictEqual(r.skipped, ['123bad 非法'], '应只跳过格式非法那条');
    assert.deepStrictEqual(storedWords().map(function (w) { return w.word; }), ['apple', 'all over the world']);
  });

  await check('addBatch：无释义歧义时回退规则保持旧行为（"hello world" → hello / world）', function () {
    resetWorld();
    const r = store.addBatch('hello world');
    assert.strictEqual(r.added, 1, '整行吃光会变成非法行，回退后应能切成 hello/world');
    assert.strictEqual(storedWords()[0].word, 'hello', '实际 ' + JSON.stringify(storedWords()[0].word));
    assert.strictEqual(storedWords()[0].meaning, 'world');
  });

  await check('addItems：dupSkipped 能区分「已在词库里」与「格式有问题」', function () {
    resetWorld();
    seedStore([mkWord({ id: 'x', word: 'apple', meaning: '苹果' })]);
    const r = store.addItems([
      { word: 'apple', meaning: '苹果' },        // 重复
      { word: 'banana', meaning: '香蕉' },       // 新增
      { word: '', meaning: '空词' }              // 格式有问题
    ]);
    assert.strictEqual(r.added, 1, '应只加 1 条');
    assert.strictEqual(r.dupSkipped, 1, '重复应计 1 条，实际 ' + r.dupSkipped);
    assert.strictEqual(r.skipped.length, 2, '跳过总数应为 2');
    assert.ok(r.dupSkipped !== r.skipped.length,
      '若 dupSkipped 等于 skipped.length，界面会把"格式有问题"误报成"都已收过"');
  });

  await check('addItems：多词短语与教材最长短语都能整条入库（教材导入路径不套 WORD_RE）', function () {
    resetWorld();
    const r = store.addItems([
      { word: 'all over the world', meaning: '全世界' },
      { word: 'as dead as a dodo', meaning: '彻底死亡' }
    ]);
    assert.strictEqual(r.added, 2, '教材合法短语不该被丢弃，实际 added=' + r.added);
    assert.deepStrictEqual(r.skipped, [], '不该有跳过项');
    assert.deepStrictEqual(storedWords().map(function (w) { return w.word; }),
      ['all over the world', 'as dead as a dodo']);
  });

  console.log('\n===== 独立证伪组：review 页 q 守卫与失败路径 =====');

  await check('study q 守卫：非法档位一律拦住，且零存储写入、不推进队列、不弹 Toast', function () {
    const badQ = [0, 2, 4, 6, -1, null, undefined, '', 'abc', false, [], {}, NaN];
    const leaked = [];
    badQ.forEach(function (v) {
      resetWorld();
      seedStore([mkWord({ id: 'q1', word: 'alpha', meaning: 'm', history: [] })]);
      const p = mount('pages/study/study.js');
      p.onLoad();
      p.flipCard();
      const idxBefore = p.data.idx;
      const wordBefore = p.data.current.word;
      const writesBefore = setCalls;

      p.onGrade({ currentTarget: { dataset: { q: v } } });
      flushTimers();

      const wrote = setCalls - writesBefore;
      const stored = storedWords()[0];
      const problems = [];
      if (stored.history.length !== 0) problems.push('写入了复习记录');
      if (wrote !== 0) problems.push('发生了 ' + wrote + ' 次存储写入');
      if (p.data.idx !== idxBefore) problems.push('推进了队列');
      if (p.data.current.word !== wordBefore) problems.push('换了词');
      if (calls.toast.length !== 0) problems.push('弹了 Toast：' + lastToast());
      if (timerQueue.length !== 0) problems.push('排了定时器');
      if (problems.length) leaked.push('q=' + JSON.stringify(v) + ' → ' + problems.join('、'));
    });
    assert.deepStrictEqual(leaked, [],
      '以下非法档位没被干净拦住：\n        ' + leaked.join('\n        '));
  });

  await check('study q 守卫：合法档位（含 WXML 传来的字符串形态）正确落库', function () {
    // WXML 的 data-q 只能给字符串，所以 '5'/'3'/'1' 必须与数字等价
    const expect = {
      '5': { q: 5, reps: 1, ef: 2.6 }, 5: { q: 5, reps: 1, ef: 2.6 },
      '3': { q: 3, reps: 1, ef: 2.36 }, 3: { q: 3, reps: 1, ef: 2.36 },
      '1': { q: 1, reps: 0, ef: 1.96 }, 1: { q: 1, reps: 0, ef: 1.96 }
    };
    const wrong = [];
    Object.keys(expect).forEach(function (k) {
      resetWorld();
      seedStore([mkWord({ id: 'q1', word: 'alpha', meaning: 'm', history: [] })]);
      const p = mount('pages/study/study.js');
      p.onLoad();
      p.flipCard();
      p.onGrade({ currentTarget: { dataset: { q: k === '5' || k === '3' || k === '1' ? k : Number(k) } } });
      flushTimers();
      const w = storedWords()[0];
      const e = expect[k];
      if (!w.history.length) { wrong.push('q=' + k + ' 未被接受'); return; }
      if (w.history[0].q !== e.q) wrong.push('q=' + k + ' 落库 q=' + w.history[0].q + '，期望 ' + e.q);
      if (w.reps !== e.reps) wrong.push('q=' + k + ' reps=' + w.reps + '，期望 ' + e.reps);
      if (w.ef !== e.ef) wrong.push('q=' + k + ' ef=' + w.ef + '，期望 ' + e.ef);
    });
    assert.deepStrictEqual(wrong, [], wrong.join('\n        '));
  });

  await check('study 写库失败：不推进队列、不弹"下次复习"、不留定时器、存储逐字节未变', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', meaning: 'm', interval: 0, history: [] }),
      mkWord({ id: 'w2', word: 'beta', meaning: 'm', interval: 1, history: [] })
    ]);
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    const snapshot = JSON.stringify(memory['words']);
    const idxBefore = p.data.idx;

    failNextSet = true;   // 让 store.updateWord 的写盘失败
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });

    assert.ok(/保存失败/.test(lastToast()), '应如实提示保存失败，实际：' + lastToast());
    assert.strictEqual(calls.toast.filter(function (t) { return /下次复习/.test(t.title || ''); }).length, 0,
      '写盘失败却弹了"下次复习"，界面会骗用户说已安排 —— 这是静默丢数据');
    assert.strictEqual(p.data.leaving, false, '写盘失败不该进入 leaving');
    assert.strictEqual(p.data.idx, idxBefore, '写盘失败不该推进队列');
    assert.strictEqual(p.data.current.prompt, 'alpha', '写盘失败不该换词');
    assert.strictEqual(p.data.done, false, '写盘失败不该进入完成态');
    assert.strictEqual(timerQueue.length, 0, '写盘失败不该排任何定时器');
    assert.strictEqual(JSON.stringify(memory['words']), snapshot, '存储被改动了');

    flushTimers();
    assert.strictEqual(p.data.idx, idxBefore, '推进定时器后队列仍不该前进');
    assert.strictEqual(p.data.current.prompt, 'alpha', '推进定时器后仍应停在原词');
    storedWords().forEach(function (w) {
      assert.strictEqual(w.history.length, 0, w.word + ' 不该留下复习记录');
    });
  });

  console.log('\n===== 独立证伪组：date.js 闰年与链式推进 =====');

  await check('isValidDateStr：不存在的日子一律为 false（含闰年判定）', function () {
    const cases = [
      // [入参, 期望, 说明]
      ['2028-02-29', true, '2028 闰年'],
      ['2024-02-29', true, '2024 闰年'],
      ['2000-02-29', true, '2000 闰年（能被 400 整除）'],
      ['1900-02-29', false, '1900 非闰年（能被 100 不能被 400 整除）'],
      ['2026-02-29', false, '2026 非闰年'],
      ['2026-02-30', false, '2 月无 30 日'],
      ['2026-04-31', false, '4 月无 31 日'],
      ['2026-13-01', false, '无 13 月'],
      ['2026-00-10', false, '无 0 月'],
      ['2026-01-00', false, '无 0 日'],
      ['2026-09-16', true, '合法'],
      ['2026-09-16 ', false, '尾部空格'],
      [' 2026-09-16', false, '首部空格'],
      ['26-09-16', false, '2 位年'],
      ['0099-01-01', false, '2 位年段（JS Date 会映射到 1999，回读校验挡住）'],
      ['', false, '空串'],
      [null, false, 'null'],
      [undefined, false, 'undefined'],
      [20260916, false, '数字'],
      ['2026-09-16T00:00:00', false, 'ISO 带时间'],
      ['2026-09-16\n', false, '尾随换行']
    ];
    const wrong = [];
    cases.forEach(function (c) {
      let got;
      try { got = dateUtil.isValidDateStr(c[0]); } catch (e) { got = 'THROW:' + e.message; }
      if (got !== c[1]) wrong.push(JSON.stringify(c[0]) + ' → ' + got + '，期望 ' + c[1] + '（' + c[2] + '）');
    });
    assert.deepStrictEqual(wrong, [], wrong.join('\n        '));
  });

  await check('addDays：闰年 / 跨月 / 跨年 / 负天数边界全部正确', function () {
    const cases = [
      ['2024-02-28', 1, '2024-02-29', '闰年 2 月末 +1'],
      ['2024-02-29', 1, '2024-03-01', '闰日 +1 进 3 月'],
      ['2023-02-28', 1, '2023-03-01', '平年 2 月末 +1 进 3 月'],
      ['2000-02-28', 1, '2000-02-29', '2000 闰年'],
      ['1900-02-28', 1, '1900-03-01', '1900 平年'],
      ['2026-12-31', 1, '2027-01-01', '跨年'],
      ['2026-01-01', -1, '2025-12-31', '负天数跨年回退'],
      ['2026-01-31', 1, '2026-02-01', '31 天月 → 2 月'],
      ['2026-03-01', -1, '2026-02-28', '3 月 1 日回退到 2 月末']
    ];
    const wrong = [];
    cases.forEach(function (c) {
      const got = dateUtil.addDays(c[0], c[1]);
      if (got !== c[2]) wrong.push('addDays(' + c[0] + ', ' + c[1] + ') = ' + got + '，期望 ' + c[2] + '（' + c[3] + '）');
    });
    assert.deepStrictEqual(wrong, [], wrong.join('\n        '));
  });

  await check('addDays：非法基准日与非法天数都回退为合法值，绝不产出 NaN-NaN-NaN', function () {
    const badBase = ['abc', '', null, undefined, '2026/09/11', '2026-13-45', '2026-02-30', 'NaN-NaN-NaN'];
    const badDays = [null, undefined, 'abc', NaN, Infinity, -Infinity, {}, []];
    const wrong = [];
    badBase.forEach(function (v) {
      const got = dateUtil.addDays(v, 1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(got) || got.indexOf('NaN') !== -1) {
        wrong.push('addDays(' + JSON.stringify(v) + ', 1) = ' + JSON.stringify(got));
      }
    });
    badDays.forEach(function (v) {
      const got = dateUtil.addDays('2026-09-16', v);
      if (got !== '2026-09-16') wrong.push('addDays("2026-09-16", ' + String(v) + ') = ' + JSON.stringify(got) + '，应回退为基准日');
    });
    assert.deepStrictEqual(wrong, [], wrong.join('\n        '));
  });

  await check('addDays：跨年链式推进 60 天不跳日、不回退、不出 NaN', function () {
    let cur = '2026-12-31';
    const seq = [cur];
    for (let i = 0; i < 60; i++) {
      cur = dateUtil.addDays(cur, 1);
      seq.push(cur);
    }
    assert.strictEqual(seq.length, 61);
    assert.strictEqual(seq[0], '2026-12-31');
    assert.strictEqual(seq[60], '2027-03-01', '60 天后应为 2027-03-01，实际 ' + seq[60]);
    const gaps = [];
    for (let i = 1; i < seq.length; i++) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(seq[i]) || seq[i].indexOf('NaN') !== -1) {
        gaps.push(seq[i] + '(格式非法)');
        continue;
      }
      const a = seq[i - 1].split('-').map(Number);
      const b = seq[i].split('-').map(Number);
      const diff = new Date(b[0], b[1] - 1, b[2]) - new Date(a[0], a[1] - 1, a[2]);
      if (diff !== 86400000) gaps.push(seq[i - 1] + '→' + seq[i] + '(' + (diff / 86400000) + '天)');
    }
    assert.deepStrictEqual(gaps, [], '以下位置跳日或回退：' + gaps.join(', '));
  });

  /*----------------- 阶段 A 证伪发现（已修复，转普通回归断言）-----------------
   * A1 由 Task #4 阶段 A 的独立证伪发现（工程师原有 51 条断言未覆盖）：
   *   isValidDateStr('2026-1-5') 曾返回 true → sanitize 放行 → nextReview 保持
   *   '2026-1-5' → dueWords 的字典序比较（'1'0x31 > '0'0x30）恒为 false → 该词永不进队列。
   * 修法：date.js 的 DATE_RE 由 \d{1,2} 收紧为 \d{2}。已修复转绿，故摘掉 pendingFix。 */
  console.log('\n===== 独立证伪组：阶段 A 发现（已修复）=====');

  await check('A1 isValidDateStr 应拒绝非规范日期串（1 位月/日），否则净化层放行 → 静默丢词', function () {
    // 曾经的失效链：DATE_RE 允许 \d{1,2} → '2026-1-5' 被判合法
    //   → sanitize 放行 → dueWords 的字典序 '2026-1-5' <= '2026-09-16' 为 false
    //   → 该词永久进不了复习队列（与 H9 / D3 同属"静默丢词"类别）
    assert.strictEqual(dateUtil.isValidDateStr('2026-1-5'), false,
      'isValidDateStr("2026-1-5") 应为 false（非规范格式），否则净化层会放行它');
    assert.strictEqual(dateUtil.isValidDateStr('2026-9-16'), false,
      'isValidDateStr("2026-9-16") 应为 false（1 位月）');
    assert.strictEqual(dateUtil.isValidDateStr('2026-01-05'), true,
      '规范格式仍应判为合法（别把修复做成"一律 false"）');

    // 端到端证据：非规范日期串在净化后必须被修正，且该词能进队列
    resetWorld();
    seedStore([mkWord({ id: 'n1', word: 'alpha', meaning: 'm', nextReview: '2026-1-5' })]);
    const loaded = store.loadWords();
    assert.strictEqual(loaded[0].nextReview, TODAY,
      '净化层应把非规范日期串修正为今天，实际 ' + JSON.stringify(loaded[0].nextReview));
    assert.strictEqual(schedule.dueWords(loaded, TODAY).length, 1,
      '净化后该词应进今日队列（修复前因字典序被静默排除）');
  });

  /*----------------- curriculum 教材导入页 -----------------*/
  console.log('\n===== curriculum 教材导入页 =====');

  // 这一页此前是唯一零页面级覆盖的页面，而它恰好承担三件最危险的事：
  //   ① 唯一会一次性写入近 300 条记录的操作（最易撞 wx.setStorageSync 的 10MB 配额）；
  //   ② 唯一走 store.addItems 直传、必须绕开 normalizeItems 的入口（决策 1）；
  //   ③ 唯一涉及 18 条合法多词短语的入口（被截断就变成假单词，且不报错）。
  // 数据口径以**真实 JSON**为准：295 词 / 18 条多词短语 / 最长 5 词。
  const BOOK = require(path.join(ROOT, 'data', 'curriculum', 'wy7s_2024.json'));

  // 2026-09-17 改造：教材页从"只有这一册"变成两级（先选册 → 再挑单元）。
  // 因此凡是断言单元/词数的用例，都必须先打开一册；enterBook 走真实点击路径
  // （WXML bindtap → openBook(e)），顺带验证 data-id 接线没断。
  const BOOK_REGISTRY = require(path.join(ROOT, 'utils', 'curriculum-books.js'));
  function enterBook(p, id) {
    p.openBook({ currentTarget: { dataset: { id: id || 'wy7s_2024' } } });
  }

  const BOOK_WORDS = BOOK.words.map(function (w) { return String(w.word || '').trim(); });
  const BOOK_MULTI = BOOK_WORDS.filter(function (w) { return w.split(/\s+/).length > 1; });
  const BOOK_LONGEST = BOOK_WORDS.slice().sort(function (a, b) {
    return b.split(/\s+/).length - a.split(/\s+/).length;
  })[0];
  // 落库口径：addItems 用「已入库 + 本批已收」的 list 查重（大小写不敏感），
  // 所以同批次内同形词只进第一条。教材里恰好一组（race v.比赛 / n.赛车，见审计 §3.2-M2）。
  const BOOK_EXPECTED = (function () {
    const seen = {};
    let n = 0;
    BOOK_WORDS.forEach(function (w) {
      const k = w.toLowerCase();
      if (seen[k] === undefined) { seen[k] = 1; n++; }
    });
    return n;
  })();
  const BOOK_INTRA_DUP = BOOK_WORDS.length - BOOK_EXPECTED;

  await check('教材页 onLoad：落在册次列表（20 册），此时一册词表都没加载', function () {
    resetWorld();
    const cachedCurriculum = function () {
      return Object.keys(require.cache).filter(function (k) {
        return k.indexOf(path.join(ROOT, 'data', 'curriculum')) === 0;
      });
    };
    // 本段开头 require 过 wy7s_2024（用例的数据口径），先摘掉它，剩下的才算"页面加载的"
    delete require.cache[path.join(ROOT, 'data', 'curriculum', 'wy7s_2024.json')];

    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'books', '首次进入应停在册次列表');
    assert.strictEqual(p.data.books.length, 20, '册次列表应有 20 册，实际 ' + p.data.books.length);
    assert.strictEqual(p.data.units.length, 0, '还没选册，不该有单元');
    assert.deepStrictEqual(cachedCurriculum().map(function (k) { return path.basename(k); }), [],
      '光进列表页不该加载任何一册词表（20 册全进内存，两级列表就白做了）');
  });

  await check('教材页 打开一册：7 个单元 / 295 词，初始全未选', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    assert.strictEqual(p.data.stage, 'units', '打开一册后应进入单元列表');
    assert.strictEqual(p.data.total, BOOK.words.length, 'total 应为 ' + BOOK.words.length);
    assert.strictEqual(p.data.units.length, 7, '单元数应为 7，实际 ' + p.data.units.length);
    assert.strictEqual(p.data.nonePicked, true, '初始 nonePicked 应为 true');
    assert.strictEqual(p.data.allPicked, false, '初始 allPicked 应为 false');
    assert.strictEqual(p.data.pickedCount, 0, '初始 pickedCount 应为 0');
    assert.ok(String(p.data.book).length > 0, 'book 名称不应为空');
  });

  await check('教材页 各单元 count 与数据实际条数逐一致（7 个单元）', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    const byUnit = {};
    BOOK.words.forEach(function (w) {
      const u = String(w.unit || '').trim();
      byUnit[u] = (byUnit[u] || 0) + 1;
    });
    p.data.units.forEach(function (u) {
      assert.strictEqual(u.count, byUnit[u.name],
        '单元 ' + u.name + ' 的 count 应为 ' + byUnit[u.name] + '，实际 ' + u.count);
    });
    const sum = p.data.units.reduce(function (s, u) { return s + u.count; }, 0);
    assert.strictEqual(sum, BOOK.words.length, '各单元 count 之和应等于总词数');
  });

  await check('教材页 selectAll / clearAll：派生状态与 pickedCount 正确', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    assert.strictEqual(p.data.pickedCount, BOOK.words.length, 'selectAll 后 pickedCount');
    assert.strictEqual(p.data.allPicked, true);
    assert.strictEqual(p.data.nonePicked, false);
    p.clearAll();
    assert.strictEqual(p.data.pickedCount, 0);
    assert.strictEqual(p.data.allPicked, false);
    assert.strictEqual(p.data.nonePicked, true);
  });

  await check('教材页 toggleUnit：单单元词数正确，且不误改其它单元', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    const u0 = p.data.units[0];
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    assert.strictEqual(p.data.pickedCount, u0.count);
    assert.strictEqual(p.data.units[0].picked, true);
    assert.strictEqual(p.data.units[1].picked, false, '不应误改相邻单元');
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    assert.strictEqual(p.data.pickedCount, 0, '再次点击应取消选择');
  });

  await check('教材页 doImport 未选单元：提示且导入过程零存储写入', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    // 两点都试：还在册次列表时点导入、以及进了册但一个单元没选，给的是同一句提示。
    // 「零写入」按**导入动作前后**的增量算 —— 打开一册本身会记下"上次选的册"
    // （curriculum_last_book），那是册次记忆功能应有的写入，不是导入造成的。
    p.doImport();
    assert.strictEqual(lastToast(), '先选一个单元', '册次列表上点导入应提示先选单元');
    assert.strictEqual(setCalls, 0, '未选单元时不该写存储');

    enterBook(p);
    const writesBefore = setCalls;
    p.doImport();
    assert.strictEqual(lastToast(), '先选一个单元', '进了册但没选单元，提示应一致');
    assert.strictEqual(setCalls - writesBefore, 0, '未选单元时不该写存储（进了册也一样）');
  });

  await check('教材页 全量导入：落库 ' + BOOK_EXPECTED + ' 条、Toast 含跳过数、选择被清空', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    assert.strictEqual(store.loadWords().length, BOOK_EXPECTED,
      '应落库 ' + BOOK_EXPECTED + ' 条（295 减去批次内同形 ' + BOOK_INTRA_DUP + ' 条）');
    assert.strictEqual(lastToast(), '已导入 ' + BOOK_EXPECTED + ' 个词，跳过 ' + BOOK_INTRA_DUP + ' 个',
      '实际提示：' + lastToast());
    assert.strictEqual(p.data.pickedCount, 0, '导入成功后应清空选择');
  });

  await check('★ 教材页 18 条多词短语全部以完整形态入库，且不产生截断假单词', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const set = new Set(store.loadWords().map(function (w) { return w.word; }));
    const missing = BOOK_MULTI.filter(function (w) { return !set.has(w); });
    assert.strictEqual(missing.length, 0, '这些短语没以完整形态入库：' + missing.join(' / '));
    // 反向：不得凭空出现被截断出来的假单词（如 as dead as dodo 的 "as" / "as dead as"）
    const heads = new Set();
    BOOK_MULTI.forEach(function (w) { heads.add(w.split(/\s+/)[0]); });
    const ghost = Array.from(heads).filter(function (h) {
      return set.has(h) && BOOK_MULTI.indexOf(h) === -1;
    });
    assert.strictEqual(ghost.length, 0, '出现被截断的假单词：' + ghost.join(' / '));
  });

  await check('★ 教材页 最长短语（' + BOOK_LONGEST + '）整条入库，非只存前 3 词', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const set = new Set(store.loadWords().map(function (w) { return w.word; }));
    assert.ok(set.has(BOOK_LONGEST), '缺少完整形态：' + BOOK_LONGEST);
    const truncated = BOOK_LONGEST.split(/\s+/).slice(0, 3).join(' ');
    assert.ok(!set.has(truncated), '出现 3 词截断形态（WORD_RE 上限的典型后果）：' + truncated);
  });

  await check('教材页 重复导入整册：明说这一册已导入，词库规模不变', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const n1 = store.loadWords().length;
    p.selectAll();
    p.doImport();
    // 2026-09-17 起整册重导走"这一册已经导入过"的判定（重合 100%），
    // 不再报「已导入 1 个词，跳过 294 个」；两者都不写盘，这里守住"规模不变"
    assert.strictEqual(lastToast(), '这一册的词已经在你的词库里了', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n1, '重复导入不得改变词库规模');
  });

  await check('教材页 部分导入：只导入第 1 单元时落库数与该单元 count 一致', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    const c0 = p.data.units[0].count;
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    p.doImport();
    assert.strictEqual(store.loadWords().length, c0);
    assert.strictEqual(lastToast(), '已导入 ' + c0 + ' 个词', '实际提示：' + lastToast());
  });

  await check('★ 教材页 末单元导入：词归属正确，不混入其它单元', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    const idx = p.data.units.length - 1;
    const name = p.data.units[idx].name;
    const want = new Set(BOOK.words.filter(function (w) { return String(w.unit || '').trim() === name; })
      .map(function (w) { return String(w.word || '').trim(); }));
    p.toggleUnit({ currentTarget: { dataset: { i: idx } } });
    p.doImport();
    const got = store.loadWords().map(function (w) { return w.word; });
    assert.strictEqual(got.length, want.size, name + ' 落库数应为 ' + want.size + '，实际 ' + got.length);
    const wrong = got.filter(function (w) { return !want.has(w); });
    assert.strictEqual(wrong.length, 0, name + ' 混入了其它单元的词：' + wrong.join(' / '));
  });

  /*---- 2026-09-17 两级改造：新增册次选择 + 记住上次选的册 + 已导入判定 ----*/

  await check('★ 教材页 册次列表：20 册的书名/词数逐册与 JSON 实际内容一致', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    const listed = p.data.books;
    assert.strictEqual(listed.length, 20, '应列出 20 册，实际 ' + listed.length);

    // 逐册拿 JSON 实际值对账（书名/词数来自 book 与 words.length，不是硬编码）
    const dir = path.join(ROOT, 'data', 'curriculum');
    const diskFiles = fs.readdirSync(dir)
      .filter(function (f) { return f.endsWith('.json') && f !== 'missing.json'; });
    assert.strictEqual(diskFiles.length, 20, '磁盘上应有 20 册词书');

    listed.forEach(function (b) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, b.id + '.json'), 'utf8'));
      assert.strictEqual(b.name, data.book, b.id + ' 书名不符：' + b.name);
      assert.strictEqual(b.count, data.words.length,
        b.id + ' 词数不符：列表 ' + b.count + ' vs 数据 ' + data.words.length);
      assert.ok(b.count > 0, b.id + ' 词数不为正');
    });

    // 排序：年级从低到高（册次列表要让学生顺着年级找）
    const gradeNum = function (g) { return Number(String(g).slice(1)); };
    for (let i = 1; i < listed.length; i++) {
      assert.ok(gradeNum(listed[i - 1].grade || 'g0') <= gradeNum(listed[i].grade || 'g0'),
        '年级顺序倒退：' + listed[i - 1].name + ' → ' + listed[i].name);
    }
  });

  await check('★ 教材页 每次进页只加载点开的那一册（内存里不留其它册）', function () {
    resetWorld();
    const dirPath = path.join(ROOT, 'data', 'curriculum');
    const cachedBooks = function () {
      return Object.keys(require.cache)
        .filter(function (k) { return k.indexOf(dirPath) === 0; })
        .map(function (k) { return path.basename(k); });
    };
    // 本段前几个用例已经点开过七上，先清掉缓存，才能干净地观察"进页加载了什么"
    Object.keys(require.cache).forEach(function (k) {
      if (k.indexOf(dirPath) === 0) delete require.cache[k];
    });

    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    assert.deepStrictEqual(cachedBooks(), [], '还没点册，不该加载任何词表');

    enterBook(p, 'wy8s');
    assert.deepStrictEqual(cachedBooks(), ['wy8s.json'],
      '打开八年级上册后，内存里应只有这一册，实际：' + cachedBooks().join(', '));
    assert.strictEqual(p.data.total, 313, '八上应为 313 词');

    p.backToBooks();
    assert.strictEqual(p.data.stage, 'books', '换一册应回到册次列表');
    assert.strictEqual(p.data.units.length, 0, '回到列表后不该还留着上一册的单元');
    assert.strictEqual(p.data.pickedCount, 0, '回到列表后不该还留着选择');

    enterBook(p, 'wy9x');
    assert.deepStrictEqual(cachedBooks().sort(), ['wy8s.json', 'wy9x.json'],
      '换册不该把已点过的册从缓存里清掉（重复进入走缓存，不重复解析）');
  });

  await check('★ 教材页 记住上次选的册：下次进页直达那一册，数据换过则退回列表', function () {
    resetWorld();
    let p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p, 'wy8s');
    assert.strictEqual(memory['curriculum_last_book'], 'wy8s', '打开一册后应记住它的 id');

    // 再进页面（模拟学生下次打开）→ 直接落在八上，不再是册次列表
    p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'units', '上次选过就该直达单元列表');
    assert.strictEqual(p.data.book, '外研版初中英语八年级上册', '直达的册不对：' + p.data.book);
    assert.strictEqual(p.data.total, 313, '直达时词数也应是该册的');

    // 记的册若已不在册次表里（教材数据换过），安静退回册次列表，不白屏不报错
    memory['curriculum_last_book'] = 'this_book_is_gone';
    p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'books', '记的册失效时应退回册次列表');
    assert.strictEqual(p.data.books.length, 20, '退回后册次列表仍应是完整的 20 册');
  });

  await check('★ 教材页 旧版册（无单元划分）：整册收进「全部单词」一格，导入即整册', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p, 'wy8s');   // 旧版册没有 unit 字段
    assert.strictEqual(p.data.units.length, 1,
      '无单元划分的册应只有一格，实际 ' + p.data.units.length);
    assert.strictEqual(p.data.units[0].name, '全部单词', '格子名应为「全部单词」，实际 ' + p.data.units[0].name);
    assert.strictEqual(p.data.units[0].count, 313, '该格词数应等于整册词数');

    p.selectAll();
    p.doImport();
    assert.strictEqual(store.loadWords().length, 313, '应整册 313 词入库');
    assert.strictEqual(lastToast(), '已导入 313 个词', '实际提示：' + lastToast());
  });

  await check('★ 教材页 预置场景：词库已预置这一册（首次启动的 295 词），再导入同一册 → 明说「这一册的词已经在你的词库里了」', function () {
    resetWorld();
    // 首次启动：app.js 用 data/textbook-7a.js 预置了七上 295 词
    const SEED_TEXTBOOK = require(path.join(ROOT, 'data', 'textbook-7a.js'));
    store.addItems(SEED_TEXTBOOK.words.map(function (w) {
      return { word: w.word, meaning: w.meaning };
    }));
    const n0 = store.loadWords().length;
    assert.strictEqual(n0, 295, '预置后应有 295 词，实际 ' + n0);

    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    // 旧文案是「已导入 1 个词，跳过 294 个」——看着像出错，其实只是同一册重来一遍
    assert.strictEqual(lastToast(), '这一册的词已经在你的词库里了', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n0, '不该新增任何词条（也不该报跳过数）');
    // 没导入任何词 == 没发生写入，选择保留原样（与 add 页"全重复时不吞掉用户输入"同口径），
    // 学生可以换个单元再试，不用重新勾一遍
    assert.strictEqual(p.data.pickedCount, p.data.total, '提示已导入时不改选择（并未写盘）');
  });

  await check('★ 教材页 换另一册导入：与已有词重合 52 条 → 只新增 261、跳过 52，不重复入库', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);                 // 七上 295 词
    p.selectAll();
    p.doImport();
    const n1 = store.loadWords().length;

    p.backToBooks();
    enterBook(p, 'wy8s');         // 八上 313 词，其中 52 条七上已有（16.6%，没到"已导入"门槛）
    p.selectAll();
    p.doImport();
    assert.strictEqual(store.loadWords().length, n1 + 261,
      '八上应新增 261 条（313 减去与七上重合的 52），实际多了 ' + (store.loadWords().length - n1));
    assert.strictEqual(lastToast(), '已导入 261 个词，跳过 52 个',
      '重合率没到门槛就该按普通导入说，实际提示：' + lastToast());
  });

  await check('★ 教材页 同一册已导过大半（重合 >90%）→ 提示已导入，不重复写盘', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();                 // 先把七上导进来
    const n1 = store.loadWords().length;

    // 再只选一个单元导入：这些词全都已在词库里（重合 100%）
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    p.doImport();
    assert.strictEqual(lastToast(), '这一册的词已经在你的词库里了', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n1, '不该新增词条');
  });

  await check('★ 跨路径：同一短语走教材页与走 add 页批量粘贴，得到同一形态', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const viaBook = store.loadWords().filter(function (w) { return w.word === BOOK_LONGEST; });
    assert.strictEqual(viaBook.length, 1, '教材路径应得到 1 条：' + BOOK_LONGEST);

    resetWorld();
    const a = mount('pages/add/add.js');
    a.setData({ batch: BOOK_LONGEST + ' 彻底死亡' });
    a.saveBatch();
    const viaPaste = store.loadWords();
    assert.strictEqual(viaPaste.length, 1,
      '粘贴路径应得到 1 条，实际 ' + viaPaste.length + ' 条：' +
      viaPaste.map(function (w) { return w.word; }).join(' / '));
    assert.strictEqual(viaPaste[0].word, BOOK_LONGEST, '两条路径的 word 形态必须一致');
  });

  await check('★ 跨路径：18 条教材短语逐条走批量粘贴，全部整条入库且释义不被吞', function () {
    BOOK_MULTI.forEach(function (phrase) {
      resetWorld();
      const a = mount('pages/add/add.js');
      a.setData({ batch: phrase + ' 测试释义' });
      a.saveBatch();
      const lib = store.loadWords();
      assert.strictEqual(lib.length, 1,
        '「' + phrase + '」应得 1 条，实际 ' + lib.length + ' 条：' +
        lib.map(function (w) { return w.word; }).join(' / '));
      assert.strictEqual(lib[0].word, phrase, '「' + phrase + '」形态被改变为「' + lib[0].word + '」');
      assert.strictEqual(lib[0].meaning, '测试释义',
        '「' + phrase + '」释义应为「测试释义」，实际「' + lib[0].meaning + '」');
    });
  });

  await check('★ 跨路径：教材已导入后粘贴同一短语 → 识别为重复而非截断新增', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const n1 = store.loadWords().length;
    const a = mount('pages/add/add.js');
    a.setData({ batch: BOOK_LONGEST + ' 彻底死亡' });
    a.saveBatch();
    assert.strictEqual(store.loadWords().length, n1, '不得新增任何词条');
    assert.strictEqual(lastToast(), '这些词都已经在词库里了', '实际提示：' + lastToast());
  });

  await check('★ 教材导入后下游三页出数正常（deck / study / stats）', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const n = store.loadWords().length;

    // 词库页：导入的 295 词应当全部可见、全部到期、且没有一个被误判成"已掌握"
    const deck = mount('pages/deck/deck.js');
    deck.onShow();
    assert.strictEqual(deck.data.overall.total, n, 'deck 总数应为 ' + n + '，实际 ' + deck.data.overall.total);
    assert.strictEqual(deck.data.overall.fresh, n, '新导入的词都该是"未学"');
    assert.strictEqual(deck.data.dueCount, n, '新词都应到期，实际 ' + deck.data.dueCount);
    assert.ok(Number.isFinite(deck.data.overall.mastered), 'mastered 不应是 NaN');

    // 复习页：队列受「学习量」设置限制 —— 这是 2026-09-17 新增的行为。
    // 学生设了"每天 10 个新词"，队列就**不应该**把 294 个词全排上，
    // 那对初中生是劝退的，而且设置项会变成假的。
    const study = mount('pages/study/study.js');
    study.onLoad();
    const cfg = require(path.resolve(__dirname, '..', 'miniprogram', 'utils', 'settings.js')).load();
    const cap = (cfg.dailyNewWords || 10) + (cfg.dailyReviewMax || 30);
    assert.ok(study.data.queue.length <= cap,
      '队列 ' + study.data.queue.length + ' 应受学习量上限 ' + cap + ' 约束');
    assert.ok(study.data.queue.length > 0, '队列不该为空');
    // 被挡住的部分要如实告知（否则学生会以为词库只有这么多）
    const hidden = study.data.hiddenNew + study.data.hiddenReview;
    assert.ok(hidden > 0, '应提示还有多少词在排队，实际 hidden=' + hidden);
    assert.strictEqual(study.data.queue.length + hidden, n,
      '队列 + 被挡住的应等于总数：' + study.data.queue.length + '+' + hidden + ' != ' + n);

    // 统计页：新词零记录，指标应显示"引导"而不是 0 或 NaN
    const stats = mount('pages/stats/stats.js');
    stats.onShow();
    assert.strictEqual(stats.data.points, 0, '新词 points 应为 0，实际 ' + stats.data.points);
    assert.strictEqual(stats.data.self.hasData, false, '无复习记录时 hasData 应为 false');
    assert.strictEqual(stats.data.overall.total, n, '统计页总数应与词库一致');
    ['avgEF', 'firstTryRate', 'retainedRatio'].forEach(function (k) {
      assert.ok(!/NaN/.test(String(stats.data.self[k])), k + ' 不得含 NaN，实际 ' + stats.data.self[k]);
    });
  });

  await check('★ 教材导入 → 复习评分 → 统计出数（跨 3 页端到端闭环）', function () {
    resetWorld();
    const p = mount('pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    p.doImport();

    const study = mount('pages/study/study.js');
    study.onLoad();
    study.flipCard();
    study.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();

    const stats = mount('pages/stats/stats.js');
    stats.onShow();
    assert.strictEqual(stats.data.points, 3, '答对一次 q=5 应得 3 分，实际 ' + stats.data.points);
    assert.strictEqual(stats.data.self.hasData, true, '有复习记录后 hasData 应为 true');
    assert.ok(!/NaN/.test(String(stats.data.self.firstTryRate)), 'firstTryRate 不得含 NaN');
    assert.ok(stats.data.reviewDist.some(function (d) { return d.label === '1 轮' && d.value === 1; }),
      '应有一张卡进入"1 轮"档');
  });

  /*----------------- 汇总 -----------------*/
  global.setTimeout = realSetTimeout;
  restoreConsole();

  console.log('\n' + '='.repeat(62));
  console.log('>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  const hardFail = failedNames.filter(function (n) { return failedPending.indexOf(n) === -1; });
  if (hardFail.length > 0) {
    console.log('\n【已通过组失败】' + hardFail.length + ' 项（属回归，需立即处理）：');
    hardFail.forEach(function (n) { console.log('  - ' + n); });
  }
  if (failedPending.length > 0) {
    console.log('\n【待修转绿】' + failedPending.length + ' 项（工程师修复后应全部转 PASS，即为验收通过）：');
    failedPending.forEach(function (n) { console.log('  - ' + n); });
  } else if (fail === 0) {
    console.log('\n修复验收标准全部转绿（待修组为空）。');
  } else {
    console.log('\n待修组为空 —— 上面的失败全部属【已通过组】回归，不受 --allow-pending 影响。');
  }
  console.log('='.repeat(62));

  if (fail === 0) {
    if (ALLOW_PENDING) {
      console.log('\n注意：本次带了 --allow-pending，但待修组已全部转绿，该开关已无作用 ——');
      console.log('      请从命令中移除，避免日后真回归被它悄悄放行。');
    }
    process.exit(0);
  }
  if (ALLOW_PENDING && hardFail.length === 0) {
    // footgun 防护：--allow-pending 会放行"待修验收项"的失败。若放任使用，
    // 一个**新引入**的缺陷只要被标成 pendingFix 就能绕过门禁。因此要求失败项
    // 必须落在已知清单里 —— 清单外的一律 exit 1，逼着人来更新清单（而非静默放行）。
    const unknown = failedPending.filter(function (n) { return KNOWN_PENDING.indexOf(n) === -1; });
    if (unknown.length > 0) {
      console.log('\n⚠️  --allow-pending 拒绝放行：以下失败项不在已知待修清单中（可能是新引入的缺陷）');
      unknown.forEach(function (n) { console.log('  - ' + n); });
      console.log('   若确认它属于"待修验收标准"，请显式加入 KNOWN_PENDING 并同步本文件头部说明。');
      process.exit(1);
    }
    console.log('\n' + '!'.repeat(62));
    console.log('⚠️  --allow-pending 已生效：本次放行了 ' + failedPending.length + ' 项待修验收项的失败。');
    console.log('    这 ' + failedPending.length + ' 项**没有被校验**，退出码 0 不代表全部通过：');
    failedPending.forEach(function (n) { console.log('      · ' + n); });
    console.log('    缺陷修复完成后必须去掉该参数重跑，否则本门禁形同虚设。');
    console.log('!'.repeat(62));
    process.exit(0);
  }
  process.exit(1);
})().catch(function (e) {
  global.setTimeout = realSetTimeout;
  restoreConsole();
  console.error('verify-pages 运行期异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
