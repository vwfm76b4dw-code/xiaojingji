/**
 * 单词拼写：判分 + 错误原因分类 + 历史聚合分析。
 *
 * ## 为什么独立成模块
 * 拼写是"产出"型练习（听/看中文 → 写出英文），与复习页的"识别"型自评
 * 是两种认知任务。判分必须客观（对/错不由学生自评），错误原因要能
 * 归类（漏写/多写/写错/顺序错），所以判定逻辑不进页面 —— 页面只管呈现。
 *
 * ## 判分口径（写进 SM-2 的映射，页面负责调用）
 *   拼对 → q=3（通过，但比"认识"保守：能认出来 ≠ 能拼出来，间隔慢涨）
 *   拼错 → q=1（重学，进当日重排）
 * 理由与 new-vs-review-two-stage 的结论同源：产出比识别难，阈值要更严。
 */

/** 归一化：拼写比对忽略首尾空格与大小写（连字符/撇号保留 —— 它们是拼写的一部分） */
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/** 公共前缀长度 */
function commonPrefix(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 公共后缀长度（不含与前缀重叠的部分） */
function commonSuffix(a, b, from) {
  let i = 0;
  while (
    i < a.length - from && i < b.length - from &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) i++;
  return i;
}

/**
 * 判定 + 生成高亮节点。
 *
 * @returns {{
 *   ok: boolean,
 *   errType: string,          // 错误原因（对时为 ''）
 *   nodes: Array<{ch: string, state: 'ok'|'wrong'|'missing'}>,
 *                             // 目标词逐字符渲染节点：ok=写对 wrong=写错 missing=漏写
 *   hint: string              // 给学生的下一步提示
 * }}
 */
function judge(typedRaw, targetRaw) {
  const typed = norm(typedRaw);
  const target = norm(targetRaw);
  const chars = String(targetRaw || '').trim();

  if (!typed) {
    return { ok: false, errType: '没有输入',
      nodes: chars.split('').map(ch => ({ ch, state: 'missing' })),
      hint: '看着释义，把单词拼出来' };
  }
  if (typed === target) {
    return { ok: true, errType: '',
      nodes: chars.split('').map(ch => ({ ch, state: 'ok' })),
      hint: '拼对了' };
  }

  // 字母集合相同 → 顺序错（最常见的产出型错误之一）
  if (typed.length === target.length &&
      typed.split('').sort().join('') === target.split('').sort().join('')) {
    return { ok: false, errType: '字母顺序错了',
      nodes: alignNodes(typed, chars),
      hint: '字母都用上了，但顺序不对 —— 读一遍发音，按音节重排' };
  }

  const pre = commonPrefix(typed, target);
  const suf = commonSuffix(typed, target, pre);
  const tMid = typed.slice(pre, typed.length - suf);
  const gMid = target.slice(pre, target.length - suf);

  let errType;
  if (tMid.length === 0) errType = '漏了字母';
  else if (gMid.length === 0) errType = '多了字母';
  else errType = '写错了字母';

  return { ok: false, errType, nodes: alignNodes(typed, chars),
    hint: hintFor(errType, target) };
}

/** 目标词逐字符对齐：typed 与 target 中段逐位比，多出的目标位记 missing */
function alignNodes(typed, charsDisplay) {
  const pre = commonPrefix(typed, norm(charsDisplay));
  const suf = commonSuffix(typed, norm(charsDisplay), pre);
  const tMid = typed.slice(pre, typed.length - suf);
  const gMid = norm(charsDisplay).slice(pre, norm(charsDisplay).length - suf);

  const nodes = [];
  let i = 0;
  for (; i < pre; i++) nodes.push({ ch: charsDisplay[i], state: 'ok' });
  // 2026-09-21 修：中段的字符下标是 `pre + i`，不是 `i`。
  // 原来写 charsDisplay[i] 会把**前缀**的字符重复渲染一遍 —— 渲染出的
  // 目标词字符数正确、内容却是错的：apple→appla、beautiful→beabtiful、
  // teacher→teachtr、receive→recreve。学生照着这个「错词」订正，
  // 而 hint 文案还在说「对照标红的位置」，画面与提示互相矛盾。
  // 只在 pre > 0（错误位置不在词首）时暴露，也就是绝大多数真实拼错。
  for (i = 0; i < gMid.length; i++) {
    const ok = i < tMid.length && tMid[i] === gMid[i];
    nodes.push({ ch: charsDisplay[pre + i], state: ok ? 'ok' : (i < tMid.length ? 'wrong' : 'missing') });
  }
  for (i = 0; i < suf; i++) {
    nodes.push({ ch: charsDisplay[pre + gMid.length + i], state: 'ok' });
  }
  return nodes;
}

function hintFor(errType, target) {
  if (errType === '漏了字母') return '少写了字母 —— 数一数音节数，对照下面标红的空位补上';
  if (errType === '多了字母') return '多写了字母 —— 慢慢拼读一遍，找出多余的字母';
  if (errType === '写错了字母') return '有字母写错了 —— 发音相近的字母最容易混（如 i/e、a/ei）';
  return '对照标红的位置订正，然后抄写两遍';
}

/*------------------------- 字母卡片池（逐一点击拼词） -------------------------*/

/**
 * 形近/键位相近字母表 —— 干扰字母优先从这里取。
 *
 * 为什么不用随机字母：学生真实写错的不是「随便一个字母」，而是
 * b/d、m/n、i/e 这类形近或音近的。用形近字母做干扰，练的才是真会错的地方。
 */
const NEAR = {
  a: 'eosu', b: 'dpv', c: 'ksg', d: 'btg', e: 'aoi', f: 'vp', g: 'jch',
  h: 'nkr', i: 'eljy', j: 'gy', k: 'cgs', l: 'irj', m: 'nw', n: 'mu',
  o: 'au', p: 'bq', q: 'pg', r: 'lnh', s: 'cz', t: 'df', u: 'ovw',
  v: 'uwf', w: 'vmu', x: 'zs', y: 'iju', z: 'sx'
};

/** 英语字母频率（从高到低），形近字母不够时用它补齐 */
const FREQ = 'etaoinshrdlucmfwypvbgkjqxz';

/** 可复现伪随机（测试需要固定序列；不传 seed 时用 Math.random） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成字母卡片池。
 *
 * ## 为什么必须有干扰字母
 * 只把目标词的字母放进池里，等于把「答案由哪些字母组成、各几个」直接告诉学生 ——
 * 难度从「拼写」塌成「排序」，而排序是更弱的一种记忆任务。
 * 池的字母**多重集必须 ⊇ 目标字母的多重集**（否则可能拼不出来），
 * 多出来的部分就是干扰；干扰允许与目标字母重复（学生得自己判断用几个）。
 *
 * ## 槽位数 = 词长
 * 这确实给了长度提示，是刻意的取舍：不给槽位时学生点击后无处安放、无法回退，
 * 「一个一个点」的交互就不成立。作为补偿，干扰字母是必须的，不是可选装饰。
 *
 * @param {string} word 目标词；连字符/空格等非字母字符会作为固定槽位预填
 * @param {Object} [opt]
 *   @param {number} [opt.extraRatio=0.5] 干扰字母数 = 目标字母数 × 该比例
 *   @param {number} [opt.minExtra=2]     干扰字母数下限
 *   @param {number} [opt.maxExtra=6]     干扰字母数上限
 *   @param {number} [opt.seed]           传入则结果可复现
 * @returns {{cells, letters, answer, letterCount, extraCount}}
 *   cells   [{ch, fixed}] 槽位；fixed=true 为预填的连字符等，不可点击
 *   letters [{ch, id, used}] 字母池卡片
 *   answer  仅字母部分拼成的目标串
 */
function buildLetterPool(word, opt) {
  opt = opt || {};
  const rand = opt.seed === undefined ? Math.random : mulberry32(opt.seed);
  const extraRatio = opt.extraRatio === undefined ? 0.5 : opt.extraRatio;
  const minExtra = opt.minExtra === undefined ? 2 : opt.minExtra;
  const maxExtra = opt.maxExtra === undefined ? 6 : opt.maxExtra;

  const chars = String(word || '').trim();
  const cells = [];
  const target = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    /**
     * 括号整段（含括号本身与内部字母）一律作固定槽位。
     *
     * 2026-10-24 修（BUG：拼写答案被括注污染）：
     * 词条名里的括注有两种来源，都不是「要拼的字母」——
     *   ① 消歧用的词性注记：`race（v.）` / `race（n.）`（预置词库，
     *      见 tools/build-textbook-seed.js 关于"括注是承重的"的说明）；
     *   ② 教材原文的可替换成分：`be (am,is,are)` / `grandpa (grandfather)`。
     *
     * 旧实现只把「非字母字符」当固定槽位，括号里的字母因此进了 target：
     * `race（v.）` 的正确答案变成 `racev`，`grandpa (grandfather)` 变成
     * 18 个字母的 `grandpagrandfather` —— 学生拼对了判错，拼错了才对。
     */
    if (ch === '(' || ch === '（') {
      const close = ch === '(' ? ')' : '）';
      let j = i;
      while (j < chars.length && chars[j] !== close) j++;
      if (j >= chars.length) j = chars.length - 1;   // 未闭合：吃到末尾，不抛错
      for (let k = i; k <= j; k++) cells.push({ ch: chars[k], fixed: true, answer: chars[k] });
      i = j;
      continue;
    }

    /**
     * 斜杠及其后内容同样固定：`half past one/two`、`take care of sb/sth`。
     * 语义是「或」与「占位」，不是连续字符 —— 学生只需拼前半段的实词。
     */
    if (ch === '/') {
      for (let k = i; k < chars.length; k++) cells.push({ ch: chars[k], fixed: true, answer: chars[k] });
      break;
    }

    if (/[a-zA-Z]/.test(ch)) {
      const low = ch.toLowerCase();
      target.push(low);
      cells.push({ ch: '', fixed: false, answer: low });
    } else {
      // 连字符/空格：直接预填，不参与点击。少了它，junior-high 这类词
      // 会让学生以为漏了字符，而池里根本没有连字符可点。
      cells.push({ ch: ch, fixed: true, answer: ch });
    }
  }

  const n = target.length;
  if (n === 0) {
    return { cells: cells, letters: [], answer: '', letterCount: 0, extraCount: 0 };
  }

  const extraCount = Math.max(minExtra, Math.min(maxExtra, Math.round(n * extraRatio)));

  const pool = target.slice();
  let guard = 0;
  while (pool.length < n + extraCount && guard++ < 500) {
    const base = target[Math.floor(rand() * n)];
    const cands = NEAR[base] || '';
    let pick;
    if (cands && rand() < 0.7) {
      pick = cands[Math.floor(rand() * cands.length)];
    } else {
      pick = FREQ[Math.floor(rand() * FREQ.length)];
    }
    pool.push(pick);
  }

  // 洗牌（Fisher-Yates）
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  const letters = pool.map(function (ch, i) { return { ch: ch, id: i, used: false }; });
  return {
    cells: cells,
    letters: letters,
    answer: target.join(''),
    letterCount: n,
    extraCount: extraCount
  };
}

/*------------------------- 历史聚合（给统计页） -------------------------*/

/**
 * 从拼写记录聚合出薄弱点。
 *
 * @param records store.loadSpellRecords() 的结构：{ [wordId]: [entry] }
 * @param wordById { [wordId]: word } —— 词形回填（词条可能已删）
 * @returns { attempts, ok, rate, hasData, errTypes: [{type, count}], worst: [{wordId, word, fail, lastTyped, lastErrType}] }
 */
function analyze(records, wordById) {
  const byId = records || {};
  let attempts = 0, ok = 0;
  const errTypeCount = {};
  const perWord = [];

  Object.keys(byId).forEach(function (wordId) {
    const list = byId[wordId] || [];
    if (!list.length) return;
    let fail = 0, last = null;
    list.forEach(function (r) {
      attempts++;
      if (r.ok) ok++;
      else {
        fail++;
        const t = r.errType || '写错了字母';
        errTypeCount[t] = (errTypeCount[t] || 0) + 1;
      }
      last = r;
    });
    if (fail > 0) {
      perWord.push({
        wordId: wordId,
        word: (wordById && wordById[wordId]) || '（词条已删除）',
        fail: fail,
        attempts: list.length,
        lastTyped: (last && last.typed) || '',
        lastErrType: (last && last.errType) || ''
      });
    }
  });

  perWord.sort(function (a, b) { return b.fail - a.fail; });

  return {
    attempts: attempts,
    ok: ok,
    rate: attempts > 0 ? Math.round((ok / attempts) * 100) : 0,
    hasData: attempts > 0,
    errTypes: Object.keys(errTypeCount)
      .map(function (t) { return { type: t, count: errTypeCount[t] }; })
      .sort(function (a, b) { return b.count - a.count; }),
    worst: perWord.slice(0, 10)
  };
}

module.exports = { judge, analyze, norm, buildLetterPool };
