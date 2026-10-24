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

/**
 * 没有单元归属的词，在「按单元筛选」里归到这个名字下。
 *
 * 两种情况会落到这里：教材导入的 19 册旧版词书（源数据没有 unit 字段）、
 * 以及学生手动录入/粘贴的词（本来就没有单元概念）。
 * 与导入页 unitNameOf() 的口径保持一致 —— 学生看到的"未分组"是一个真实可选项。
 */
const UNGROUPED_UNIT = '未分组';

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
 * Fisher-Yates 洗牌（不走 sort(() => Math.random()-0.5) —— 那种写法在 V8 里
 * 有系统性偏差，且门禁无法确定性复现）。
 *
 * ## 为什么复习队列要"先排序、后洗牌"
 * SM-2 的到期排序（pickCards 的 byPriority）喂给学生的永远是"最该复习的在前"，
 * 但同一天到期的卡如果按间隔严格排（突然的"今天到期的全是 21 天间隔的词"）,
 * 学生会感到**顺序可预测**——背答案而不背词（用户原话「这个单词顺序是不是得随机打乱一下？」）。
 * 所以每日到期队列在「同到期日」这一档内要洗牌：
 *   ① 第一层按 nextReview 升序（时间优先级，错的先出）；
 *   ② 同一 nextReview 内做 Fisher-Yates（次序随机，防模式记忆）；
 *   ③ 新卡（无 state）永远排在最前 —— 新词要建立第一印象，不能被洗到中间去。
 *
 * 这与拼写轮的洗牌是两个层面：拼写轮洗的是**整轮词**的呈现顺序（_startSpellRound 的 slice().shuffled），
 * 这里洗的是**识别队列**的呈现顺序。两个都做，学生才不会觉得"怎么天天从同一批词开始"。
 *
 * @param {Array} arr 候选数组（不修改原数组）
 * @param {Function} [rng] 随机源（默认 Math.random）；测试可注入 mulberry32 确定性复现
 */
function shuffleInPlace(arr, rng) {
  const rand = rng || Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/**
 * 把同一到期日的卡洗牌（新卡除外 —— 它们永远在最前）。
 *
 * 为什么这样设计：SM-2 的到期日天然把队列切成"过期 / 今天到期 / 明天到期"几段，
 * 每段内部的相对次序对学生没有学习意义，是该被打散的；但段与段之间不能洗
 * （把明天到期的洗到今天到期的前面就是真的乱来了）。
 *
 * 实现：按 nextReview 分组，同组内 shuffle，按组拼接。新卡组（无 state）独立放在最前。
 */
function shuffleByDueDate(picked, states, rng) {
  if (!picked || picked.length <= 1) return picked;
  states = states || {};
  const fresh = [];
  const dueGroups = Object.create(null);   // nextReview -> [card]
  picked.forEach(function (c) {
    const st = states[c.id];
    if (!st) { fresh.push(c); return; }
    const d = st.nextReview || '';
    if (!Object.prototype.hasOwnProperty.call(dueGroups, d)) dueGroups[d] = [];
    dueGroups[d].push(c);
  });
  const dates = Object.keys(dueGroups).sort();           // 'YYYY-MM-DD' 字典序 = 日期序
  const out = fresh.slice();
  dates.forEach(function (d) {
    const group = dueGroups[d];
    shuffleInPlace(group, rng);
    group.forEach(function (c) { out.push(c); });
  });
  return out;
}

/**
 * 按条件挑出要复习的卡 —— 复习页的入口筛选。
 *
 * @param opts { subject: 'all'|学科名, unit: 'all'|单元名, scope: 'due'|'all'|'weak' }
 *   due  —— 到期（含从未学过的新卡），默认的"今日任务"
 *   all  —— 该范围内全部卡片（想整体过一遍时用）
 *   weak —— 只练答错过或标过"模糊"的卡
 * @param weakIdList 错题本的 id 列表（由 store.weakIds() 提供，避免这里依赖存储层）
 */
function pickCards(cards, states, today, opts, weakIdList) {
  opts = opts || {};
  states = states || {};
  const subject = opts.subject || 'all';
  const unit = opts.unit || 'all';
  const scope = opts.scope || 'due';

  let pool = cards || [];
  if (subject !== 'all') {
    pool = pool.filter(function (c) { return (c.subject || '未分类') === subject; });
  }

  /**
   * 单元筛选（2026-09-18 加）。
   *
   * 真实场景：学生明天要听写 Unit 2，想只练那一单元的 43 个词。
   * 没有这个筛选，他只能在 295 个词里碰运气。
   *
   * 没有 unit 的词（旧版 19 册教材、手动录入的词）用 UNGROUPED 归类，
   * 与 unitNameOf 在导入页的口径一致 —— 学生看到的"未分组"是一个真实可选项，
   * 而不是一个筛不出来的空洞。
   */
  if (unit !== 'all') {
    pool = pool.filter(function (c) { return (c.unit || UNGROUPED_UNIT) === unit; });
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

/**
 * 列出所有单元（含卡片数与已学数），供「按单元学习」筛选器用。
 *
 * 排序：Starter 在前，然后按单元号自然序（Unit 1 → Unit 2 → … → Unit 10），
 * **不能用字典序** —— 那会把 Unit 10 排在 Unit 2 前面（"10" < "2"）。
 * 真实课本里单元数可能到 10+，这个坑一定会踩到。
 *
 * @param cards  全部卡片
 * @param states 学习状态（用于算"这一单元学了多少"，让学生知道进度）
 */
function unitsOf(cards, states) {
  states = states || {};
  const map = {};
  (cards || []).forEach(function (c) {
    const u = c.unit || UNGROUPED_UNIT;
    if (!map[u]) map[u] = { unit: u, count: 0, learned: 0 };
    map[u].count += 1;
    if (states[c.id]) map[u].learned += 1;
  });

/**
 * 从单元名里抽出数字用于排序：Starter → -1，Unit 3 → 3，抽不出 → 999。
 *
 * ⚠️ 必须取**最后一个**数字，不能取第一个。真实单元名是 `7A Unit 3` 这种带年级前缀的，
 * `/(\d+)/` 会先命中年级里的 "7"：`7A Unit 10` 与 `7A Unit 2` 双双退化成 rank 7，
 * 平局后落到下面的 `a.unit < b.unit` 字典序兜底 —— 于是 Unit 10 又排到了 Unit 2 前面，
 * 正是本函数上方注释明令避免的那件事。（当前教材只到 Unit 6，所以一直没暴露。）
 * `/(\d+)(?!.*\d)/` 命中"后面不再有数字"的那一段，即单元号本身。
 */
const unitRank = function (name) {
  if (/starter/i.test(name)) return -1;
  const m = String(name).match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : 999;
};

  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) {
      const ra = unitRank(a.unit), rb = unitRank(b.unit);
      if (ra !== rb) return ra - rb;
      return a.unit < b.unit ? -1 : 1;
    });
}

/*======================== 今日队列（首页 / 复习页共用） ========================*/

/**
 * 「这个范围该不该过每日上限」—— **全项目唯一的判据**。
 *
 * ## 为什么必须只有一份
 * 这条规则原来在 study.js 的 buildQueue / refreshCounts / countDueInScope 三处
 * 各写了一遍，首页 deck.refresh 又写了第四遍（而且写错了，见下）。三处散写时
 * 已经出现过真实分叉：refreshCounts 的条件比 buildQueue 少一个 `!singleMode`，
 * 只因当时不可达才没暴露。判断"某处的条件是不是和别处一样"靠人眼比对是防不住的，
 * 只能靠"根本没有第二处"。
 *
 * ## 首页那一遍错在哪（2026-09-19 修）
 * deck.refresh 只按**全库**算到期数，完全不看 prefs.unit。于是学生上次选了
 * 「7A Starter」时：首页显示 38（全库+限流），点「开始」进去是 33（该单元、不限流）——
 * 数字与动作打架，正是本项目反复踩过的那一类。首页那个数字既然叫"今天要练的"，
 * 就该是**他当前范围内**今天要练多少。
 *
 * ## 三个因子各自的理由
 * · scope === 'due'：学生主动选「全部单词」是想整体过一遍，那时再卡上限会显得莫名其妙。
 *   设置项叫"每日学习量"，管的是**今天该给多少**，不是"最多能看多少"。
 * · unit === 'all'：学生说"我明天听写 Unit 2"，系统只给他 43 个里的 10 个，
 *   就是把他明确的意图打了折。单元规模本身可控（当前每单元 33~49 词）。
 * · !singleMode：单卡模式（卡详情页「练这一张」）的队列被固定成那一张，
 *   与"今天该给多少张"无关。
 *
 * @param opts { scope, unit, singleMode }
 *   ⚠️ 必须传**要判断的那个范围**，而不是"当前页面范围"。例如回答
 *   "切到 due 会给我多少张"时要传 scope:'due'，哪怕页面此刻在 'all'。
 */
function shouldApplyDailyLimits(opts) {
  opts = opts || {};
  const scope = opts.scope || 'due';
  const unit = opts.unit || 'all';
  return !opts.singleMode && scope === 'due' && unit === 'all';
}

/**
 * 今日队列 = pickCards + 上面的判据 + applyDailyLimits 的**唯一实现**。
 *
 * 存在的意义是让"首页显示的数字"与"点进去拿到的队列"走同一条计算路径，
 * 而不是靠两个页面各自记得写一样（那种"记得"必然在某次改动后分叉）。
 * 调用方：
 *   · deck.refresh()          —— 首页「今天要练的」那个数字
 *   · study.countDueInScope() —— 复习页完成页「还有 N 个词待复习」
 * 两边都只取 .queue.length，于是三个数字天然相等。
 *
 * 不过限流时返回与 applyDailyLimits **同形状**的结果（queue 原样、hidden* 为 0），
 * 调用方因此不必再写一遍 `limited ? limited.x : 0` —— 少一处能写错的地方。
 *
 * @param opts 同 pickCards / shouldApplyDailyLimits
 * @param limits { dailyNewWords, dailyReviewMax }
 * @returns { queue, hiddenNew, hiddenReview }（限流时还带 totalNew / totalReview）
 */
function dailyQueue(cards, states, today, opts, weakIdList, limits, rng) {
  const picked = pickCards(cards, states, today, opts, weakIdList);
  let out;
  if (!shouldApplyDailyLimits(opts)) {
    out = { queue: picked, hiddenNew: 0, hiddenReview: 0 };
  } else {
    out = applyDailyLimits(picked, states, limits);
  }
  /* 「今天要练的」是到期队列，到期日的同档内次序对学生没有任何学习价值，
   * 不打乱会被背模式（见 shuffleByDueDate 的注释）。
   * 洗牌放在限流之后：拿到的是学生**真的会见到的那 N 张**，洗它们才有意义。 */
  if ((opts && opts.scope || 'due') === 'due') {
    out.queue = shuffleByDueDate(out.queue, states, rng);
  }
  return out;
}

module.exports = {
  MASTERED_INTERVAL,
  UNGROUPED_UNIT,
  // 词条视角
  dueWords, nextDueDate, masteredCount, intervalCurve, pointsOf, selfCheck,
  // 卡片/状态视角
  dueCards, freshCount, progressBySubject, overallProgress, pickCards, subjectsOf,
  unitsOf,
  applyDailyLimits,
  shuffleInPlace, shuffleByDueDate,
  // 今日队列（首页 / 复习页共用，保证"显示的数字 === 点进去的队列"）
  shouldApplyDailyLimits, dailyQueue
};
