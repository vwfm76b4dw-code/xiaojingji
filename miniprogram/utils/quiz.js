/**
 * 单元测验 —— 阶段验收。**纯函数 + 一处存储，可单独测。**
 *
 * ## 它和「检查点」是什么关系（别混）
 * 成长看板里的**检查点**是**被动的里程碑**：掌握到 25 个词、连续 7 天，
 * 系统自己算出来，用户什么都不用做。
 * **单元测验**是**主动的验收**：用户点进去答题，答够 80% 才算过。
 *
 * 两者并存、互不替代 —— 被动里程碑给"我在进步"的持续感，
 * 主动验收给"这一单元我真的拿下了"的阶段性成就感。这也是多邻国的做法
 * （日常进度 + 单元关卡测验）。
 *
 * ## 为什么按"单元"而不是按"词表"
 * 单元是**老师的教学单位**：明天要听写 Unit 2，学生想验证的就是 Unit 2。
 * 本项目词库自带 `unit` 字段（7 个单元，33~49 词），天然可做，零新增数据。
 *
 * ## 为什么题目要"挑"而不是"全出"
 * 一个单元 49 个词，全考一遍要 5 分钟以上，学生做不完就会放弃。
 * 取 10 题，并且**优先考他做错过的词**（错题本里的）——
 * 验收的价值在于查出漏洞，不在于把已知的再过一遍。
 *
 * ## 为什么通过奖励只给一次
 * 反复通过同一单元不该反复加分（否则刷分就能涨称号，称号就贬值了）。
 * 但**可以反复重考**，用来刷新最好成绩 —— 重考没有惩罚，这是刻意的。
 */

const spellingMod = require('./spelling.js');

/** 通过线（百分比）。研究建议 80%。 */
const PASS_PCT = 80;

/** 一次测验最多几题。49 词的单元全考完要 5 分钟以上，做不完就会放弃。 */
const MAX_QUESTIONS = 10;

/** 首次通过一个单元给多少积分 */
const PASS_BONUS = 50;

/** 全对额外称号（界面上的"传奇"标） */
const PERFECT_PCT = 100;

/** 题型：中译英逐字母点填 / 英译中四选一。与拼写轮交替的节奏一致。 */
const TYPE_SPELL = 'spell';
const TYPE_CHOICE = 'choice';

/** 存储键：{ [unit]: { best, passedAt, attempts } } */
const QUIZ_KEY = 'quiz_records';

/*======================== 单元状态 ========================*/

/**
 * 各单元的解锁状态。
 *
 * 解锁条件（研究建议）：**该单元所有词都至少复习过一次**。
 * 为什么是"复习过"而不是"掌握"：掌握要连续记住 21 天，等它等到天荒地老；
 * 而"都见过一遍"是学生自己就能达成的门槛，验收才有意义。
 *
 * @param {Array} cards 卡片（含 id / unit / prompt / answer）
 * @param {Object} states 学习状态
 * @returns {Array<{unit, total, learned, ready, missing}>}
 */
function unitsOf(cards, states) {
  states = states || {};
  const map = Object.create(null);
  (cards || []).forEach(function (c) {
    const u = c && c.unit ? String(c.unit) : '';
    if (!u) return;
    if (!map[u]) map[u] = { unit: u, total: 0, learned: 0 };
    map[u].total += 1;
    const st = states[c.id];
    // 判定口径与 store.studiedIds 一致：有复习历史才算学过
    if (st && Array.isArray(st.history) && st.history.length > 0) map[u].learned += 1;
  });

  // 排序**不能走纯字典序**：'…8A Module 10' < '…8A Module 2'（'1' < '2'），
  // 2012 版教材的 Module 10/11/12 会排到 Module 2 前面。schedule.js 的 unitsOf
  // 为同一个坑修过（见那里 unitRank"必须取最后一个数字"的注释），这里取同一套
  // 口径而不是第二份写法 —— 两页的单元列表排序分叉又是"多口径打架"的老问题。
  const unitRank = function (name) {
    if (/starter/i.test(name)) return -1;
    const m = String(name).match(/(\d+)(?!.*\d)/);
    return m ? Number(m[1]) : 999;
  };
  return Object.keys(map).sort(function (a, b) {
    const ra = unitRank(a), rb = unitRank(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : 1;                       // 同单元号：按全名兜底（跨册稳定分组）
  }).map(function (k) {
    const m = map[k];
    return {
      unit: m.unit,
      total: m.total,
      learned: m.learned,
      ready: m.total > 0 && m.learned >= m.total,
      missing: Math.max(0, m.total - m.learned)
    };
  });
}

/*======================== 出题 ========================*/

/**
 * 造一份测验卷。
 *
 * @param {Array} cards
 * @param {Object} states
 * @param {string} unit
 * @param {Object} [opt]
 *   @param {Function} [opt.rng] 随机源（默认 Math.random）—— 测试要确定性
 *   @param {Array<string>} [opt.weakIds] 错题本里的 id，会被优先选入
 *   @param {number} [opt.count] 题目数（默认 MAX_QUESTIONS）
 * @returns {{unit, questions, poolSize, error}}
 */
function buildQuiz(cards, states, unit, opt) {
  opt = opt || {};
  const rng = opt.rng || Math.random;
  const want = Math.max(1, Number(opt.count) || MAX_QUESTIONS);
  const weakIds = opt.weakIds || [];

  const inUnit = (cards || []).filter(function (c) {
    return c && String(c.unit || '') === String(unit) && c.prompt && c.answer;
  });
  if (!inUnit.length) return { unit: unit, questions: [], poolSize: 0, error: 'empty-unit' };

  // 先取错题本里的（更值得考），再补其余的；各自内部打乱
  const weak = shuffle(inUnit.filter(function (c) { return weakIds.indexOf(c.id) >= 0; }), rng);
  const rest = shuffle(inUnit.filter(function (c) { return weakIds.indexOf(c.id) < 0; }), rng);
  const picked = weak.concat(rest).slice(0, Math.min(want, inUnit.length));

  // 干扰项池：**全库**的释义（不只是本单元）—— 同单元的词义往往主题相近，
  // 只用本单元会造出"食物 / 食物 / 食物"这种一眼能排除的选项。
  const allAnswers = [];
  (cards || []).forEach(function (c) {
    if (c && c.answer && allAnswers.indexOf(c.answer) < 0) allAnswers.push(c.answer);
  });

  const questions = picked.map(function (card, i) {
    // 交替题型：偶数位拼写、奇数位选择 —— 与拼写轮的节奏一致
    const type = i % 2 === 0 ? TYPE_SPELL : TYPE_CHOICE;
    if (type === TYPE_CHOICE) {
      return {
        id: card.id, type: type, word: card.prompt,
        answer: card.answer,
        choices: buildChoices(card.answer, allAnswers, rng)
      };
    }
    const pool = spellingMod.buildLetterPool(card.prompt);
    return {
      id: card.id, type: type, word: card.prompt,
      answer: card.prompt,
      meaning: card.answer,
      cells: pool.cells,
      letters: pool.letters
    };
  });

  return { unit: String(unit), questions: questions, poolSize: inUnit.length, error: '' };
}

/** 4 个选项：1 个正确 + 3 个干扰，顺序打乱 */
function buildChoices(answer, allAnswers, rng) {
  const pool = allAnswers.filter(function (a) { return a !== answer; });
  const distractors = shuffle(pool, rng).slice(0, 3);
  return shuffle([answer].concat(distractors), rng);
}

function shuffle(arr, rng) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/*======================== 判分 ========================*/

/**
 * 判一份卷子。
 *
 * @param {Array} questions buildQuiz 的产物
 * @param {Object} answers { [questionId]: string } 用户的作答
 * @returns {{correct, total, pct, passed, perfect, wrongIds}}
 */
function scoreQuiz(questions, answers) {
  answers = answers || {};
  const list = questions || [];
  const wrongIds = [];
  let correct = 0;

  list.forEach(function (q) {
    const given = normAnswer(answers[q.id]);
    const want = normAnswer(q.type === TYPE_CHOICE ? q.answer : q.answer);
    if (given && given === want) correct += 1;
    else wrongIds.push(q.id);
  });

  const total = list.length;
  // 0 题的卷子不该算"通过"（否则空单元会白送 50 分）
  const pct = total > 0 ? Math.round(correct / total * 100) : 0;
  return {
    correct: correct,
    total: total,
    pct: pct,
    passed: total > 0 && pct >= PASS_PCT,
    perfect: total > 0 && pct >= PERFECT_PCT,
    wrongIds: wrongIds
  };
}

/**
 * 答案归一化。
 * 拼写题比的是**字母**（忽略大小写、连字符、空格），选择题比的是**释义原文**。
 * 统一小写去空白，避免"大小写不同就判错"这种冤案。
 */
function normAnswer(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/*======================== 记录与奖励 ========================*/

/** 读记录。坏数据一律当空，不能让一个坏键把整页打崩。 */
function recordsOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  Object.keys(raw).forEach(function (k) {
    const r = raw[k];
    if (!r || typeof r !== 'object') return;
    const best = Number(r.best);
    out[k] = {
      best: Number.isFinite(best) ? Math.max(0, Math.min(100, Math.round(best))) : 0,
      passedAt: typeof r.passedAt === 'string' ? r.passedAt : '',
      attempts: Math.max(0, Math.floor(Number(r.attempts) || 0))
    };
  });
  return out;
}

/**
 * 把一次成绩并进记录（纯函数，不写盘）。
 *
 * - best 只增不减（最好成绩是荣誉，重考砸了不该抹掉）
 * - passedAt 只在**首次通过**时写（用于"首次通过才给积分"）
 * - attempts 每次 +1
 *
 * @returns {{records, firstPass, improved}}
 */
function mergeResult(records, unit, result, today) {
  const all = recordsOf(records);
  const prev = all[unit] || { best: 0, passedAt: '', attempts: 0 };
  const pct = Math.max(0, Math.min(100, Math.round(Number(result && result.pct) || 0)));

  const firstPass = !!(result && result.passed) && !prev.passedAt;
  const improved = pct > prev.best;

  const next = Object.assign({}, all);
  next[unit] = {
    best: Math.max(prev.best, pct),
    passedAt: prev.passedAt || (result && result.passed ? today : ''),
    attempts: prev.attempts + 1
  };
  return { records: next, firstPass: firstPass, improved: improved };
}

/**
 * 测验带来的积分（**可推导**，不需要单独记账）。
 *
 * 只有**首次通过**才计入 —— 反复通过同一单元不该反复加分，
 * 否则刷分就能涨称号，称号会贬值。
 *
 * @param {Object} records
 * @returns {number}
 */
function bonusOf(records) {
  const all = recordsOf(records);
  let n = 0;
  Object.keys(all).forEach(function (k) { if (all[k].passedAt) n += 1; });
  return n * PASS_BONUS;
}

module.exports = {
  QUIZ_KEY, PASS_PCT, MAX_QUESTIONS, PASS_BONUS, PERFECT_PCT,
  TYPE_SPELL, TYPE_CHOICE,
  unitsOf, buildQuiz, buildChoices, scoreQuiz, normAnswer,
  recordsOf, mergeResult, bonusOf
};
