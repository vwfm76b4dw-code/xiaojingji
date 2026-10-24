/**
 * 增长看板的计算内核 —— 连胜 / 检查点 / 积分 / 称号。**纯函数，零依赖，可单独测。**
 *
 * ## 为什么全部靠"推导"而不是"记状态"
 * 本项目已确立的范式（见 schedule.pointsOf）：能从既有数据算出来的，就不新增存储。
 * 好处有三个，都是实打实的：
 *   ① 老用户升级后**自动获得**连胜与检查点进度，不需要迁移脚本；
 *   ② 没有"存的状态与实际行为不一致"这类静默 bug（那种 bug 一旦出现，
 *      用户看到的是"我明明天天在学，连胜却是 0"）；
 *   ③ 清空进度/换设备时不会留下孤儿状态。
 *
 * 推导的输入只有三样，都是既有数据：
 *   · 复习历史  states[id].history[].date     （study 页每次评分写入）
 *   · 朗读记录  pron_records[id][].date       （pronounce 页每次评测写入）
 *   · 拼写记录  spell_records[id][].date      （spelling 页每次判分写入）
 *
 * **唯一需要存储的是"花掉的积分"与"补签了哪几天"** —— 这两件事无法从行为推导
 * （花掉就是花掉了）。它们各自一个 storage key，见 REPAIR_KEY / SPENT_KEY。
 *
 * ## 打卡口径：三种练习都算
 * 只要当天有**任意一种**练习（复习 / 朗读 / 拼写）就算打卡。
 * 为什么放宽到三种而不是只认复习：连胜的作用是"把人拉回来"，不是"考核他有没有
 * 按我规定的方式学"。学生今天只读了三遍发音、没做复习，他确实来了 ——
 * 判他断签只会让他觉得"做了也不算"，那正是要避免的。复习仍然是积分主体（见下）。
 */

const dateUtil = require('./date.js');

/*======================== 常量 ========================*/

/** 每日目标默认值（张）。与 settings.dailyLimit 同源，调用方传进来。 */
const DEFAULT_DAILY_GOAL = 10;

/**
 * 称号阶梯（累计积分 → 身份）。
 *
 * ## 阈值是怎么定的
 * 按"一个每天练 10 个词的活跃学生"估算日均得分（见 pointsBreakdown 的分值）：
 * 复习约 +40、拼写约 +30、朗读约 +50 —— 实际日均约 80~120 分。
 * 于是把四档锚在真实时间尺度上，而不是拍一个整数：
 *   100  → 第 1 天就能拿到（**首日必得**，这是新用户留存最要紧的一步）
 *   500  → 约第 6 天（一周内，形成"我在这上面有投入"的感觉）
 *   2000 → 约第 25 天（满月，习惯成型期）
 *   8000 → 约第 100 天（一学期，真正的长期目标）
 *
 * ⚠️ 2026-09-24 重标定过：旧值 100/500/1500/4000 是在"只有复习计分"的年代定的，
 *    而那时**拼写与朗读根本不产生积分**（文案却写着 +3/+5，属于文案与实现不符）。
 *    现在三种练习都计分，日均翻了几倍，阈值必须跟着走，否则 4000 分五周就能到，
 *    "传说"会失去分量。
 */
const TITLES = [
  { at: 0,    name: '初出茅庐' },
  { at: 100,  name: '单词新秀' },
  { at: 500,  name: '单词能手' },
  { at: 2000, name: '背诵掌门' },
  { at: 8000, name: '词海传说' }
];

/**
 * 检查点（里程碑）—— 过了就发积分奖励。
 *
 * 两条线并行，覆盖"短期高频"与"长期目标"：
 *   · 掌握里程碑：按已掌握词数（interval ≥ 21 天，与 schedule.MASTERED_INTERVAL 同口径）
 *   · 连胜里程碑：按历史最长连胜天数
 *
 * 奖励**不需要存储**：如果掌握了 50 个词，必然已经过了 10 和 25 那两关，
 * 所以奖励总额是"已过各关奖励之和"这个纯函数。这也顺带保证了一件事——
 * 用户换设备/清缓存后重进，检查点进度与奖励**不会丢**（因为本来就没存）。
 */
const MILESTONES = [
  { id: 'm1',   kind: 'mastered', at: 1,   name: '复习第一个词',   reward: 20 },
  { id: 'm10',  kind: 'mastered', at: 10,  name: '掌握 10 个词',   reward: 50 },
  { id: 'm25',  kind: 'mastered', at: 25,  name: '掌握 25 个词',   reward: 100 },
  { id: 'm50',  kind: 'mastered', at: 50,  name: '掌握 50 个词',   reward: 150 },
  { id: 'm100', kind: 'mastered', at: 100, name: '掌握 100 个词',  reward: 300 },
  { id: 'm200', kind: 'mastered', at: 200, name: '掌握 200 个词',  reward: 600 },
  { id: 'm295', kind: 'mastered', at: 295, name: '掌握全册 295 词', reward: 1000 },

  { id: 's3',   kind: 'streak',   at: 3,   name: '连续 3 天',     reward: 30 },
  { id: 's7',   kind: 'streak',   at: 7,   name: '连续 7 天',     reward: 80 },
  { id: 's14',  kind: 'streak',   at: 14,  name: '连续 14 天',    reward: 150 },
  { id: 's30',  kind: 'streak',   at: 30,  name: '连续 30 天',    reward: 400 },
  { id: 's60',  kind: 'streak',   at: 60,  name: '连续 60 天',    reward: 800 },
  { id: 's100', kind: 'streak',   at: 100, name: '连续 100 天',   reward: 1500 }
];

/**
 * 护身符（= 多邻国的 streak freeze）。
 *
 * ## 为什么是"护身符"而不是"补签"
 * 断签最大的风险不是"少练一天"，而是**断签即放弃** —— 用户看到连胜归零，
 * 最理性的选择就是"反正断了，不练了"。所以兜底必须是**自动的**：
 * 断签当天由系统默默消耗一张，用户回来时看到的是"连胜还在"，
 * 而不是"请手动补签"（一个已经灰心的人不会去点那个按钮）。
 *
 * ## 上限为什么必须是 2
 * 无限囤积会让"连胜"这个数字失去真实性。Duolingo 会员可囤 5 张，
 * 这正是它被用户诟病"连胜不真实"的原因。2 张够接住"周末回老家没网"这种
 * 真实情况，又不足以让连胜变成可以长期不练的摆设。
 */
const MAX_CHARMS = 2;

/** 每连续多少天送 1 张护身符 */
const CHARM_STREAK_STEP = 7;

/** 用积分买一张护身符的价格 */
const CHARM_PRICE = 200;

/** 兑换一次「再练一组」的价格（当日目标达成后再加一批） */
const EXTRA_BATCH_PRICE = 100;

/** 「再练一组」一次给多少张 */
const EXTRA_BATCH_SIZE = 10;

/**
 * 积分用途表 —— 界面的"积分能干什么"直接读这张表，避免文案与实现两处维护。
 *
 * ## 选这三样的理由
 * 排序原则是**工具性 > 装饰性**（研究结论）：积分要换成"能继续学下去的东西"，
 * 而不是换成贴纸。所以：
 *   ① 护身符 —— 保住连胜，最刚需
 *   ② 再练一组 —— 当日目标达成后还想练的人可以继续（把"限流"从阻碍变成可解锁）
 *   ③ 称号 —— 自动解锁，纯荣誉，不需要花积分
 *
 * ## 明确不做的
 * · 不能买"跳过复习"或"买复习次数"—— 那会直接破坏 SM-2 的学习效果，本末倒置；
 * · 不做付费/广告相关的一切；
 * · 不做"花积分提升每日上限"这类会让免费用户被惩罚的设计。
 */
const SPENDS = [
  { id: 'charm',      name: '护身符',      price: CHARM_PRICE,
    desc: '断签时自动用掉一张，连胜不断。最多同时持有 ' + MAX_CHARMS + ' 张' },
  { id: 'extraBatch', name: '再练一组',    price: EXTRA_BATCH_PRICE,
    desc: '今天的目标完成后，再解锁 ' + EXTRA_BATCH_SIZE + ' 张（限当天）' },
  { id: 'title',      name: '称号',        price: 0,
    desc: '累计积分自动解锁，不用花 —— 它是荣誉，不是商品' }
];

/** 存储键 */
const REPAIR_KEY = 'growth_repairs';   // string[]：被护身符/补签覆盖掉的日期
const BOUGHT_KEY = 'growth_charms_bought';  // number：用积分买过的护身符张数
const SPENT_KEY = 'growth_spent';      // number：已花掉的积分
const EXTRA_KEY = 'growth_extra_day';  // string：今天是否已买过「再练一组」（存日期，隔天自动失效）

/*======================== 打卡日期 ========================*/

/**
 * 汇总所有"有学习行为"的日期。
 *
 * @param {Object} states  store.loadStates()
 * @param {Object} pron    store.loadPronRecords()
 * @param {Object} spell   store.loadSpellRecords()
 * @returns {string[]} 升序去重的 'YYYY-MM-DD'
 */
function activeDates(states, pron, spell) {
  const set = Object.create(null);

  function take(map) {
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach(function (k) {
      const list = map[k];
      if (!Array.isArray(list)) return;
      list.forEach(function (e) {
        const d = e && e.date;
        // 脏日期直接丢：一个非法串会让排序结果错位、进而把连胜算错，
        // 而"连胜算错"用户是会立刻发现并失去信任的。
        if (typeof d === 'string' && dateUtil.isValidDateStr(d)) set[d] = true;
      });
    });
  }

  // states 的 history 在词条对象里
  if (states && typeof states === 'object') {
    Object.keys(states).forEach(function (k) {
      const st = states[k];
      const hist = st && st.history;
      if (!Array.isArray(hist)) return;
      hist.forEach(function (h) {
        const d = h && h.date;
        if (typeof d === 'string' && dateUtil.isValidDateStr(d)) set[d] = true;
      });
    });
  }
  take(pron);
  take(spell);

  return Object.keys(set).sort();
}

/*======================== 连胜 ========================*/

/**
 * 连胜。
 *
 * @param {string[]} dates  activeDates() 的结果
 * @param {string} today    'YYYY-MM-DD'
 * @param {Object} [opt]
 *   @param {string[]} [opt.repairs] 已补签的日期（算作打卡）
 * @returns {{current, best, todayDone, atRisk, activeDays, lastActive, daysToNext}}
 */
function streakOf(dates, today, opt) {
  opt = opt || {};
  const set = Object.create(null);
  (dates || []).forEach(function (d) { if (d) set[d] = true; });
  (opt.repairs || []).forEach(function (d) { if (d) set[d] = true; });

  const all = Object.keys(set).sort();
  if (!all.length) {
    return { current: 0, best: 0, todayDone: false, atRisk: false,
             activeDays: 0, lastActive: '', daysToNext: 0 };
  }

  // 历史最长连胜：扫一遍所有日期，连续的段取最长
  let best = 0, run = 0, prev = '';
  all.forEach(function (d) {
    run = (prev && dateUtil.addDays(prev, 1) === d) ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  });

  /**
   * 当前连胜：从「今天」或「昨天」往回数。
   *
   * 为什么要允许从昨天起算：连胜应当是"到今晚 24 点才断"，而不是"过 0 点就断"。
   * 学生早上起来打开 app，看到连胜还在（标着"今天还没练"）才会去练；
   * 如果 0 点一过就归零，他看到的是"已经断了"，那就干脆不练了 —— 正好反了。
   */
  const todayDone = !!set[today];
  let current = 0;
  const anchor = todayDone ? today : dateUtil.addDays(today, -1);
  if (set[anchor]) {
    let cur = anchor;
    while (set[cur]) { current += 1; cur = dateUtil.addDays(cur, -1); }
  }

  const atRisk = !todayDone && current > 0;
  const lastActive = all[all.length - 1];

  // 距下一个连胜里程碑还差几天（已到顶则 0）
  const nextMs = MILESTONES.filter(function (m) { return m.kind === 'streak' && m.at > best; })[0];
  const daysToNext = nextMs ? (nextMs.at - best) : 0;

  return {
    current: current,
    best: best,
    todayDone: todayDone,
    atRisk: atRisk,
    activeDays: all.length,
    lastActive: lastActive,
    daysToNext: daysToNext
  };
}

/*======================== 每日目标 ========================*/

/**
 * 今日目标完成度。
 *
 * @param {Object} states
 * @param {string} today
 * @param {number} [goal] 每日目标张数
 * @returns {{done, goal, met, percent, remain}}
 */
function dailyGoalOf(states, today, goal) {
  /**
   * 目标值必须**回落**而不是钳到 1。
   * 写成 `Math.max(1, Number(goal) || DEFAULT)` 会有一个安静的坑：
   * 负数走的是 `||` 的另一条分支（-5 是真值，不会被替换），于是 Math.max 把它抬成 1 ——
   * 目标变成"今天做 1 张"，进度条一进去就满，学生会以为今天已经练完了。
   * 所以非法/非正数一律回到默认值。
   */
  const n = Number(goal);
  const g = (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULT_DAILY_GOAL;
  let done = 0;
  if (states && typeof states === 'object') {
    Object.keys(states).forEach(function (k) {
      const hist = states[k] && states[k].history;
      if (!Array.isArray(hist)) return;
      hist.forEach(function (h) { if (h && h.date === today) done += 1; });
    });
  }
  return {
    done: done,
    goal: g,
    met: done >= g,
    percent: Math.min(100, Math.round(done / g * 100)),
    remain: Math.max(0, g - done)
  };
}

/*======================== 检查点 ========================*/

/**
 * 检查点列表：已过的、下一个、以及奖励总额。
 *
 * @param {number} mastered 已掌握词数（schedule.masteredCount 的结果）
 * @param {number} bestStreak 历史最长连胜
 * @returns {{list, passedCount, total, bonus, next, justReached}}
 */
function checkpointsOf(mastered, bestStreak) {
  const m = Math.max(0, Number(mastered) || 0);
  const s = Math.max(0, Number(bestStreak) || 0);

  let bonus = 0;
  let passedCount = 0;
  const list = MILESTONES.map(function (ms) {
    const value = ms.kind === 'mastered' ? m : s;
    const passed = value >= ms.at;
    if (passed) { bonus += ms.reward; passedCount += 1; }
    return {
      id: ms.id,
      kind: ms.kind,
      at: ms.at,
      name: ms.name,
      reward: ms.reward,
      passed: passed,
      // 进度（0~1）—— 让"下一个还差多少"可以被画成进度条
      progress: Math.min(1, ms.at > 0 ? value / ms.at : 0)
    };
  });

  const next = list.filter(function (x) { return !x.passed; })[0] || null;
  return { list: list, passedCount: passedCount, total: MILESTONES.length,
           bonus: bonus, next: next };
}

/*======================== 积分 ========================*/

/**
 * 积分构成（三种练习各自的分 + 检查点奖励 + 单元测验奖励）。
 *
 * ## 为什么单独一层，而不是改 schedule.pointsOf
 * `pointsOf` 只算复习分，且它的口径被三道门禁钉住了（verify-edge / verify-integration /
 * verify-devtools 都断言"认识 = 3 分"）。改它等于同时改三处已验证的契约，
 * 而收益只是省一层函数 —— 不划算。
 * 更重要的是：**分层之后，"复习分"这个口径仍然可以被单独验证**，
 * 而这里只负责把几路加起来。职责清楚，改动面小。
 *
 * ## 分值（2026-09-24 与文案对齐）
 * 旧文案写着"认识 +4 · 模糊 +2 · 拼对 +3 · 朗读读准 +5"，但实现里
 * **拼写与朗读一分都不给**，认识/模糊实际是 +3/+1 —— 文案与实现不符。
 * 现在按文案实现，并把分值定成：
 *   复习：认识 +4 / 模糊 +2 / 不认识 +0（不惩罚，别让人因为怕扣分而不敢点"不认识"）
 *   拼写：拼对 +3 / 拼错 +0
 *   朗读：读准 +5 / 接近 +2 / 读错 +0
 * 朗读给得最高，因为它是**最费力**的动作（要真的开口），也是最容易被跳过的。
 * 单元测验的奖励由调用方算好传进来（见下）。
 *
 * ## 为什么测验奖励是"传进来"而不是自己去读
 * 让 growth.js 去 require quiz.js 会顺带把 spelling.js 也拖进来 ——
 * 而这个模块的价值之一就是**零依赖、可以被单独验证**。
 * 所以测验奖励以数值传入，调用方（页面）负责算。
 *
 * @param {Object} input {states, pron, spell, mastered, bestStreak, quizBonus}
 * @returns {{review, spell, pron, checkpoint, quiz, total}}
 */
function pointsBreakdown(input) {
  input = input || {};
  const states = input.states || {};
  const pron = input.pron || {};
  const spell = input.spell || {};

  /* 复习分：与 schedule.pointsOf 同口径（认识 +4 / 模糊 +2） */
  let review = 0;
  Object.keys(states).forEach(function (k) {
    const hist = states[k] && states[k].history;
    if (!Array.isArray(hist)) return;
    hist.forEach(function (h) {
      const q = Number((h || {}).q);
      if (!Number.isFinite(q)) return;
      if (q >= 5) review += 4;
      else if (q >= 3) review += 2;
    });
  });

  /* 拼写分 */
  let spellPts = 0;
  Object.keys(spell).forEach(function (k) {
    const list = spell[k];
    if (!Array.isArray(list)) return;
    list.forEach(function (e) { if (e && e.ok === true) spellPts += 3; });
  });

  /* 朗读分 */
  let pronPts = 0;
  Object.keys(pron).forEach(function (k) {
    const list = pron[k];
    if (!Array.isArray(list)) return;
    list.forEach(function (e) {
      if (!e) return;
      if (e.band === 'pass') pronPts += 5;
      else if (e.band === 'borderline') pronPts += 2;
    });
  });

  const cp = checkpointsOf(input.mastered, input.bestStreak);
  const quiz = Math.max(0, Math.floor(Number(input.quizBonus) || 0));

  return {
    review: review,
    spell: spellPts,
    pron: pronPts,
    checkpoint: cp.bonus,
    quiz: quiz,
    total: review + spellPts + pronPts + cp.bonus + quiz
  };
}

/**
 * 称号（按**累计**积分，只增不减）。
 *
 * ⚠️ 注意：花掉的积分（补签）**不影响称号**。称号是"你练了多少"的荣誉，
 * 兑换是"你拿它换东西"，两件事分开算才不会出现"兑换一次掉一级"的荒唐结果。
 *
 * @param {number} total 累计积分
 * @returns {{name, at, next, nextName, toNext, percent, level}}
 */
function titleOf(total) {
  const p = Math.max(0, Number(total) || 0);
  let level = 0;
  for (let i = 0; i < TITLES.length; i++) if (p >= TITLES[i].at) level = i;
  const cur = TITLES[level];
  const next = TITLES[level + 1] || null;
  const span = next ? (next.at - cur.at) : 0;
  return {
    name: cur.name,
    at: cur.at,
    level: level,
    next: next ? next.at : 0,
    nextName: next ? next.name : '',
    toNext: next ? (next.at - p) : 0,
    percent: next ? Math.min(100, Math.round((p - cur.at) / span * 100)) : 100
  };
}

/** 可用余额 = 累计 − 已花 */
function balanceOf(total, spent) {
  return Math.max(0, (Number(total) || 0) - (Number(spent) || 0));
}

/*======================== 护身符 ========================*/

/**
 * 护身符账本。
 *
 * 获得 = min(上限, ⌊最长连胜 / 7⌋) + 买过的张数
 * 已用 = 被覆盖的日期数
 * 可用 = 获得 − 已用
 *
 * 为什么"获得"能推导：连续 7 天是既成事实，不需要记录"发过几张"。
 * 唯一要存的是**买过几张**与**覆盖了哪几天** —— 这两件事无法从行为反推。
 *
 * @returns {{earnedFree, bought, earned, used, available, max, nextFreeAt}}
 */
function charmsOf(bestStreak, bought, used) {
  const s = Math.max(0, Number(bestStreak) || 0);
  const b = Math.max(0, Math.floor(Number(bought) || 0));
  const u = Math.max(0, Math.floor(Number(used) || 0));

  const earnedFree = Math.min(MAX_CHARMS, Math.floor(s / CHARM_STREAK_STEP));
  const earned = Math.min(MAX_CHARMS, earnedFree + b);

  // 距下一张免费护身符还差几天连胜（已达上限则为 0）
  const nextFreeAt = earnedFree >= MAX_CHARMS
    ? 0
    : (earnedFree + 1) * CHARM_STREAK_STEP - s;

  return {
    earnedFree: earnedFree,
    bought: b,
    earned: earned,
    used: u,
    available: Math.max(0, earned - u),
    max: MAX_CHARMS,
    nextFreeAt: nextFreeAt
  };
}

/**
 * 断签缺口。只看"昨天往前连续没学的天数"。
 *
 * @param {string[]} dates activeDates()
 * @param {string} today
 * @param {string[]} covered 已被护身符覆盖的日期
 * @returns {{gapDays, missedDates, hasHistory, todayDone}}
 */
function gapInfo(dates, today, covered) {
  const set = Object.create(null);
  (dates || []).forEach(function (d) { if (d) set[d] = true; });
  (covered || []).forEach(function (d) { if (d) set[d] = true; });

  if (set[today]) {
    return { gapDays: 0, missedDates: [], hasHistory: true, todayDone: true };
  }

  const missed = [];
  let cur = dateUtil.addDays(today, -1);
  for (let i = 0; i < 60 && !set[cur]; i++) {
    missed.push(cur);
    cur = dateUtil.addDays(cur, -1);
  }
  return {
    gapDays: missed.length,
    missedDates: missed,
    hasHistory: !!set[cur],      // 再往前有没有学习记录（没有 = 新用户，谈不上"断签"）
    todayDone: false
  };
}

/**
 * 补断方案：先看护身符能不能自动盖住，盖不住的才要手动补（花积分）。
 *
 * @param {number} gapDays        断掉的天数
 * @param {number} charmAvailable 可用护身符张数
 * @param {number} balance        可用积分
 * @returns {{autoUse, autoCovered, needManual, manualCost, canAfford, ok, reason}}
 */
function bridgePlan(gapDays, charmAvailable, balance) {
  const gap = Math.max(0, Math.floor(Number(gapDays) || 0));
  const charms = Math.max(0, Math.floor(Number(charmAvailable) || 0));

  if (gap === 0) {
    return { autoUse: 0, autoCovered: true, needManual: 0, manualCost: 0,
             canAfford: true, ok: true, reason: 'not-broken' };
  }

  const autoUse = Math.min(gap, charms);
  const needManual = gap - autoUse;
  const manualCost = needManual * CHARM_PRICE;

  return {
    autoUse: autoUse,
    autoCovered: needManual === 0,
    needManual: needManual,
    manualCost: manualCost,
    canAfford: balanceOf(balance, 0) >= manualCost,
    ok: needManual === 0 || balanceOf(balance, 0) >= manualCost,
    reason: needManual === 0 ? '' : (balanceOf(balance, 0) >= manualCost ? 'paid' : 'poor')
  };
}

/*======================== 排行榜：进步榜口径 ========================*/

/**
 * 本周与上周的学习量，以及"进步幅度"。
 *
 * ## 为什么榜按"进步"而不是"总积分"排
 * 几十人规模下，按绝对积分排名是**负向机制**：头部和底部的差距是 5~10 倍且基本固定，
 * 后进者从第一天就知道追不上，榜只会强化"我不行"。而按"比上周多练了多少"排，
 * **后进者的提升空间最大、最容易第一** —— 比的是努力，不是天赋。
 *
 * 新用户的 lastWeek 自然是 0，所以任何学习都是正进步 —— 这正是想要的：
 * 让刚来的人也有机会站到前面。
 *
 * 口径取"复习张数"（history 条数），与每日目标同源，用户看得懂、也不会被
 * 朗读/拼写的高频动作刷分。
 *
 * @param {Object} states
 * @param {string} today
 * @returns {{thisWeek, lastWeek, progress, weekStart}}
 */
function weeklyProgressOf(states, today) {
  const weekStart = mondayOf(today);
  const lastStart = dateUtil.addDays(weekStart, -7);
  const lastEnd = dateUtil.addDays(weekStart, -1);

  let thisWeek = 0, lastWeek = 0;
  if (states && typeof states === 'object') {
    Object.keys(states).forEach(function (k) {
      const hist = states[k] && states[k].history;
      if (!Array.isArray(hist)) return;
      hist.forEach(function (h) {
        const d = h && h.date;
        if (typeof d !== 'string' || !dateUtil.isValidDateStr(d)) return;
        if (d >= weekStart && d <= today) thisWeek += 1;
        else if (d >= lastStart && d <= lastEnd) lastWeek += 1;
      });
    });
  }
  return { thisWeek: thisWeek, lastWeek: lastWeek,
           progress: thisWeek - lastWeek, weekStart: weekStart };
}

/** 取某天所在周的周一（周一为一周之始，符合国内学校习惯） */
function mondayOf(dateStr) {
  const parts = String(dateStr).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  // getDay(): 0=周日 … 6=周六。周一为 0 偏移 → 周日要回退 6 天
  const dow = d.getDay();
  const back = (dow === 0 ? 6 : dow - 1);
  return dateUtil.addDays(dateStr, -back);
}

/*======================== 导出 ========================*/

module.exports = {
  // 常量（界面文案直接读，避免两处维护）
  DEFAULT_DAILY_GOAL, TITLES, MILESTONES, SPENDS,
  MAX_CHARMS, CHARM_STREAK_STEP, CHARM_PRICE, EXTRA_BATCH_PRICE, EXTRA_BATCH_SIZE,
  REPAIR_KEY, BOUGHT_KEY, SPENT_KEY, EXTRA_KEY,
  // 计算
  activeDates, streakOf, dailyGoalOf, checkpointsOf,
  pointsBreakdown, titleOf, balanceOf,
  charmsOf, gapInfo, bridgePlan, weeklyProgressOf, mondayOf
};
