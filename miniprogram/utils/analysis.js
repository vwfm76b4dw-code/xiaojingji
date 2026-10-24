/**
 * 学习历史分析 —— 全部是**可解释、可复现的公式**，纯 JS 零依赖。
 *
 * ## 设计立场
 * 不做"AI 随便给个分数"。每个指标都要能**写出算式**，界面上每个数字都能回答
 * "这怎么算出来的" —— 这是本作品"记忆科学"定位的一部分，也是和"套壳聊天机器人"
 * 的区别所在。所有函数都是纯函数（输入数据、输出结果），便于单元测试与前端复算。
 *
 * ## 数据来源
 * 词条的 `history` 数组：`[{ date: 'YYYY-MM-DD', q: 5|3|1, interval: N }, ...]`
 * 按时间升序追加（见 pages/study 的 onGrade）。日期是本地串，可直接字典序比较。
 * 朗读记录 `pron_records`：`{ [wordId]: [{ date, band, score, heard, ms }] }`
 *
 * ## 与"间隔重复"这个领域的对应关系
 * 通用笔记应用分析的是"写了多少"，本应用分析的是**记忆是否真的在巩固**，
 * 所以核心指标围绕"间隔是否在增长、遗忘是否在减少、复习成本是否在下降"设计。
 */

/*=============================== 基础工具 ===============================*/

function dayStr(d) {
  // 与 utils/date.js 同口径：本地日期拼接，禁用 toISOString（UTC 偏移会错一天）
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 日期串 → 天数序号（用于算间隔）。非法串返回 null */
function dayIndex(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const parts = String(s).split('-').map(Number);
  const t = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  return Math.floor(t / 86400000);
}

/** 天数序号 → 日期串 */
function indexToDay(i) {
  const d = new Date(i * 86400000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

/** 收集所有复习事件：[{ date, q, interval, wordId }]，按日期升序 */
function events(cards, states) {
  const out = [];
  (cards || []).forEach(function (c) {
    const st = states && states[c.id];
    const hist = (st && st.history) || [];
    if (!Array.isArray(hist)) return;
    hist.forEach(function (h) {
      const d = h && h.date;
      if (!d || dayIndex(d) === null) return;
      out.push({
        date: d,
        q: Number(h.q) || 0,
        interval: Number(h.interval) || 0,
        wordId: c.id,
        word: c.prompt
      });
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

/**
 * 按日聚合复习次数，**补齐空日**。
 *
 * 为什么必须补空日：不补的话折线图会把"断更三天"画成"连续复习"，
 * 视觉上完全掩盖了习惯中断——而那恰恰是最该被看见的信息。
 */
function dailyCounts(evs, todayStr, windowDays) {
  windowDays = windowDays || 30;
  const today = dayIndex(todayStr);
  if (today === null) return [];
  const map = Object.create(null);
  evs.forEach(function (e) { map[e.date] = (map[e.date] || 0) + 1; });
  const out = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = indexToDay(today - i);
    out.push({ date: d, count: map[d] || 0 });
  }
  return out;
}

/*=============================== ① 连续性 ===============================*/

/**
 * 连续学习天数。
 *
 * 口径（三条都要明确，否则"连续 N 天"没有意义）：
 *   · current  : 从今天往前数，有记录的天数；**今天没记录但昨天有，仍算连续**
 *                （习惯判定放宽一天，避免"今天还没开始学"就把连击清零，
 *                 那会让打卡类的正反馈变得刻薄）
 *   · longest  : 历史最长连续段
 *   · alive    : 当前连击是否还活着（最后记录距今 ≤1 天）
 *   · daysSinceLast: 距最后一次记录多少天（无记录为 null）
 */
function streak(evs, todayStr) {
  const days = Array.from(new Set(evs.map(function (e) { return e.date; }))).sort();
  if (!days.length) {
    return { current: 0, longest: 0, alive: false, daysSinceLast: null, totalDays: 0 };
  }

  // 最长连续段
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = dayIndex(days[i]) - dayIndex(days[i - 1]);
    if (gap === 1) run++;
    else { if (run > longest) longest = run; run = 1; }
  }
  if (run > longest) longest = run;

  const today = dayIndex(todayStr);
  const last = dayIndex(days[days.length - 1]);
  const daysSinceLast = today - last;

  // 当前段：从最后一次记录往前数
  let current = 1;
  for (let i = days.length - 1; i > 0; i--) {
    if (dayIndex(days[i]) - dayIndex(days[i - 1]) === 1) current++;
    else break;
  }
  // 中断超过一天 → 连击已断，当前段不成立
  const alive = daysSinceLast <= 1;
  if (!alive) current = 0;

  return {
    current: current,
    longest: longest,
    alive: alive,
    daysSinceLast: daysSinceLast,
    totalDays: days.length
  };
}

/** 活跃率：窗口内有复习的天数 ÷ 窗口天数（衡量"是不是稳定在学"） */
function activeRate(evs, todayStr, windowDays) {
  windowDays = windowDays || 30;
  const today = dayIndex(todayStr);
  if (today === null) return 0;
  const from = today - windowDays + 1;
  const hit = new Set();
  evs.forEach(function (e) {
    const d = dayIndex(e.date);
    if (d !== null && d >= from && d <= today) hit.add(e.date);
  });
  return Math.round((hit.size / windowDays) * 100) / 100;
}

/*=============================== ② 间隔增长 ===============================*/

/**
 * 间隔增长曲线 + 增长率。
 *
 * 这条曲线是本应用"记忆科学"的可视化核心：
 * **间隔在变长 = 记忆在变牢**。因为 SM-2 的规则是记住才拉长间隔，
 * 所以曲线上升本身就是"确实记住了"的客观证据（不是自我感觉）。
 *
 * growth 的计算：末次平均间隔 ÷ 首次平均间隔。
 * 首次为 0 时返回 null（无法定义倍数，不是"增长 0 倍"）。
 */
function intervalGrowth(states) {
  const rows = [];
  Object.keys(states || {}).forEach(function (id) {
    const h = (states[id] && states[id].history) || [];
    if (Array.isArray(h) && h.length) rows.push(h);
  });
  if (!rows.length) return { points: [], growth: null, first: 0, last: 0, maxRound: 0 };

  let maxLen = 0;
  rows.forEach(function (h) { if (h.length > maxLen) maxLen = h.length; });

  const points = [];
  for (let i = 1; i <= maxLen; i++) {
    let sum = 0, n = 0;
    rows.forEach(function (h) {
      if (h.length < i) return;
      const iv = Number((h[i - 1] || {}).interval);
      if (!Number.isFinite(iv)) return;
      sum += iv; n++;
    });
    if (n > 0) points.push({ x: i, y: Math.round((sum / n) * 10) / 10, n: n });
  }
  if (!points.length) return { points: [], growth: null, first: 0, last: 0, maxRound: 0 };

  const first = points[0].y, last = points[points.length - 1].y;
  return {
    points: points,
    growth: first > 0 ? Math.round((last / first) * 10) / 10 : null,
    first: first,
    last: last,
    maxRound: maxLen
  };
}

/*=============================== ③ 记忆保持 ===============================*/

/**
 * 记忆保持率 —— **本应用最核心的一个数字**。
 *
 * 定义：已进入长期记忆的词占"已学过"的比例。
 *   retained = interval >= 21 天的词数（21 天是间隔重复界公认的"成熟卡"门槛）
 *   denominator = 有过复习记录的词数
 *
 * 为什么不拿"总词数"做分母：没学过的新词不该拉低保持率 ——
 * 那会把"还没开始学"误报成"记不住"。
 */
function retention(cards, states) {
  let studied = 0, mature = 0, learning = 0, fresh = 0;
  (cards || []).forEach(function (c) {
    const st = states && states[c.id];
    const h = (st && st.history) || [];
    if (!st || !Array.isArray(h) || !h.length) { fresh++; return; }
    studied++;
    const iv = Number(st.interval);
    if (Number.isFinite(iv) && iv >= 21) mature++;
    else learning++;
  });
  return {
    studied: studied,
    mature: mature,
    learning: learning,
    fresh: fresh,
    total: (cards || []).length,
    rate: studied > 0 ? Math.round((mature / studied) * 100) : 0
  };
}

/**
 * 遗忘事件统计：历史里出现过 q<3（"不认识"）的**次数与占比**。
 *
 * 口径说明：统计的是"事件"而非"词"—— 同一个词可以忘多次，
 * 这正是要观察的现象（反复忘 = 这个词需要换记忆法）。
 */
function forgetting(evs) {
  let total = 0, forgot = 0;
  const byWord = Object.create(null);
  evs.forEach(function (e) {
    total++;
    if (e.q < 3) {
      forgot++;
      byWord[e.wordId] = (byWord[e.wordId] || 0) + 1;
    }
  });
  const worst = Object.keys(byWord)
    .map(function (id) { return { wordId: id, count: byWord[id] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 10);
  return {
    total: total,
    forgot: forgot,
    rate: total > 0 ? Math.round((forgot / total) * 100) : 0,
    worst: worst
  };
}

/*=============================== ④ 复习效率 ===============================*/

/**
 * 复习效率 —— 衡量"花多少力气换一个记住的词"。
 *
 *   reviewsPerMature = 总复习次数 ÷ 已长期记住的词数
 * 数字越小越好（说明复习得准，没有反复无效重刷）。
 * 已记住为 0 时返回 null —— 不是 0，0 会被误读成"效率极高"。
 */
function efficiency(evs, retentionInfo) {
  const reviews = evs.length;
  const mature = retentionInfo ? retentionInfo.mature : 0;
  return {
    reviews: reviews,
    mature: mature,
    reviewsPerMature: mature > 0 ? Math.round((reviews / mature) * 10) / 10 : null
  };
}

/*=============================== ⑤ 时间分布 ===============================*/

/**
 * 复习时段分布（按小时）。
 *
 * 为什么值得统计：能看出"什么时候学效率最高"。
 * 结合每天的 q 值可以发现规律，比如晚上复习的遗忘率明显更高。
 *
 * ⚠️ 数据限制：history 里只存了**日期**，没有时刻，所以小时分布只能
 * 基于朗读记录（pron_records 有 ms 但没有时刻）—— 因此这里实际返回的是
 * **按"星期几"的分布**，那个能从日期算出来。这是如实告知的限制，不是遗漏。
 */
function weekdayDistribution(evs) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const count = [0, 0, 0, 0, 0, 0, 0];
  const forgot = [0, 0, 0, 0, 0, 0, 0];
  evs.forEach(function (e) {
    const d = dayIndex(e.date);
    if (d === null) return;
    const w = ((d + 4) % 7 + 7) % 7;      // 1970-01-01 是周四
    count[w]++;
    if (e.q < 3) forgot[w]++;
  });
  return names.map(function (n, i) {
    return {
      label: n,
      value: count[i],
      forgotRate: count[i] > 0 ? Math.round((forgot[i] / count[i]) * 100) : 0
    };
  });
}

/*=============================== ⑥ 综合指数 ===============================*/

/**
 * 「记忆沉淀指数」—— 把四个维度压成一个 0-100 的数，用于首页展示。
 *
 * 四项权重（和为 1）与各自的"满分参考值"：
 *   坚持 active   0.30  活跃率 ≥ 60% 计满分
 *   规模 volume   0.25  成熟词 ≥ 100 计满分
 *   深度 depth    0.25  保持率 ≥ 70% 计满分
 *   稳固 streak   0.20  连续 ≥ 7 天计满分
 *
 * 为什么这么配：**习惯（active+streak）占一半**。
 * 背单词失败的主因不是方法，是中断；所以指数必须对"坚持"最敏感。
 * 每项都先夹到 [0,1] 再加权，避免某一项爆表把总分拉满。
 *
 * 返回 breakdown，让界面能解释"这 62 分是怎么来的"。
 */
function sedimentIndex(evs, retentionInfo, streakInfo, todayStr) {
  const active = activeRate(evs, todayStr, 30);
  const mature = retentionInfo ? retentionInfo.mature : 0;
  const rate = retentionInfo ? retentionInfo.rate : 0;
  const cur = streakInfo ? streakInfo.current : 0;

  const parts = [
    { key: '坚持', weight: 0.30, raw: active, full: 0.60, note: '近 30 天活跃 ' + Math.round(active * 100) + '%' },
    { key: '规模', weight: 0.25, raw: mature, full: 100, note: '已牢记 ' + mature + ' 词' },
    { key: '深度', weight: 0.25, raw: rate / 100, full: 0.70, note: '保持率 ' + rate + '%' },
    { key: '稳固', weight: 0.20, raw: cur, full: 7, note: '连续 ' + cur + ' 天' }
  ];

  let score = 0;
  const breakdown = parts.map(function (p) {
    const ratio = p.full > 0 ? Math.min(p.raw / p.full, 1) : 0;
    const contrib = ratio * p.weight * 100;
    score += contrib;
    return {
      key: p.key,
      weight: p.weight,
      note: p.note,
      ratio: Math.round(ratio * 100),
      points: Math.round(contrib * 10) / 10
    };
  });

  return {
    score: Math.round(score),
    breakdown: breakdown,
    // 一句话解读，让分数不只是一个数字
    summary: score >= 80 ? '记忆很扎实，保持这个节奏'
      : score >= 50 ? '在稳步积累，继续保持'
      : score >= 20 ? '刚起步，先把连续天数拉起来'
      : '还没有足够记录，学几天就能看到变化'
  };
}

/*=============================== ⑦ 朗读表现 ===============================*/

/**
 * 朗读表现统计（数据来自 pronounce 页写入的 pron_records）。
 *
 * band 四档：pass / borderline / fail / unknown（不会读）
 * 只统计有记录的词；无记录返回 zero 结构而不是 null，避免页面到处判空。
 */
function pronunciation(records) {
  const zero = { words: 0, attempts: 0, pass: 0, borderline: 0, fail: 0, unknown: 0, na: 0, passRate: 0, worst: [] };
  if (!records || typeof records !== 'object') return zero;

  let attempts = 0, pass = 0, borderline = 0, fail = 0, unknown = 0, na = 0;
  const perWord = [];
  Object.keys(records).forEach(function (id) {
    const list = records[id];
    if (!Array.isArray(list) || !list.length) return;
    let p = 0, f = 0, b = 0, u = 0, n = 0;
    list.forEach(function (r) {
      const band = r && r.band;
      /**
       * `na` = 期望词缺音素数据，**根本没法评**（见 pron-judge.js 的
       * expected_no_phoneme 分支）。它不是"读错了"。
       *
       * 2026-09-30 修：原来 `na` 落进最后的 else，被当成 fail 计入 ——
       * 于是学生在统计页看到「朗读读准率 0%」、那个词还进了「最需要练的
       * 前 10」。他其实一次都没读错，那些词只是**评不了**。
       * 把"无法评判"谎报成"读错了"，比不显示更糟：
       * 它会让学生去反复练一个根本练不出结果的词，并以为自己语感有问题。
       *
       * 现在：`na` 单独计数，不进 passRate 的分母、也不算 trouble。
       * ⚠️ 分母口径变了（少算 na），但这正是"读准率"的正确含义：
       * **只在真的评过的次数里算通过率**。否则数据一多就必然被拉低。
       */
      if (band === 'na') { na++; n++; return; }   // 不计入 attempts
      attempts++;
      if (band === 'pass') { pass++; p++; }
      else if (band === 'borderline') { borderline++; b++; }
      else if (band === 'unknown') { unknown++; u++; }
      else { fail++; f++; }
    });
    perWord.push({ wordId: id, attempts: list.length, pass: p, fail: f, borderline: b, unknown: u, na: n });
  });

  // 最需要练的：读错、读不准、或"不会读"的次数多
  // （na 不算 trouble —— 评不了的词练了也白练，列进来是误导）
  const worst = perWord
    .map(function (x) {
      x.trouble = x.fail + x.borderline + x.unknown;
      return x;
    })
    .filter(function (x) { return x.trouble > 0; })
    .sort(function (a, b) { return b.trouble - a.trouble; })
    .slice(0, 10);

  return {
    words: perWord.length,
    attempts: attempts,
    pass: pass,
    borderline: borderline,
    fail: fail,
    unknown: unknown,
    na: na,
    passRate: attempts > 0 ? Math.round((pass / attempts) * 100) : 0,
    worst: worst
  };
}

/*=============================== 总入口 ===============================*/

/**
 * 一次算完全部分析 —— 页面只调这一个函数。
 *
 * 为什么合并成一个入口：页面若逐个调用，会散落 7 处 setData，
 * 且顺序错一点就可能出现"连击按旧数据算"这类不一致。
 * 集中计算保证**所有指标基于同一份快照**，彼此自洽。
 */
function analyze(cards, states, todayStr, opts) {
  opts = opts || {};
  const evs = events(cards, states);
  const retentionInfo = retention(cards, states);
  const streakInfo = streak(evs, todayStr);
  const growth = intervalGrowth(states);

  return {
    events: evs.length,
    streak: streakInfo,
    activeRate: activeRate(evs, todayStr, opts.windowDays || 30),
    daily: dailyCounts(evs, todayStr, opts.windowDays || 30),
    growth: growth,
    retention: retentionInfo,
    forgetting: forgetting(evs),
    efficiency: efficiency(evs, retentionInfo),
    weekday: weekdayDistribution(evs),
    sediment: sedimentIndex(evs, retentionInfo, streakInfo, todayStr),
    pronunciation: pronunciation(opts.pronRecords)
  };
}

/**
 * 近 N 天的每日忘记率（遗忘统计的可视化数据源）。
 * 数据来自每张卡的复习历史（history[].date/.q），q<3 记为忘记。
 * 没有复习的天 rate 记 0（图上是断点前的 0 值，比留空诚实）。
 */
function dailyForget(cards, states, today, days) {
  days = days || 14;
  const byDate = {};
  (cards || []).forEach(function (c) {
    const st = states[c.id];
    const hist = (st && st.history) || [];
    hist.forEach(function (h) {
      if (!h || !h.date) return;
      const d = byDate[h.date] || (byDate[h.date] = { reviews: 0, forgot: 0 });
      d.reviews++;
      if (h.q < 3) d.forgot++;
    });
  });

  const out = [];
  const base = parseDate(today);
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(base.getTime() - i * 86400000);
    const key = formatDate(dt);
    const d = byDate[key] || { reviews: 0, forgot: 0 };
    out.push({
      label: key.slice(5).replace('-', '/'),
      reviews: d.reviews,
      forgot: d.forgot,
      rate: d.reviews > 0 ? Math.round((d.forgot / d.reviews) * 100) : 0
    });
  }
  return out;
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
}
function formatDate(d) {
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = {
  dailyForget,
  analyze,
  // 单项（供测试与局部复用）
  events, dailyCounts, streak, activeRate, intervalGrowth,
  retention, forgetting, efficiency, weekdayDistribution,
  sedimentIndex, pronunciation,
  // 日期工具
  dayIndex, indexToDay, dayStr
};
