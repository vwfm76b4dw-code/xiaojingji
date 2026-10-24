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
let modalInput = null;           // editable 弹窗回传的输入内容（null = 结果不带 content 字段）

/* ---- 1.3 可控定时器：只入队，由 flushTimers() 手动推进 ----
 *
 * 2026-09-24 补 clearTimeout：原来只替身了 setTimeout，clearTimeout 走真实实现，
 * 而真实实现对一个数字 id 是**静默无效**的 —— 于是"取消定时器"的代码在测试里
 * 从来没被验证过：clear 之后 flush 照样把回调跑掉。
 * 开屏动画的"点击跳过"正是靠 clearTimeout 生效，这个缺口必须先补上。
 * 队列元素随之从「函数」变成「{id, fn}」，flushTimers 相应取 .fn。 */
let sfxCalls = [];      // 已播放的音效 src（createInnerAudioContext 替身写入）
let timerQueue = [];
let timerSeq = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = function (fn) {
  timerSeq += 1;
  timerQueue.push({ id: timerSeq, fn: fn });
  return timerSeq;
};
global.clearTimeout = function (id) {
  timerQueue = timerQueue.filter(function (t) { return t.id !== id; });
};

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
    batch.forEach(function (t) { t.fn(); });
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
      const res = { confirm: modalDecision === 'confirm', cancel: modalDecision === 'cancel' };
      // editable 弹窗（基础库 2.17.1+）在 res.content 里回传输入 —— renameBook 依赖它
      if (modalInput !== null) res.content = modalInput;
      o.success(res);
    }
  },
  navigateTo: function (o) { calls.navigateTo.push(o && o.url); },
  switchTab: function (o) { calls.switchTab.push(o && o.url); },
  // stats.js 的 draw() 用得到；桩不执行回调，只保证不抛错
  createSelectorQuery: function () {
    /**
     * 选择器查询替身。
     *
     * ⚠️ `in(component)` 必须支持 —— 它是"在自定义组件内查询"，
     * deck 页会用它拿自定义 tabBar / 组件的节点。
     * 第一版替身只有 select→fields→exec，于是所有调 `.in()` 的用例
     * 一律炸 `wx.createSelectorQuery(...).in is not a function`，
     * 而报错信息完全指不到真正的原因（看着像页面代码坏了）。
     *
     * 替身直接返回自身：本层只关心"页面数据与跳转对不对"，
     * 不驱动真实布局，所以作用域链在这里没有意义。
     */
    const q = {
      in: function () { return q; },
      select: function () { return { fields: function () { return { exec: function () {} }; } }; },
      selectAll: function () { return { fields: function () { return { exec: function () {} }; } }; }
    };
    return q;
  },
  getWindowInfo: function () { return { pixelRatio: 2 }; },
  getSystemInfoSync: function () { return { pixelRatio: 2 }; },
  // 小程序真机上 nextTick 是"下一帧"，stats 页用它等 canvas 节点就绪后再画。
  // 桩里同步执行回调即可（测试关心的是"回调里读到的数据对不对"，不是时序）。
  nextTick: function (fn) { if (typeof fn === 'function') fn(); },
  /**
   * 录音/播放器替身 —— 朗读页（pronounce）onLoad 会取这两个对象。
   * 方法全部空实现：本层只关心"页面的数据与跳转对不对"，不驱动真实录音。
   * 有了它们，朗读页的入口（goStudy）才能被真跑一遍，而不是只做源码文本断言。
   */
  getRecorderManager: function () {
    const noop = function () {};
    return { onStart: noop, onStop: noop, onError: noop, onFrameRecorded: noop, start: noop, stop: noop };
  },
  createInnerAudioContext: function () {
    const noop = function () {};
    return {
      src: '', playbackRate: 1,
      /**
       * 记录播放了哪些音效（只记 src，不记别的）。
       * 为什么要记：音效是"响了没有"这类**没有返回值**的行为，不记就只能靠肉眼听；
       * 而"完成时该放结算音 / 空态不该放庆祝音"是有明确契约的，值得被断言。
       */
      play: function () { if (this.src) sfxCalls.push(this.src); },
      pause: noop, stop: noop, destroy: noop, seek: noop,
      onEnded: noop, onError: noop, onPlay: noop, onStop: noop
    };
  },
  // cloud 默认不存在 → ai.isAvailable() === false，即"云开发未开通"场景
};

/* ---- 1.5 Page / Component / getApp 替身 ---- */
let captured = null;
global.Page = function (cfg) { captured = cfg; return cfg; };
global.Component = function () { return {}; };
/**
 * app 替身必须是**同一个对象**，不能每次调用新建一个。
 *
 * 原来写的是 `return { globalData: {} }` —— 每次 getApp() 都拿到全新对象，
 * 等于把「跨页、跨生命周期保存的标记」整类状态从测试视野里抹掉了。
 * 后果：页面里写 `if (app.globalData.x) return;` 这类"只做一次"的逻辑，
 * 测试里**永远走第一次分支**，看起来正常，实际完全没被验证。
 * （2026-09-24 加开屏动画时发现：开屏"只放一次"的断言在这套替身下不可能通过。）
 */
const APP_STUB = { globalData: {} };
global.getApp = function () { return APP_STUB; };

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
function mount(rel, opts) {
  const inst = instantiate(loadPage(rel));
  // 2026-09-19：学后拼写默认开（产品行为）。页面逻辑门禁只测打分与推进本身，
  // 统一给 study 页注入关闭标记，避免每个用例都先处理拼写挂起。
  //
  // 2026-09-21 修 —— 这个注入本身就是缺陷来源：它把**产品默认配置**整条路径
  // 从门禁视野里删掉了。study.js:1022 的裸标识符 `singleMode` 只在
  // spellCheck=true 时可达，于是「复习完一轮」抛 ReferenceError、页面冻结
  // 这个 P0 逃过了全部 4 道相关门禁（含两道自称"真实引擎"的门）。
  // 教训：为测试方便而关掉默认行为 = 把默认行为的回归测试一并关掉。
  // 需要覆盖真实默认值的用例传 { realPrefs: true } 跳过注入。
  //
  // 2026-09-25 语义更新（用户反馈「复习不能只靠自评」的连带）：spellCheck 的
  // 出厂默认值自此**显式定义在 settings.DEFAULTS.spellCheck = true**（此前只活在
  // study.js 的 `prefs.spellCheck !== false` 里，settings.js「所有参数集中在这里」
  // 的承诺对它名存实亡）。本注入因此不再是"绕过旧默认"，而是模拟一个
  // **显式关掉了学后拼写的用户** —— 这仍是真实可达且必须被覆盖的配置
  // （verify-runtime 的同名前置说明同此口径），默认值本身的回归由
  // realPrefs 用例 + verify-reviewUX 的 DEFAULTS 断言承担。
  if (!opts || !opts.realPrefs) {
    if (rel.indexOf('study') !== -1) {
      memory['study_prefs'] = Object.assign({}, memory['study_prefs'], { spellCheck: false });
    }
  }
  return inst;
}

/* ---- 1.7 场景工具 ---- */
function resetWorld() {
  memory = {};
  failNextSet = false;
  failRequestGet = false;
  setCalls = 0;
  calls.toast = []; calls.modal = []; calls.navigateTo = []; calls.switchTab = [];
  modalDecision = 'confirm';
  modalInput = null;
  timerQueue = [];
  sfxCalls = [];
  delete global.wx.cloud;
  // 跨页状态也要复位，否则上一个用例的"已经放过开屏"会漏进下一个用例
  APP_STUB.globalData = {};
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
      ['/pages/add/add', '/pack-curriculum/pages/curriculum/curriculum'],
      '添加页与教材页入口必须存在');
  });

  /*----------------- 成长看板（2026-09-24 新增）-----------------
   * 这一页是留存机制的落点，失效方式同样是"静默"：
   *   · 连胜算错 → 用户看到"我昨天明明学了却断了"，直接不信这个功能；
   *   · 累计天数跟着连胜清零 → 断签的人觉得白干了，再也不回来；
   *   · 护身符不自动消耗 → 兜底机制形同虚设。
   */
  await check('成长看板：空数据不抛错，三个数都是 0', function () {
    resetWorld();
    seedStore([]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.ready, true, '应完成渲染');
    assert.strictEqual(p.data.streak, 0);
    assert.strictEqual(p.data.activeDays, 0);
    assert.strictEqual(p.data.broken, false, '从没学过谈不上断签');
  });

  await check('成长看板：今天有复习 → 今日已打卡、连胜与累计都 ≥ 1', function () {
    resetWorld();
    seedStore([mkWord({ word: 'alpha', history: [{ date: TODAY, q: 5, interval: 1 }] })]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.todayDone, true);
    assert.strictEqual(p.data.streak, 1);
    assert.strictEqual(p.data.activeDays, 1);
  });

  await check('成长看板：积分把拼写与朗读也算进来（旧实现只算复习）', function () {
    resetWorld();
    seedStore([mkWord({ word: 'alpha', history: [{ date: TODAY, q: 5, interval: 1 }] })]);
    memory['pron_records'] = { 'id-alpha': [{ date: TODAY, band: 'pass' }] };
    memory['spell_records'] = { 'id-alpha': [{ date: TODAY, ok: true }] };
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    // 复习 认识 +4，朗读读准 +5，拼写拼对 +3
    assert.strictEqual(p.data.points.review, 4, '复习分');
    assert.strictEqual(p.data.points.pron, 5, '朗读分');
    assert.strictEqual(p.data.points.spell, 3, '拼写分');
    assert.ok(p.data.points.total >= 12, '总分应含三路，实得 ' + p.data.points.total);
  });

  await check('成长看板：断签但有护身符 → 自动盖住，连胜不清零', function () {
    resetWorld();
    // 造 8 天连续（≥7 天 → 送 1 张护身符），最后一天是"前天"，昨天断了
    const hist = [];
    for (let i = 8; i >= 2; i--) {
      hist.push({ date: dateUtil.addDays(TODAY, -i), q: 5, interval: i });
    }
    seedStore([mkWord({ word: 'alpha', history: hist })]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.bridged, 1, '应自动用掉 1 张护身符，实得 ' + p.data.bridged);
    assert.strictEqual(p.data.streak, 8, '连胜应被保住（8 天），实得 ' + p.data.streak);
    assert.ok(Array.isArray(memory['growth_repairs']), '覆盖记录应落盘');
    assert.strictEqual(memory['growth_repairs'].length, 1, '只覆盖昨天那一天');
  });

  await check('成长看板：断签且没护身符 → 明确显示"重新开始"，但累计天数不清零', function () {
    resetWorld();
    const hist = [
      { date: dateUtil.addDays(TODAY, -5), q: 5, interval: 1 },
      { date: dateUtil.addDays(TODAY, -4), q: 5, interval: 2 }
    ];
    seedStore([mkWord({ word: 'alpha', history: hist })]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.streak, 0, '连胜归零');
    assert.strictEqual(p.data.activeDays, 2, '累计天数必须保留 —— 这是断签挽回的关键');
    assert.strictEqual(p.data.broken, true, '应进入断签态（文案不指责，只给下一步）');
  });

  await check('首页连胜条：数字与看板同口径，且点击能进看板', function () {
    resetWorld();
    seedStore([mkWord({ word: 'alpha', history: [{ date: TODAY, q: 5, interval: 1 }] })]);
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    const growth = mount('pages/growth/growth.js');
    growth.onLoad();
    growth.onShow();
    assert.strictEqual(deck.data.streakDays, growth.data.streak,
      '首页与看板的连胜必须一致（口径不同会让用户觉得数据是假的）');
    assert.strictEqual(deck.data.activeDays, growth.data.activeDays, '累计天数同理');
    deck.goGrowth();
    assert.strictEqual(calls.navigateTo[calls.navigateTo.length - 1],
      '/pages/growth/growth', '首页应能进成长看板');
  });

  await check('成长看板：排行榜默认关闭，未开启时不发任何请求', function () {
    resetWorld();
    seedStore([]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.rankOn, false, '排行榜必须默认关闭（唯一会外传数据的功能）');
    assert.strictEqual(p.data.rankList.length, 0);
    assert.strictEqual(p.data.rankErr, '', '未开启时不该显示错误');
  });

  /*----------------- 「再练一组」的额度接线（2026-09-24）-----------------
   * 这一组守的是一个**已经发生过的死功能**：成长看板里花 100 积分买了
   * 「再练一组」，写进了 growth_extra_day，但复习页从来没读过它 ——
   * 用户花了积分什么都不发生，而且不会报错。
   * 断言必须覆盖"额度真的变了"，而不只是"存储键写了"。
   */
  await check('再练一组：没买时额度就是设置值', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    const lim = p.dailyLimits();
    assert.strictEqual(lim.extraBatch, undefined, '没买时不该带 extraBatch');
    assert.strictEqual(lim.dailyNewWords, 10, '应等于设置里的 dailyNewWords');
    assert.strictEqual(p.data.extraBoughtToday, false);
  });

  await check('再练一组：买了之后新词与复习额度各加一批', function () {
    resetWorld();
    seedQueue();
    memory['growth_extra_day'] = TODAY;
    const p = mount('pages/study/study.js');
    p.onLoad();
    const lim = p.dailyLimits();
    assert.strictEqual(lim.dailyNewWords, 10 + 10, '新词额度应 +10，实得 ' + lim.dailyNewWords);
    assert.strictEqual(lim.dailyReviewMax, 30 + 10, '复习额度应 +10，实得 ' + lim.dailyReviewMax);
    assert.strictEqual(lim.extraBatch, 10);
    assert.strictEqual(p.data.extraBoughtToday, true, '界面应知道今天已买');
  });

  await check('再练一组：隔天自动失效（存的是日期，不是布尔）', function () {
    resetWorld();
    seedQueue();
    memory['growth_extra_day'] = dateUtil.addDays(TODAY, -1);
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.dailyLimits().extraBatch, undefined, '昨天买的不该影响今天');
    assert.strictEqual(p.data.extraBoughtToday, false);
  });

  await check('再练一组：端到端 —— 队列真的变长（不只是额度数字变了）', function () {
    resetWorld();
    // 造 30 个到期词，基础额度只能拿到一部分
    const list = [];
    for (let i = 0; i < 30; i++) {
      list.push(mkWord({ id: 'w' + i, word: 'w' + i, nextReview: TODAY, interval: 0 }));
    }
    seedStore(list);

    const base = mount('pages/study/study.js');
    base.onLoad();
    const baseLen = base.data.queue.length;

    memory['growth_extra_day'] = TODAY;
    const withExtra = mount('pages/study/study.js');
    withExtra.onLoad();
    const extraLen = withExtra.data.queue.length;

    assert.ok(baseLen > 0, '基础额度应至少拿到一张，实得 ' + baseLen);
    assert.ok(extraLen > baseLen,
      '买了之后队列必须真的变长：' + baseLen + ' → ' + extraLen);
  });

  /*----------------- 完成页的文案与结算音（2026-09-24）-----------------
   * 两条来自留存研究的规则：
   *   ① 完成时该有一句"人话"，而且**按日期轮换**（每天回来看到新句子本身就是留存）；
   *   ② **空态不放庆祝音** —— "今天没有要复习的词"不是成就，
   *      放一段上行琶音会很怪，像是在庆祝你不用学。
   */
  await check('完成页：空队列给空态文案，且不放结算音', function () {
    resetWorld();
    seedStore([]);            // 没有词 → 队列为空 → 直接进空态完成页
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.done, true, '应进入完成态');
    assert.ok(p.data.doneSay && p.data.doneSay.length > 0, '空态也该有一句话');
    assert.strictEqual(
      sfxCalls.filter(function (s) { return /finish\.wav$/.test(s); }).length, 0,
      '空态不该放结算音，实得 ' + JSON.stringify(sfxCalls));
  });

  await check('完成页：走完一轮会放结算音，且文案按日期轮换（同一天稳定）', function () {
    resetWorld();
    seedStore([mkWord({ id: 'w1', word: 'alpha', nextReview: TODAY, interval: 0 })]);
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    // ⚠️ spellCheck=false 时，评分到"进完成态"之间隔着 190ms 的定时器
    // （留给卡片滑出动画）。不推进定时器的话，看到的还是中间态。
    flushTimers();
    assert.strictEqual(p.data.done, true, '应进入完成态');
    const say1 = p.data.doneSay;
    assert.ok(say1 && say1.length > 0, '完成页应有一句话，实得 ' + JSON.stringify(say1));
    assert.ok(sfxCalls.filter(function (s) { return /finish\.wav$/.test(s); }).length >= 1,
      '完成时应放结算音，实得 ' + JSON.stringify(sfxCalls));

    // 同一个文案库、同一天、同场景 → 必须稳定（随机挑会让文字每次渲染都跳）
    const copyMod = require(path.join(ROOT, 'utils', 'growth-copy.js'));
    assert.strictEqual(copyMod.pick('goalDone', null, p.today), copyMod.pick('goalDone', null, p.today),
      '同一天同一场景的文案必须稳定（否则界面上的字会跳）');
  });

  /*----------------- 音节分色跟着换卡（2026-09-27 修）-----------------
   * WXML 正面与听写背面在 sylParts 非空时渲染它的字母**代替**单词本身。
   * _advanceTo 的普通推进分支（isLast=false 的主路径）曾漏设 sylParts ——
   * 它停在 buildQueue 设的首卡，于是每轮第 2 张起全部显示当册第一个词
   * （用户报的"不管点哪册教材，什么单词都只会显示当册第一个单词"）。
   * stillMore 分支一直带着它，所以只有"重排回来的末尾卡"显示正确 —— 更具迷惑性。
   */
  await check('★ 音节分色跟着换卡：第 2 张起显示当前词的字母，不再停在首卡', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'geography', meaning: '地理' }),
      mkWord({ id: 'w2', word: 'history', meaning: '历史' }),
      mkWord({ id: 'w3', word: 'technology', meaning: '科技' })
    ]);
    const syl = require(path.join(ROOT, 'utils', 'syllable.js'));
    const sylText = function (w) {
      return (syl.displayParts(w) || []).map(function (p) { return p.t; }).join('');
    };
    const partsText = function (inst) {
      return (inst.data.sylParts || []).map(function (p) { return p.t; }).join('');
    };

    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.ok(p.data.queue.length >= 2, '场景需要至少 2 张卡，实得 ' + p.data.queue.length);
    const firstWord = p.data.queue[0].prompt;
    assert.strictEqual(partsText(p), sylText(firstWord), '首卡 sylParts 应是自己的');

    // 推进到第 2 张：sylParts 必须跟着换（修复前它停在首卡 = 每张卡都显示第一个单词）
    p.setData({ flipped: true });
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    const secondWord = p.data.current.prompt;
    assert.notStrictEqual(secondWord, firstWord, '场景要求第 2 张是不同的词');
    assert.strictEqual(partsText(p), sylText(secondWord),
      '第 2 张的 sylParts 应对应第 2 张的词（修复前停在首卡），实得 ' + partsText(p));

    // 推进到第 3 张：同口径再钉一次
    p.setData({ flipped: true });
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(partsText(p), sylText(p.data.current.prompt),
      '第 3 张的 sylParts 仍应对应当前词，实得 ' + partsText(p));
  });

  /*----------------- 单元测验（2026-09-24 新增）-----------------
   * 它是"主动验收"：解锁条件、判分边界、奖励只给一次，三处任一写错
   * 都会让这个功能变成摆设，而且都不报错。
   */
  await check('单元测验：空词库时单元列表为空，不抛错', function () {
    resetWorld();
    seedStore([]);
    const p = mount('pages/quiz/quiz.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.ready, true);
    assert.strictEqual(p.data.units.length, 0);
    assert.strictEqual(p.data.totalUnits, 0);
  });

  await check('单元测验：单元内词没学全 → 不解锁，点进去被拦住', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'apple', meaning: '苹果', unit: 'U1',
               history: [{ date: TODAY, q: 5 }] }),
      mkWord({ id: 'b', word: 'bee', meaning: '蜜蜂', unit: 'U1', history: [] })
    ]);
    const p = mount('pages/quiz/quiz.js');
    p.onLoad();
    p.onShow();
    const u1 = p.data.units[0];
    assert.strictEqual(u1.ready, false, '还差一个词不该解锁');
    assert.strictEqual(u1.missing, 1);

    calls.toast = [];
    p.startUnit({ currentTarget: { dataset: { unit: 'U1' } } });
    assert.strictEqual(p.data.stage, 'units', '不该进入答题态');
    assert.ok(calls.toast.some(function (t) { return /还有 1 个词/.test(t.title || ''); }),
      '应提示还差几个词，实得 ' + JSON.stringify(calls.toast));
  });

  await check('单元测验：学全后能开考，且答对 80% 判通过', function () {
    resetWorld();
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push(mkWord({ id: 'q' + i, word: 'word' + i, meaning: '释义' + i, unit: 'U1',
                         history: [{ date: TODAY, q: 5 }] }));
    }
    seedStore(list);
    const p = mount('pages/quiz/quiz.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.units[0].ready, true, '学全了应解锁');

    p.startUnit({ currentTarget: { dataset: { unit: 'U1' } } });
    assert.strictEqual(p.data.stage, 'running');
    assert.ok(p.data.questions.length > 0);

    // 全部答对
    p.data.questions.forEach(function (q) {
      if (q.type === 'choice') p._answers[q.id] = q.answer;
      else p._answers[q.id] = q.word;
    });
    p._finish();
    assert.strictEqual(p.data.stage, 'result');
    assert.strictEqual(p.data.result.pct, 100);
    assert.strictEqual(p.data.result.passed, true);
    assert.strictEqual(p.data.result.perfect, true, '全对应给传奇标');
    assert.strictEqual(p.data.firstPass, true, '首次通过');
    assert.strictEqual(p.data.gained, 50, '首次通过应得 50 积分');
  });

  await check('单元测验：重复通过不再给积分（否则刷分就能涨称号）', function () {
    resetWorld();
    const list = [];
    for (let i = 0; i < 6; i++) {
      list.push(mkWord({ id: 'q' + i, word: 'word' + i, meaning: '释义' + i, unit: 'U1',
                         history: [{ date: TODAY, q: 5 }] }));
    }
    seedStore(list);
    const p = mount('pages/quiz/quiz.js');
    p.onLoad();
    p.onShow();

    function runOnce() {
      p.startUnit({ currentTarget: { dataset: { unit: 'U1' } } });
      p.data.questions.forEach(function (q) {
        p._answers[q.id] = (q.type === 'choice' ? q.answer : q.word);
      });
      p._finish();
    }
    runOnce();
    assert.strictEqual(p.data.gained, 50);
    runOnce();
    assert.strictEqual(p.data.gained, 0, '第二次通过不该再给积分');
    assert.strictEqual(p.data.firstPass, false);
    // 记录只写一次通过日期
    const rec = memory['quiz_records']['U1'];
    assert.ok(rec.passedAt, '通过日期应落盘');
    assert.strictEqual(rec.attempts, 2, 'attempts 应累计到 2');
  });

  await check('单元测验：答错不扣分、重考只刷新最好成绩', function () {
    resetWorld();
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push(mkWord({ id: 'q' + i, word: 'word' + i, meaning: '释义' + i, unit: 'U1',
                         history: [{ date: TODAY, q: 5 }] }));
    }
    seedStore(list);
    const p = mount('pages/quiz/quiz.js');
    p.onLoad();
    p.onShow();

    // 第一次：全对
    p.startUnit({ currentTarget: { dataset: { unit: 'U1' } } });
    p.data.questions.forEach(function (q) {
      p._answers[q.id] = (q.type === 'choice' ? q.answer : q.word);
    });
    p._finish();
    assert.strictEqual(memory['quiz_records']['U1'].best, 100);

    // 第二次：全错（故意）
    p.startUnit({ currentTarget: { dataset: { unit: 'U1' } } });
    p.data.questions.forEach(function (q) { p._answers[q.id] = '错的'; });
    p._finish();
    assert.strictEqual(p.data.result.passed, false, '全错不该通过');
    assert.strictEqual(memory['quiz_records']['U1'].best, 100,
      '最好成绩不该被重考砸掉 —— 否则学生不敢重考');
  });

  await check('单元测验：积分并入总积分（可推导，不重复计）', function () {
    resetWorld();
    seedStore([mkWord({ id: 'q0', word: 'apple', meaning: '苹果', unit: 'U1',
                        history: [{ date: TODAY, q: 5 }] })]);
    memory['quiz_records'] = { U1: { best: 90, passedAt: TODAY, attempts: 1 } };
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    assert.strictEqual(p.data.points.quiz, 50, '测验奖励应计入');
    assert.strictEqual(p.data.quizPassed, 1);
    assert.ok(p.data.points.total >= 50, '总分应含测验奖励');
  });

  await check('成长看板：单元测验入口可点', function () {
    resetWorld();
    seedStore([]);
    const p = mount('pages/growth/growth.js');
    p.onLoad();
    p.onShow();
    p.goQuiz();
    assert.strictEqual(calls.navigateTo[calls.navigateTo.length - 1],
      '/pages/quiz/quiz', '看板应能进单元测验');
  });

  /*----------------- 教材：导入 / 管理 / 移除（2026-09-25 修）-----------------
   * 这一组守的是一个**从 2026-09-19 就存在的真 bug**：
   * doImport 里写的是 `else if (!item.unit)`，而教材源数据**每条都自带 unit**，
   * 于是这个分支是死代码 —— 导入的词 unit 停在 "7A Unit 1"，没有册名前缀。
   * 后果：buildManaged() 用 unit 前缀反查册名，永远匹配不上，
   * 学生看到的是"导入成功了，但教材管理里找不到这一册，也就删不掉"。
   * 用户报的"书本无法添加、删除"就是它。
   */
  await check('教材导入：unit 必须带册名前缀（否则管理列表找不到这一册）', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版初中英语七年级上册';
    const words = books.load('wy7s_2024').words;
    const units = Array.from(new Set(words.map(function (w) { return String(w.unit || '').trim(); })));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.words = words;
    p.data.book = BOOK;
    p.data.units = units.map(function (u) {
      return { name: u, count: 1, picked: u === units[0] };
    });
    memory['words'] = [];
    invalidateCardsCache();

    p.doImport();
    const lib = storedWords();
    assert.ok(lib.length > 0, '应导入若干词');
    lib.forEach(function (w) {
      assert.ok(String(w.unit).indexOf(BOOK + ' · ') === 0,
        '词 ' + w.word + ' 的 unit 应带册名前缀，实得 ' + JSON.stringify(w.unit));
    });
  });

  await check('教材管理：导入后能看到这一册，且整册移除真的删掉词', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版初中英语七年级上册';
    const words = books.load('wy7s_2024').words;
    const units = Array.from(new Set(words.map(function (w) { return String(w.unit || '').trim(); })));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.words = words;
    p.data.book = BOOK;
    p.data.units = units.map(function (u) {
      return { name: u, count: 1, picked: u === units[0] };
    });
    memory['words'] = [];
    invalidateCardsCache();
    p.doImport();

    p.buildManaged();
    assert.strictEqual(p.data.managed.length, 1, '管理列表应正好有这一册');
    assert.strictEqual(p.data.managed[0].name, BOOK);
    assert.strictEqual(p.data.managed[0].count, storedWords().length, '统计词数应与实际一致');

    modalDecision = 'confirm';
    p.deleteBook({ currentTarget: { dataset: { orig: BOOK } } });
    assert.strictEqual(storedWords().length, 0, '整册移除后词库应为空，实得 ' + storedWords().length);
  });

  /**
   * 2026-09-25 补（Agent B）：残余 bug 回归组。
   * 用户报"书本无法添加/删除"的主根因（doImport 死分支）已修，但用替身复现
   * 用户场景时又发现两个残余形态，与重命名（TODO-5）一起在这里钉死：
   *   ① 导入成功后点「换一册」回列表 —— 原来只在 onLoad 算一次 managed，
   *      刚导入的册不出现（也删不掉），要退出重进才看得到；
   *   ② 重命名若直接改词条 unit 前缀，buildManaged 的注册表反查会失配，
   *      这本书又从管理列表里消失 —— 所以改名只写本地显示映射；
   *   ③ 被替换下架的 12 册（北京版/课改版）：学生词库里的旧数据必须仍可见、可删，
   *      否则"导入过的书从管理列表消失"以更大规模复发。
   */
  await check('★ 教材管理：导入后点「换一册」回列表，刚导入的册立刻可见（残余 bug 回归）', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版初中英语七年级上册';
    const words = books.load('wy7s_2024').words;
    const units = Array.from(new Set(words.map(function (w) { return String(w.unit || '').trim(); })));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.words = words;
    p.data.book = BOOK;
    p.data.units = units.map(function (u) {
      return { name: u, count: 1, picked: true };
    });
    memory['words'] = [];
    invalidateCardsCache();
    p.doImport();

    // 用户路径：导完点「换一册」—— 不重进页面，直接回列表
    p.backToBooks();
    assert.strictEqual(p.data.stage, 'books');
    assert.strictEqual(p.data.managed.length, 1,
      '导入后回列表应立刻看到这一册，实得 ' + p.data.managed.length + ' 册');
    assert.strictEqual(p.data.managed[0].origName, BOOK);
  });

  await check('★ 教材管理：重命名只改显示名 —— 管理列表不消失、删除仍按原册名生效', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版初中英语七年级上册';
    const words = books.load('wy7s_2024').words;
    const units = Array.from(new Set(words.map(function (w) { return String(w.unit || '').trim(); })));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.words = words;
    p.data.book = BOOK;
    p.data.units = units.map(function (u) {
      return { name: u, count: 1, picked: true };
    });
    memory['words'] = [];
    invalidateCardsCache();
    p.doImport();
    p.buildManaged();

    // 弹窗确认并输入新名
    modalDecision = 'confirm';
    modalInput = '我的七上课本';
    p.renameBook({ currentTarget: { dataset: { orig: BOOK } } });
    assert.strictEqual(p.data.managed.length, 1, '重命名后管理列表不得消失（TODO-5 的设计陷阱）');
    assert.strictEqual(p.data.managed[0].name, '我的七上课本', '显示名应变为改名');
    assert.strictEqual(p.data.managed[0].origName, BOOK, '聚合键必须仍是原册名');
    assert.strictEqual(memory['curriculum_book_meta'][BOOK].displayName, '我的七上课本',
      '映射应持久化到本地存储');

    // 改名后删除仍按原册名前缀整册生效
    modalDecision = 'confirm';
    p.deleteBook({ currentTarget: { dataset: { orig: BOOK } } });
    assert.strictEqual(storedWords().length, 0,
      '改名后整册移除必须仍然删得掉，实得 ' + storedWords().length);
    // 词被删光后管理列表也该空了
    assert.strictEqual(p.data.managed.length, 0);
  });

  await check('★ 教材管理：已下架册（北京版等）的旧数据仍可见、可整册移除（防幽灵书复发）', function () {
    resetWorld();
    const RETIRED = '北京版小学英语一年级上册';
    seedStore([
      mkWord({ id: 'r1', word: 'apple', meaning: '苹果', unit: RETIRED + ' · 上半' }),
      mkWord({ id: 'r2', word: 'banana', meaning: '香蕉', unit: RETIRED + ' · 下半' })
    ]);

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();   // onLoad 里的 buildManaged 要认得出已下架册名
    const m = p.data.managed.filter(function (x) { return x.origName === RETIRED; });
    assert.strictEqual(m.length, 1, '已下架册必须出现在管理列表里，否则删不掉');
    assert.strictEqual(m[0].retired, true, '应标记 retired，让学生知道不再提供导入');
    assert.strictEqual(p.data.hasRetired, true, '页面应知道存在下架册（显示提示行）');

    modalDecision = 'confirm';
    p.deleteBook({ currentTarget: { dataset: { orig: RETIRED } } });
    assert.strictEqual(storedWords().length, 0,
      '下架册的词必须能整册移除，实得 ' + storedWords().length);
  });

  await check('★ 教材导入：外研社新册的自带记忆钩子（mnemonic）随词条入库并映射为卡 hook', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版小学英语三年级上册（三年级起点）';
    const words = books.load('wy3s').words;   // 新册每词自带 mnemonic
    const units = Array.from(new Set(words.map(function (w) { return String(w.unit || '').trim(); })));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.words = words;
    p.data.book = BOOK;
    p.data.units = units.map(function (u) {
      return { name: u, count: 1, picked: true };
    });
    memory['words'] = [];
    invalidateCardsCache();
    p.doImport();

    const lib = storedWords();
    const noHook = lib.filter(function (w) { return !w.mnemonic; });
    assert.strictEqual(noHook.length, 0,
      '新册词条应全部带 mnemonic 入库，缺失：' + noHook.slice(0, 3).map(function (w) { return w.word; }).join('/'));
    // store 视图：toCard 把 mnemonic 映射成 hook（study 背面「记忆钩子」区的数据源）
    const hooked = store.loadCards().filter(function (c) { return c.hook; });
    assert.strictEqual(hooked.length, lib.length, 'loadCards 应把 mnemonic 映射为 hook');
  });

  await check('教材自愈：历史数据（无前缀）在打开该册时被修好', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK = '外研版2024新版初中英语七年级上册';
    const words = books.load('wy7s_2024').words;
    const first = words.filter(function (w) { return String(w.unit || '').trim() === '7A Starter'; });

    // 造"旧形态"数据：unit 只有单元名，没有册名前缀
    seedStore(first.map(function (w, i) {
      return mkWord({ id: 'old' + i, word: w.word, meaning: w.meaning, unit: '7A Starter' });
    }));

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    const n = p._repairUnits(BOOK, words);
    assert.strictEqual(n, first.length, '应修好 ' + first.length + ' 个词，实得 ' + n);
    storedWords().forEach(function (w) {
      assert.ok(String(w.unit).indexOf(BOOK + ' · ') === 0, '修好后应带前缀：' + w.unit);
    });
  });

  await check('教材自愈：跨册同名单元不误伤（不同教材都叫 Unit 1）', function () {
    resetWorld();
    const books = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
    const BOOK_A = '外研版2024新版初中英语七年级上册';
    const wordsA = books.load('wy7s_2024').words;

    // 词库里放一个"属于 B 册、但也叫 7A Starter"的词（词表不同）
    seedStore([
      mkWord({ id: 'x1', word: 'zzz-not-in-book-a', meaning: '别的册的词', unit: '7A Starter' })
    ]);

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    const n = p._repairUnits(BOOK_A, wordsA);
    assert.strictEqual(n, 0, '不在本册词表里的词不该被改（否则会把别的册的数据改坏）');
    assert.strictEqual(storedWords()[0].unit, '7A Starter', 'unit 应保持原样');
  });

  /*----------------- 首页「按单元练」入口（2026-09-18 新增）-----------------
   * 这一组守两条产品契约：
   *   ① due > 0 → 显示今天到期张数、点进去走 scope 'due'；
   *      due = 0 → **不是死路**，显示整单元词数、点进去走 scope 'all'
   *      （"明天听写 Unit 2，今天想整单元过一遍"正是这个功能的用途）；
   *   ② 首页显示的数字 === 点进去的队列长度。
   *      这是本项目已立的规矩（见 deck.refresh 的注释）：首页不能和复习页打架，
   *      否则学生看到 10 进去却是 43，或者看到"已练完"点进去空空如也。
   *
   * 为什么口径必须是"数字来源"而不是"写死某个数"：单元行套不套 applyDailyLimits
   * 是这次修复的核心分歧点，写死数字会把"限流条件改回去"这个回归漏掉。
   */
  console.log('\n===== 首页「按单元练」入口 =====');

  /**
   * 夹具：一个"今天有到期"的单元 + 一个"已学完且不到期"的单元。
   *
   * 为什么必须有后者：due = 0 的单元是这次修复的重点（原来固定送 'due'，
   * 于是已学完的单元点进去是空的 = 死路）。只用"有到期"的单元测不出这条分支。
   */
  function seedUnits() {
    const future = dateUtil.addDays(TODAY, 7);
    seedStore([
      mkWord({ id: 'u1a', word: 'alpha', subject: '英语', unit: '7A Unit 1', nextReview: TODAY }),
      mkWord({ id: 'u1b', word: 'beta', subject: '英语', unit: '7A Unit 1', nextReview: TODAY }),
      mkWord({ id: 'u1c', word: 'gamma', subject: '英语', unit: '7A Unit 1', nextReview: TODAY }),
      mkWord({ id: 'u2a', word: 'delta', subject: '英语', unit: '7A Unit 2',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] }),
      mkWord({ id: 'u2b', word: 'epsilon', subject: '英语', unit: '7A Unit 2',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] })
    ]);
  }

  await check('deck 单元入口 due>0：显示到期张数，点击送 pending_study{scope:due}', function () {
    resetWorld();
    seedUnits();
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();

    const row = p.data.units.filter(function (u) { return u.unit === '7A Unit 1'; })[0];
    assert.ok(row, '单元列表里应有 7A Unit 1：' + JSON.stringify(p.data.units.map(function (u) { return u.unit; })));
    assert.strictEqual(row.due, 3, 'Unit 1 有 3 张今天到期，实际 ' + row.due);
    assert.strictEqual(row.count, 3, 'Unit 1 共 3 个词');
    assert.strictEqual(row.learned, 0, 'Unit 1 还没学过');

    calls.switchTab = [];
    p.practiceUnit({ currentTarget: { dataset: { unit: '7A Unit 1', scope: 'due' } } });
    assert.deepStrictEqual(memory['pending_study'], { unit: '7A Unit 1', scope: 'due' },
      '应写入 pending_study 且 scope=due，实际 ' + JSON.stringify(memory['pending_study']));
    assert.strictEqual(calls.switchTab[calls.switchTab.length - 1], '/pages/study/study',
      '应跳到复习页（tabBar 页，只能 switchTab）');
  });

  await check('deck 单元入口 due=0：不是死路 —— 显示整单元词数，点击送 pending_study{scope:all}', function () {
    resetWorld();
    seedUnits();
    const p = mount('pages/deck/deck.js');
    p.onLoad();
    p.onShow();

    const row = p.data.units.filter(function (u) { return u.unit === '7A Unit 2'; })[0];
    assert.ok(row, '单元列表里应有 7A Unit 2');
    assert.strictEqual(row.due, 0, 'Unit 2 今天没有到期的（前置条件）');
    assert.strictEqual(row.count, 2, 'Unit 2 共 2 个词');
    assert.strictEqual(row.learned, 2, 'Unit 2 已学 2/2');

    p.practiceUnit({ currentTarget: { dataset: { unit: '7A Unit 2', scope: 'all' } } });
    assert.deepStrictEqual(memory['pending_study'], { unit: '7A Unit 2', scope: 'all' },
      'due=0 的单元必须送 scope=all（整单元过一遍），否则点进去是空的 = 死路。实际 ' +
      JSON.stringify(memory['pending_study']));
  });

  await check('deck 单元入口：数字来源与 scope 分支同源（due>0 看 due，due=0 看 count）', function () {
    // WXML 的 data-scope 与右侧数字都看 item.due —— 若哪天把数字改成恒取 count，
    // due>0 的单元会显示"共 3 个"却只给 3 张到期里的子集，首页与复习页立刻打架。
    // 这里断言"显示口径"本身：把 units 里的 due/count 与 pickCards 的两种 scope 结果对上。
    resetWorld();
    seedUnits();
    const all = store.loadCards();
    const states = store.loadStates();
    const weak = store.weakIds();
    const rows = schedule.unitsOf(all, states);
    const bad = [];
    rows.forEach(function (u) {
      const dueLen = schedule.pickCards(all, states, TODAY,
        { subject: 'all', scope: 'due', unit: u.unit }, weak).length;
      const allLen = schedule.pickCards(all, states, TODAY,
        { subject: 'all', scope: 'all', unit: u.unit }, weak).length;
      if (dueLen !== 0) return;                 // 有到期时看 due（另一条用例已覆盖）
      if (allLen !== u.count) {
        bad.push(u.unit + '：due=0 时点进去走 scope=all，队列 ' + allLen +
          ' 张，但首页要显示"共 ' + u.count + ' 个"');
      }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n        '));
  });

  await check('deck 单元入口：首页显示的数字 === 点进去复习页的队列长度（逐单元核对）', function () {
    resetWorld();
    seedUnits();
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();

    const rows = deck.data.units.slice();
    assert.ok(rows.length > 1, '前置：至少两个单元，否则入口不该出现');
    const bad = [];
    rows.forEach(function (row) {
      const scope = row.due > 0 ? 'due' : 'all';
      const shown = row.due > 0 ? row.due : row.count;   // 与 deck.wxml 的显示口径一致
      memory['pending_study'] = { unit: row.unit, scope: scope };   // 等价于点这一行
      const study = mount('pages/study/study.js');
      study.onLoad();
      if (study.data.queue.length !== shown) {
        bad.push(row.unit + '：首页显示 ' + shown + '（due=' + row.due + ', count=' + row.count +
          '）但点进去队列 ' + study.data.queue.length + ' 张');
      }
    });
    assert.deepStrictEqual(bad, [],
      '首页数字与复习页队列不一致（学生看到 N 进去却不是 N）：\n        ' + bad.join('\n        '));
  });

  await check('deck 单元入口只在单元数 > 1 时渲染（单单元时是装饰品）', function () {
    const wxml = fs.readFileSync(path.join(ROOT, 'pages', 'deck', 'deck.wxml'), 'utf8');
    const i = wxml.indexOf('practiceUnit');
    assert.ok(i !== -1, 'deck.wxml 里找不到 practiceUnit 的点击入口');
    // 入口所在的那个 <block> 必须带 units.length > 1 的守卫
    const head = wxml.slice(0, i);
    const blockStart = head.lastIndexOf('<block');
    assert.ok(blockStart !== -1, '入口没有被 <block wx:if> 包住');
    const guard = wxml.slice(blockStart, blockStart + 120);
    assert.ok(/wx:if="\{\{!searching && units\.length > 1\}\}"/.test(guard),
      '单元入口的 wx:if 守卫丢了或改错了，实际：' + guard.split('>')[0]);
  });

  /*----------------- 首页「今天要练的」的范围口径（2026-09-19 修）-----------------
   * 产品契约：首页那个数字必须等于**点「开始」后复习页的队列长度**，
   * 且要按 prefs 里的**当前范围**（subject/unit）算 —— 不是全库。
   *
   * 修前的形态：prefs.unit='7A Starter' 时首页显示 38（全库 + 限流），
   * 点「开始」进去是 33（该单元、不限流）—— 数字与动作打架。
   *
   * 为什么口径必须是"数字来源"而不是"写死某个数"：写死 38/33/43 一改夹具就失效，
   * 也守不住"范围算错"与"限流判据分叉"这两类回归（后者正是上一轮漏掉的那半边）。
   */
  console.log('\n===== 首页「今天要练的」范围口径 =====');

  /**
   * 夹具：一个"部分学过、部分新词"的单元 + 一个"大批到期"的单元 + 一个"全新"的单元。
   * 目的是让**全库口径**与**单元口径**在数字上必然不同 —— 若首页仍按全库算，
   * 下面的用例立刻抓到（这正是 2026-09-19 那处打架的形态）。
   */
  function seedRange() {
    memory['settings'] = { dailyNewWords: 10, dailyReviewMax: 30 };
    const due = function (id, unit) {
      return mkWord({ id: id, word: id, subject: '英语', unit: unit,
        interval: 6, nextReview: TODAY, history: [{ q: 5, interval: 6 }] });
    };
    const fresh = function (id, unit) {
      return mkWord({ id: id, word: id, subject: '英语', unit: unit, nextReview: TODAY });
    };
    const list = [];
    list.push(due('s1', '7A Starter'), due('s2', '7A Starter'), due('s3', '7A Starter'));
    list.push(fresh('s4', '7A Starter'), fresh('s5', '7A Starter'));
    for (let i = 0; i < 40; i++) list.push(due('u1_' + i, '7A Unit 1'));
    for (let i = 0; i < 43; i++) list.push(fresh('u2_' + i, '7A Unit 2'));
    seedStore(list);
  }

  /** 走真实跨页路径：deck 点「开始」→ study onLoad，返回队列长度 */
  function queueAfterStart(deck) {
    calls.switchTab = [];
    deck.goStudy();
    assert.strictEqual(calls.switchTab[calls.switchTab.length - 1], '/pages/study/study',
      '「开始」应跳到复习页');
    const study = mount('pages/study/study.js');
    study.onLoad();
    return study.data.queue.length;
  }

  await check('deck 今日任务 unit=all：数字 === 点「开始」后的队列长度（全库 + 限流）', function () {
    resetWorld();
    seedRange();
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: 'all' };
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    // 全库 88 张到期（43 复习 + 45 新词），上限裁成 30 复习 + 10 新词 = 40
    assert.strictEqual(deck.data.dueCount, 40,
      '全库口径应被每日上限裁到 40，实际 ' + deck.data.dueCount);
    assert.strictEqual(deck.data.scopeLabel, '', '不限单元时不该有范围前缀，实际 ' + deck.data.scopeLabel);
    assert.strictEqual(queueAfterStart(deck), deck.data.dueCount,
      '首页数字（' + deck.data.dueCount + '）必须等于点「开始」后的队列长度');
  });

  await check('deck 今日任务 选了单元：数字 === 该单元到期数（不限流），副文案带单元名', function () {
    resetWorld();
    seedRange();
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Starter' };
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    assert.strictEqual(deck.data.dueCount, 5,
      '7A Starter 有 5 张到期（3 复习 + 2 新词），实际 ' + deck.data.dueCount);
    assert.strictEqual(deck.data.scopeLabel, '7A Starter',
      '副文案必须带单元名（否则这个数字是神秘的），实际 ' + deck.data.scopeLabel);
    assert.strictEqual(queueAfterStart(deck), deck.data.dueCount,
      '首页数字必须等于点「开始」后的队列长度（学生看到 N 进去就该是 N）');
  });

  await check('deck 今日任务 未学的新单元：数字 === 点进去的队列长度，不受每日上限打折', function () {
    resetWorld();
    seedRange();
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Unit 2' };
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    assert.strictEqual(deck.data.dueCount, 43,
      '7A Unit 2 的 43 个词全未学 = 全到期，且选单元时不限流，实际 ' + deck.data.dueCount);
    assert.strictEqual(deck.data.scopeLabel, '7A Unit 2');
    assert.strictEqual(queueAfterStart(deck), 43,
      '点进去必须就是这 43 张 —— 被每日上限裁成 10 就是把他刚说的"我只背这一单元"打了折');
  });

  await check('deck 今日任务：范围变了数字跟着变（同一个词库，三个范围三个数）', function () {
    resetWorld();
    seedRange();
    const seen = [];
    [['all', 40], ['7A Starter', 5], ['7A Unit 2', 43]].forEach(function (pair) {
      memory['study_prefs'] = { subject: 'all', scope: 'due', unit: pair[0] };
      const deck = mount('pages/deck/deck.js');
      deck.onLoad();
      deck.onShow();
      seen.push(pair[0] + '=' + deck.data.dueCount);
      assert.strictEqual(deck.data.dueCount, pair[1],
        'unit=' + pair[0] + ' 时应显示 ' + pair[1] + '，实际 ' + deck.data.dueCount);
    });
    assert.strictEqual(new Set(seen).size, 3, '三个范围必须给出三个不同的数字：' + seen.join(', '));
  });

  await check('deck 今日任务：点「开始」不会把复习页留在旧 scope（错题本优先那次的影响）', function () {
    resetWorld();
    seedRange();
    // 模拟"刚点过错题重练"：prefs.scope 还是 weak，unit 被那次重置成 all
    memory['study_prefs'] = { subject: 'all', scope: 'weak', unit: 'all' };
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    const shown = deck.data.dueCount;
    calls.switchTab = [];
    deck.goStudy();
    const study = mount('pages/study/study.js');
    study.onLoad();
    assert.strictEqual(study.data.scope, 'due',
      '「开始」必须把复习页切回 due —— 否则首页写着「今天要练的 ' + shown +
      '」，点进去却是错题本，数字与动作又打架（实际 ' + study.data.scope + '）');
    assert.strictEqual(study.data.queue.length, shown, '队列长度必须等于首页那个数字');
  });

  await check('deck 今日任务：「词库里还有 N 个词没学」保持全库口径（库存 ≠ 今日任务）', function () {
    resetWorld();
    seedRange();
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Starter' };
    const deck = mount('pages/deck/deck.js');
    deck.onLoad();
    deck.onShow();
    // 全库 88 个词里，45 个从未学过（Starter 2 + Unit 2 的 43）
    assert.strictEqual(deck.data.freshTotal, 45,
      '这句的主语是"词库"，说的是库存，不该被当前单元缩小，实际 ' + deck.data.freshTotal);
  });

  await check('deck 今日任务：源码层不许再手写限流判据（必须走 schedule.dailyQueue）', function () {
    const js = fs.readFileSync(path.join(ROOT, 'pages', 'deck', 'deck.js'), 'utf8');
    const viaDailyQueue = (js.match(/schedule\.dailyQueue\s*\(\s*all/g) || []).length;
    assert.strictEqual(viaDailyQueue, 1,
      'deck.refresh 必须经 schedule.dailyQueue 算「今天要练的」（实际 ' + viaDailyQueue + ' 处）—— ' +
      '它内部含范围过滤 + 与复习页同一个限流判据，数字因此与队列天然相等');
    assert.strictEqual(js.indexOf("unit === 'all'"), -1,
      "deck.js 里不该手写限流判据（unit === 'all'）—— 判据只能有一份（utils/schedule.js）");
    assert.strictEqual((js.match(/schedule\.applyDailyLimits\s*\(/g) || []).length, 0,
      'deck.js 不该直接调 applyDailyLimits：那样就绕过了判据，又回到"两页各算一套"');
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

  /**
   * 2026-09-21 新增（回归保护）。
   *
   * 这条用例存在的唯一理由：其余所有 study 用例都被 mount() 注入了
   * spellCheck=false，于是**产品默认配置这条路径零覆盖** —— study.js 的
   * _advanceTo() 完成分支里裸引用了 `singleMode`（作用域链上不存在，
   * let 声明在 buildQueue 内部），默认配置下做完一轮最后一张卡就抛
   * ReferenceError；异常在 setTimeout 回调里无人捕获，而 leaving 已提交为 true，
   * onGrade / flipCard 首行的 leaving 守卫又挡住一切交互 —— 页面彻底冻结。
   *
   * 因此这里必须传 { realPrefs: true }，让页面跑真实默认值。
   * 断言守的是三件事：① 整轮走完不抛错；② leaving 复位（否则界面卡死）；
   * ③ 确实走到了完成页或拼写轮之一（不能停在中途）。
   */
  await check('study 默认配置（spellCheck 未关）走完整轮：不抛错、不冻结、进入完成页或拼写轮', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js', { realPrefs: true });
    p.onLoad();
    assert.strictEqual(p.data.spellCheck, true, '默认应为开启「学后拼写」（这是产品默认行为）');
    const n = p.data.queue.length;
    assert.ok(n > 0, '队列不该为空，否则这条用例没有覆盖力');
    for (let i = 0; i < n; i++) {
      p.flipCard();
      p.onGrade({ currentTarget: { dataset: { q: 5 } } });
      // 定时器回调里的异常会从这里冒出来 —— 这正是要守的东西
      flushTimers();
    }
    assert.strictEqual(p.data.leaving, false,
      '收尾后 leaving 必须为 false（true = 卡片已滑出但流程未收尾，界面冻结）');
    assert.ok(p.data.done === true || p.data.spellRound === true,
      '整轮结束应进入完成页或拼写轮，实际 done=' + p.data.done + ' / spellRound=' + p.data.spellRound);
  });

  /**
   * 2026-09-21 新增（回归保护）。
   *
   * 单卡模式（从卡详情页"练这一张"进来）**不进拼写轮** —— 那一张刚单独练完，
   * 再拼一遍没有意义。这条用例与上一条配对：两条一起才能证明
   * `_advanceTo()` 里的 singleMode 判据读的是**当前队列的模式**，
   * 而不是某个恒为假的值（若判据写死为 false，上一条会通过、这条会失败）。
   */
  await check('study 默认配置 + 单卡模式：跳过拼写轮，直接进完成页', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js', { realPrefs: true });
    p.onLoad();
    p.singleId = p.data.queue[0].id;   // 等价于从卡详情页点"练这一张"
    p.onShow();
    assert.strictEqual(p.data.singleMode, true, '单卡模式应生效');
    assert.strictEqual(p.data.queue.length, 1, '单卡模式队列应只有一张');
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    assert.strictEqual(p.data.leaving, false, '不该卡在 leaving');
    assert.strictEqual(p.data.done, true, '单卡练完应直接进完成页');
    assert.notStrictEqual(p.data.spellRound, true, '单卡模式不该进拼写轮');
  });

  /**
   * 2026-09-18 更新文案：新词走"学习"路径，按钮叫「记住了」而不是「认识」——
   * 因为对从没见过的词说"你认识吗"是问不通的（学生只能蒙）。
   * 2026-09-19 改断言对象：评分反馈从 wx.showToast 换成了**结果条**（page.data.lastResult，
   * 组件来自 prototype-ui ⑦）—— toast 悬浮在换进来的下一张卡上，会遮挡单词（作者点名）。
   * 断言守的契约没变：**结果条里的天数必须与 sm2 算出的 interval 一致**。
   */
  await check('study 结果条文案与新词 interval 一致（新词：「记住了 · N 天后复习」）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    const lr = p.data.lastResult;
    assert.ok(lr, '评分后应有结果条（lastResult）');
    assert.strictEqual(lr.text, '记住了 · 1 天后复习', '实际：' + (lr ? lr.text : '(无)'));
    assert.strictEqual(lr.word, 'alpha', '结果条应带上一张的词形');
  });

  await check('study 结果条文案与已进阶词的 interval 一致（reps2/interval6 → 16 天）', function () {
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
    const lr = p.data.lastResult;
    assert.ok(lr, '评分后应有结果条（lastResult）');
    assert.strictEqual(lr.text, '认识 · 16 天后', '实际：' + (lr ? lr.text : '(无)'));
    assert.strictEqual(lr.word, 'delta', '结果条应带上一张的词形');
    assert.strictEqual(storedWords()[0].interval, 16, 'interval 应与结果条一致');
  });

  await check('study leaving 期间重复点击被忽略（只写库一次）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    let stripCount = 0;
    const origSetData = p.setData;
    p.setData = function (patch, cb) {
      if (patch && patch.lastResult) stripCount++;
      return origSetData.call(this, patch, cb);
    };
    p.onLoad();
    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    assert.strictEqual(p.data.leaving, true, '评分后应进入 leaving');
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();
    const w = storedWords().filter(function (x) { return x.id === 'w1'; })[0];
    assert.strictEqual(w.history.length, 1, '连点不该重复计分，实际 ' + w.history.length + ' 条');
    // 2026-09-19：反馈载体从 toast 换成结果条，"只反馈一次"改用 setData 计数守卫
    assert.strictEqual(stripCount, 1, '连点不该重复提交结果条，实际 ' + stripCount + ' 次');
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

  /*----------------- 跨页请求通道 consumePending（2026-09-18 修的真 bug）-----------------
   *
   * ## 被守的那个 bug
   * 复习页是 tabBar 页 = **长生命周期实例**：wx.switchTab 到已经创建过的 tabBar 页
   * **不重跑 onLoad**，只跑 onShow。而跨页请求原来只在 onLoad 里消费，于是：
   *   · 「练这一张」（card.js 写 single_practice + switchTab）完全失效，
   *     标记留在盘上，等下一次 onLoad 才突然生效 = 幽灵单卡模式；
   *   · 首页「错题重练」（deck.js 写 prefs + switchTab）完全失效
   *     （prefs 落盘了，但页面实例的 this.data.scope 一直是旧值）。
   * 修法：consumePending() 在 onLoad 与 onShow 各调一次，两个键读后即删。
   *
   * ## 为什么这一组必须存在
   * 这是"页面层契约"而不是"算法契约"：算法层 12 道门禁全绿，这个 bug 照样发生
   * —— 因为它压根不涉及算法，只涉及**生命周期**。Node 层用真实生命周期顺序
   * （onLoad 一次 + onShow 多次）驱动实例，就能在没有开发者工具时先兜住一大半；
   * 剩下那一半（真引擎到底跑不跑 onShow）由 verify-devtools.js 兜。
   */
  console.log('\n===== 跨页请求通道（consumePending）=====');

  await check('★ study onShow 消费跨页请求：tabBar 实例不重跑 onLoad 也能切到单卡（本轮 bug 的回归测试）', function () {
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.singleMode, false, '前置：普通队列');
    assert.strictEqual(p.data.queue.length, 3, '前置：3 张');

    /**
     * 卡详情页「练这一张」= 写 single_practice + switchTab。
     * switchTab 到**已创建过**的 tabBar 页只跑 onShow —— 所以这里**只调 onShow**，
     * 一个 onLoad 都不许补。补了就测不出本轮的 bug（那正是修之前"看起来是好的"的原因）。
     */
    memory['single_practice'] = 'w2';
    p.onShow();

    assert.strictEqual(p.data.singleMode, true,
      'onShow 必须消费到请求，否则「练这一张」完全失效（用户看到的是"点了没反应"）');
    assert.strictEqual(p.data.queue.length, 1, '单卡模式队列应只有 1 张，实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.current.id, 'w2', '应是指定的那张卡，实际 ' + p.data.current.id);
    assert.ok(memory['single_practice'] === undefined,
      '标记必须读后即删，否则下次 onLoad 会幽灵式生效');
  });

  await check('study 跨页请求优先级：single_practice 与 pending_study 同时命中时单卡优先，且不套用范围', function () {
    resetWorld();
    seedUnits();
    memory['single_practice'] = 'u2a';
    memory['pending_study'] = { unit: '7A Unit 1', scope: 'all' };
    const p = mount('pages/study/study.js');
    p.onLoad();

    assert.strictEqual(p.data.singleMode, true, '更具体的单卡请求应优先');
    assert.strictEqual(p.data.queue.length, 1, '队列应只有指定的这一张');
    assert.strictEqual(p.data.current.id, 'u2a');

    // 契约②：命中 single_practice 时**不应用** pending_study 的范围
    // （单卡模式下 unit/scope 无意义，套用了反而会让"退出单卡模式后"的范围莫名变化）
    assert.strictEqual(p.data.unit, 'all',
      '单卡模式下不该套用 pending_study 的 unit，实际 ' + JSON.stringify(p.data.unit));
    assert.strictEqual(p.data.scope, 'due',
      '单卡模式下不该套用 pending_study 的 scope，实际 ' + JSON.stringify(p.data.scope));

    // 契约④：两个键都必须被消费掉 —— 否则过期的那次范围请求会变成幽灵
    assert.ok(memory['single_practice'] === undefined, 'single_practice 应被删除');
    assert.ok(memory['pending_study'] === undefined,
      'pending_study 也必须删除（即使这次没应用），否则它会在下一次切页时突然生效');
  });

  await check('study 跨页请求互斥：范围请求命中时必须清掉上次的单卡标记（否则只出现一张卡）', function () {
    resetWorld();
    seedUnits();
    memory['single_practice'] = 'u1a';
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.singleMode, true, '前置：先进入单卡模式');
    assert.strictEqual(p.singleId, 'u1a', '前置：实例上挂着单卡标记');

    // 用户接着从首页点「按单元练」
    memory['pending_study'] = { unit: '7A Unit 1', scope: 'due' };
    p.onShow();

    assert.strictEqual(p.singleId, null,
      '范围请求必须清掉上次的单卡标记，否则这次请求会被串成"只出现一张卡"');
    assert.strictEqual(p.data.singleMode, false, 'singleMode 应同步复位');
    assert.strictEqual(p.data.unit, '7A Unit 1', '应切到请求的单元');
    assert.strictEqual(p.data.queue.length, 3,
      '应是整个 Unit 1 的 3 张（单卡模式退出后不再只剩 1 张），实际 ' + p.data.queue.length);
    const foreign = p.data.queue.filter(function (c) { return c.unit !== '7A Unit 1'; });
    assert.deepStrictEqual(foreign, [], '队列里不该混进其它单元的词');
  });

  await check('study 跨页请求读后即删：消费过的范围请求不会在下一次切页时"幽灵生效"', function () {
    resetWorld();
    seedUnits();
    memory['pending_study'] = { unit: '7A Unit 1', scope: 'all' };
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.unit, '7A Unit 1', '前置：请求已生效');
    assert.strictEqual(memory['pending_study'], undefined, '前置：键已删');

    // 用户改回"全部单元"
    p.setData({ reviewed: 0, done: false });
    p.pickUnit({ currentTarget: { dataset: { unit: 'all' } } });
    assert.strictEqual(p.data.unit, 'all', '前置：已切回全部');

    // 再切走切回（只跑 onShow）—— 若键没删干净，这里会被重新拉回 Unit 1
    p.onShow();
    assert.strictEqual(p.data.unit, 'all',
      '请求已被消费过，不该再次生效（"没人操作但状态变了"是最难排查的一类 bug）');
  });

  await check('study 跨页请求脏值不算请求：{} / 字符串 / 数组 / null 都不改变范围', function () {
    /**
     * 为什么 `{}` 这条最要命：`{}` 在 JS 里是**真值**，`getStorageSync || null` 拦不住它。
     * 若判据写成"pending 存在即请求"，一个空对象就会把 unit 意外重置成 'all' ——
     * 学生刚选好的单元被一个空壳请求悄悄清掉。
     */
    const dirty = [
      { label: '空对象 {}', value: {}, mustDelete: true },
      { label: '字符串', value: 'garbage', mustDelete: true },
      { label: '数组', value: [1, 2], mustDelete: true },
      { label: 'null', value: null, mustDelete: false },
      { label: '空字符串', value: '', mustDelete: false }
    ];
    const bad = [];
    dirty.forEach(function (c) {
      resetWorld();
      seedUnits();
      // 前置：学生已经选了 Unit 1（这是"不能被脏值改掉"的那个状态）
      memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Unit 1' };
      memory['pending_study'] = c.value;
      const p = mount('pages/study/study.js');
      p.onLoad();

      if (p.data.unit !== '7A Unit 1') {
        bad.push(c.label + ' 被当成了请求：unit 变成 ' + JSON.stringify(p.data.unit));
      }
      if (p.data.scope !== 'due') {
        bad.push(c.label + ' 被当成了请求：scope 变成 ' + JSON.stringify(p.data.scope));
      }
      if (p.data.queue.length !== 3) {
        bad.push(c.label + ' 被当成了请求：队列变成 ' + p.data.queue.length + ' 张（应为 Unit 1 的 3 张）');
      }
      if (c.mustDelete && memory['pending_study'] !== undefined) {
        bad.push(c.label + ' 是真值，必须被删掉，否则它会一直躺在盘上等着幽灵生效');
      }
    });
    assert.deepStrictEqual(bad, [], '脏值没被干净拦住：\n        ' + bad.join('\n        '));
  });

  await check('study 跨页请求读取抛异常：按"无请求"处理，复习页不抛错、队列照常', function () {
    // 白屏级后果的守卫：一次 storage 异常不能让整个复习页抛错。
    // 代价只是"这次跳转没生效"（键还在盘上，下次还能被消费），远比白屏可接受。
    resetWorld();
    seedQueue();
    const p = mount('pages/study/study.js');
    p.onLoad();
    const beforeIds = p.data.queue.map(function (c) { return c.id; });

    failRequestGet = true;
    let threw = null;
    try { p.onShow(); } catch (e) { threw = e; }
    assert.strictEqual(threw, null,
      '读 storage 抛异常不该让复习页抛错：' + (threw && threw.message));
    assert.strictEqual(p.data.singleMode, false, '读失败时不该误进单卡模式');
    assert.deepStrictEqual(p.data.queue.map(function (c) { return c.id; }), beforeIds,
      '队列应保持不变');
    assert.strictEqual(p.data.ready, true, '页面应仍然可用');

    // 冷启动（onLoad）路径同理 —— 它也会消费一次请求
    failRequestGet = true;
    let threw2 = null;
    try { mount('pages/study/study.js').onLoad(); } catch (e) { threw2 = e; }
    assert.strictEqual(threw2, null,
      'onLoad 路径同样不该抛错：' + (threw2 && threw2.message));
  });

  await check('study 指定单元时 subject 归 all（否则残留学科求交集会筛空 —— 表现就是"点了没反应"）', function () {
    /**
     * 造出真实的"筛空"条件：要练的那个单元里全是**数学**词，
     * 而上一轮留下的学科筛选是**英语**。
     * 修之前：subject='英语' + unit='7A Unit 9' → 交集为空 → 点进去什么都没有。
     * 首页那行的数字是按 subject:'all' 算的（deck.refresh），所以还会显示"共 2 个"——
     * 首页说 2 个、点进去 0 个，正是"首页不能和复习页打架"这条规矩要消灭的现象。
     */
    resetWorld();
    seedStore([
      mkWord({ id: 'm1', word: 'plus', subject: '数学', unit: '7A Unit 9', nextReview: TODAY }),
      mkWord({ id: 'm2', word: 'minus', subject: '数学', unit: '7A Unit 9', nextReview: TODAY })
    ]);
    memory['study_prefs'] = { subject: '英语', scope: 'due', unit: 'all' };
    memory['pending_study'] = { unit: '7A Unit 9' };        // 没带 subject
    const p = mount('pages/study/study.js');
    p.onLoad();

    assert.strictEqual(p.data.subject, 'all',
      '指定单元时必须把学科归 all，实际 ' + JSON.stringify(p.data.subject));
    assert.strictEqual(p.data.unit, '7A Unit 9');
    assert.strictEqual(p.data.queue.length, 2,
      '队列必须非空（残留学科与单元求交集会筛空 → 点了没反应），实际 ' + p.data.queue.length);
  });

  await check('study 请求带 subject 时尊重它，没带 unit 时回到"不限"（错题重练等全库请求的口径）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'e1', word: 'alpha', subject: '英语', unit: '7A Unit 1', nextReview: TODAY }),
      mkWord({ id: 'm1', word: 'plus', subject: '数学', unit: '7A Unit 9', nextReview: TODAY })
    ]);
    memory['study_prefs'] = { subject: '英语', scope: 'due', unit: '7A Unit 1' };
    memory['pending_study'] = { subject: '数学', scope: 'all' };
    const p = mount('pages/study/study.js');
    p.onLoad();

    assert.strictEqual(p.data.subject, '数学', '请求显式带 subject 时应尊重，实际 ' + p.data.subject);
    assert.strictEqual(p.data.unit, 'all',
      '没指定单元应回到"不限"—— 错题本是全库范围，不该被上一轮选过的单元困住。实际 ' +
      JSON.stringify(p.data.unit));
    assert.strictEqual(p.data.queue.length, 1, '应只剩数学那 1 张，实际 ' + p.data.queue.length);
  });

  /*----------------- 限流语义（B）----------------- */

  await check('study 限流：不限单元时按每日上限裁队列，学生显式选单元时给满整单元', function () {
    /**
     * 语义：**学生显式选了一个单元 = 明确指定了范围，尊重它。**
     * 与代码里既有的"学生主动选「全部单词」是想过一遍，那时再卡上限会显得莫名其妙"同源。
     * 学生说"我明天听写 Unit 2"，系统只给他 43 个里的 10 个，就是把他的意图打了折。
     */
    resetWorld();
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push(mkWord({ id: 'n' + i, word: 'w' + i, unit: '7A Unit 2', nextReview: TODAY }));
    }
    seedStore(many);

    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.unit, 'all', '前置：默认不限单元');
    assert.strictEqual(p.data.queue.length, 10,
      '不限单元时应被每日新词上限（默认 10）裁到 10，实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.hiddenNew, 20, '被挡在今天的应有 20 个，实际 ' + p.data.hiddenNew);

    p.setData({ reviewed: 0, done: false });
    p.pickUnit({ currentTarget: { dataset: { unit: '7A Unit 2' } } });
    assert.strictEqual(p.data.queue.length, 30,
      '学生显式选了单元就该给满整单元 30 张，实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.hiddenNew, 0,
      '选单元时不该有限流提示 —— 界面会说"今天的量已经做完了"，与"整单元都给满了"自相矛盾');
  });

  await check('study 顶部数字与队列长度同口径：限流条件在 buildQueue 与 refreshCounts 之间不允许分叉', function () {
    /**
     * 这条守的是"同一个页面自己跟自己矛盾"：
     * 顶部筛选栏显示 {{dueCountNow}} 个，进度条却是 {{queue.length}} 张。
     * 两处各写一遍限流条件，改一处漏一处就会分叉（2026-09-18 就是这么坏过一次）。
     * 所以断言"两处算出来的数必须相等"，而不是分别断言各自的值。
     *
     * 注意口径：两处的限流条件现在由 study.js 的 shouldApplyLimits() **单一提供**
     * （抽取前 buildQueue 还带 `!singleMode`、refreshCounts 少了它 —— 一个"今天恰好
     * 不可达"的分叉；抽取后判据只有一份，见下一条断言里的源码守卫）。
     * 这里断言的是"两处算出来的数必须相等"，而不是"源码文本相同" ——
     * 行为一致才是要守的东西。
     */
    const cases = [
      { label: '不限单元（限流生效）', unit: 'all' },
      { label: '选了单元（不限流）', unit: '7A Unit 2' }
    ];
    const bad = [];
    cases.forEach(function (c) {
      resetWorld();
      const many = [];
      for (let i = 0; i < 30; i++) {
        many.push(mkWord({ id: 'n' + i, word: 'w' + i, unit: '7A Unit 2', nextReview: TODAY }));
      }
      for (let i = 0; i < 5; i++) {
        many.push(mkWord({ id: 'o' + i, word: 'v' + i, unit: '7A Unit 1', nextReview: TODAY }));
      }
      seedStore(many);

      const p = mount('pages/study/study.js');
      p.onLoad();
      if (c.unit !== 'all') {
        p.setData({ reviewed: 0, done: false });
        p.pickUnit({ currentTarget: { dataset: { unit: c.unit } } });
      }
      const queueLen = p.data.queue.length;
      // 模拟"切走再切回"：onShow 无请求时走的就是 refreshCounts
      p.refreshCounts();
      const shown = p.data.dueCountNow;
      if (shown !== queueLen) {
        bad.push(c.label + '：顶部显示 ' + shown + ' 个，队列却是 ' + queueLen + ' 张');
      }
    });
    assert.deepStrictEqual(bad, [],
      '同一个页面自相矛盾（顶部数字与进度条打架）：\n        ' + bad.join('\n        '));
  });

  /*----------------- 单卡模式「练完即退出」（D）----------------- */

  await check('study 单卡模式练完即退出：清掉 singleId 且 singleMode 归 false（tabBar 实例不再锁死在一张卡上）', function () {
    /**
     * 原来 this.singleId 只挂在页面实例上、**永不清除**：
     * 复习页是 tabBar 页，实例不会被销毁 → 这个实例永远停在那一张卡上循环，
     * 而 tabBar 页没有"退出"这个动作，用户除了杀掉小程序没有任何办法自己出来。
     * （"注释写了、实现没兑现"的典型。）
     */
    resetWorld();
    seedQueue();
    memory['single_practice'] = 'w1';
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.singleMode, true, '前置：单卡模式');
    assert.strictEqual(p.singleId, 'w1', '前置：实例挂着单卡标记');

    p.flipCard();
    p.onGrade({ currentTarget: { dataset: { q: 5 } } });
    flushTimers();

    assert.strictEqual(p.data.done, true, '前置：应练完');
    assert.strictEqual(p.singleId, null,
      '练完必须清掉 singleId，否则这个 tabBar 实例永远出不来');
    assert.strictEqual(p.data.singleMode, false, 'singleMode 应同步复位（否则完成页还带着单卡痕迹）');

    // 用户能自己出来：再来一轮回到普通队列，而不是又是同一张卡
    p.again();
    assert.strictEqual(p.data.singleMode, false, 'again() 后不该还是单卡模式');
    assert.strictEqual(p.data.queue.length, 2,
      'w1 已练完（明天才到期），应剩 w2/w3 两张，实际 ' + p.data.queue.length);
    const ids = p.data.queue.map(function (c) { return c.id; });
    assert.ok(ids.indexOf('w1') === -1, '已练完的 w1 不该又出现：' + ids.join(','));
  });

  await check('study 单卡模式中途切走再回来仍停在那一张（只在"练完"时清，不是一评分就清）', function () {
    resetWorld();
    seedQueue();
    memory['single_practice'] = 'w2';
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.current.id, 'w2');

    p.onShow();                                  // 切走再回来（无新请求）
    assert.strictEqual(p.singleId, 'w2',
      '还没做完就清标记会让用户弄丢这张卡 —— 清只在"完成"那一刻做');
    assert.strictEqual(p.data.singleMode, true, '应仍停在单卡模式');
    assert.strictEqual(p.data.queue.length, 1, '队列应仍是那 1 张');
    assert.strictEqual(p.data.current.id, 'w2');
  });

  await check('study 完成页「还有 N 个词待复习」：数字按当前筛选口径算，且 scope=due 时不再渲染死链', function () {
    /**
     * 2026-09-19 修的两个**叠加**缺陷（QA 真机实测：选 `7A Unit 4`、队列 49 张，
     * 完成页却显示「还有 275 个词待复习 → 去练」，点它什么都不发生）：
     *
     *   ① 数字口径错：totalDue 取的是 schedule.dueCards(全部卡片) —— 全库到期数，
     *      不按当前 subject/unit 过滤。学生刚选了单元，数字却属于整个词库。
     *   ② 动作是死的：那一行的动作是 pickScope('due')，而 pickScope 首行是
     *      `if (s === this.data.scope) return;` —— scope 已经是 'due'（默认值）时直接返回。
     *   两条叠加 = 「数字与动作打架」+「点了没反应」，正是本项目一直在消灭的那类毛病。
     *
     * ②不是新引入的，是被上一轮"选单元不限流"激活的：原来 hiddenNew > 0 挡着不显示；
     * 但**基础场景本来就是坏的** —— 不限单元、到期数小于上限时 hidden 也是 0，
     * 同样会露出一行点了没反应的入口。所以修的是根因。
     *
     * ③ 上一轮只对齐了**范围**（subject/unit），漏了**上限**（2026-09-19 再修）：
     *    scope='all' + 不限单元时 N 是全库到期数（如 275/287），点过去后队列却被每日上限
     *    裁到 40 上下 —— 数字与动作仍然不等。这半边由情形④覆盖：
     *    数字必须等于"切到 due 后实际会给的张数"，而不是"这个范围里有多少词到期"。
     *    判据（含 scope / unit / singleMode 三个因子）已抽成 study.js 的
     *    shouldApplyLimits()，三处入口共用，末尾的源码守卫钉住"不许再分叉"。
     */
    resetWorld();
    const future = dateUtil.addDays(TODAY, 7);
    seedStore([
      // 7A Unit 2：2 张今天到期 + 3 张 7 天后到期
      mkWord({ id: 'm1', word: 'one', subject: '英语', unit: '7A Unit 2', nextReview: TODAY }),
      mkWord({ id: 'm2', word: 'two', subject: '英语', unit: '7A Unit 2', nextReview: TODAY }),
      mkWord({ id: 'm3', word: 'three', subject: '英语', unit: '7A Unit 2',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] }),
      mkWord({ id: 'm4', word: 'four', subject: '英语', unit: '7A Unit 2',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] }),
      mkWord({ id: 'm5', word: 'five', subject: '英语', unit: '7A Unit 2',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] }),
      // 其它单元的到期词 —— 全库口径会把它们算进"还有 N 个"里（旧实现那个 275 的来源）
      mkWord({ id: 'n1', word: 'six', subject: '英语', unit: '7A Unit 3', nextReview: TODAY }),
      mkWord({ id: 'n2', word: 'seven', subject: '英语', unit: '7A Unit 3', nextReview: TODAY }),
      mkWord({ id: 'n3', word: 'eight', subject: '英语', unit: '7A Unit 3', nextReview: TODAY })
    ]);
    const UNIT_DUE = 2;   // 7A Unit 2 的到期数
    const LIB_DUE = 5;    // 全库到期数（2 + 3）—— 旧实现会把这个数字显示给选了单元的学生

    // 那一行的 wx:if 等价判据（study.wxml）。WXML 条件在 Node 里执行不了，
    // 所以这里显式写出来，并用下面的文本断言钉住它与源码一致。
    function rowVisible(d) { return d.scope !== 'due' && d.totalDue > 0; }

    // 情形①：scope='due' + 选了单元 → 数字按单元算，且**不显示**那一行（队列已给满，没有"更多"可切）
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Unit 2' };
    let p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.queue.length, UNIT_DUE, '前置：Unit 2 应给 2 张到期卡');
    assert.strictEqual(p.data.totalDue, UNIT_DUE,
      'totalDue 必须是当前单元口径（' + UNIT_DUE + '），而不是全库（' + LIB_DUE + '），实际 ' + p.data.totalDue);
    assert.strictEqual(rowVisible(p.data), false,
      'scope 已经是 due 时不该显示「去练」（它的动作就是切到 due，点了没反应）');

    // 情形②：scope='all' + 选了单元 → 显示该单元的到期数；点它 → 队列变成该单元到期数
    memory['study_prefs'] = { subject: 'all', scope: 'all', unit: '7A Unit 2' };
    p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.queue.length, 5, '前置：scope=all 时 Unit 2 共 5 个词');
    assert.strictEqual(p.data.totalDue, UNIT_DUE,
      'totalDue 应按当前单元算，实际 ' + p.data.totalDue);
    assert.strictEqual(rowVisible(p.data), true, 'scope=all 时这一行应当显示');
    p.pickScope({ currentTarget: { dataset: { scope: 'due' } } });   // 等价于点那一行
    assert.strictEqual(p.data.scope, 'due', '点它必须真的切到 due（不能点了没反应）');
    assert.strictEqual(p.data.queue.length, UNIT_DUE,
      '切过去后的队列长度必须等于刚才显示的数字（数字与动作同源），实际 ' + p.data.queue.length);

    // 情形③：scope='due' + 不限单元 + 到期数 ≤ 上限 → 同样**不显示**（基础场景的死链一并修掉）
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: 'all' };
    p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.hiddenNew, 0, '前置：5 张到期 < 默认上限 10 新词，没被挡');
    assert.strictEqual(p.data.hiddenReview, 0, '前置：没有到期的复习卡');
    assert.strictEqual(p.data.totalDue, LIB_DUE, '不限单元时 totalDue 就是全库到期数');
    assert.strictEqual(rowVisible(p.data), false,
      '基础场景（不限单元、到期数小于上限）同样不该显示死链 —— 旧条件 hidden===0 && totalDue>0 恰好全中');

    // 情形④：scope='all' + 不限单元 + 全库到期数 > 每日上限
    //   → 数字必须是"切到 due 后实际会给的张数"（被上限截短后的量），
    //     而不是全库到期数。这正是上一轮留下的那半边残留。
    resetWorld();
    // 显式钉住上限，让本用例的前提（30 复习 + 10 新词）不随默认值漂移
    memory['settings'] = { dailyNewWords: 10, dailyReviewMax: 30 };
    const bulk = [];
    // 30 张到期的**复习**卡（有 history → 学过 → 吃 dailyReviewMax）
    for (let i = 0; i < 30; i++) {
      bulk.push(mkWord({ id: 'r' + i, word: 'r' + i, subject: '英语', unit: '7A Unit 1',
                         interval: 6, nextReview: TODAY, history: [{ q: 5, interval: 6 }] }));
    }
    // 20 张到期的**新**卡（无 history → 没学过 → 吃 dailyNewWords）
    for (let i = 0; i < 20; i++) {
      bulk.push(mkWord({ id: 'q' + i, word: 'q' + i, subject: '英语', unit: '7A Unit 1',
                         nextReview: TODAY }));
    }
    seedStore(bulk);
    const BIG_LIB_DUE = 50;             // 全库到期数（旧实现会把这个数字显示给学生）
    const BIG_LIMITED = 30 + 10;        // 上限裁完实际会给的张数（复习 30 + 新词 10）

    memory['study_prefs'] = { subject: 'all', scope: 'all', unit: 'all' };
    p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.queue.length, BIG_LIB_DUE,
      '前置：scope=all + 不限单元时队列就是全部 ' + BIG_LIB_DUE + ' 张（scope=all 不限流），实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.totalDue, BIG_LIMITED,
      '不限单元时 totalDue 必须等于"切到 due 后实际会给的张数"（' + BIG_LIMITED + '），' +
      '而不是全库到期数（' + BIG_LIB_DUE + '）—— 后者就是上一轮残留的那半边。实际 ' + p.data.totalDue);
    assert.notStrictEqual(p.data.totalDue, BIG_LIB_DUE,
      'totalDue 绝不能退化成"这个范围里有多少词到期"（' + BIG_LIB_DUE + '）—— 那是个与动作无关的库存数');
    assert.strictEqual(rowVisible(p.data), true, 'scope=all 时这一行应当显示');
    p.pickScope({ currentTarget: { dataset: { scope: 'due' } } });   // 等价于点那一行
    assert.strictEqual(p.data.scope, 'due', '点它必须真的切到 due');
    assert.strictEqual(p.data.queue.length, BIG_LIMITED,
      '切过去后的队列长度必须等于刚才显示的数字（数字与动作同源），实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.totalDue, BIG_LIMITED,
      '切到 due 后 totalDue 不应变化（它本来就是 due 口径），实际 ' + p.data.totalDue);

    // 源码层：那一行的 wx:if 必须含 scope !== 'due'。
    // 定位方式用"同一行同时含 <view / data-scope="due" / totalDue" —— 三者缺一不可，
    // 因为筛选面板的 chip 也有 data-scope="due"（第 14 行），上方注释里也提到了 totalDue。
    const wxml = fs.readFileSync(path.join(ROOT, 'pages', 'study', 'study.wxml'), 'utf8');
    const rowLine = wxml.split(/\r?\n/).filter(function (l) {
      return l.indexOf('<view') !== -1 &&
        l.indexOf('data-scope="due"') !== -1 &&
        l.indexOf('totalDue') !== -1;
    })[0];
    assert.ok(rowLine, 'study.wxml 里找不到完成页「还有 N 个词待复习」那一行' +
      '（<view + data-scope="due" + totalDue 缺一不可）');
    const cond = (rowLine.match(/wx:if="([^"]*)"/) || [])[1];
    assert.ok(cond, '那一行必须有 wx:if 守卫，实际：' + rowLine.trim());
    assert.ok(/scope\s*!==\s*'due'/.test(cond),
      '那一行的 wx:if 必须排除"scope 已经是 due"（pickScope 首行会直接 return，点了没反应）。实际：' + cond);
    assert.ok(/totalDue\s*>\s*0/.test(cond),
      '那一行仍须要求 totalDue > 0（没有到期词时不该出现）。实际：' + cond);

    /**
     * 源码层守卫：限流判据**只允许有一份**。
     *
     * 为什么用源码断言而不是再写几个用例：这一条要防的是"将来某次改动把判据
     * 又抄一份出去"—— 那在用例层是不可见的（抄出来的那份往往今天恰好与主份等价，
     * 行为断言照样全绿），只有在它下次与主份分叉时才发作。
     *
     * 判据本体现在在 utils/schedule.js 的 shouldApplyDailyLimits()：2026-09-19
     * 首页 deck.refresh 也要问同一个问题（它的数字必须等于复习页的队列长度），
     * 而首页不该 require 一个页面实例。所以页面侧只允许"传参调用"。
     */
    const js = fs.readFileSync(path.join(ROOT, 'pages', 'study', 'study.js'), 'utf8');
    const rawLimitCalls = (js.match(/schedule\.applyDailyLimits\s*\(/g) || []).length;
    assert.strictEqual(rawLimitCalls, 1,
      'study.js 里应只有 applyLimitsIfNeeded 一处直接调用 applyDailyLimits（实际 ' + rawLimitCalls +
      ' 处）—— 多出来的那处就是"判据分叉"的开始，而分叉的症状是顶部数字与进度条自相矛盾');
    assert.strictEqual((js.match(/schedule\.shouldApplyDailyLimits\s*\(/g) || []).length, 1,
      'study.js 必须把判据委托给 schedule.shouldApplyDailyLimits（且只有一处）');
    assert.strictEqual(js.indexOf("this.data.unit === 'all'"), -1,
      "study.js 里不该再出现手写的限流判据（this.data.unit === 'all'）—— " +
      '它必须只存在于 utils/schedule.js，否则首页与复习页会再次分叉');
    const viaShared = (js.match(/this\.applyLimitsIfNeeded\s*\(/g) || []).length;
    assert.strictEqual(viaShared, 2,
      'buildQueue / refreshCounts 两个入口必须经 applyLimitsIfNeeded 走同一判据（实际 ' + viaShared + ' 处）');
    // 只数真正的调用（注释里提到函数名不算）—— 所以要求紧跟实参 cards
    const viaDailyQueue = (js.match(/schedule\.dailyQueue\s*\(\s*cards/g) || []).length;
    assert.strictEqual(viaDailyQueue, 1,
      'countDueInScope 必须经 schedule.dailyQueue 走"范围 + 判据 + 限流"的同一条路径（实际 ' +
      viaDailyQueue + ' 处）—— 首页那个数字走的也是它，两处因此必然相等');
  });

  /*----------------- 入口通道与完成页边界（2026-09-19 修）-----------------
   * 四处 ★ + 两处同类入口，是同一个病根的三副面孔：
   *   ① 数字/文案与动作打架 —— 错题本那行写着全库 N，动作却按当前单元取交集；
   *   ② 只写 prefs 不写 pending_study —— 复习页是 tabBar 长生命周期实例，
   *      switchTab 到它不重跑 onLoad，于是"点了没反应"；
   *   ③ 动作把学生刚挣到的成绩洗掉 —— 「再来一轮」遇到空批次时 total/reviewed 归零，
   *      而完成页成绩块的渲染条件是 total > 0，整块当场消失。
   * 全部按"用户真的点一下"来断言（含跨页 onLoad 消费），而不是断言源码文本。
   */
  console.log('\n===== 入口通道与完成页边界 =====');

  await check('★ stats「专项重练」：必须写 pending_study{scope:weak}，不能只 savePrefs', function () {
    /**
     * 与 deck.goWeakPractice 同一个 bug（2026-09-18 在首页修过，统计页被漏了）：
     * 复习页是 tabBar 长生命周期实例，wx.switchTab 到**已经创建过**的它不重跑
     * onLoad、只跑 onShow，而 prefs 只在 onLoad 里读一次。于是 prefs 落了盘，
     * this.data.scope 却仍是 'due' —— 本页写着"错题本 N 个"，点进去还是普通队列。
     */
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', subject: '英语',
               interval: 1, nextReview: TODAY, history: [{ q: 1, interval: 1 }] })
    ]);
    const p = mount('pages/stats/stats.js');
    p.onLoad();
    assert.strictEqual(p.data.weakCount, 1, '前置：全库错题 1 个');

    calls.switchTab = [];
    p.goWeak();
    assert.deepStrictEqual(memory['pending_study'], { scope: 'weak' },
      '必须写 pending_study{scope:weak}（读后即删的跨页请求）。实际 ' +
      JSON.stringify(memory['pending_study']));
    assert.strictEqual(calls.switchTab[calls.switchTab.length - 1], '/pages/study/study',
      '应跳到复习页（tabBar 页，只能 switchTab）');
    assert.strictEqual(memory['study_prefs'].scope, 'weak',
      'prefs 仍要落盘 —— 它负责"切走再回来还记得"，pending_study 只负责"这次立刻生效"');

    // 走真实跨页路径：复习页 onLoad 消费它
    const study = mount('pages/study/study.js');
    study.onLoad();
    assert.strictEqual(study.data.scope, 'weak', '复习页应真的切到错题本（而不是仍停在旧 scope）');
    assert.strictEqual(study.data.queue.length, 1, '错题队列应有 1 张');
  });

  await check('★ 完成页「错题本里攒了 N 个 → 专项重练」：显示 N → 点进去队列就是 N（unit 重置为 all）', function () {
    /**
     * 修前形态：显示 weakCount = **全库**错题数（2），动作却是 applyFilter({scope:'weak'})
     * —— 保留当前 unit，于是变成"全库错题 ∩ 当前单元" = 0，点进去是「错题本已清空」。
     * 修法：点它时把 unit 重置为 'all'，让**动作与文案的主语一致**
     *（那行文案的主语是「错题本里攒了 N 个」，错题本在全项目都是全库口径）。
     */
    resetWorld();
    const future = dateUtil.addDays(TODAY, 7);
    seedStore([
      // 当前单元：0 个错题，且今天不到期 → 页面停在完成态
      mkWord({ id: 'u1a', word: 'alpha', subject: '英语', unit: '7A Unit 1',
               interval: 6, nextReview: future, history: [{ q: 5, interval: 6 }] }),
      // 全库错题：两个都在**另一个**单元
      mkWord({ id: 'u2a', word: 'beta', subject: '英语', unit: '7A Unit 2',
               interval: 1, nextReview: future, history: [{ q: 1, interval: 1 }] }),
      mkWord({ id: 'u2b', word: 'gamma', subject: '英语', unit: '7A Unit 2',
               interval: 1, nextReview: future, history: [{ q: 3, interval: 1 }] })
    ]);
    memory['study_prefs'] = { subject: 'all', scope: 'due', unit: '7A Unit 1' };

    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.done, true, '前置：当前单元今天没有到期的 → 完成页');
    const shown = p.data.weakCount;          // 完成页那行文案里的 N
    assert.strictEqual(shown, 2, '完成页显示的 N 是全库错题数，实际 ' + shown);

    // 负面对照：保留当前 unit 取交集 = 0 —— 这正是修复前的形态
    const ifKeptUnit = schedule.pickCards(store.loadCards(), store.loadStates(), TODAY,
      { subject: 'all', scope: 'weak', unit: '7A Unit 1' }, store.weakIds()).length;
    assert.strictEqual(ifKeptUnit, 0,
      '前置：当前单元内的错题必须为 0（否则这条用例证明不了"数字与动作打架"）');

    p.practiceWeak();
    assert.strictEqual(p.data.unit, 'all',
      '点它必须把 unit 重置成 all —— 错题本在全项目都是全库口径，' +
      '不能"同一个错题本，两个入口两种范围"（实际 ' + p.data.unit + '）');
    assert.strictEqual(p.data.scope, 'weak');
    assert.strictEqual(p.data.done, false, '应回到复习态，而不是留在完成页');
    assert.strictEqual(p.data.queue.length, shown,
      '显示 ' + shown + ' → 点进去队列必须是 ' + shown + '（实际 ' + p.data.queue.length +
      '）—— 学生看到 N 进去就该是 N');
    assert.strictEqual(memory['study_prefs'].unit, 'all',
      'prefs 也要落成 all，否则切走再回来又变回按单元取交集');
  });

  await check('★ 完成页「再来一轮」：范围内已无到期时不清零本轮成绩、不切走（只给一句实话）', function () {
    /**
     * 修前形态：范围内已无到期卡时点「再来一轮」→ buildQueue 空队列 →
     * done=true, total=0, reviewed=0；完成页成绩块的渲染条件是 total > 0，
     * 于是学生**刚看到的这一轮成绩（如 2）当场消失**，页面从"这一轮完成了"
     * 变成"今日已完成 0"。
     */
    resetWorld();
    seedStore([
      mkWord({ id: 'a', word: 'alpha', nextReview: TODAY }),
      mkWord({ id: 'b', word: 'beta', nextReview: TODAY }),
      mkWord({ id: 'c', word: 'gamma', nextReview: TODAY })
    ]);
    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.queue.length, 3, '前置：3 张今天到期');

    // 真的把这一轮做完（翻面 → 认识 ×3）—— 成绩要"挣"出来，而不是直接改 data
    for (let i = 0; i < 3; i++) {
      p.flipCard();
      p.onGrade({ currentTarget: { dataset: { q: 5 } } });
      flushTimers();
    }
    assert.strictEqual(p.data.done, true, '前置：应进入完成态');
    const total = p.data.total, reviewed = p.data.reviewed, know = p.data.roundKnow;
    const queueLen = p.data.queue.length;
    assert.strictEqual(total, 3, '前置：本轮 total');
    assert.strictEqual(reviewed, 3, '前置：本轮 reviewed');
    assert.strictEqual(know, 3, '前置：本轮认识 3 个');

    calls.toast = [];
    p.again();     // 这 3 张已排到明天 → 该范围内没有下一批

    assert.strictEqual(p.data.total, total,
      '「再来一轮」把 total 洗成 0 —— 学生刚看到的成绩当场消失（实际 ' + p.data.total + '）');
    assert.strictEqual(p.data.reviewed, reviewed,
      'reviewed 被清零了（实际 ' + p.data.reviewed + '）');
    assert.strictEqual(p.data.roundKnow, know,
      'roundKnow 被清零了 —— 完成页成绩块靠 total>0 渲染，清零即整块消失（实际 ' + p.data.roundKnow + '）');
    assert.strictEqual(p.data.done, true, '无下一批时应保持完成态，而不是切到"今日已完成 0"');
    assert.strictEqual(p.data.queue.length, queueLen,
      '界面应一点不动（队列也不该被换掉），实际 ' + p.data.queue.length + ' / 原 ' + queueLen);
    assert.ok(/暂时没有/.test(lastToast()), '应给一句实话的提示，实际：' + lastToast());
  });

  await check('★ 「再来一轮」有下一批时行为不变：正常重建队列（守卫不能拦掉被上限挡住的词）', function () {
    /**
     * 「再来一轮」的**正常用途**就是"被每日上限挡住的词继续练" —— 完成页那行
     * 「词库里还有 N 个词没练（…）想继续可以再练一轮」说的正是这件事。
     * 新守卫只能在"真的没有下一批"时生效，否则等于把这个功能废掉。
     */
    resetWorld();
    memory['settings'] = { dailyNewWords: 2, dailyReviewMax: 30 };
    const many = [];
    for (let i = 0; i < 4; i++) many.push(mkWord({ id: 'n' + i, word: 'w' + i, nextReview: TODAY }));
    seedStore(many);

    const p = mount('pages/study/study.js');
    p.onLoad();
    assert.strictEqual(p.data.queue.length, 2, '前置：每日新词上限 2 → 队列 2 张');
    assert.strictEqual(p.data.hiddenNew, 2, '前置：还有 2 个被上限挡在今天的词');

    for (let i = 0; i < 2; i++) {
      p.flipCard();
      p.onGrade({ currentTarget: { dataset: { q: 5 } } });
      flushTimers();
    }
    assert.strictEqual(p.data.done, true, '前置：第一轮做完');

    p.again();     // 剩下 2 个新词今天仍到期 → 有下一批
    assert.strictEqual(p.data.done, false,
      '有下一批时必须照旧重开一轮（这就是「再来一轮」的正常用途，不能被守卫拦掉）');
    assert.strictEqual(p.data.queue.length, 2, '应重建出下一批 2 张，实际 ' + p.data.queue.length);
    assert.strictEqual(p.data.total, 2, '新一轮 total = 队列长度');
    assert.strictEqual(p.data.reviewed, 0, '新一轮计数从 0 开始（与修复前逐字一致）');
    assert.strictEqual(p.data.roundKnow, 0, '新一轮 roundKnow 归零（与修复前逐字一致）');
  });

  await check('★ stats「去复习」：写 pending_study{scope:due,subject,unit} —— 落到今日待复习且不丢单元', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', subject: '英语', unit: '7A Unit 1', nextReview: TODAY })
    ]);
    // 模拟"刚点过错题重练"：prefs 里残留 scope='weak'
    memory['study_prefs'] = { subject: '英语', scope: 'weak', unit: '7A Unit 1' };

    const p = mount('pages/stats/stats.js');
    p.onLoad();
    calls.switchTab = [];
    p.goStudy();
    assert.deepStrictEqual(memory['pending_study'],
      { scope: 'due', unit: '7A Unit 1', subject: '英语' },
      '必须把范围压成"当前 subject/unit + scope due"；只送 scope 会把学生选好的单元丢掉' +
      '（consumePending 对"没指定单元"的请求会把 unit 重置成 all）。实际 ' +
      JSON.stringify(memory['pending_study']));
    assert.strictEqual(calls.switchTab[calls.switchTab.length - 1], '/pages/study/study');

    // 走真实跨页路径：复习页 onLoad 消费它
    const study = mount('pages/study/study.js');
    study.onLoad();
    assert.strictEqual(study.data.scope, 'due',
      '应落到"今日待复习"，而不是残留的 weak（实际 ' + study.data.scope + '）');
    assert.strictEqual(study.data.unit, '7A Unit 1', 'unit 必须一起带，否则被重置成 all');
    assert.strictEqual(study.data.subject, '英语');
    assert.strictEqual(study.data.queue.length, 1, '今日待复习队列应有 1 张');
  });

  await check('★ 朗读页「去复习」：同样写 pending_study{scope:due,subject,unit}（两处同类入口）', function () {
    resetWorld();
    seedStore([
      mkWord({ id: 'w1', word: 'alpha', subject: '英语', unit: '7A Unit 1', nextReview: TODAY })
    ]);
    memory['study_prefs'] = { subject: '英语', scope: 'weak', unit: '7A Unit 1' };

    const p = mount('pages/pronounce/pronounce.js');
    p.onLoad();     // 录音/播放器走 wx 替身（见文件顶部的 getRecorderManager / createInnerAudioContext）
    calls.switchTab = [];
    p.goStudy();
    assert.deepStrictEqual(memory['pending_study'],
      { scope: 'due', unit: '7A Unit 1', subject: '英语' },
      '朗读页的「去复习」与统计页必须是同一条通道、同一份载荷。实际 ' +
      JSON.stringify(memory['pending_study']));
    assert.strictEqual(calls.switchTab[calls.switchTab.length - 1], '/pages/study/study');

    const study = mount('pages/study/study.js');
    study.onLoad();
    assert.strictEqual(study.data.scope, 'due', '应落到今日待复习（实际 ' + study.data.scope + '）');
    assert.strictEqual(study.data.unit, '7A Unit 1', 'unit 必须一起带');
  });

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
  // 2026-09-24：注册表随教材模块搬进分包（主包当时已超限）。
  // 数据源 .json 仍留在 data/curriculum/（构建源，不进包），故两者路径不同。
  const BOOK_REGISTRY = require(path.join(ROOT, 'pack-curriculum', 'utils', 'curriculum-books.js'));
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

  await check('教材页 onLoad：落在册次列表（32 册），此时一册词表都没加载', function () {
    resetWorld();
    const cachedCurriculum = function () {
      return Object.keys(require.cache).filter(function (k) {
        return k.indexOf(path.join(ROOT, 'data', 'curriculum')) === 0;
      });
    };
    // 本段开头 require 过 wy7s_2024（用例的数据口径），先摘掉它，剩下的才算"页面加载的"
    delete require.cache[path.join(ROOT, 'data', 'curriculum', 'wy7s_2024.json')];

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'books', '首次进入应停在册次列表');
    assert.strictEqual(p.data.books.length, 32, '册次列表应有 32 册，实际 ' + p.data.books.length);
    assert.strictEqual(p.data.units.length, 0, '还没选册，不该有单元');
    assert.deepStrictEqual(cachedCurriculum().map(function (k) { return path.basename(k); }), [],
      '光进列表页不该加载任何一册词表（32 册全进内存，两级列表就白做了）');
  });

  await check('教材页 打开一册：7 个单元 / 295 词，初始全未选', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const n1 = store.loadWords().length;
    p.selectAll();
    p.doImport();
    // 2026-09-17 起整册重导走"这一册已经导入过"的判定（重合 100%），
    // 不再报「已导入 1 个词，跳过 294 个」；两者都不写盘，这里守住"规模不变"
    assert.strictEqual(lastToast(), '这一册已在词库里，去「复习」直接练', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n1, '重复导入不得改变词库规模');
  });

  await check('教材页 部分导入：只导入第 1 单元时落库数与该单元 count 一致', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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

  await check('★ 教材页 册次列表：32 册的书名/词数逐册与 JSON 实际内容一致', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    const listed = p.data.books;
    assert.strictEqual(listed.length, 32, '应列出 32 册，实际 ' + listed.length);

    // 逐册拿 JSON 实际值对账（书名/词数来自 book 与 words.length，不是硬编码）
    const dir = path.join(ROOT, 'data', 'curriculum');
    const diskFiles = fs.readdirSync(dir)
      .filter(function (f) { return f.endsWith('.json') && f !== 'missing.json'; });
    assert.strictEqual(diskFiles.length, 32, '磁盘上应有 32 册词书');

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
    // 2026-09-24：.js 产物搬进分包，观察目录随之改变（.json 构建源留在 data/curriculum/，
    // 但注册表 require 的是分包里的 .js，所以这里盯分包目录）。
    const dirPath = path.join(ROOT, 'pack-curriculum', 'data', 'curriculum');
    // 2026-09-18：注册表的 require 由 .json 改为 .js（真引擎不支持 require .json，
    // 详见 verify-structure.js 的「真机兼容」检查）。这里按 .js 观察，检查意图不变。
    const cachedBooks = function () {
      return Object.keys(require.cache)
        .filter(function (k) { return k.indexOf(dirPath) === 0; })
        .map(function (k) { return path.basename(k); });
    };
    // 本段前几个用例已经点开过七上，先清掉缓存，才能干净地观察"进页加载了什么"
    Object.keys(require.cache).forEach(function (k) {
      if (k.indexOf(dirPath) === 0) delete require.cache[k];
    });

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    assert.deepStrictEqual(cachedBooks(), [], '还没点册，不该加载任何词表');

    enterBook(p, 'wy8s');
    assert.deepStrictEqual(cachedBooks(), ['wy8s.js'],
      '打开八年级上册后，内存里应只有这一册，实际：' + cachedBooks().join(', '));
    assert.strictEqual(p.data.total, 313, '八上应为 313 词');

    p.backToBooks();
    assert.strictEqual(p.data.stage, 'books', '换一册应回到册次列表');
    assert.strictEqual(p.data.units.length, 0, '回到列表后不该还留着上一册的单元');
    assert.strictEqual(p.data.pickedCount, 0, '回到列表后不该还留着选择');

    enterBook(p, 'wy9x');
    assert.deepStrictEqual(cachedBooks().sort(), ['wy8s.js', 'wy9x.js'],
      '换册不该把已点过的册从缓存里清掉（重复进入走缓存，不重复解析）');
  });

  await check('★ 教材页 记住上次选的册：下次进页直达那一册，数据换过则退回列表', function () {
    resetWorld();
    let p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p, 'wy8s');
    assert.strictEqual(memory['curriculum_last_book'], 'wy8s', '打开一册后应记住它的 id');

    // 再进页面（模拟学生下次打开）→ 直接落在八上，不再是册次列表
    p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'units', '上次选过就该直达单元列表');
    assert.strictEqual(p.data.book, '外研版初中英语八年级上册', '直达的册不对：' + p.data.book);
    assert.strictEqual(p.data.total, 313, '直达时词数也应是该册的');

    // 记的册若已不在册次表里（教材数据换过），安静退回册次列表，不白屏不报错
    memory['curriculum_last_book'] = 'this_book_is_gone';
    p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    assert.strictEqual(p.data.stage, 'books', '记的册失效时应退回册次列表');
    assert.strictEqual(p.data.books.length, 32, '退回后册次列表仍应是完整的 32 册');
  });

  await check('★ 教材页 旧版册（无单元划分）：整册收进「全部单词」一格，导入即整册', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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

  await check('★ 教材页 预置场景：词库已预置这一册（首次启动的 295 词），再导入同一册 → 明说已在词库里', function () {
    resetWorld();
    // 首次启动：app.js 用 data/textbook-7a.js 预置了七上 295 词
    const SEED_TEXTBOOK = require(path.join(ROOT, 'data', 'textbook-7a.js'));
    store.addItems(SEED_TEXTBOOK.words.map(function (w) {
      return { word: w.word, meaning: w.meaning };
    }));
    const n0 = store.loadWords().length;
    assert.strictEqual(n0, 295, '预置后应有 295 词，实际 ' + n0);

    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    // 旧文案是「已导入 1 个词，跳过 294 个」——看着像出错，其实只是同一册重来一遍
    assert.strictEqual(lastToast(), '这一册已在词库里，去「复习」直接练', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n0, '不该新增任何词条（也不该报跳过数）');
    // 没导入任何词 == 没发生写入，选择保留原样（与 add 页"全重复时不吞掉用户输入"同口径），
    // 学生可以换个单元再试，不用重新勾一遍
    assert.strictEqual(p.data.pickedCount, p.data.total, '提示已导入时不改选择（并未写盘）');
  });

  await check('★ 教材页 换另一册导入：与已有词重合 52 条 → 只新增 261、跳过 52，不重复入库', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();                 // 先把七上导进来
    const n1 = store.loadWords().length;

    // 再只选一个单元导入：这些词全都已在词库里（重合 100%）
    p.toggleUnit({ currentTarget: { dataset: { i: 0 } } });
    p.doImport();
    assert.strictEqual(lastToast(), '这一册已在词库里，去「复习」直接练', '实际提示：' + lastToast());
    assert.strictEqual(store.loadWords().length, n1, '不该新增词条');
  });

  await check('★ 跨路径：同一短语走教材页与走 add 页批量粘贴，得到同一形态', function () {
    resetWorld();
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
    p.onLoad();
    enterBook(p);
    p.selectAll();
    p.doImport();
    const n = store.loadWords().length;

    // 词库页：导入的 295 词应当全部可见、全部未学、且没有一个被误判成"已掌握"
    const deck = mount('pages/deck/deck.js');
    deck.onShow();
    assert.strictEqual(deck.data.overall.total, n, 'deck 总数应为 ' + n + '，实际 ' + deck.data.overall.total);
    assert.strictEqual(deck.data.overall.fresh, n, '新导入的词都该是"未学"');
    /**
     * 2026-09-18 改口径：首页主数字从"词库里所有到期的"改成"今日计划张数（受每日新词上限约束）"。
     * 原因：原来显示 229 而复习页只给 10 张，首页在吓唬用户。
     *
     * 所以这里断言的契约变成两条（比原来更严）：
     *   ① freshTotal —— 词库总量仍如实反映"还有多少没学"（背景信息）
     *   ② dueCount  —— 首页主数字 = 复习页实际会给的张数（两者同口径）
     */
    assert.strictEqual(deck.data.freshTotal, n, '词库还有未学词数应为 ' + n + '，实际 ' + deck.data.freshTotal);
    assert.ok(deck.data.dueCount > 0, '今日计划应有词可练，实际 ' + deck.data.dueCount);
    assert.ok(deck.data.dueCount <= n, '今日计划不应超过词库总量');

    // 与复习页对照：两页的"今天要练多少"必须一致（这是本次修复的核心契约）
    const studyForCount = mount('pages/study/study.js');
    studyForCount.onLoad();
    assert.strictEqual(studyForCount.data.dueCountNow, deck.data.dueCount,
      '首页与复习页的今日计划数必须一致：deck=' + deck.data.dueCount +
      ' study=' + studyForCount.data.dueCountNow);
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
    const p = mount('pack-curriculum/pages/curriculum/curriculum.js');
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
  global.clearTimeout = realClearTimeout;
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
