/**
 * 本地学习量自适应建议 —— **纯本地、纯函数、零 LLM**。
 *
 * ## 这个模块要回答什么问题
 * 学生原话：「关于每天的学习量，应该科学的制定基于本地模型进行一个小体量的分析」。
 * 翻译过来：**他不想再凭感觉拍一个 10（每日新词）+ 30（每日复习）**，
 * 而是要 app 看着他的近 7 天表现、当前词库规模、当前连胜，给出一个**有理由**的推荐值。
 *
 * ## 为什么必须本地（**完全没有 LLM**）
 * 三个理由都是硬约束，不是审美选择：
 *   ① **离线可用**：本项目承诺"随包发音、离线可用、零延迟"。一次云调用就把这条破了。
 *   ② **零成本零配置**：增长域其它功能都不要部署设置；advisor 一来就要 API Key
 *      会与整体定位打架。
 *   ③ **可解释可复现**：规则引擎的每个推荐都能给出"为什么是 8 而不是 15"
 *      （见 reason 字段）；LLM 给的数字学生只能信/不信，无法验证。
 *      没有新鲜数据（<3 天活跃）时必须落到默认值，这是规则模型最稳的地带。
 *
 * ## 输入信号（全部来自既有存储，不新增采集）
 *   · dailyActivity：最近 7 天每天的"练习条数"（复习/拼写/朗读三路合并）
 *   · activeDays7：7 天里有几天真的来学过（0~7）
 *   · forgetRate14：近 14 天忘记率（q<3 占比），用来识别"是不是贪多了"
 *   · todayPlan：今天到期应练张数（算出来的需求端）
 *   · currentStreak：当前连胜（衡量"已经在节奏里"的程度）
 *   · poolSize：词库总词数（决定"调到 15"在数字上是否可能）
 *
 * ## 输出
 *   · newWords：推荐的每日新词数（区间 [5, 15]）
 *   · reviewMax：推荐的每日复习上限（区间 [10, 50]，且 >= newWords*2 否则复习会被挤没）
 *   · reason：一句话说明白**为什么是这个数**，直接给 UI 用
 *   · inputs：上述输入信号原样回带（verify 用来断言"consistency <= same inputs same output"）
 *   · insufficientData：true 时 reason 说明"数据不够，给默认值"，UI 应该弱化呈现
 *
 * ## 调整规则（每条都对应一类真实学生）
 *   · 起点：跟随 settings 里的当前值（用户手动调的优先级最高，不喧宾夺主）
 *   · 活跃天数 ≤2：维持现状 —— 还没建立节奏，加量只会更早放弃
 *   · 活跃天数 3~5：以当前值为准小幅上调（≤1.25x）—— 已经在节奏里
 *   · 活跃天数 ≥6 且忘记率 <25%：上调新词 +30% —— 是"加点冲量"的那种学生
 *   · 活跃天数 ≥6 且忘记率 ≥40%：**下调**新词 −25% —— 量超载了，先稳住再扩
 *   · 活跃 ≥5 且今日到期 > dailyReviewMax：上调复习上限 —— 复习挤压不能拿新词抵账
 *   · poolSize < 推荐：封顶到词库实际剩余可学的量（不能"推荐 15 但只剩 8 个新词"）
 *
 * ## 为什么不要"模型/机器学习"
 * 一开始真考虑过线性回归或贝叶斯，但都放弃了：
 *   · 样本量太小：一个学生一周只有 7 个点，回归等于在噪声上拟合；
 *   · 我们的目标不是"预测他能学多少"，是"给出一个他够得着、又不劝退的目标" ——
 *     这是产品决策不是统计决策；
 *   · 规则模型把所有"为什么"都摊在明面上，正好对齐用户那句"怎么这么随机"的吐槽。
 *
 * 这是**小体量分析**（学生原话）：只用 7 天窗口 + 阈值判断，不做参数学习。
 */

const dateUtil = require('./date.js');

/*======================== 常量 ========================*/

/**
 * 推荐值的合法区间 —— 窄区间是刻意的。
 *
 * 研究表明初中生每日新词的"可承受上限"约 15（再多就会挤占复习时间）；
 * 下限 5 是"再少就形不成节奏"的心理底线。复习上限给 [10, 50]：
 * 50 是"一次打开不会被劝退"的上限（200 是设置面板的工程上限，不是学习上限）。
 * advisor 不应该把学生推出工程护栏外的极端值 —— 那会破坏设置页那张卡的契约。
 */
const LIMITS = {
  NEW_WORDS_MIN: 5,
  NEW_WORDS_MAX: 15,
  REVIEW_MIN: 10,
  REVIEW_MAX: 50
};

/** 活跃天数分档阈值（[冷启动, 建立节奏, 加点冲量]） */
const ACTIVE_TIERS = { COLD: 2, WARM: 3, HOT: 6 };

/** 忘记率阈值：低于 25% 视为"轻松"，高于 40% 视为"超载" */
const FORGET_LOW = 0.25;
const FORGET_HIGH = 0.40;

/** 上冲/下调的比例（取整时保护向默认） */
const RAMP_UP = 1.30;
const RAMP_DOWN = 0.75;
const WARM_UP = 1.10;

/*======================== 输入采集 ========================*/

/**
 * 汇总最近 N 天每天的"学习行为次数"（复习 + 拼写 + 朗读三路合并）。
 *
 * 为什么合并三路而不是只看复习：连胜打卡的口径就是"任一即可"，
 * advisor 服务的对象就是那个口径 —— 一个只朗读没复习的学生
 * **确实**来学过，不该被计成 0（否则推荐会基于"他没来"错位地减小量）。
 *
 * @param {Object} states  store.loadStates()
 * @param {Object} pron    store.loadPronRecords()
 * @param {Object} spell   store.loadSpellRecords()
 * @param {string} today   'YYYY-MM-DD'
 * @param {number} days    窗口天数（含今天）
 * @returns {Array<{date, count}>} 升序
 */
function dailyActivity(states, pron, spell, today, days) {
  const out = [];
  const set = Object.create(null);
  for (let i = days - 1; i >= 0; i--) {
    const d = dateUtil.addDays(today, -i);
    set[d] = 0;
    out.push({ date: d, count: 0 });
  }
  function bump(d) {
    if (typeof d === 'string' && Object.prototype.hasOwnProperty.call(set, d)) set[d] += 1;
  }
  if (states && typeof states === 'object') {
    Object.keys(states).forEach(function (k) {
      const hist = states[k] && states[k].history;
      if (!Array.isArray(hist)) return;
      hist.forEach(function (h) { bump(h && h.date); });
    });
  }
  [pron, spell].forEach(function (map) {
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach(function (k) {
      const list = map[k];
      if (!Array.isArray(list)) return;
      list.forEach(function (e) { bump(e && e.date); });
    });
  });
  out.forEach(function (row) { row.count = set[row.date]; });
  return out;
}

/**
 * 近 14 天忘记率（q<3 的历史条数占比）。
 * 只看复习（states.history）—— 拼写/朗读的"错"与 SM-2 的"忘记"语义不同，
 * 混在一起会把"拼错一个字母"也算成"没记住这个词"。
 *
 * @returns {number|null} null = 还没有任何复习历史（不是"忘记率 0"）
 */
function forgetRate14(states, today) {
  const from = dateUtil.addDays(today, -13);
  let forgot = 0, total = 0;
  if (states && typeof states === 'object') {
    Object.keys(states).forEach(function (k) {
      const hist = states[k] && states[k].history;
      if (!Array.isArray(hist)) return;
      hist.forEach(function (h) {
        const d = h && h.date;
        if (typeof d !== 'string' || d < from || d > today) return;
        const q = Number(h.q);
        if (!Number.isFinite(q)) return;
        total += 1;
        if (q < 3) forgot += 1;
      });
    });
  }
  if (total === 0) return null;
  return forgot / total;
}

/*======================== 推荐主函数 ========================*/

/**
 * 推荐今日学习量。
 *
 * @param {Object} input
 *   @param {Object} input.states        store.loadStates()
 *   @param {Object} input.pron          store.loadPronRecords()
 *   @param {Object} input.spell         store.loadSpellRecords()
 *   @param {Object} input.cards         cardStore.allCards()
 *   @param {string} input.today         'YYYY-MM-DD'
 *   @param {Object} input.current       当前设置 { dailyNewWords, dailyReviewMax }
 *   @param {number} input.currentStreak 当前连胜（growth.streakOf 的 current）
 *   @param {number} input.todayPlan     今日应练张数（schedule.dailyQueue().queue.length）
 * @returns {{
 *   newWords: number, reviewMax: number,
 *   reason: string,
 *   inputs: Object,
 *   insufficientData: boolean,
 *   adjusted: boolean
 * }}
 */
function recommend(input) {
  input = input || {};
  const today = (typeof input.today === 'string' && dateUtil.isValidDateStr(input.today))
    ? input.today : dateUtil.todayStr();
  const current = input.current || {};
  // 当前值必须落回默认 —— 的学生清空过设置时 advisor 不能把 undefined 一路传出去
  const curNew = Math.max(1, Number(current.dailyNewWords) || 10);
  const curRev = Math.max(1, Number(current.dailyReviewMax) || 30);

  /* 输入信号采集（全部走纯函数，下同） */
  const activity = dailyActivity(input.states, input.pron, input.spell, today, 7);
  const activeDays7 = activity.filter(function (r) { return r.count > 0; }).length;
  const totalActions7 = activity.reduce(function (s, r) { return s + r.count; }, 0);
  const forget14 = forgetRate14(input.states, today);
  const todayPlan = Math.max(0, Number(input.todayPlan) || 0);
  const currentStreak = Math.max(0, Number(input.currentStreak) || 0);
  const poolSize = (input.cards && input.cards.length) || 0;

  const inputs = {
    activeDays7: activeDays7,
    totalActions7: totalActions7,
    forget14: forget14,                 // null 或 0~1
    todayPlan: todayPlan,
    currentStreak: currentStreak,
    poolSize: poolSize,
    currentNew: curNew,
    currentReview: curRev
  };

  /*  insufficientData：连"建立节奏"的最低样本都不够。
   *  <3 天时硬规推荐会失去解释力 —
   *  我们把"还没数据"也当成一条推荐（推荐=保持默认），UI 据此弱化呈现，不伪装智能。 */
  const insufficientData = activeDays7 < ACTIVE_TIERS.WARM;
  if (insufficientData) {
    return {
      newWords: curNew,
      reviewMax: curRev,
      reason: '近 7 天只学了 ' + activeDays7 + ' 天，先按当前节奏（新词 ' + curNew
        + ' · 复习上限 ' + curRev + '）跑满 3 天再来调整。',
      inputs: inputs,
      insufficientData: true,
      adjusted: false
    };
  }

  /*  三档调整（同一学生只会命中一档 —— 每层最多改一次） */
  let newWords = curNew;
  let reviewMax = curRev;
  let reason = '';
  let adjusted = false;

  if (activeDays7 >= ACTIVE_TIERS.HOT && forget14 !== null && forget14 < FORGET_LOW) {
    /* 加点冲量：连学 ≥6 天 且 近 14 天忘记率 < 25% —— 学生在状态里、记uals 还轻松 */
    newWords = Math.min(LIMITS.NEW_WORDS_MAX, Math.ceil(curNew * RAMP_UP));
    reason = '你连学 ' + currentStreak + ' 天、近 14 天忘记率 '
      + Math.round(forget14 * 100) + '%（很低）— 加点冲量。';
    adjusted = true;
  } else if (activeDays7 >= ACTIVE_TIERS.HOT && forget14 !== null && forget14 >= FORGET_HIGH) {
    /* 超载下调：连学 ≥6 天 但 忘记率 ≥ 40% —— 不是练不够，是一次吞太多 */
    newWords = Math.max(LIMITS.NEW_WORDS_MIN, Math.floor(curNew * RAMP_DOWN));
    reason = '近 14 天忘记率 ' + Math.round(forget14 * 100) + '% —— 别贪多，先把已学的稳下来。';
    adjusted = true;
  } else if (activeDays7 >= ACTIVE_TIERS.WARM) {
    /* 建立节奏：3~5 天活跃，不动大部分，只允许小幅上浮 */
    const candidate = Math.min(LIMITS.NEW_WORDS_MAX, Math.ceil(curNew * WARM_UP));
    if (candidate > curNew) {
      newWords = candidate;
      reason = '近 7 天学了 ' + activeDays7 + ' 天，节奏渐稳 —— 新词微调到 ' + newWords + ' 个。';
      adjusted = true;
    } else {
      reason = '近 7 天学了 ' + activeDays7 + ' 天，节奏渐稳 —— 保持当前新词 ' + curNew + ' 个。';
    }
  } else {
    /* 落入这里的唯一路径是 activeDays7 === COLD（=2），严格小于 WARM ——
       但上面 insufficientData 已经拦住 <3，按理说不可达。防御性保留避免未来阈值改动漏出。 */
    reason = '先把今天这几个词练完。';
  }

  /* 复习上限：todayPlan 是需求端，rep 压不住时主动抬。
   *  为什么只在 activeDays >= WARM 时才抬：冷启动学生的 todayPlan 几乎恒为 0（新词多、复习少），
   *  一抬就顶到 REVIEW_MAX，到第二周会被反噬。 */
  if (activeDays7 >= ACTIVE_TIERS.WARM && todayPlan > reviewMax) {
    const lifted = Math.min(LIMITS.REVIEW_MAX, Math.max(reviewMax, todayPlan));
    if (lifted > reviewMax) {
      reviewMax = lifted;
      reason += (reason ? ' ' : '') + '今天待复习 ' + todayPlan + ' 张，上限同步抬到 ' + reviewMax + '。';
      adjusted = true;
    }
  }

  /* 词库规模护栏：推荐的"每日新词"不能超过剩余可学的量。
   * 例：剩 8 个新词时推荐 15 是假话。 */
  const newRemaining = countNewRemaining(input.cards, input.states);
  if (newRemaining > 0 && newWords > newRemaining) {
    newWords = Math.max(LIMITS.NEW_WORDS_MIN, newRemaining);
    reason += (reason ? ' ' : '') + '词库新词剩 ' + newRemaining + ' 个，已按此封顶。';
    adjusted = true;
  }

  /* 最终夹取：任何路径都不能越出条块区间 */
  newWords = clamp(Math.round(newWords), LIMITS.NEW_WORDS_MIN, LIMITS.NEW_WORDS_MAX);
  reviewMax = clamp(Math.round(reviewMax), LIMITS.REVIEW_MIN, LIMITS.REVIEW_MAX);

  /* 复习必须能装下新词（至少 2 倍）— 否则新词被复习挤压永远进不来 */
  const minReview = newWords * 2;
  if (reviewMax < minReview) reviewMax = clamp(minReview, LIMITS.REVIEW_MIN, LIMITS.REVIEW_MAX);

  if (!reason) {
    reason = '按当前节奏走（新词 ' + newWords + ' · 复习上限 ' + reviewMax + '）。';
  }

  return {
    newWords: newWords,
    reviewMax: reviewMax,
    reason: reason,
    inputs: inputs,
    insufficientData: false,
    adjusted: adjusted
  };
}

/**
 * 词库里还没学过的词数（新词剩余量）。
 * 注意返回 0 本身是有值的（说明已全部学过）—— 上层用它决定要不要把推荐封顶。
 */
function countNewRemaining(cards, states) {
  states = states || {};
  let n = 0;
  (cards || []).forEach(function (c) {
    if (c && !states[c.id]) n += 1;
  });
  return n;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/*======================== 面向 UI 的汇总一句话 ========================*/

/**
 * 给"学习建议"卡片用的汇总文案。
 *
 * 为什么不要 "你的表现很好/需改进" 这种价值判断：初中生的挫折感大多来自被评价；
 * 我们只摆事实（几天、几张），让学生自己得出结论 —— 与 stats 页的"句子从数据推导"
 * 同一哲学。
 */
function summarize(rec) {
  if (!rec) return '';
  if (rec.insufficientData) return rec.reason;
  const in7 = rec.inputs.activeDays7;
  const acts = rec.inputs.totalActions7;
  const f = rec.inputs.forget14;
  const fText = f === null ? '（还没有忘记率样本）' : ('忘记率 ' + Math.round(f * 100) + '%');
  return '近 7 天练了 ' + in7 + ' 天 · 共 ' + acts + ' 次动作 · ' + fText + '。';
}

module.exports = {
  LIMITS,
  ACTIVE_TIERS,
  FORGET_LOW, FORGET_HIGH,
  dailyActivity, forgetRate14, countNewRemaining,
  recommend, summarize
};
