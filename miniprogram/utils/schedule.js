/**
 * 复习队列与统计 —— 纯函数，供页面与 Node 测试共用。
 * 日期均为本地 YYYY-MM-DD 字符串，可直接按字典序比较。
 *
 * ## 为什么两套入参形状共存
 * 存储层是"内容+状态同记录"的扁平词条列表（见 utils/store.js），
 * 但页面有两种视角：
 *   · 词条视角：loadWords() → [{ word, meaning, ef, reps, nextReview, history }]
 *     用于录入、词库管理 —— 直接把词条当整体操作最省事。
 *   · 卡片/状态分离视角：loadCards() + loadStates() → 内容表 + { id: 状态 } map
 *     用于卡组浏览、复习、统计 —— 内容只读、状态频繁改，分开写更清晰。
 *
 * 同名函数对**第一参数做形状分派**（数组 vs 普通对象），两边调用方都不用改。
 * 这不是"重载魔法"：两种形状在首参上二值且无歧义，Array.isArray 一眼可判。
 *
 * ## 脏数据护栏
 * 所有取值都走 Number(...) + Number.isFinite 检查。原因：本地存储可能被旧版本、
 * 手改、或跨版本迁移写坏，一次 `undefined + 1` 就让整页统计变 NaN，
 * 而 Canvas 上表现为曲线消失、文字显示 "NaN" —— 比"少一个点"难排查得多。
 */

// 连续间隔达到 21 天视为已掌握（参照间隔重复软件的成熟卡惯例）
const MASTERED_INTERVAL = 21;

/** 把状态源统一成"逐条遍历"的形式，屏蔽两套入参差异 */
function eachState(src, fn) {
  if (Array.isArray(src)) {
    // 词条视角：直接遍历列表。**不按 id 过滤** —— 词条本来就未必有 id
    // （测试夹具、旧版本数据都可能没有），按 id 过滤会静默丢光整批。
    src.forEach(function (w) { if (w && typeof w === 'object') fn(w.id, w); });
  } else if (src && typeof src === 'object') {
    Object.keys(src).forEach(function (id) { fn(id, src[id]); });
  }
}

/** 取一条状态里真正参与计算的字段（缺 id 的脏记录返回 null） */
function safeState(st) {
  if (!st || typeof st !== 'object') return null;
  return st;
}

/*======================== 到期队列 ========================*/

/**
 * 今日到期队列。
 * 词条视角：dueWords(list, today)
 * 卡片视角：dueCards(cards, states, today)
 */
function dueWords(list, today) {
  return list
    .filter(function (w) { return w.nextReview <= today; })
    .sort(function (a, b) {
      if (a.nextReview !== b.nextReview) return a.nextReview < b.nextReview ? -1 : 1;
      return a.interval - b.interval;
    });
}

function dueCards(cards, states, today) {
  states = states || {};
  return cards
    .filter(function (c) {
      const st = states[c.id];
      // 从未学过的卡也算到期 —— 新卡立刻可学，否则首次打开队列是空的
      if (!st) return true;
      return st.nextReview <= today;
    })
    .sort(function (a, b) {
      const sa = states[a.id] || null;
      const sb = states[b.id] || null;
      // 新卡排前面：先建立初始印象，比先巩固旧卡更合理
      if (!sa && sb) return -1;
      if (sa && !sb) return 1;
      if (!sa && !sb) return 0;
      if (sa.nextReview !== sb.nextReview) return sa.nextReview < sb.nextReview ? -1 : 1;
      return sa.interval - sb.interval;
    });
}

/*======================== 下一批到期 ========================*/

/**
 * 区分"词条视角"与"卡片视角"两种调用形状。
 *
 * ⚠️ **不能用 Array.isArray(第一个参数) 判断** —— 卡片数组与词条数组都是数组，
 *    误判会让卡片视角走进词条分支：在卡片身上找 `card.interval` 恒为 undefined，
 *    于是"已掌握"永远算出 0、"下一批到期日"永远为空。这类错误**不会抛异常**，
 *    只是安静地给出错误数字，比崩溃更难发现。
 *
 * 可靠的判据是**第二个参数**：
 *   · 词条视角：第二参数是"今天"日期串，或根本不传 → 不是对象
 *   · 卡片视角：第二参数必定是状态 map → 是对象
 */
function isCardView(second) {
  return second !== undefined && second !== null && typeof second === 'object';
}

/** nextDueDate(list, today) 或 nextDueDate(cards, states, today) */
function nextDueDate(a, b, c) {
  let min = '';
  if (isCardView(b)) {
    const states = b;
    const today = c;
    (a || []).forEach(function (card) {
      const st = states[card.id];
      if (st && st.nextReview > today && (min === '' || st.nextReview < min)) min = st.nextReview;
    });
  } else {
    const today = b;
    (a || []).forEach(function (w) {
      if (w.nextReview > today && (min === '' || w.nextReview < min)) min = w.nextReview;
    });
  }
  return min;
}

/*======================== 掌握 / 新卡计数 ========================*/

/** masteredCount(list) 或 masteredCount(cards, states) */
function masteredCount(a, b) {
  if (isCardView(b)) {
    const states = b;
    return (a || []).filter(function (card) {
      const st = states[card.id];
      return st && st.interval >= MASTERED_INTERVAL;
    }).length;
  }
  // 词条视角：状态就在词条记录里
  return (a || []).filter(function (w) { return w.interval >= MASTERED_INTERVAL; }).length;
}

/** 新卡数（从未复习）—— 仅卡片视角需要 */
function freshCount(cards, states) {
  states = states || {};
  return (cards || []).filter(function (c) { return !states[c.id]; }).length;
}

/**
 * 按学科的进度概览 —— 卡组页要展示"这个学科我学到哪了"。
 * 返回 [{ subject, total, fresh, learning, mastered, dueToday }]
 */
function progressBySubject(cards, states, today) {
  states = states || {};
  const map = {};
  (cards || []).forEach(function (c) {
    const s = c.subject || '未分类';
    if (!map[s]) map[s] = { subject: s, total: 0, fresh: 0, learning: 0, mastered: 0, dueToday: 0 };
    const m = map[s];
    m.total++;
    const st = states[c.id];
    if (!st) {
      m.fresh++;
      m.dueToday++;              // 新卡随时可学
    } else {
      if (st.interval >= MASTERED_INTERVAL) m.mastered++;
      else m.learning++;
      if (st.nextReview <= today) m.dueToday++;
    }
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.total - a.total; });
}

/** 整体完成度：已掌握占比（含未学新卡，反映真实进度） */
function overallProgress(cards, states) {
  cards = cards || [];
  if (cards.length === 0) return { mastered: 0, learning: 0, fresh: 0, total: 0, percent: 0 };
  const m = masteredCount(cards, states);
  const fresh = freshCount(cards, states);
  return {
    mastered: m,
    learning: cards.length - m - fresh,
    fresh: fresh,
    total: cards.length,
    percent: Math.round((m / cards.length) * 100)
  };
}

/*======================== 积分 ========================*/

/** 累计积分：认识 +3 / 模糊 +1 / 不认识 +0（由复习历史推导，零新增存储） */
function pointsOf(src) {
  let sum = 0;
  eachState(src, function (id, st) {
    const hist = (safeState(st) && st.history) || [];
    if (!Array.isArray(hist)) return;
    hist.forEach(function (h) {
      // 脏历史项（null 条目 / q 缺失）跳过而不是抛错：
      // 一处 h.q 的 TypeError 会让整个统计页白屏，代价远大于少算 3 分。
      const q = Number((h || {}).q);
      if (!Number.isFinite(q)) return;
      if (q >= 5) sum += 3;
      else if (q >= 3) sum += 1;
    });
  });
  return sum;
}

/*======================== 间隔增长曲线 ========================*/

/**
 * 间隔增长曲线：对第 n 次复习，取所有经历过该次数的记录的平均间隔。
 * 返回 [{ x: 复习次数, y: 平均间隔天数 }]
 * 这条曲线是本项目"可视化的记忆科学"——上升即巩固。
 */
function intervalCurve(src) {
  const rows = [];
  eachState(src, function (id, st) {
    const s = safeState(st);
    if (!s || !Array.isArray(s.history) || s.history.length === 0) return;
    rows.push(s.history);
  });
  if (rows.length === 0) return [];

  let maxLen = 0;
  rows.forEach(function (h) { if (h.length > maxLen) maxLen = h.length; });

  const points = [];
  for (let i = 1; i <= maxLen; i++) {
    let sum = 0, n = 0;
    rows.forEach(function (h) {
      if (h.length < i) return;
      // 脏历史项缺 interval 不能直接相加：一次 undefined 让整点 y 变 NaN，
      // Canvas 上表现为曲线断裂/消失，比"少一个点"更难排查。
      const iv = Number((h[i - 1] || {}).interval);
      if (!Number.isFinite(iv)) return;
      sum += iv;
      n++;
    });
    points.push({ x: i, y: n > 0 ? Math.round((sum / n) * 10) / 10 : 0 });
  }
  return points;
}

/*======================== 三项自测指标 ========================*/

/**
 * 三项自测指标（口径见 docs/开发文档-完整版.md §4.3）
 * firstTryRate:   首次复习即 q>=3 的 ÷ 有复习记录的 ×100
 * avgEF:          全库 EF 平均（新词按初始 2.5 计入，避免"没学的拉低平均"）
 * retainedRatio:  interval>=21 天的 ÷ 有复习记录的 ×100
 * hasData:        无已复习记录时为 false —— 界面显示引导而非 0%
 *
 * ⚠️ hasData=false 时 avgEF 返回 0，那只是占位，**不是"平均熟练度是 0"**。
 *    使用前必须先判 hasData，否则会拿到 0 而不是新词默认的 2.5。
 *
 * 入参：selfCheck(list) 或 selfCheck(cards, states)
 */
function selfCheck(a, b) {
  let total = 0;
  let efSum = 0;
  let reviewed = 0;
  let firstOk = 0;
  let retained = 0;

  /**
   * 判定入参形状。
   *
   * ⚠️ 这里**不能**用 Array.isArray(a) 来区分：卡片数组和词条数组都是数组，
   *    那样会把"卡片视角"误判成"词条视角"——于是每条卡片身上找不到 .history，
   *    reviewed 恒为 0，页面永远显示"还没有复习记录"。
   *    （这正是当初的真实 bug，靠运行时测试才抓到。）
   *
   * 正确的判据是**第二参数**：卡片视角必须传状态 map，词条视角只有一个参数。
   */
  const isCardMode = b !== undefined && b !== null && typeof b === 'object';
  const states = isCardMode ? (b || {}) : null;

  const entries = [];
  if (isCardMode) {
    (a || []).forEach(function (card) {
      entries.push({ _card: card, _state: states[card.id] });
    });
  } else {
    (a || []).forEach(function (w) { entries.push(w); });
  }

  entries.forEach(function (e) {
    total++;
    const st = isCardMode ? e._state : e;
    const hist = (st && st.history) || [];

    // 缺 ef 的脏记录不能直接相加：一次 undefined 就让 avgEF 变 NaN，
    // 而页面会把它 toFixed(2) 成字符串 "NaN" 直接显示给用户。
    let ef = isCardMode ? (st ? st.ef : 2.5) : e.ef;
    ef = Number(ef);
    efSum += Number.isFinite(ef) ? ef : 2.5;

    if (!Array.isArray(hist) || hist.length === 0) return;
    reviewed++;
    // history 非空但首个条目是 null 时，直接 .q 会抛 TypeError
    const h0 = hist[0] || {};
    if (Number(h0.q) >= 3) firstOk++;
    const iv = Number(st.interval);
    if (Number.isFinite(iv) && iv >= MASTERED_INTERVAL) retained++;
  });

  if (total === 0 || reviewed === 0) {
    return { firstTryRate: 0, avgEF: 0, retainedRatio: 0, hasData: false };
  }
  return {
    firstTryRate: Math.round((firstOk / reviewed) * 100),
    avgEF: Math.round((efSum / total) * 100) / 100,
    retainedRatio: Math.round((retained / reviewed) * 100),
    hasData: true
  };
}

/*======================== 每日学习量上限 ========================*/

/**
 * 按设置里的"学习量"限制今日队列。
 *
 * ## 为什么需要这一步
 * 学生设了"每日新词 10 个"，结果首次打开看到的是「295 个待复习」——
 * 那个数字对初中生是劝退的，而且**设置项形同虚设**。
 * 学习量是产品承诺，必须真的管住队列。
 *
 * ## 为什么新词和复习分两个上限
 * 两者的认知负荷完全不同：复习是"想起来"，学新词是"建立新连接"。
 * 混用一个上限会导致「复习一堆积，新词就永远学不进去」。
 *
 * ## 排序：复习在前，新词在后
 * 到期复习有时效性（今天不复习，遗忘曲线就白算了），新词随时可学。
 * 所以先用 dailyReviewMax 装满复习，剩余额度才给新词。
 *
 * @param picked  已按优先级排好序的候选（来自 pickCards）
 * @param states  学习状态（判"是否学过"）
 * @param limits  { dailyNewWords, dailyReviewMax }
 * @returns { queue, totalNew, totalReview, hiddenNew, hiddenReview }
 *          hidden* = 被上限挡在今天的量（界面用它显示"还有 N 个明天继续"）
 */
function applyDailyLimits(picked, states, limits) {
  limits = limits || {};
  const maxNew = Number(limits.dailyNewWords);
  const maxRev = Number(limits.dailyReviewMax);
  // 没设或设成非法值时**不限制**（默认放开，而不是默认清零 —— 后者会让队列意外变空）
  const capNew = Number.isFinite(maxNew) && maxNew > 0 ? maxNew : Infinity;
  const capRev = Number.isFinite(maxRev) && maxRev > 0 ? maxRev : Infinity;

  const news = [];
  const revs = [];
  (picked || []).forEach(function (c) {
    if (states && states[c.id]) revs.push(c);
    else news.push(c);
  });

  const takeRev = revs.slice(0, capRev);
  const takeNew = news.slice(0, capNew);

  return {
    queue: takeRev.concat(takeNew),
    totalNew: news.length,
    totalReview: revs.length,
    hiddenNew: Math.max(0, news.length - takeNew.length),
    hiddenReview: Math.max(0, revs.length - takeRev.length)
  };
}

/*======================== 复习范围筛选 ========================*/

/**
 * 按条件挑出要复习的卡 —— 复习页的入口筛选。
 *
 * @param opts { subject: 'all'|学科名, scope: 'due'|'all'|'weak' }
 *   due  —— 到期（含从未学过的新卡），默认的"今日任务"
 *   all  —— 该范围内全部卡片（想整体过一遍时用）
 *   weak —— 只练答错过或标过"模糊"的卡
 * @param weakIdList 错题本的 id 列表（由 store.weakIds() 提供，避免这里依赖存储层）
 */
function pickCards(cards, states, today, opts, weakIdList) {
  opts = opts || {};
  states = states || {};
  const subject = opts.subject || 'all';
  const scope = opts.scope || 'due';

  let pool = cards || [];
  if (subject !== 'all') {
    pool = pool.filter(function (c) { return (c.subject || '未分类') === subject; });
  }

  /** 统一的"该先复习的排前面"排序 */
  const byPriority = function (a, b) {
    const sa = states[a.id], sb = states[b.id];
    if (!sa && sb) return -1;
    if (sa && !sb) return 1;
    if (!sa && !sb) return 0;
    if (sa.nextReview !== sb.nextReview) return sa.nextReview < sb.nextReview ? -1 : 1;
    return sa.interval - sb.interval;
  };

  if (scope === 'all') return pool.slice().sort(byPriority);

  if (scope === 'weak') {
    const weak = {};
    (weakIdList || []).forEach(function (id) { weak[id] = true; });
    const picked = pool.filter(function (c) { return weak[c.id]; });
    // 答错次数多的排前面（更该多练）
    return picked.sort(function (a, b) {
      const wa = ((states[a.id] && states[a.id].history) || []).filter(function (r) { return r.q <= 3; }).length;
      const wb = ((states[b.id] && states[b.id].history) || []).filter(function (r) { return r.q <= 3; }).length;
      return wb - wa;
    });
  }

  // 默认：到期（含新卡）
  return pool.filter(function (c) {
    const st = states[c.id];
    if (!st) return true;
    return st.nextReview <= today;
  }).sort(byPriority);
}

/** 列出所有学科（含卡片数），供筛选器用 */
function subjectsOf(cards) {
  const map = {};
  (cards || []).forEach(function (c) {
    const s = c.subject || '未分类';
    map[s] = (map[s] || 0) + 1;
  });
  return Object.keys(map).map(function (s) { return { subject: s, count: map[s] }; })
    .sort(function (a, b) { return b.count - a.count; });
}

module.exports = {
  MASTERED_INTERVAL,
  // 词条视角
  dueWords, nextDueDate, masteredCount, intervalCurve, pointsOf, selfCheck,
  // 卡片/状态视角
  dueCards, freshCount, progressBySubject, overallProgress, pickCards, subjectsOf,
  applyDailyLimits
};
