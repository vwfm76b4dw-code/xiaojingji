/**
 * 音节划分 —— 把单词切成音节，供背诵时**分色展示**。
 *
 * ## 为什么值得做（这是"背单词枯燥"的一个具体解法）
 * 初中生背长词最常卡在"读不出、记不住节奏"。而英语拼写与读音的对应关系里，
 * **音节是最有规律的一层**：会切音节的人能自己读出没学过的词（如 `con-gra-tu-la-tions`），
 * 不会切的人只能一个字母一个字母硬背。分色展示等于把这条规律**直接画在词上**。
 *
 * ## 为什么用规则而不是查表
 * 查表需要为每个词准备音节数据（295 个预置词还好，但用户自录入的词、教材导入的 5000+ 词
 * 都没有）。规则法**任何词都能切**，且零数据、零体积 —— 对主包只剩 77 KB 的现状是唯一可行解。
 *
 * ## 算法（正交切分 + 最大音节首原则）
 *   ① 把词拆成"辅音簇 + 元音核"的序列（元音核含 ea/ee/oo/ai… 这类双元音字母组合）
 *   ② 相邻两个元音核之间的辅音簇 C：
 *      · |C| ≤ 1 → C 整体归后一个音节（元音后单个辅音通常后移：o-pen）
 *      · |C| ≥ 2 → 把 C 的**最长合法后缀**（合法的音节首）留给后一个音节
 *        例：`monster` → n|st 中 "st" 是合法音节首 → mon-ster
 *            `picture` → c|t 中 "t" 是合法音节首，但 "ct" 不是 → pic-ture
 *   ③ 特例：`-le` 结尾（ta-ble）、词尾不发音 e（make 只算 1 个音节）、
 *      `-ed` 结尾（除非前面是 t/d 才算独立音节）
 *
 * ## 这个实现的诚实边界（别指望它是词典级）
 * 英语音节划分**本质是音系的、不是拼写的**，纯拼写规则必然有错例
 * （最典型：`family` 应为 fam-i-ly 但规则会切出 fam-i-ly 之外的形态；
 *  `chocolate` 口语常读 2 音节而拼写是 3）。所以：
 *   · 本模块**保证**：所有音节拼起来**逐字符等于原词**（见 gate 断言）
 *   · 本模块**不保证**：每一处切分都符合某本词典
 *   对"帮助学生看出节奏"这个用途，前者是底线，后者可以容忍少量偏差。
 */

/** 元音字母。y 单独处理（词首是辅音、词中/词尾常作元音） */
const VOWELS = 'aeiou';

/**
 * 元音字母组合 —— 视为**一个**元音核（不切开）。
 * 按长度降序匹配，否则 "ea" 会被 "e" 抢先匹配。
 */
const VOWEL_TEAMS = [
  'eau', 'iew', 'eou',
  'ai', 'ay', 'ea', 'ee', 'ei', 'eu', 'ey', 'ie', 'oa', 'oe', 'oi', 'oo',
  'ou', 'ow', 'oy', 'ue', 'ui', 'au', 'aw'
].sort(function (a, b) { return b.length - a.length; });

/**
 * 合法音节首（onset）—— 最大音节首原则要查这张表。
 * 只收录**常见**组合；不在表里的一律保守处理（辅音留在前一个音节），
 * 这样切出来更接近"看得懂"而不是"语言学正确"。
 */
const VALID_ONSETS = [
  // 单辅音（全部合法）
  'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z',
  // 二合辅音（digraph，不可拆）
  'ch', 'sh', 'th', 'ph', 'wh', 'ck', 'gh', 'ng', 'qu', 'wr', 'kn', 'gn', 'ps', 'pn', 'rh',
  // 常见辅音连缀
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm',
  'sn', 'sp', 'st', 'sw', 'tr', 'tw', 'dw', 'squ', 'spl', 'spr', 'str', 'scr', 'shr', 'thr',
  // 后接 y/u 的常见组合（如 "cu-ri-ous" 里的 "r"）
  'cy', 'dy', 'fy', 'gy', 'ky', 'ly', 'my', 'ny', 'py', 'ry', 'sy', 'ty', 'vy', 'zy'
];

const ONSET_SET = (function () {
  const s = Object.create(null);
  VALID_ONSETS.forEach(function (o) { s[o] = true; });
  return s;
})();

function isVowelChar(ch) {
  return VOWELS.indexOf(ch) >= 0;
}

/** 判断某个位置（从 start 起）是否匹配一个元音组合；返回匹配长度（0 表示没有） */
function matchVowelTeam(word, start) {
  for (let i = 0; i < VOWEL_TEAMS.length; i++) {
    const t = VOWEL_TEAMS[i];
    if (word.substr(start, t.length) === t) return t.length;
  }
  return 0;
}

/**
 * 把词切成 token 序列：{ type: 'c'|'v', text }
 * y 的判定：词首 → 辅音；其它位置 → 元音（city / happy / my）
 */
function tokenize(word) {
  const tokens = [];
  let i = 0;
  while (i < word.length) {
    const ch = word[i];

    // 元音组合优先（仅当起始字符是元音）
    if (isVowelChar(ch)) {
      const n = matchVowelTeam(word, i);
      if (n > 0) {
        tokens.push({ type: 'v', text: word.substr(i, n) });
        i += n;
        continue;
      }
      tokens.push({ type: 'v', text: ch });
      i += 1;
      continue;
    }

    // y：词首为辅音，其余为元音
    if (ch === 'y') {
      if (i === 0) tokens.push({ type: 'c', text: 'y' });
      else tokens.push({ type: 'v', text: 'y' });
      i += 1;
      continue;
    }

    // 辅音：把连续辅音攒成一个簇（后面再决定怎么切）
    let j = i;
    while (j < word.length) {
      const c = word[j];
      if (isVowelChar(c)) break;
      if (c === 'y' && j !== 0) break;      // y 作元音时结束辅音簇
      if (!/[a-z']/.test(c)) break;          // 撇号、连字符等非字母：停
      j += 1;
    }
    if (j === i) { tokens.push({ type: 'c', text: ch }); i += 1; }
    else { tokens.push({ type: 'c', text: word.slice(i, j) }); i = j; }
  }
  return tokens;
}

/**
 * 切一个辅音簇：返回 [留给前一个音节的尾部, 留给后一个音节的首部]
 * 规则：把**最长的合法后缀**当作后一个音节的 onset。
 */
function splitCluster(cluster) {
  if (cluster.length <= 1) {
    // 单个辅音 → 整体后移（o-pen）。这是英语的普遍倾向。
    return ['', cluster];
  }
  // 从最长到最短试后缀
  for (let len = Math.min(cluster.length, 3); len >= 1; len--) {
    const suffix = cluster.slice(cluster.length - len);
    if (ONSET_SET[suffix]) {
      return [cluster.slice(0, cluster.length - len), suffix];
    }
  }
  // 没有合法后缀（极少）→ 只把最后一个字母后移，保证不丢字符
  return [cluster.slice(0, -1), cluster.slice(-1)];
}

/**
 * 划分音节。
 *
 * @param {string} raw 单词（可含空格、连字符、撇号、大小写）
 * @returns {string[]} 音节数组。**保证 join('') 逐字符等于原词。**
 *   无法切分时返回 `[raw]`（一个音节），绝不返回空数组 —— 调用方据此直接渲染原词。
 */
function split(raw) {
  const word = String(raw == null ? '' : raw);
  if (!word) return [];

  /**
   * 含分隔符的条目要**按段处理**：教材词表里有 "information technology"、
   * "junior high"、"well-known" 这类多词条目。
   *
   * 第一版没处理，把整条当一个词切 —— "information technology" 切出 7 段，
   * 而且空格被当成辅音簇参与切分（`splitCluster(' ')` 会吐出一个纯空格音节）。
   * 正确做法：逐段切分，**分隔符并入前一段**（不留孤立的分隔音节），
   * 这样拼回去仍然逐字符等于原词，颜色也自然衔接。
   */
  if (/[^A-Za-z']/.test(word)) {
    /**
     * ⚠️ 含**非拉丁字符**的条目直接不切。
     *
     * 起因：预置词表里有 `race（v.）` / `race（n.）` 这种脏数据 ——
     * 词性括注被写进了 word 字段（中文全角括号）。
     * 对它做音节划分会切出 `v.）` 这种没有元音的碎片，既难看又无意义。
     * 音节划分只对真正的英文词有意义，遇到混入其它字符的条目就原样返回。
     *
     * 注意：这一条只拦"非 ASCII"，**不拦空格与连字符** ——
     * "junior high" / "well-known" 是正常的多词条目，要继续切（见下）。
     */
    if (/[^\x20-\x7E]/.test(word)) return [word];
    return splitWithSeparators(word);
  }

  return splitLetters(word);
}

function splitWithSeparators(word) {
  const runs = [];
  let i = 0;
  while (i < word.length) {
    const isLetter = /[A-Za-z']/.test(word[i]);
    let j = i + 1;
    while (j < word.length && /[A-Za-z']/.test(word[j]) === isLetter) j += 1;
    runs.push({ text: word.slice(i, j), letter: isLetter });
    i = j;
  }

  const out = [];
  runs.forEach(function (r) {
    if (!r.letter) {
      // 分隔符：并入前一段；若它出现在开头（罕见），自成一段
      if (out.length) out[out.length - 1] += r.text;
      else out.push(r.text);
      return;
    }
    splitLetters(r.text).forEach(function (p) { out.push(p); });
  });

  return out.length ? out : [word];
}

/** 纯字母串的音节划分（split 的核心，被 splitWithSeparators 复用） */
function splitLetters(word) {
  const lower = word.toLowerCase();

  // 不含元音（如 "hmm"、缩写）→ 不切
  if (!/[aeiouy]/.test(lower)) return [word];

  const tokens = tokenize(lower);
  const vowels = tokens.filter(function (t) { return t.type === 'v'; });

  // 0 或 1 个元音核 → 单音节
  if (vowels.length <= 1) return [word];

  /**
   * 词尾不发音的 e：`make` / `nice` / `hope` 只算 1 个音节。
   *
   * ⚠️ 判定必须严格到 **CVCe** 这一个形态（单个辅音夹在单个元音和词尾 e 之间）。
   * 第一版写得太松（只要"最后一个元音核是 e 且前面有辅音"），
   * 结果把 `apple` / `table` / `little` 全吞成 1 个音节 ——
   * 它们的词尾 e **是发音的**（和前面的 l 构成 -le 音节）。
   *
   * 所以三个条件缺一不可：
   *   ① 最后一个 token 是单个 'e'
   *   ② 它前面是**恰好 1 个辅音**
   *   ③ 那个辅音前面是**恰好 1 个元音字母**（不是 ea/ee 这类组合）
   *   ④ 那个辅音不是 'l'（排除 -le：ta-ble / lit-tle 里 e 要发音）
   */
  let last = tokens[tokens.length - 1];
  let silentE = false;
  if (last && last.type === 'v' && last.text === 'e' && vowels.length >= 2) {
    const cluster = tokens[tokens.length - 2];
    const prevVowel = tokens[tokens.length - 3];
    if (cluster && cluster.type === 'c' && cluster.text.length === 1 && cluster.text !== 'l' &&
        prevVowel && prevVowel.type === 'v' && prevVowel.text.length === 1) {
      silentE = true;
    }
  }
  if (vowels.length - (silentE ? 1 : 0) <= 1) return [word];

  // 逐段构造：元音核 + 后面的辅音簇归属
  const cuts = [];                       // 切点位置（在 lower 上的下标）
  let pos = 0;
  const positions = [];                  // 每个 token 的起始下标
  tokens.forEach(function (t) { positions.push(pos); pos += t.text.length; });

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'c') continue;
    // 找这个辅音簇前后是否都是元音核
    const before = tokens[k - 1];
    const after = tokens[k + 1];
    if (!before || !after || before.type !== 'v' || after.type !== 'v') continue;
    // 不发音 e 之前的那一段不再产生新音节
    if (silentE && k >= tokens.length - 2 && after.text === 'e') continue;

    const head = splitCluster(t.text)[0];
    const cutAt = positions[k] + head.length;
    if (cutAt > 0 && cutAt < lower.length) cuts.push(cutAt);
  }

  if (cuts.length === 0) return [word];

  // 按切点组装（去重、排序）
  const uniq = Array.from(new Set(cuts)).sort(function (a, b) { return a - b; });
  const parts = [];
  let from = 0;
  uniq.forEach(function (c) {
    parts.push(word.slice(from, c));
    from = c;
  });
  parts.push(word.slice(from));

  // 收尾特例：`-le` 结尾（ta-ble / lit-tle）—— 前一段末尾若是"辅音+le"，
  // 把那个辅音移到 le 前面，读起来才顺（"tab-le" 不如 "ta-ble" 自然）
  return tidy(parts, word);
}

/**
 * 收尾整理：
 *   · 去掉空段（切点重合会产生空串）
 *   · `-le` 结尾时把前一段末尾的单个辅音让给最后一段
 *   · 最后再兜一次"拼回去等于原词"的检查，不成立就退回不切
 */
function tidy(parts, word) {
  let out = parts.filter(function (s) { return s.length > 0; });

  if (out.length >= 2) {
    const lastPart = out[out.length - 1];
    const prevPart = out[out.length - 2];
    // le / les / led 结尾，且前一段以"辅音 + 元音 + 辅音"结尾
    if (/^le[sd]?$/.test(lastPart) && /[^aeiou]/.test(prevPart.slice(-1)) &&
        /[aeiou]/.test(prevPart.slice(-2, -1))) {
      out[out.length - 2] = prevPart.slice(0, -1);
      out[out.length - 1] = prevPart.slice(-1) + lastPart;
    }
  }

  // 底线：拼回去必须逐字符等于原词，否则宁可不切
  if (out.join('') !== word) return [word];
  return out;
}

/**
 * 供界面直接渲染的分段（带交替颜色索引）。
 *
 * 为什么在这里算好颜色索引而不是在 WXML 里算：WXML 不能做取模运算，
 * 而且动态类名（`syl-{{index % 3}}`）会被静态门禁当成"未定义的类名"。
 * 在 JS 里把类名拼成完整字符串，模板只做 `class="syl {{item.c}}"` 即可。
 *
 * @param {string} word
 * @returns {Array<{t: string, c: string}>} c ∈ syl-0 / syl-1 / syl-2
 */
function segments(word) {
  const parts = split(word);
  return parts.map(function (t, i) {
    return { t: t, c: 'syl-' + (i % 3) };
  });
}

/** 音节数。切不出来时算 1（调用方不该拿到 0） */
function count(word) {
  const parts = split(word);
  return parts.length || 1;
}

/**
 * 给界面用的"值不值得分色"判断。
 *
 * 返回 null 表示**不要分色**（模板直接渲染原文本），返回数组才分色。三种情况返回 null：
 *   ① 中文释义 —— 它没有音节概念，染成三种颜色只会让人以为界面坏了；
 *   ② 单音节词（`cat`）—— 只有一段，染色没有信息量，反而多一层视觉噪音；
 *   ③ 混入非拉丁字符的脏数据（`race（v.）`）—— 切出来是碎片，不如原样显示。
 *
 * 为什么把判断放在这里而不是模板里：WXML 写不了正则，也做不了这种多条件判断。
 *
 * @param {string} word
 * @returns {Array<{t:string,c:string}>|null}
 */
function displayParts(word) {
  const raw = String(word == null ? '' : word);
  if (!raw) return null;
  if (!/^[A-Za-z' .-]+$/.test(raw)) return null;   // 含中文等非拉丁字符 → 不分色
  const parts = segments(raw);
  return parts.length > 1 ? parts : null;          // 单音节 → 不分色
}

module.exports = {
  split, segments, count, displayParts,
  // 导出中间件便于门禁逐层验证
  tokenize, splitCluster, VALID_ONSETS
};
