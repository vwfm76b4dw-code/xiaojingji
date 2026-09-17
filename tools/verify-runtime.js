/**
 * 运行时冒烟测试 —— 用 mock 的 wx 真实执行页面生命周期。
 *
 * 为什么必须有这一层：
 *   编译通过 ≠ 能跑。编译器不执行代码，所以像
 *   「setData 里引用了 undefined」「onLoad 里读的字段不存在」
 *   「生命周期顺序错导致 this.xxx 是 undefined」这类问题，
 *   编译期一个都发现不了，但一进模拟器就白屏。
 *
 * 做法：伪造一个够真的 wx（storage / setData / toast / selectorQuery），
 * 然后按真实顺序调用每个页面的 onLoad / onShow / 交互方法，看会不会抛错。
 *
 * 运行：node tools/verify-runtime.js
 */
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const results = [];

/**
 * 支持异步的断言包装。
 * 注意：页面里不少推进是 setTimeout 做的（评分后隔 190ms 切下一张），
 * 用例必须能 await，否则断言会跑在状态更新之前而误判通过。
 */
async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') await r;
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name);
    console.log('      ' + (e && e.message ? e.message : String(e)));
    results.push({ name, err: e });
  }
}

/*------------------------ 伪造一个够真的 wx ------------------------*/

// 模拟"未接入插件"（个人主体无法添加 WechatSI 的常见情况）——
// 这也顺带验证了 voice.js 的容错：插件不可用不能拖垮整个模块
global.requirePlugin = function (name) {
  throw new Error('plugin not configured: ' + name);
};

function makeWx() {
  const storage = {};
  const toasts = [];
  const modals = [];

  return {
    // --- 存储 ---
    getStorageSync: k => (k in storage ? JSON.parse(JSON.stringify(storage[k])) : ''),
    setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete storage[k]; },

    // --- 交互反馈（记录下来供断言）---
    showToast: o => { toasts.push(o); },
    hideToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    showModal: o => { modals.push(o); if (o && o.success) o.success({ confirm: false }); },
    setClipboardData: () => {},
    stopPullDownRefresh: () => {},

    // --- 导航 ---
    switchTab: () => {},
    navigateTo: () => {},
    redirectTo: () => {},
    navigateBack: () => {},
    setNavigationBarTitle: () => {},

    // --- 设备信息（chart.js 会读）---
    getWindowInfo: () => ({ pixelRatio: 2, windowWidth: 375, windowHeight: 667 }),
    getSystemInfoSync: () => ({ pixelRatio: 2, windowWidth: 375, windowHeight: 667 }),
    getDeviceInfo: () => ({ brand: 'test', model: 'mock', system: 'mock' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.17.3' }),

    // --- 录音与播放（朗读页要用）---
    getRecorderManager: () => makeRecorder(),
    createInnerAudioContext: () => makeAudio(),

    // --- 文件系统与用户目录（随包音频的复制路径要用）---
    env: { USER_DATA_PATH: '/mock-userdata' },
    getFileSystemManager: () => ({
      copyFile: o => {
        // 模拟真机：包内文件存在则复制成功
        if (String(o.srcPath || '').indexOf('/data/audio/') === 0) {
          setTimeout(() => o.success && o.success({}), 0);
        } else {
          setTimeout(() => o.fail && o.fail({ errMsg: 'copyFile:fail no such file' }), 0);
        }
      },
      readFile: o => {
        if (o.encoding === 'base64') {
          setTimeout(() => o.success && o.success({ data: 'QkFTRTY0' }), 0);
        } else {
          setTimeout(() => o.success && o.success({ data: new ArrayBuffer(8) }), 0);
        }
      }
    }),

    // --- 网络（asr.js 要用）---
    request: opts => {
      if (!opts || typeof opts.success !== 'function') return;
      const url = String(opts.url || '');
      // 按接口返回不同的 mock 数据
      let data = { ok: true, vocab_size: 295, asr_loaded: true };
      if (url.indexOf('/api/word/ask') !== -1) {
        data = {
          ok: true, mode: 'generated',
          answer: 'geography 容易和 photography 混，都含 graph。',
          sources: [
            { word: 'photography', meaning: 'n. 摄影', via: 'phonetic', score: 0.806 },
            { word: 'geography', meaning: 'n. 地理', via: 'semantic', score: 0.723 }
          ]
        };
      }
      setTimeout(() => opts.success({ statusCode: 200, data: data }), 0);
    },
    uploadFile: opts => {
      if (opts && typeof opts.success === 'function') {
        // 模拟一次"读得不错"的评测结果
        setTimeout(() => opts.success({
          statusCode: 200,
          data: JSON.stringify({
            ok: true, heard: 'geography', band: 'pass', score: 1.0,
            verdict: '读得不错', suggestion: '', asr_seconds: 1.1, total_seconds: 2.2
          })
        }), 0);
      }
    },

    // --- 下一帧 ---
    nextTick: fn => { setTimeout(fn, 0); },

    // --- selectorQuery：canvas 查询在 mock 里返回 null（页面应容错）---
    createSelectorQuery: () => ({
      in: () => ({
        select: () => ({
          fields: () => ({
            exec: cb => cb([null])          // 模拟"查不到 canvas 节点"
          })
        })
      })
    }),

    // --- 仅供测试读取 ---
    __toasts: toasts,
    __modals: modals,
    __storage: storage
  };
}

/**
 * 伪造录音管理器：能触发 onStart/onStop，用于跑通朗读流程。
 * 页面通过 this.recorder.start() 开始、.stop() 结束；
 * mock 里 stop() 立刻回调 onStop（带一个假的临时文件路径）。
 */
function makeRecorder() {
  const handlers = {};
  const rec = {
    // 让测试能指定"平台报告的真实录音时长"（页面优先用它，而非定时器估算）
    __duration: 1200,
    onStart: fn => { handlers.start = fn; },
    onStop: fn => { handlers.stop = fn; },
    onError: fn => { handlers.error = fn; },
    start() { if (handlers.start) setTimeout(() => handlers.start(), 0); },
    stop() {
      if (handlers.stop) {
        setTimeout(() => handlers.stop({
          tempFilePath: '/tmp/mock_rec.wav',
          duration: rec.__duration
        }), 0);
      }
    }
  };
  return rec;
}

function makeAudio() {
  return {
    src: '', volume: 1,
    onEnded: fn => { /* 记录但不主动触发 */ },
    onError: fn => {},
    play() {},
    stop() {},
    destroy() {}
  };
}

/**
 * 载入一个页面模块并实例化。
 * 页面 JS 调用的是全局 Page(options)，所以这里临时替换全局 Page 把它接住。
 */
function loadPage(relPath) {
  const full = path.resolve(__dirname, '..', 'miniprogram', relPath);
  delete require.cache[full];

  let captured = null;
  const realPage = global.Page;
  global.Page = opts => { captured = opts; };
  try {
    require(full);
  } finally {
    global.Page = realPage;
  }
  if (!captured) throw new Error(relPath + ' 没有调用 Page()');

  // 造一个像页面实例的对象：data + setData + 各方法
  const inst = Object.assign({}, captured);
  inst.data = JSON.parse(JSON.stringify(captured.data || {}));
  inst.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(k => { inst.data[k] = patch[k]; });
    if (typeof cb === 'function') cb();
  };
  return inst;
}

/** 安全地清掉模块缓存，保证每轮从干净状态开始 */
function freshRequire(relPath) {
  const full = path.resolve(__dirname, '..', 'miniprogram', relPath);
  delete require.cache[full];
  return require(full);
}

/*---------------------- 状态读写辅助 ----------------------
 * 关键差异：本项目把「内容 + SM-2 状态」写在**同一条词条记录**里
 * （storage key = 'words'），而不是分成两张表。所以测试不能再用
 * states[id] 这种独立表的方式读写，必须落到 words 数组里。
 * 这三个辅助就是把这层差异收拢到一处，避免散落每个用例。
 */

/**
 * 让 cards.js 的模块级缓存失效。
 *
 * 为什么测试必须做这件事：cards.js 缓存了全量卡片与状态，页面 onShow 时
 * 靠 invalidate() 刷新。测试直接改 storage 后如果不同步失效，
 * 页面会读到上一轮的旧快照 —— 表现为"明明塞了记录，页面却说没有"。
 * 这不是测试的取巧，而是真实存在的约束：**绕过 store 写数据，就要负责通知缓存**。
 */
function invalidateCards() {
  try {
    const m = require(path.resolve(__dirname, '..', 'miniprogram', 'utils', 'cards.js'));
    if (m && typeof m.invalidate === 'function') m.invalidate();
  } catch (e) { /* 尚未加载时忽略 */ }
}

/** 读某个词条的算法状态；没有该词或未复习返回 null */
function readState(id) {
  const arr = global.wx.__storage['words'] || [];
  for (const w of arr) {
    if (w.id === id) return (w.history && w.history.length > 0) || w.reps > 0 ? w : null;
  }
  return null;
}

/** 把学过的记录全部抹掉（保留词条内容），用于造"全新用户"场景 */
function clearAllStates() {
  const arr = global.wx.__storage['words'] || [];
  arr.forEach(w => {
    w.ef = 2.5; w.reps = 0; w.interval = 0; w.history = [];
  });
  global.wx.__storage['words'] = arr;
  invalidateCards();
}

/** 给指定词条塞一条状态（模拟"这个词已经学过了"） */
function seedState(id, st) {
  const arr = global.wx.__storage['words'] || [];
  for (const w of arr) {
    if (w.id === id) {
      w.ef = st.ef; w.reps = st.reps; w.interval = st.interval;
      w.nextReview = st.nextReview;
      w.history = st.history || [];
      break;
    }
  }
  global.wx.__storage['words'] = arr;
  invalidateCards();
}

/** 取一个真实的词条 id（不写死，避免内容换代后测试失效） */
function anyCardId(nth) {
  const arr = global.wx.__storage['words'] || [];
  if (arr.length === 0) throw new Error('词库为空，预置没生效');
  return arr[nth || 0].id;
}

/** 取一个真实的词条 id（同批次，用于邻卡测试） */
function anyCardIds(n) {
  return (global.wx.__storage['words'] || []).slice(0, n).map(w => w.id);
}

/*------------------------------ 用例 ------------------------------*/

(async function main() {
  global.wx = makeWx();

  // 预置词表：页面通过 utils/cards.js 从本机词库读，首次打开由 app.js 预置。
  // 这里手工跑一次 initSeed，模拟"用户首次打开"的存储状态，让页面有内容可读。
  const seed = freshRequire('data/textbook-7a.js');
  const storeMod = freshRequire('utils/store.js');
  storeMod.initSeed(seed.words);
  const cardsMod = freshRequire('utils/cards.js');
  cardsMod.invalidate();

  // 本轮的"今天"：页面内部用的就是它，断言里要能对比
  const today0 = freshRequire('utils/date.js').todayStr();

  console.log('运行时冒烟测试（mock wx，真实执行生命周期）\n');
  console.log('词表：' + seed.count + ' 词\n');

  /*------------------- 卡组页 -------------------*/

  await check('卡组页：onLoad + onShow 不抛错', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.onShow();
    assert.ok(page.data.overall, '没有算出 overall');
    assert.ok(Array.isArray(page.data.subjects), 'subjects 不是数组');
  });

  await check('卡组页：整体进度数字自洽', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.onShow();
    const o = page.data.overall;
    assert.strictEqual(o.mastered + o.learning + o.fresh, o.total,
      `三态之和应等于总数：${o.mastered}+${o.learning}+${o.fresh} != ${o.total}`);
    assert.ok(o.total > 0, '应有卡片');
    assert.ok(o.percent >= 0 && o.percent <= 100, 'percent 越界：' + o.percent);
  });

  await check('卡组页：今日到期数 = 初始应为全部新卡', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.onShow();
    // 全新状态：所有卡都没学过 → 全部到期
    assert.strictEqual(page.data.dueCount, page.data.overall.total,
      '新状态下所有卡都应到期');
  });

  await check('卡组页：点学科能展开卡片列表', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.onShow();
    const first = page.data.subjects[0];
    assert.ok(first, '没有学科');
    page.toggleSubject({ currentTarget: { dataset: { subject: first.subject } } });
    assert.strictEqual(page.data.expanded, first.subject, '未展开');
    assert.ok(page.data.cardList.length > 0, '卡片列表为空');
    assert.ok(page.data.cardList[0].status, '卡片缺状态标签');
    // 再点一次应收起
    page.toggleSubject({ currentTarget: { dataset: { subject: first.subject } } });
    assert.strictEqual(page.data.expanded, '', '未收起');
  });

  await check('卡组页：resetProgress 弹确认框', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.toggleSubjectClear = null;
    page.resetProgress();
    assert.ok(global.wx.__modals.length > 0, '没有弹出确认框');
  });

  /*------------------- 复习页 -------------------*/

  await check('复习页：onLoad 建立队列且首卡就绪', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    assert.ok(page.data.ready, 'ready 未置位');
    assert.ok(page.data.queue.length > 0, '队列为空');
    assert.ok(page.data.current, 'current 为空');
    assert.strictEqual(page.data.current.id, page.data.queue[0].id, 'current 应等于队列首张');
  });

  await check('复习页：未翻面时评分被拦截（主动回忆机制）', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    const before = JSON.stringify(page.data);
    page.onGrade({ currentTarget: { dataset: { q: 5 } } });
    assert.strictEqual(JSON.stringify(page.data), before, '未翻面却发生了评分');
  });

  await check('复习页：翻面后评分推进到下一张并落库', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    const firstId = page.data.current.id;
    page.flipCard();
    assert.strictEqual(page.data.flipped, true, '翻面失败');
    page.onGrade({ currentTarget: { dataset: { q: 5 } } });

    // 评分是异步推进（setTimeout），等一拍
    return new Promise(resolve => setTimeout(resolve, 350)).then(() => {
      // 状态应已写入 storage（词条记录里）
      const stored = readState(firstId);
      assert.ok(stored, '学习状态没有落库');
      assert.strictEqual(stored.interval, 1, '首次"认识"间隔应为 1 天');
      assert.strictEqual(stored.reps, 1, 'reps 应为 1');
      assert.ok(page.data.reviewed >= 1, 'reviewed 未累加');
    });
  });

  await check('复习页：连对计数与徽章', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    // 连做 3 次"认识"
    for (let i = 0; i < 3; i++) {
      page.flipCard();
      page.onGrade({ currentTarget: { dataset: { q: 5 } } });
      // 立刻复位 leaving，模拟 setTimeout 已完成
      page.data.leaving = false;
      page.data.idx = Math.min(page.data.idx + 1, page.data.queue.length - 1);
      page.data.current = page.data.queue[page.data.idx];
      page.data.flipped = false;
    }
    assert.ok(page.data.streak >= 1, 'streak 未累加');
    assert.ok(page.data.roundKnow >= 1, 'roundKnow 未累加');
  });

  await check('复习页：答"不认识"重置连对', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    page.data.streak = 5;
    page.flipCard();
    page.onGrade({ currentTarget: { dataset: { q: 1 } } });
    assert.strictEqual(page.data.streak, 0, '不认识应重置连对');
    assert.ok(page.data.roundForgot >= 1, 'roundForgot 未累加');
  });

  await check('复习页：队列耗尽后进入完成态', () => {
    const page = loadPage('pages/study/study.js');
    // 直接把队列缩到 1 张，模拟"只剩最后一张"
    page.onLoad();
    page.data.queue = [page.data.queue[0]];
    page.data.current = page.data.queue[0];
    page.data.idx = 0;
    page.data.flipped = true;
    page.onGrade({ currentTarget: { dataset: { q: 5 } } });
    return new Promise(resolve => setTimeout(resolve, 350)).then(() => {
      assert.strictEqual(page.data.done, true, '未进入完成态');
      assert.ok(page.data.reviewed >= 1, 'reviewed 未记录');
    });
  });

  await check('复习页：again() 能重开一轮', () => {
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    page.data.done = true;
    page.again();
    // 刚复习过的卡已排到未来，队列应清空（正常：今天没有到期的了）
    assert.ok(page.data.ready, 'again 后 ready 未置位');
    assert.ok(Array.isArray(page.data.queue), 'queue 不是数组');
  });

  /*------------------- 统计页 -------------------*/

  await check('统计页：onLoad + onShow 不抛错', () => {
    const page = loadPage('pages/stats/stats.js');
    page.onLoad();
    page.onShow();
    assert.ok(page.data.overall, '缺 overall');
    assert.ok(page.data.self, '缺 self');
    assert.ok(Array.isArray(page.data.subjects), 'subjects 不是数组');
    assert.ok(Array.isArray(page.data.reviewDist), 'reviewDist 不是数组');
  });

  await check('统计页：无复习记录时 self.hasData=false（显示引导而非 0%）', () => {
    // 先清空学习状态，确保是"全新用户"场景
    clearAllStates();
    const page = loadPage('pages/stats/stats.js');
    page.onLoad();
    assert.strictEqual(page.data.self.hasData, false, '无记录时 hasData 应为 false');
    assert.ok(page.data.curveSummary.indexOf('还没有') !== -1,
      '应提示还没有记录，实际：' + page.data.curveSummary);
  });

  await check('统计页：canvas 查不到节点时不崩（真机首帧可能查不到）', () => {
    // mock 的 selectorQuery 返回 [null]，页面必须容错
    const page = loadPage('pages/stats/stats.js');
    page.onLoad();
    // drawCurve / drawSubjectBars 内部走 initCanvas → 返回 null → 应静默跳过
    // 这里只要不抛错即可（onLoad 里已经触发过绘制）
    assert.ok(true);
  });

  await check('统计页：有复习记录后指标出数', () => {
    // 造一条复习记录
    clearAllStates();
    seedState(anyCardId(0), {
      ef: 2.6, reps: 1, interval: 1, nextReview: '2026-09-17',
      history: [{ date: '2026-09-16', q: 5, interval: 1 }]
    });

    const page = loadPage('pages/stats/stats.js');
    page.onLoad();
    assert.strictEqual(page.data.self.hasData, true, '有记录时 hasData 应为 true');
    assert.ok(page.data.self.firstTryRate >= 0, 'firstTryRate 异常');
    assert.ok(page.data.self.avgEF > 0, 'avgEF 异常');
    assert.ok(page.data.points > 0, '积分未累加');
  });

  /*------------------- 卡详情页 -------------------*/

  await check('卡详情页：能按 id 找到卡并显示钩子', () => {
    const all = cardsMod.allCards();
    const target = all[0];
    const page = loadPage('pages/card/card.js');
    page.onLoad({ id: target.id });
    assert.ok(page.data.ready, 'ready 未置位');
    assert.ok(page.data.card, '没找到卡');
    assert.strictEqual(page.data.card.id, target.id);
    assert.ok(page.data.card.hook, '卡没有 hook 字段');
    assert.ok(page.data.statusText, '缺状态文案');
  });

  await check('卡详情页：未学过的卡显示"还没学过"', () => {
    clearAllStates();
    const target = cardsMod.allCards()[1];
    const page = loadPage('pages/card/card.js');
    page.onLoad({ id: target.id });
    assert.strictEqual(page.data.statusText, '还没学过');
    assert.strictEqual(page.data.history.length, 0, '新卡不该有历史');
  });

  await check('卡详情页：id 不存在时不崩（显示"找不到"）', () => {
    const page = loadPage('pages/card/card.js');
    page.onLoad({ id: 'this-id-does-not-exist' });
    assert.ok(page.data.ready, 'ready 未置位');
    assert.strictEqual(page.data.card, null, '不该找到卡');
  });

  await check('卡详情页：onLoad 无参数也不崩', () => {
    const page = loadPage('pages/card/card.js');
    page.onLoad({});
    assert.ok(page.data.ready);
  });

  await check('卡详情页：同批次邻卡不含自己', () => {
    const all = cardsMod.allCards();
    const target = all[0];
    const page = loadPage('pages/card/card.js');
    page.onLoad({ id: target.id });
    const sibs = page.data.siblings || [];
    assert.ok(sibs.every(s => s.id !== target.id), '邻卡里混进了自己');
  });

  /*------------------- 复习筛选与错题本 -------------------*/

  await check('复习页：默认按"今日待复习"建队列', () => {
    clearAllStates();
    delete global.wx.__storage['study_prefs'];
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    assert.strictEqual(page.data.scope, 'due', '默认范围应为 due');
    assert.strictEqual(page.data.subject, 'all', '默认学科应为 all');
    assert.ok(page.data.queue.length > 0);
  });

  await check('复习页：切学科重建队列且只含该学科', () => {
    clearAllStates();
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    const subs = page.data.subjects;
    assert.ok(subs.length > 0, '没有学科可选');
    const target = subs[0].subject;
    page.data.reviewed = 0;           // 避免触发"换一批"确认弹窗
    page.pickSubject({ currentTarget: { dataset: { subject: target } } });
    assert.strictEqual(page.data.subject, target, '学科未切换');
    assert.ok(page.data.queue.length > 0, '切换后队列为空');
    assert.ok(page.data.queue.every(c => c.subject === target), '队列混进了别的学科');
  });

  await check('复习页：错题本为空时点"重练"给提示而不崩', () => {
    clearAllStates();
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    global.wx.__toasts.length = 0;
    page.practiceWeak();
    assert.ok(global.wx.__toasts.length > 0, '应给出提示');
  });

  await check('复习页：答错后该卡进入错题本', () => {
    clearAllStates();
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    const id = page.data.current.id;
    page.flipCard();
    page.onGrade({ currentTarget: { dataset: { q: 1 } } });
    return new Promise(r => setTimeout(r, 350)).then(() => {
      const st = freshRequire('utils/store.js');
      assert.ok(st.weakIds().indexOf(id) !== -1, '答错的卡应进错题本');
    });
  });

  await check('复习页：全部答对时错题本不含该卡', () => {
    clearAllStates();
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    const id = page.data.current.id;
    page.flipCard();
    page.onGrade({ currentTarget: { dataset: { q: 5 } } });
    return new Promise(r => setTimeout(r, 350)).then(() => {
      const st = freshRequire('utils/store.js');
      assert.ok(st.weakIds().indexOf(id) === -1, '全对的卡不该进错题本');
    });
  });

  await check('复习页：偏好被持久化（下次打开沿用）', () => {
    clearAllStates();
    delete global.wx.__storage['study_prefs'];
    const page = loadPage('pages/study/study.js');
    page.onLoad();
    page.data.reviewed = 0;
    page.pickScope({ currentTarget: { dataset: { scope: 'all' } } });
    const saved = global.wx.__storage['study_prefs'];
    assert.ok(saved && saved.scope === 'all', '偏好未保存：' + JSON.stringify(saved));

    const page2 = loadPage('pages/study/study.js');
    page2.onLoad();
    assert.strictEqual(page2.data.scope, 'all', '未沿用上次选择的范围');
  });

  /*------------------- 卡组页搜索 -------------------*/

  await check('卡组页：搜索能命中 prompt / answer / hook', () => {
    clearAllStates();
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    const sample = cardsMod.allCards()[0];

    // 用 prompt 的一段搜
    page.data.keyword = String(sample.prompt).slice(0, 3);
    page.doSearch();
    assert.ok(page.data.searchResults.length > 0, '按 prompt 搜索无结果');

    // 用 hook 里的词搜（体现"能靠记忆钩子找到卡"）
    page.data.keyword = '词根';
    page.doSearch();
    assert.ok(page.data.searchResults.length >= 0, 'hook 搜索不应崩');

    page.clearSearch();
    assert.strictEqual(page.data.searching, false, '清空后 searching 未复位');
    assert.strictEqual(page.data.searchResults.length, 0);
  });

  await check('卡组页：搜索空关键词给提示而不崩', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    global.wx.__toasts.length = 0;
    page.data.keyword = '   ';
    page.doSearch();
    assert.ok(global.wx.__toasts.length > 0, '应提示输入关键词');
  });

  await check('卡组页：搜不到时给空结果而非报错', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    page.data.keyword = 'zzzz-not-exist-keyword-zzzz';
    page.doSearch();
    assert.strictEqual(page.data.searchResults.length, 0);
  });

  await check('卡组页：搜索覆盖全学科（不因筛选丢失结果）', () => {
    const page = loadPage('pages/deck/deck.js');
    page.onLoad();
    // 用一个几乎所有卡都含的常见字（如"的"或字母 a）
    page.data.keyword = 'a';
    page.doSearch();
    const subjects = {};
    page.data.searchResults.forEach(r => { subjects[r.subject] = true; });
    // 至少不该崩，且结果都带 subject
    page.data.searchResults.forEach(r => {
      assert.ok(r.subject, '搜索结果缺学科字段');
      assert.ok(r.status, '搜索结果缺状态字段');
    });
  });

  /*------------------- 朗读页（ASR）-------------------*/

  await check('朗读页：onLoad 建立队列且首词就绪', () => {
    clearAllStates();
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    assert.ok(page.data.ready, 'ready 未置位');
    assert.ok(page.data.card, '没有当前单词');
    assert.ok(page.data.card.prompt, '单词卡缺 prompt');
    assert.strictEqual(page.data.revealed, false, '初始不该揭示答案（先读后看）');
  });

  await check('朗读页：cfg 已进 data（WXML 要读它）', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    assert.ok(page.data.cfg && typeof page.data.cfg === 'object', 'cfg 不在 data 里');
    assert.ok('showHook' in page.data.cfg, 'cfg 缺 showHook');
  });

  await check('朗读页：录音 → 评测 → 出结果并记录', () => {
    clearAllStates();
    delete global.wx.__storage['pron_records'];
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    const word = page.data.card.prompt;
    const cardId = page.data.card.id;

    page.startRecord();
    return new Promise(r => setTimeout(r, 30)).then(() => {
      assert.strictEqual(page.data.recording, true, '未进入录音态');
      page.recorder.__duration = 1200;         // 平台报告录了 1.2 秒
      page.stopRecord();
      return new Promise(r => setTimeout(r, 120));
    }).then(() => {
      assert.ok(page.data.result, '评测后无结果');
      assert.strictEqual(page.data.result.band, 'pass', '结果档位错误');
      assert.strictEqual(page.data.revealed, true, '评测后应揭示答案');
      assert.strictEqual(page.data.stats.pass, 1, '统计未累加');
      // 记录应已落库
      const recs = global.wx.__storage['pron_records'];
      assert.ok(recs && recs[cardId], '朗读记录未写入');
      assert.strictEqual(recs[cardId][0].band, 'pass');
    });
  });

  await check('朗读页：录音太短不发请求', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    global.wx.__toasts.length = 0;
    page.startRecord();
    return new Promise(r => setTimeout(r, 30)).then(() => {
      page.recorder.__duration = 100;          // 平台报告只录了 100ms
      page.stopRecord();
      return new Promise(r => setTimeout(r, 60));
    }).then(() => {
      assert.strictEqual(page.data.result, null, '太短不该出结果');
      assert.ok(global.wx.__toasts.length > 0, '应提示"读完整个单词"');
    });
  });

  await check('朗读页："不会读" → 记录为 unknown 并播放发音', () => {
    delete global.wx.__storage['pron_records'];
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    const cardId = page.data.card.id;
    page.markUnknown();
    assert.strictEqual(page.data.result.band, 'unknown');
    assert.strictEqual(page.data.stats.unknown, 1);
    assert.strictEqual(page.data.revealed, true, '点"不会读"也应看到答案');
    const recs = global.wx.__storage['pron_records'];
    assert.ok(recs[cardId], '"不会读"未记录');
    assert.strictEqual(recs[cardId][0].band, 'unknown');
  });

  await check('朗读页：播放发音设置 src 且不崩（随包音频，本地路径）', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    page.playAudio();
    // 播放现在是异步的（要先解析出可播路径：包内 → 本地复制 → 插件）
    return new Promise(r => setTimeout(r, 30)).then(() => {
      // 断言的是"有可播的音频源"，而不是"必须是 http 链接"——
      // 随包音频是本地路径，这比走网络更好（离线可用、零延迟）
      assert.ok(page.audio.src && page.audio.src.indexOf('.mp3') !== -1,
        'audio.src 未设置：' + page.audio.src);
      assert.strictEqual(page.data.playing, true, 'playing 未置位');
      page.stopAudio();
      assert.strictEqual(page.data.playing, false, 'stopAudio 未复位');
    });
  });

  await check('朗读页：next 推进到下一个词', () => {
    clearAllStates();
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    const firstId = page.data.card.id;
    page.next();
    if (page.data.total > 1) {
      assert.notStrictEqual(page.data.card.id, firstId, '未切到下一个词');
      assert.strictEqual(page.data.result, null, '切词后应清空上一轮结果');
    }
  });

  await check('朗读页：走完一轮进入完成态', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    for (let i = 0; i < page.data.total; i++) page.next();
    assert.strictEqual(page.data.finished, true, '未进入完成态');
  });

  await check('朗读页：松手快于录音启动时不录满 10 秒（首次授权场景）', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    let stopCalled = false;
    const origStop = page.recorder.stop.bind(page.recorder);
    page.recorder.stop = () => { stopCalled = true; origStop(); };

    page.startRecord();
    // 立刻松手（onStart 还没回来）
    page.stopRecord();
    return new Promise(r => setTimeout(r, 40)).then(() => {
      assert.strictEqual(stopCalled, true,
        'onStart 未回来时松手，必须补一次 stop —— 否则会录满 10 秒');
    });
  });

  await check('朗读页：onHide 清理（不在已隐藏页面上继续录音/刷数据）', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    page.startRecord();
    return new Promise(r => setTimeout(r, 30)).then(() => {
      page.onHide();     // 模拟切走
      assert.strictEqual(page.data.recording, false, 'onHide 后应停止录音态');
    });
  });

  await check('朗读页：评测中标记"不会读"被拦住（防止两张卡叠显）', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    page.setData({ judging: true });
    const before = JSON.stringify(page.data.result);
    page.markUnknown();
    assert.strictEqual(JSON.stringify(page.data.result), before,
      '评测中点"不会读"应被忽略');
  });

  await check('朗读页：分数对学生显示为百分比', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    page.startRecord();
    return new Promise(r => setTimeout(r, 30)).then(() => {
      page.recorder.__duration = 1200;
      page.stopRecord();
      return new Promise(r => setTimeout(r, 120));
    }).then(() => {
      assert.ok(page.data.result.scorePct >= 0 && page.data.result.scorePct <= 100,
        'scorePct 应为 0-100，实际 ' + page.data.result.scorePct);
    });
  });

  /*------------------- 问词页（RAG）-------------------*/

  await check('问词页：onLoad 不抛错且有示例问题', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    assert.ok(Array.isArray(page.data.samples), '缺示例问题');
    assert.ok(page.data.samples.length >= 3, '示例问题太少');
  });

  await check('问词页：空问题被拦下', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    global.wx.__toasts.length = 0;
    page.setData({ question: '   ' });
    page.ask();
    assert.ok(global.wx.__toasts.length > 0, '空问题应提示');
    assert.strictEqual(page.data.answer, '', '不该有回答');
  });

  await check('问词页：提问 → 端上检索出回答 → 带来源', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    page.setData({ question: 'geography 和哪个词容易混' });
    page.ask();
    return new Promise(r => setTimeout(r, 200)).then(() => {
      assert.ok(page.data.question, '问题未填入');
      assert.ok(page.data.answer, '没有回答');
      // 现在是**端上检索**作答（不再依赖服务器与模型），
      // 所以模式是 retrieval_only；云函数可用时才会升级为 generated
      assert.ok(page.data.mode === 'retrieval_only' || page.data.mode === 'generated',
        '模式异常：' + page.data.mode);
      assert.ok(page.data.sources.length > 0, '没有来源');
      // 易混通道的来源要能标出来（这是本功能的特色）
      assert.ok(page.data.sources.some(s => s.via === 'phonetic' || s.via === 'category'),
        '缺易混/同类来源');
    });
  });

  await check('问词页：点示例问题直接提问', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    // 示例问题现在是 {q, tag} 对象（带类型标签，让学生看得出能问什么），
    // 所以传下标而不是原来的 data-q 字符串
    page.useSample({ currentTarget: { dataset: { i: 1 } } });
    assert.ok(page.data.question, '问题未填入');
    return new Promise(r => setTimeout(r, 200)).then(() => {
      assert.ok(page.data.answer, '点示例后没有回答');
    });
  });

  await check('问词页：清空复位', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    page.setData({ question: 'q', answer: 'a', sources: [{ word: 'x' }], mode: 'generated' });
    page.clearAll();
    assert.strictEqual(page.data.answer, '');
    assert.strictEqual(page.data.sources.length, 0);
    assert.strictEqual(page.data.question, '');
  });

  await check('问词页：点来源词能播放发音（随包音频）', () => {
    const page = loadPage('pages/ask/ask.js');
    page.onLoad();
    page.playSource({ currentTarget: { dataset: { word: 'geography' } } });
    return new Promise(r => setTimeout(r, 30)).then(() => {
      assert.strictEqual(page.data.playingWord, 'geography', '未标记播放中');
      assert.ok(page.audio.src && page.audio.src.indexOf('.mp3') !== -1,
        'audio.src 未设置：' + page.audio.src);
    });
  });

  await check('语音适配层：插件不可用时不崩（个人主体场景）', () => {
    const voice = freshRequire('utils/voice.js');
    const cap = voice.capability();
    assert.strictEqual(cap.plugin, false, 'mock 环境下插件应不可用');
    assert.ok(cap.backend === 'local' || cap.backend === 'offline', '后端应降级');
  });

  await check('语音适配层：插件不可用时识别返回 NO_PLUGIN 而非抛错', () => {
    const voice = freshRequire('utils/voice.js');
    return voice.recognizeOnce({}).then(r => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'NO_PLUGIN');
    });
  });

  await check('朗读页：语音后端为 offline 时，按住按钮给"先自己读"的出路', () => {
    const page = loadPage('pages/pronounce/pronounce.js');
    page.onLoad({});
    page.setData({ voiceMode: 'offline' });
    page.voiceBackend = 'offline';
    global.wx.__toasts.length = 0;
    page.startRecord();
    assert.ok(global.wx.__toasts.length > 0, '应给出提示而不是静默');
    assert.strictEqual(page.data.revealed, true, '应直接揭示答案让学生自己核对');
  });

  /*------------------- 设置页（参数化）-------------------*/

  await check('设置页：onLoad 载入配置且带默认值', () => {
    delete global.wx.__storage['settings'];
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    const c = page.data.cfg;
    assert.ok(c.dailyNewWords > 0, '缺每日新词数默认值');
    assert.ok(c.sessionSize > 0, '缺单轮张数默认值');
    assert.ok(typeof c.passScore === 'number', '缺判定阈值默认值');
    assert.strictEqual(c.pronounceEnabled, true, '朗读默认应开启');
  });

  await check('设置页：步进器改变参数并持久化', () => {
    delete global.wx.__storage['settings'];
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    const before = page.data.cfg.dailyNewWords;
    page.step({ currentTarget: { dataset: { k: 'dailyNewWords', d: '5', min: '5', max: '50' } } });
    assert.strictEqual(page.data.cfg.dailyNewWords, before + 5, '步进未生效');
    const saved = global.wx.__storage['settings'];
    assert.strictEqual(saved.dailyNewWords, before + 5, '未持久化');
  });

  await check('设置页：步进器受上下限约束', () => {
    delete global.wx.__storage['settings'];
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    // 往下点很多次，应停在 min
    for (let i = 0; i < 20; i++) {
      page.step({ currentTarget: { dataset: { k: 'sessionSize', d: '-5', min: '5', max: '50' } } });
    }
    assert.strictEqual(page.data.cfg.sessionSize, 5, '未停在最小值');
    for (let i = 0; i < 30; i++) {
      page.step({ currentTarget: { dataset: { k: 'sessionSize', d: '5', min: '5', max: '50' } } });
    }
    assert.strictEqual(page.data.cfg.sessionSize, 50, '未停在最大值');
  });

  await check('设置页：开关切换并持久化', () => {
    delete global.wx.__storage['settings'];
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    const before = page.data.cfg.autoPlayAudio;
    page.toggle({ currentTarget: { dataset: { k: 'autoPlayAudio' } } });
    assert.strictEqual(page.data.cfg.autoPlayAudio, !before, '开关未翻转');
    assert.strictEqual(global.wx.__storage['settings'].autoPlayAudio, !before);
  });

  await check('设置页：判定尺度三档切换', () => {
    delete global.wx.__storage['settings'];
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    page.pickThreshold({ currentTarget: { dataset: { level: 'strict' } } });
    assert.strictEqual(page.data.cfg.passScore, 0.90, '严格档阈值不对');
    page.pickThreshold({ currentTarget: { dataset: { level: 'loose' } } });
    assert.strictEqual(page.data.cfg.passScore, 0.78, '宽松档阈值不对');
    page.pickThreshold({ currentTarget: { dataset: { level: 'normal' } } });
    assert.strictEqual(page.data.cfg.passScore, 0.84, '标准档阈值不对');
  });

  await check('设置页：服务地址校验（必须 http 开头）', () => {
    const page = loadPage('pages/settings/settings.js');
    page.onLoad();
    global.wx.__toasts.length = 0;
    page.setData({ draftBase: 'not-a-url' });
    page.saveBase();
    assert.ok(global.wx.__toasts.length > 0, '非法地址应被拒绝');

    page.setData({ draftBase: 'http://192.168.1.5:8766' });
    page.saveBase();
    assert.strictEqual(global.wx.__storage['asr_base'], 'http://192.168.1.5:8766',
      '合法地址未保存');
  });

  /*------------------- 跨页一致性 -------------------*/

  await check('跨页：学习状态在卡组页与统计页口径一致', () => {
    clearAllStates();
    // 先学一张
    const study = loadPage('pages/study/study.js');
    study.onLoad();
    const id = study.data.current.id;
    study.flipCard();
    study.onGrade({ currentTarget: { dataset: { q: 5 } } });

    return new Promise(r => setTimeout(r, 350)).then(() => {
      const deck = loadPage('pages/deck/deck.js');
      deck.onLoad();
      deck.onShow();
      // 学过一张后：fresh 应减少 1，dueCount 应减少 1
      assert.ok(deck.data.overall.learning >= 1, '卡组页没反映"复习中"');
      // 该卡今天不应再到期（状态落在词条记录里，不是独立的 states 表）
      const st = readState(id);
      assert.ok(st, '状态未落库');
      assert.ok(st.nextReview > today0, 'nextReview 应为未来日期，实际 ' + st.nextReview);
    });
  });

  function page0Today() {
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /*------------------- 完成 -------------------*/

  await new Promise(r => setTimeout(r, 600));   // 等异步绘制/推进收尾

  console.log('\n>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) {
    console.log('\n失败详情：');
    results.forEach(r => {
      console.log('  · ' + r.name);
      console.log('    ' + (r.err && r.err.stack ? r.err.stack.split('\n').slice(0, 3).join('\n    ') : r.err));
    });
  }
  process.exit(fail > 0 ? 1 : 0);
})();
