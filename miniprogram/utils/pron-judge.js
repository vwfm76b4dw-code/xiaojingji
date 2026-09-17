/**
 * 端上发音判定引擎 —— 纯 JS，零依赖，不需要任何服务器。
 *
 * 这是"任何手机都能用"的关键：把原本跑在 Python 服务里的音素判定，
 * 用纯 JS 重新实现（音素表只有 7.7KB，可打进主包）。
 *
 * 算法与 server/pron_judge.py 同源，保持一致：
 *   ① 规范化（去标点/大小写/连字符）
 *   ② 音素化（查音素表；缺失时退化为字符级比较）
 *   ③ 片段滑窗（解决"多读了词"，如 "nervous system" 里取出 "nervous"）
 *   ④ 要素级 Jaro 相似度（对音素序列，而非字母）
 *   ⑤ 长度护栏 + 词表否决
 *
 * 为什么必须走音素而非字符串：
 *   英语拼写与发音严重脱节。geography vs geometry 字母相似度只有 0.44，
 *   但音素层面共享 5/8 个音素，可分性完全不同。
 *
 * 三档判定（与后端一致）：
 *   pass        ≥ passScore        → "读得不错"
 *   borderline  ≥ borderlineScore  → "再试一次"（把机器的犹豫和学生的错误分开）
 *   fail        <  borderlineScore → "这个词有点难"
 */

const PHONEME_TABLE = require('./phoneme-table.js');

const DEFAULT_PASS = 0.84;
const DEFAULT_BORDER = 0.68;
const LEN_POW = 0.5;

/** 规范化：小写、去标点（保留撇号与连字符转空格） */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[^a-z'\- ]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取某段文本的音素序列。返回 {phones: string[], oov: string[]} */
function phonesOf(text) {
  const phones = [];
  const oov = [];
  const toks = normalize(text).split(' ').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const p = PHONEME_TABLE[toks[i]];
    if (p) {
      // 音素表里是空格分隔的字符串
      const arr = p.split(' ');
      for (let j = 0; j < arr.length; j++) phones.push(arr[j]);
    } else {
      oov.push(toks[i]);
    }
  }
  return { phones: phones, oov: oov };
}

/**
 * 要素级 Jaro 相似度 —— 对任意可比较的元素序列生效。
 * 传入音素数组时，比较的是"发音"而不是"拼写"。
 */
function jaroElem(a, b) {
  if (!a.length || !b.length) return 0;
  if (a.length === b.length) {
    let same = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    if (same) return 1;
  }

  const la = a.length, lb = b.length;
  const md = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const fa = new Array(la).fill(false);
  const fb = new Array(lb).fill(false);
  let m = 0;

  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - md);
    const hi = Math.min(i + md + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (!fb[j] && b[j] === a[i]) {
        fa[i] = true; fb[j] = true; m++;
        break;
      }
    }
  }
  if (m === 0) return 0;

  // 换位数
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!fa[i]) continue;
    while (!fb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t = Math.floor(t / 2);

  return (m / la + m / lb + (m - t) / m) / 3;
}

/** 生成 1..nmax 元的连续片段（用于从"多读了词"里取出核心词） */
function spans(text, nmax) {
  const t = normalize(text).split(' ').filter(Boolean);
  if (!t.length) return [''];
  const out = [];
  const top = nmax || 3;
  for (let n = 1; n <= top; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      out.push(t.slice(i, i + n).join(' '));
    }
  }
  const full = t.join(' ');
  if (out.indexOf(full) === -1) out.push(full);
  return out;
}

/**
 * 判定一次朗读。
 *
 * @param expected  期望单词
 * @param heard     ASR 识别结果
 * @param vocab     词表（字符串数组），用于"读成别的词"的否决；可省略
 * @param opts      { passScore, borderlineScore }
 * @returns { ok, band, score, scorePct, verdict, suggestion, reason, heard }
 */
function judge(expected, heard, vocab, opts) {
  opts = opts || {};
  const passT = typeof opts.passScore === 'number' ? opts.passScore : DEFAULT_PASS;
  const borderT = typeof opts.borderlineScore === 'number'
    ? opts.borderlineScore : DEFAULT_BORDER;

  const expNorm = normalize(expected);
  const heardNorm = normalize(heard);

  const fail = (reason, detail) => ({
    ok: false, band: 'fail', score: 0, scorePct: 0,
    reason: reason, detail: detail || '',
    verdict: '这个词有点难',
    suggestion: '点下面的喇叭听标准发音，跟着读一遍',
    heard: heard || ''
  });

  if (!expNorm) return fail('bad_input', '期望词为空');
  if (!heardNorm) {
    return {
      ok: false, band: 'borderline', score: 0, scorePct: 0,
      reason: 'no_speech', detail: '没听到声音',
      verdict: '没听清',
      suggestion: '再读一次，靠近手机一点',
      heard: ''
    };
  }

  const exp = phonesOf(expected);
  const expPhones = exp.phones;
  if (!expPhones.length) {
    // 期望词没有音素数据：无法评测，如实说明而不是误判
    return {
      ok: false, band: 'na', score: 0, scorePct: 0,
      reason: 'expected_no_phoneme', detail: '这个词缺少音素数据',
      verdict: '这个词暂时评不了',
      suggestion: '可以先听发音跟着读',
      heard: heard || ''
    };
  }

  // ---- 词表否决：识别成了**另一个**词 ----
  //
  // 用途：学生把 geography 读成 geology 时，两个词都在表里且音素接近，
  //       相似度可能过阈值，需要否决掉。
  //
  // ⚠️ 两个必须排除的误伤（都踩过）：
  //   ① 候选片段是期望词的一部分：'in fact' 会切出 'fact'（词表词）→ 不能否决
  //   ② 候选是期望词的**形态变体**：hobbies ⊃ hobby、holidays ⊃ holiday
  //      → 学生读的是同一个词的复数，不是"读成别的词"。
  //      曾因此把 0.933 分的正确答案判成 fail。
  /**
   * 变体判定：判断"候选词是不是期望词的形态变化"（复数/时态/比较级）。
   *
   * 判据演进（两次踩坑）：
   *   v1 前缀匹配：hobby→hobbies 词干从 'hobby' 变 'hobbi'，indexOf 失效
   *   v2 编辑距离：hobbies vs hobby 距离是 3（y→i 加 es），仍判不出
   *   v3（本版）**正则剥离词缀后比词干** —— 这是最本质的判法，
   *      因为它建模的正是"英语构词法"本身，而不是字符表面的相似。
   */
  const stripAffix = (w) => {
    return w
      .replace(/ies$/, 'y')      // hobbies → hobby, studies → study
      .replace(/ied$/, 'y')
      .replace(/([^aeiou])es$/, '$1')   // boxes → box
      .replace(/s$/, '')         // books → book（放在 ies 之后）
      .replace(/ing$/, '')       // running → runn（末尾重复字母另处理）
      .replace(/([a-z])$/, '$1')     // runn → run
      .replace(/ed$/, '')
      .replace(/(er|est)$/, '')  // bigger → big（双写另处理）
      .replace(/([a-z])$/, '$1');
  };

  const isVariantOf = (cand, exp) => {
    if (cand === exp) return true;
    if (!cand || !exp) return false;
    // 只对单词语判变体；短语交给"包含"逻辑
    if (cand.indexOf(' ') !== -1 || exp.indexOf(' ') !== -1) return false;
    return stripAffix(cand) === stripAffix(exp);
  };

  let veto = null;
  if (vocab && vocab.length) {
    const vset = {};
    for (let i = 0; i < vocab.length; i++) vset[normalize(vocab[i])] = true;
    const expTokens = {};
    expNorm.split(' ').forEach(function (t) { expTokens[t] = true; });

    const cands = spans(heard, 1);
    for (let i = 0; i < cands.length; i++) {
      const tok = cands[i];
      if (!tok || tok === expNorm || !vset[tok]) continue;
      if (expTokens[tok] || expNorm.indexOf(tok) !== -1) continue;   // ① 期望词的一部分
      if (isVariantOf(tok, expNorm)) continue;                        // ② 形态变体
      veto = tok;
      break;
    }
  }

  // ---- 主判定：音素要素级 Jaro，取最佳片段 ----
  //
  // ★ 双路径取优（踩过的坑）：
  //   音素表只含【课本词 + 常见变体】（866 条，22KB），而 ASR 可能识别出
  //   完全不在表里的词（学生读错时会得到 geometry / Hello Day 这类结果）。
  //   只走音素路径的话，这些候选查不到音素 → 分数直接 0 →
  //   连 `hobbies`（hobby 的复数，课本变体里有）都可能因大小写/形态差异失配。
  //   所以：**音素查得到就用音素，查不到就用字母级 Jaro 兜底**，两者取优。
  //   字母级虽然分不清拼写与发音的差异，但用来判断"这是不是同一个词"够用。
  const expChars = expNorm.replace(/ /g, '').split('');
  let best = 0, bestSpan = null, via = '';

  const candSpans = spans(heard);
  for (let i = 0; i < candSpans.length; i++) {
    const sp = candSpans[i];
    const c = phonesOf(sp);
    const spNorm = normalize(sp);

    let sPhone = 0;
    if (c.phones.length) {
      sPhone = jaroElem(expPhones, c.phones);
      // 长度护栏：候选音素比期望长很多时衰减（防"读了一长串"蒙分）
      if (c.phones.length - expPhones.length > 1) {
        sPhone *= Math.pow(expPhones.length / c.phones.length, LEN_POW);
      }
    }

    // 字母级兜底：只在音素路径拿不到分时启用（避免它拖累音素判定）
    let sChar = 0;
    if (sPhone < 0.5 && spNorm) {
      sChar = jaroElem(expChars, spNorm.replace(/ /g, '').split('')) * 0.95;
    }

    const s = Math.max(sPhone, sChar);
    if (s > best) {
      best = s;
      bestSpan = sp;
      via = sPhone >= sChar ? 'phoneme' : 'letters';
    }
  }

  let band = best >= passT ? 'pass' : (best >= borderT ? 'borderline' : 'fail');
  let reason = best >= 0.999 ? 'exact'
    : band === 'pass' ? 'acceptable'
    : band === 'borderline' ? 'unclear' : 'mismatch';

  if (veto && band === 'pass') {
    band = 'fail';
    reason = 'other_word';
  }

  const verdictMap = {
    pass: '读得不错',
    borderline: '再试一次',
    fail: '这个词有点难'
  };
  const suggestMap = {
    pass: '',
    borderline: '听上去接近了，慢一点、把每个音节读清楚',
    fail: '点下面的喇叭听标准发音，跟着读一遍'
  };

  return {
    ok: band === 'pass',
    band: band,
    score: Math.round(best * 1000) / 1000,
    scorePct: Math.round(best * 100),
    reason: reason,
    via: via,
    detail: veto ? ('听成了词表里的「' + veto + '」')
                 : ('匹配「' + bestSpan + '」· ' + (via === 'phoneme' ? '按发音比对' : '按拼写比对')),
    verdict: verdictMap[band],
    suggestion: suggestMap[band],
    heard: heard || ''
  };
}

/** 词表（用于否决逻辑）—— 从音素表取键即可 */
function vocabList() {
  return Object.keys(PHONEME_TABLE);
}

module.exports = {
  DEFAULT_PASS, DEFAULT_BORDER,
  normalize, phonesOf, jaroElem, judge, vocabList,
  TABLE_SIZE: Object.keys(PHONEME_TABLE).length
};
