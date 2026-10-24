/**
 * 端上问词引擎 —— 零依赖、零网络，全部在本机算完。
 *
 * ## 设计上的一个重要修正（2026-09-17）
 * 初版做的是「猜哪个词容易混」：给一个词，返回拼写最像的几个。
 * 实测结果是噪音：
 *     important → parent(50%) / instrument(45%)    ← 学生绝不会混这两个
 *     difficult → （无）                            ← 一半的词没有结果
 *
 * 根因是**问错了问题**：
 *   · 拼写相似 ≠ 容易混。important/parent 拼写像但意思无关。
 *   · 学生不会问"哪个词跟这个像"。他们会说"**我这两个词分不清**"——
 *     词是**学生自己指定的**，不需要系统猜。
 *   · 而且 295 词的初学者词表里，真正互相干扰的词对本来就少
 *     （实测释义重合的只有 13 组，一半还是误报）。
 *
 * 所以现在回答的是学生**真的会问**的几类问题：
 *   ① 两词对比   —— "quite 和 quiet 有什么区别"（学生指定两个词，给具体的差异）
 *   ② 课本定位   —— "belong 在第几单元"（翻课本时的刚需）
 *   ③ 记忆法     —— "怎么记住 holiday"
 *   ④ 释义       —— "nervous 什么意思"
 *   ⑤ 同类词     —— "课本里学校用品有哪些"
 *   ⑥ 学习建议   —— "我该复习什么"（用真实学习数据回答）
 *   ⑦ 薄弱词     —— "我哪些词总记不住"
 *
 * 形近/同族检索仍保留为**底层工具**（`similar`/`family`），但只在
 * 学生明确问到时才用，并且会**如实说明"不算太像"**，而不是硬凑三个出来。
 */
const PHONEME_TABLE = require('./phoneme-table.js');
const TOPICS = require('../data/topics.js');

/*============================= 基础工具 =============================*/

function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z'\- ]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normWord(s) { return normalize(s).replace(/[^a-z]/g, ''); }

/** 中文归一化：用于"这两个词的中文意思像不像" */
function normCn(s) {
  return String(s == null ? '' : s)
    .replace(/^[a-z]+\.\s*/, '')
    .replace(/[\s,;，；、。.()（）「」【】]/g, '');
}

const VOWELS = {
  AA: 1, AE: 1, AH: 1, AO: 1, AW: 1, AY: 1, EH: 1, ER: 1,
  EY: 1, IH: 1, IY: 1, OW: 1, OY: 1, UH: 1, UW: 1
};
function isVowel(p) { return !!VOWELS[String(p).replace(/[0-9]/g, '')]; }
function stripStress(p) { return String(p).replace(/[0-9]/g, ''); }

/** 查音素（逐词查表，短语也支持） */
function phonesRaw(w) {
  const toks = normalize(w).split(' ').filter(Boolean);
  if (!toks.length) return null;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const p = PHONEME_TABLE[toks[i]];
    if (!p) return null;
    out.push.apply(out, p.split(' '));
  }
  return out;
}
function phones(w) {
  const r = phonesRaw(w);
  return r ? r.map(stripStress) : null;
}

/*============================= 距离与相似度 =============================*/

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

/** Damerau：相邻换位算 1 步（识别 quite/quiet、form/from 的关键） */
function damerau(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = new Array(n + 1); d[i][0] = i; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function dlSim(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - damerau(a, b) / m : 0;
}

function ngrams(s, n) {
  const out = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

function diceSet(sa, sb) {
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach(function (g) { if (sb.has(g)) inter++; });
  return (2 * inter) / (sa.size + sb.size);
}

function jaro(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const win = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(b.length - 1, i + win);
    for (let j = lo; j <= hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true; m++; break;
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (m / a.length + m / b.length + (m - t / 2) / m) / 3;
}

function jaroWinkler(a, b, p, maxPrefix) {
  const j = jaro(a, b);
  if (j < 0.7) return j;
  p = p == null ? 0.1 : p;
  maxPrefix = maxPrefix == null ? 4 : maxPrefix;
  let l = 0;
  const n = Math.min(Math.min(a.length, b.length), maxPrefix);
  while (l < n && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

function seqSim(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 0;
}

/**
 * 两个单词的逐字母差异 —— 用于回答"这两个词哪里不一样"。
 *
 * ## 为什么不用 LCS 对齐
 * 初版用最长公共子序列做对齐，技术上正确、读起来是灾难：
 *     geography  →  [g][e][·][·][·][·]og[r][a][p][h]y
 *     biology    →  [·][·][b][i][o][l]og[·][·][·][·]y
 * 人读词是从两端往中间的：**开头一样、结尾一样，中间不同**。
 * 所以改成"剥掉公共前缀与公共后缀，只把中间那段标出来"：
 *     quite   →  qui[te]        对比  quiet → qui[et]
 *     form    →  f[orm]         对比  from  → f[rom]
 *     geography → [geograph]y   对比  biology → [biolog]y
 * 一眼就能看出差别在哪。
 */
function diffWords(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;

  let s = 0;
  while (s < a.length - p && s < b.length - p &&
         a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);
  const prefix = a.slice(0, p);
  const suffix = s > 0 ? a.slice(a.length - s) : '';

  // 没有公共前后缀时，整词标红没有信息量（festival vs holiday 全红 = 等于没说），
  // 用 noCommon 标记让调用方换一种说法
  const noCommon = p === 0 && s === 0;
  return {
    left: noCommon ? a : (prefix + '[' + (aMid || '·') + ']' + suffix),
    right: noCommon ? b : (prefix + '[' + (bMid || '·') + ']' + suffix),
    prefix: prefix,
    suffix: suffix,
    aMid: aMid,
    bMid: bMid,
    noCommon: noCommon,
    // 只是字母顺序不同（quite/quiet、form/from）
    anagram: a.length === b.length && a.split('').sort().join('') === b.split('').sort().join(''),
    // 完全没变（同形）
    same: a === b
  };
}

/*============================= 构词法（同族词）=============================*/

const SUFFIX_RULES = [
  { suf: 'ies', to: 'y', kind: 'i' }, { suf: 'ied', to: 'y', kind: 'i' },
  { suf: 'ing', to: '', kind: 'i' }, { suf: 'ed', to: '', kind: 'i' },
  { suf: 'es', to: '', kind: 'i' }, { suf: 's', to: '', kind: 'i' },
  { suf: 'tion', to: '', kind: 'd' }, { suf: 'sion', to: '', kind: 'd' },
  { suf: 'ment', to: '', kind: 'd' }, { suf: 'ness', to: '', kind: 'd' },
  { suf: 'ity', to: '', kind: 'd' }, { suf: 'ous', to: '', kind: 'd' },
  { suf: 'ive', to: '', kind: 'd' }, { suf: 'ful', to: '', kind: 'd' },
  { suf: 'less', to: '', kind: 'd' }, { suf: 'able', to: '', kind: 'd' },
  { suf: 'ance', to: '', kind: 'd' }, { suf: 'ence', to: '', kind: 'd' },
  { suf: 'er', to: '', kind: 'a' }, { suf: 'est', to: '', kind: 'a' },
  { suf: 'ly', to: '', kind: 'a' }, { suf: 'al', to: '', kind: 'a' },
  { suf: 'ist', to: '', kind: 'a' }
];

function undouble(s) { return /([^aeiou])\1$/.test(s) ? s.slice(0, -1) : s; }

function stemOf(w, wordSet) {
  let cur = w, used = false;
  for (let i = 0; i < SUFFIX_RULES.length; i++) {
    const r = SUFFIX_RULES[i];
    if (!cur.endsWith(r.suf)) continue;
    if (cur.length - r.suf.length < 3) continue;
    let cand = cur.slice(0, cur.length - r.suf.length) + r.to;
    cand = undouble(cand);
    if (wordSet[cand] || PHONEME_TABLE[cand]) { cur = cand; used = true; break; }
  }
  return { stem: cur, verified: used };
}

function familyForms(base) {
  const out = [];
  const push = function (form, how) {
    if (form && form !== base && out.indexOf(form) === -1) out.push({ form: form, how: how });
  };
  push(base + 's', '+s'); push(base + 'es', '+es'); push(base + 'ed', '+ed');
  push(base + 'ing', '+ing'); push(base + 'ly', '+ly'); push(base + 'ness', '+ness');
  push(base + 'ful', '+ful'); push(base + 'less', '+less'); push(base + 'er', '+er');
  push(base + 'est', '+est'); push(base + 'ment', '+ment'); push(base + 'ous', '+ous');
  if (/e$/.test(base)) {
    const b = base.slice(0, -1);
    push(b + 'ing', '-e+ing'); push(b + 'ed', '-e+ed');
    push(b + 'ous', '-e+ous'); push(b + 'ion', '-e+ion');
  }
  return out;
}

/** 规则推不出的同族词（拉丁语异形派生、元音交替）—— 必须人工维护 */
const FAMILY_OVERRIDE = [
  ['produce', 'product'], ['decide', 'decision'], ['nature', 'natural'],
  ['polite', 'politics'], ['nervous', 'nerve'], ['nervous', 'nerves'],
  ['nervous', 'nervously'], ['wide', 'width'], ['strong', 'strength'],
  ['laugh', 'laughter'], ['grow', 'growth'], ['history', 'historical'],
  ['geography', 'geographic'], ['biology', 'biologist'], ['chemistry', 'chemical'],
  ['music', 'musical'], ['science', 'scientist'], ['art', 'artist'],
  ['celebrate', 'celebration'], ['educate', 'education'], ['invent', 'invention'],
  ['protect', 'protection'], ['pollute', 'pollution'], ['collect', 'collection'],
  ['excite', 'excited'], ['surprise', 'surprised'], ['travel', 'traveller']
];

/*============================= 索引 =============================*/

function buildIndex(cards) {
  const items = [];
  (cards || []).forEach(function (c) {
    const raw = c.prompt || c.word || '';
    const norm = normWord(raw);
    if (!norm) return;
    const ph = phones(raw);
    items.push({
      id: c.id, norm: norm, display: raw,
      meaning: c.answer || c.meaning || '',
      detail: c.detail || '',
      hook: c.hook || c.mnemonic || '',
      tags: c.tags || [],
      subject: c.subject || '英语',
      cn: normCn(c.answer || c.meaning || ''),
      phones: ph, phonesRaw: phonesRaw(raw),
      skel: ph ? ph.filter(function (p) { return !isVowel(p); }) : null,
      bigrams: new Set(ngrams(norm, 2)),
      sortedChars: norm.split('').sort().join('')
    });
  });

  const wordSet = Object.create(null);
  const byNorm = Object.create(null);
  items.forEach(function (it) { wordSet[it.norm] = true; byNorm[it.norm] = it; });

  const stemDict = Object.create(null);
  items.forEach(function (it) {
    const r = stemOf(it.norm, wordSet);
    it.stem = r.stem;
    it.stemVerified = r.verified;
    (stemDict[r.stem] = stemDict[r.stem] || []).push(it);
  });

  const tagIdx = Object.create(null);
  items.forEach(function (it) {
    it.tags.forEach(function (t) { (tagIdx[t] = tagIdx[t] || []).push(it); });
  });

  const bigramIdx = Object.create(null);
  items.forEach(function (it) {
    it.bigrams.forEach(function (g) { (bigramIdx[g] = bigramIdx[g] || []).push(it); });
  });

  const topicIdx = Object.create(null);
  Object.keys(TOPICS).forEach(function (t) {
    const entry = TOPICS[t];
    const list = Array.isArray(entry) ? entry : entry.words;
    const alias = Array.isArray(entry) ? [] : (entry.alias || []);
    const bucket = (topicIdx[t] = topicIdx[t] || { words: [], names: [] });
    bucket.names.push(t);
    alias.forEach(function (a) {
      bucket.names.push(a);
      topicIdx[a] = topicIdx[a] || bucket;
    });
    (list || []).forEach(function (w) {
      const it = byNorm[normWord(w)];
      if (it && bucket.words.indexOf(it) === -1) bucket.words.push(it);
    });
  });

  return {
    items: items, wordSet: wordSet, byNorm: byNorm,
    stemDict: stemDict, tagIdx: tagIdx, bigramIdx: bigramIdx, topicIdx: topicIdx
  };
}

function makeProbe(word, idx) {
  const norm = normWord(word);
  if (!norm) return null;
  if (idx.byNorm[norm]) return idx.byNorm[norm];
  const ph = phones(word);
  return {
    id: norm, norm: norm, display: word, meaning: '', detail: '', hook: '',
    tags: [], subject: '', offCorpus: true, cn: '',
    phones: ph, phonesRaw: phonesRaw(word),
    skel: ph ? ph.filter(function (p) { return !isVowel(p); }) : null,
    bigrams: new Set(ngrams(norm, 2)),
    sortedChars: norm.split('').sort().join('')
  };
}

/*============================= 形近检索（底层工具）=============================*/

const WEIGHTS = { spell: 0.45, phone: 0.35, skel: 0.10, rhyme: 0.10 };

function rhymeTail(raw) {
  if (!raw) return null;
  let idx = -1;
  for (let i = 0; i < raw.length; i++) if (/1$/.test(raw[i])) idx = i;
  if (idx < 0) for (let i = 0; i < raw.length; i++) if (/[012]$/.test(raw[i])) { idx = i; break; }
  return (idx >= 0 ? raw.slice(idx) : raw).map(stripStress);
}

function scorePair(a, b) {
  const spell = 0.50 * dlSim(a.norm, b.norm)
    + 0.35 * jaroWinkler(a.norm, b.norm)
    + 0.15 * diceSet(a.bigrams, b.bigrams);

  let phone = 0;
  if (a.phones && b.phones) {
    phone = seqSim(a.phones, b.phones);
    const la = a.phones.length, lb = b.phones.length;
    if (Math.abs(la - lb) > 1) {
      phone *= Math.pow(Math.min(la, lb) / Math.max(la, lb), 0.5);
    }
  }
  const skel = (a.skel && b.skel && a.skel.length && b.skel.length) ? seqSim(a.skel, b.skel) : 0;
  let rhyme = 0;
  const ta = rhymeTail(a.phonesRaw), tb = rhymeTail(b.phonesRaw);
  if (ta && tb && ta.length && tb.length) rhyme = seqSim(ta, tb);

  const conf = WEIGHTS.spell * spell + WEIGHTS.phone * phone
    + WEIGHTS.skel * skel + WEIGHTS.rhyme * rhyme;
  const ana = a.norm !== b.norm && a.norm.length === b.norm.length
    && a.sortedChars === b.sortedChars;

  return { item: b, conf: conf, spell: spell, phone: phone, skel: skel, rhyme: rhyme, ana: ana };
}

/**
 * 形近/音近检索。
 *
 * ⚠️ 这是**底层工具**，不直接推荐给学生（宁缺勿滥）。
 * 调用方应当用高阈值（≥0.55）并且如实说明"像不像"，
 * 而不是把 0.3 分的噪音包装成"容易混"。
 */
function similar(word, idx, opts) {
  opts = opts || {};
  const topK = opts.topK || 8;
  const minScore = opts.minScore == null ? 0.28 : opts.minScore;

  const probe = makeProbe(word, idx);
  if (!probe) return { query: word, inCorpus: false, results: [] };

  let pool = idx.items;
  if (opts.prune !== false && probe.norm.length > 5 && probe.bigrams.size) {
    const seen = new Set();
    probe.bigrams.forEach(function (g) {
      const b = idx.bigramIdx[g];
      if (b) b.forEach(function (it) { seen.add(it); });
    });
    if (seen.size >= 30) {
      const arr = [];
      seen.forEach(function (it) { arr.push(it); });
      pool = arr;
    }
  }

  const out = [];
  pool.forEach(function (it) {
    if (it.norm === probe.norm) return;
    const r = scorePair(probe, it);
    if (r.conf >= minScore) out.push(r);
  });
  out.sort(function (x, y) { return y.conf - x.conf; });

  return {
    query: word, inCorpus: !probe.offCorpus, probe: probe,
    results: out.slice(0, topK)
  };
}

/** 同族词 */
function family(word, idx, opts) {
  opts = opts || {};
  const probe = makeProbe(word, idx);
  if (!probe) return { base: '', word: word, curated: [], inCorpus: [], inTable: [] };
  const base = probe.norm;

  const curated = [];
  FAMILY_OVERRIDE.forEach(function (pair) {
    if (pair[0] === base && curated.indexOf(pair[1]) === -1) curated.push(pair[1]);
    else if (pair[1] === base && curated.indexOf(pair[0]) === -1) curated.push(pair[0]);
  });

  const inCorpus = [], inTable = [], unverified = [];
  familyForms(base).forEach(function (f) {
    if (idx.wordSet[f.form]) {
      if (inCorpus.indexOf(f.form) === -1) inCorpus.push(f.form);
    } else if (PHONEME_TABLE[f.form]) {
      if (inTable.indexOf(f.form) === -1) inTable.push(f.form);
    } else {
      unverified.push(f.form);
    }
  });

  const stemOnly = [];
  const r = stemOf(base, idx.wordSet);
  (idx.stemDict[r.stem] || []).forEach(function (it) {
    if (it.norm === base) return;
    if (curated.indexOf(it.norm) !== -1) return;
    if (inCorpus.indexOf(it.norm) !== -1) return;
    if (inTable.indexOf(it.norm) !== -1) return;
    stemOnly.push(it.norm);
  });

  return {
    base: base, word: probe.display, curated: curated,
    inCorpus: inCorpus, inTable: inTable, stemOnly: stemOnly,
    unverified: opts.includeUnverified ? unverified : []
  };
}

/** 主题检索 */
function category(topicOrWord, idx, opts) {
  opts = opts || {};
  const limit = opts.limit || 20;
  const q = String(topicOrWord || '').trim();

  const bucket = idx.topicIdx[q];
  if (bucket && bucket.words.length) {
    return { topic: q, names: bucket.names, items: bucket.words.slice(0, limit), matchedBy: 'topic' };
  }

  const probe = makeProbe(topicOrWord, idx);
  if (!probe || !probe.tags.length) {
    return { topic: q, names: [], items: [], matchedBy: 'none' };
  }
  const hit = Object.create(null);
  probe.tags.forEach(function (t) {
    const b = idx.topicIdx[t];
    if (!b) return;
    b.words.forEach(function (it) {
      if (it.norm !== probe.norm) hit[it.norm] = it;
    });
  });
  const items = [];
  Object.keys(hit).forEach(function (k) { items.push(hit[k]); });
  return { topic: q, names: probe.tags, items: items.slice(0, limit), matchedBy: items.length ? 'tag' : 'none' };
}

/*============================= 问题解析 ==============================*/

/**
 * 意图识别。
 *
 * 顺序很重要：**对比型必须排在形近型前面**。
 * "A 和 B 有什么区别" 里同时含有两个词，若先被"形近"匹配走，
 * 就会变成"给你推荐几个像 A 的词"——答非所问。
 */
const INTENTS = [
  // 注意："容易混" 也算 compare 意图 —— 学生说的"和哪个容易混"就是"我分不清"
  { name: 'compare', re: /区别|不同|分不清|搞混|混淆|怎么区分|哪个对|哪个是|容易混|易混|和.*像|哪个词像/ },
  { name: 'locate', re: /哪个单元|第几单元|在哪一课|哪一课|课本哪|什么时候学|哪个部分/ },
  { name: 'advice', re: /该复习|复习什么|学什么|先学|安排|今天学|计划|下一步/ },
  { name: 'weak', re: /总记不住|老是忘|老忘|记不住的词|薄弱|错题|不会的词|哪些词我/ },
  { name: 'howto', re: /怎么记|怎么背|巧记|记忆法|记不住这个|如何记/ },
  { name: 'pronounce', re: /怎么读|读音|发音|念/ },
  { name: 'category', re: /有哪些|哪些词|一类|分类|相关的词|属于/ },
  { name: 'meaning', re: /什么意思|是什么意思|释义|含义|啥意思/ }
];

/** 从问题里抽出所有英文词（keep order, dedup） */
function pickWords(question) {
  const cands = String(question || '').match(/[A-Za-z][A-Za-z'\-]{1,}/g) || [];
  const seen = Object.create(null);
  const out = [];
  cands.forEach(function (c) {
    const k = normWord(c);
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(c);
  });
  return out;
}

function parseQuestion(question) {
  const q = String(question || '').trim();
  let intent = 'general';
  for (let i = 0; i < INTENTS.length; i++) {
    if (INTENTS[i].re.test(q)) { intent = INTENTS[i].name; break; }
  }
  const words = pickWords(q);
  return {
    question: q,
    intent: intent,
    word: words.length ? words[words.length - 1] : '',   // 单问时取最后一个（通常是主题词）
    words: words
  };
}

/*============================= 回答生成 ==============================*/

/** 两词对比 —— 这是"我这两个词分不清"的正确答案 */
function composeCompare(idx, w1, w2) {
  const a = makeProbe(w1, idx);
  const b = makeProbe(w2, idx);
  if (!a || !b) return '';

  const missing = [];
  if (a.offCorpus) missing.push(w1);
  if (b.offCorpus) missing.push(w2);
  if (missing.length === 2) {
    return '课本词表里没有「' + missing.join('」和「') + '」这两个词。';
  }

  const lines = [];
  const d = diffWords(a.norm, b.norm);

  // ① 拼写差异（学生最直观的切入点）
  if (d.anagram) {
    lines.push('这两个词的字母完全相同，只是顺序不同：');
    lines.push('  ' + d.left);
    lines.push('  ' + d.right);
  } else if (d.noCommon) {
    // 完全不同型：说"拼写不像"比列两个整词更有用
    lines.push('这两个词拼写完全不同，不会因为长得像而混 —— 要区分的是**意思和用法**：');
  } else {
    lines.push('拼写差异（方括号里是不同的部分）：');
    lines.push('  ' + a.display + '  →  ' + d.left);
    lines.push('  ' + b.display + '  →  ' + d.right);
  }

  // ② 释义对比
  lines.push('');
  lines.push('意思：');
  lines.push('  ' + a.display + '  ' + (a.meaning || '（词表里没收录释义）'));
  lines.push('  ' + b.display + '  ' + (b.meaning || '（词表里没收录释义）'));

  // ③ 读音是否相同（同音异形是最容易混的）
  //    不显示音标：ARPAbet 对初一学生是天书，让他们点下面的词听真人发音
  if (a.phonesRaw && b.phonesRaw) {
    const same = a.phonesRaw.join(' ') === b.phonesRaw.join(' ');
    lines.push('');
    lines.push(same
      ? '两个词读音完全相同，只能靠上下文（句子意思）区分。'
      : '读音不一样，读出来就能分辨 —— 点下面的词可以各听一遍。');
  }

  // ④ 各自怎么记
  const hooks = [];
  if (a.hook) hooks.push('  ' + a.display + '：' + a.hook);
  if (b.hook) hooks.push('  ' + b.display + '：' + b.hook);
  if (hooks.length) {
    lines.push('');
    lines.push('怎么记：');
    lines.push.apply(lines, hooks);
  }

  return lines.join('\n');
}

/** 课本定位 */
function composeLocate(idx, word) {
  const probe = makeProbe(word, idx);
  if (!probe) return '';
  if (probe.offCorpus) return '课本词表里没有「' + word + '」这个词。';

  const unitTag = (probe.tags || []).filter(function (t) { return /^(Starter|Unit)/.test(t); })[0];
  if (!unitTag) {
    return probe.display + ' 在课本里，但没有标注单元信息。';
  }
  return probe.display + '（' + probe.meaning + '）在 **' + unitTag.replace('Unit', 'Unit ') +
    '**。翻课本找这一单元的单词表就能看到它。';
}

/** 学习建议（用真实学习数据） */
function composeAdvice(stats) {
  const s = stats || {};
  const due = s.dueCount || 0;
  const weak = s.weakCount || 0;
  const fresh = s.freshCount || 0;
  const studied = s.studiedCount || 0;

  if (due === 0 && weak === 0) {
    return '今天的复习都做完了。可以歇一会儿，明天到期的词会自动接上。';
  }
  const lines = [];
  if (weak > 0) {
    lines.push('错题本里有 ' + weak + ' 个词是你标过「不认识」或「模糊」的 —— 建议先过这一批，它们是最容易忘的。');
  }
  if (due > 0) {
    lines.push('今天还有 ' + due + ' 个词到期该复习。');
  }
  if (fresh > 0 && studied > 0) {
    lines.push('另外还有 ' + fresh + ' 个词没学过，属于新课内容。');
  }
  lines.push('（复习的优先级比新词高 —— 到期的词今天不复习，之前的记忆就白费了）');
  return lines.join('\n');
}

/** 薄弱词查询 */
function composeWeak(idx, stats) {
  const ids = (stats && stats.weakIds) || [];
  if (!ids.length) {
    return '还没有标过「不认识」或「模糊」的词。答错过的词会自动进这里，之后再专项过一遍。';
  }
  const names = [];
  ids.slice(0, 15).forEach(function (id) {
    const it = idx.items.filter(function (x) { return x.id === id; })[0];
    if (it) names.push(it.display);
  });
  return '这些词你标过不会或模糊，共 ' + ids.length + ' 个：\n' + names.join('、') +
    (ids.length > names.length ? ' …' : '') +
    '\n\n去「复习 → 筛选 → 错题重练」可以专门过一遍。';
}

/**
 * 主入口 —— 端上回答。
 *
 * 返回结构与页面兼容：{ ok, mode, intent, word, answer, sources }
 * sources 只在真有依据时给出（宁缺勿滥）。
 */
function ask(question, cards, opts) {
  opts = opts || {};
  const idx = opts.index || buildIndex(cards);
  const parsed = parseQuestion(question);
  const stats = opts.stats || {};
  const sources = [];
  const push = function (it, via, score) {
    if (!it) return;
    sources.push({
      word: it.display, meaning: it.meaning, via: via,
      score: Math.round((score || 0) * 1000) / 1000
    });
  };

  let answer = '';
  let mode = 'retrieval_only';

  /* ---- ① 两词对比（学生明确说了两个词）---- */
  if (parsed.intent === 'compare' && parsed.words.length >= 2) {
    const w1 = parsed.words[0], w2 = parsed.words[1];
    answer = composeCompare(idx, w1, w2);
    push(makeProbe(w1, idx), 'compare', 1);
    push(makeProbe(w2, idx), 'compare', 1);
  }

  /**
   * ② 单问"和哪个容易混" —— 诚实地回答。
   *
   * 这里**不做推荐**。初版给的是"按拼写最像的三个词"，实测是噪音
   * （important → parent 50%，学生绝不会混这两个），反而让人以为功能坏了。
   *
   * 真正会混的词是**学生自己已经混了的**，所以这里：
   *   · 只有当真有一个"像度很高"（≥0.6）的词时才提，且如实说明是"拼写/读音接近"
   *   · 否则直说"课本里没有特别容易混的"，并告诉学生怎么问才有效（说出两个词）
   */
  else if (parsed.intent === 'compare' && parsed.words.length === 1) {
    const w = parsed.words[0];
    const probe = makeProbe(w, idx);
    if (!probe || probe.offCorpus) {
      answer = '课本词表里没有「' + w + '」这个词。';
      mode = 'no_match';
    } else {
      const sim = similar(w, idx, { topK: 3, minScore: 0.6 });
      const real = sim.results.filter(function (r) { return r.conf >= 0.6; });
      if (real.length) {
        answer = '课本里和「' + w + '」拼写或读音比较接近的有：\n' +
          real.map(function (r) {
            return '· ' + r.item.display + '（' + r.item.meaning + '）' +
              (r.ana ? ' —— 字母相同、顺序不同' : '');
          }).join('\n') +
          '\n\n如果你已经分不清某两个词，直接告诉我，比如「' + w + ' 和 xxx 有什么区别」。';
        real.forEach(function (r) { push(r.item, 'phonetic', r.conf); });
      } else {
        answer = '课本 295 个词里，没有和「' + w + '」特别容易混的。\n\n' +
          '如果你已经有分不清的两个词，直接说「A 和 B 有什么区别」，我会把两边的拼写、意思、读音逐项对比给你。';
        push(probe, 'handle', 1);
      }
    }
  }

  /* ---- ③ 课本定位 ---- */
  else if (parsed.intent === 'locate' && parsed.word) {
    answer = composeLocate(idx, parsed.word);
    push(makeProbe(parsed.word, idx), 'locate', 1);
  }

  /* ---- ③ 学习建议 ---- */
  else if (parsed.intent === 'advice') {
    answer = composeAdvice(stats);
  }

  /* ---- ④ 薄弱词 ---- */
  else if (parsed.intent === 'weak') {
    answer = composeWeak(idx, stats);
  }

  /* ---- ⑤ 同类词 ---- */
  else if (parsed.intent === 'category') {
    let cat = category(parsed.word || parsed.question, idx);
    // 主题名可能不含英文（"学校用品"），用整句再试
    if (!cat.items.length) {
      const q = String(parsed.question).replace(/[?？。，,]/g, '').trim();
      cat = category(q, idx);
      if (!cat.items.length) {
        Object.keys(idx.topicIdx).forEach(function (name) {
          if (cat.items.length) return;
          if (name.length >= 2 && q.indexOf(name) !== -1) cat = category(name, idx);
        });
      }
    }
    if (cat.items.length) {
      answer = '「' + cat.topic + '」这一类，课本里有 ' + cat.items.length + ' 个：\n' +
        cat.items.map(function (it) { return it.display + '（' + it.meaning + '）'; }).join('\n');
      cat.items.forEach(function (it) { push(it, 'category', 0.9); });
    } else {
      answer = '没找到这一类词。可以换个说法，比如「关于天气的词」「课本里的动物」。';
      mode = 'no_match';
    }
  }

  /* ---- ⑥ 记忆法 ---- */
  else if (parsed.intent === 'howto' && parsed.word) {
    const probe = makeProbe(parsed.word, idx);
    if (probe && !probe.offCorpus) {
      answer = probe.display + '（' + probe.meaning + '）\n\n' +
        (probe.hook ? probe.hook : '这个词没有现成的记忆法。可以自己拆一下词根，或者造个例句。') +
        (probe.detail ? '\n\n补充：' + probe.detail : '');
      push(probe, 'handle', 1);
    } else {
      answer = '课本词表里没有「' + parsed.word + '」这个词。';
      mode = 'no_match';
    }
  }

  /* ---- ⑦ 读音 ---- */
  else if (parsed.intent === 'pronounce' && parsed.word) {
    const probe = makeProbe(parsed.word, idx);
    if (probe && !probe.offCorpus) {
      answer = probe.display + ' 读作 /' +
        (probe.phonesRaw ? probe.phonesRaw.map(stripStress).join(' ').toLowerCase() : '?') +
        '/\n点下面的词可以听真人发音。';
      push(probe, 'handle', 1);
    } else {
      answer = '课本词表里没有「' + parsed.word + '」这个词。';
      mode = 'no_match';
    }
  }

  /* ---- ⑧ 释义（默认）---- */
  else {
    const w = parsed.word;
    if (w) {
      const probe = makeProbe(w, idx);
      if (probe && !probe.offCorpus) {
        const lines = [probe.display + '  ' + probe.meaning];
        if (probe.hook) lines.push('', '记忆法：' + probe.hook);
        if (probe.detail) lines.push('', probe.detail);
        const unit = (probe.tags || []).filter(function (t) { return /^(Starter|Unit)/.test(t); })[0];
        if (unit) lines.push('', '（在课本 ' + unit.replace('Unit', 'Unit ') + '）');
        answer = lines.join('\n');
        push(probe, 'handle', 1);
      } else {
        answer = '课本词表里没有「' + w + '」这个词。\n\n' +
          '问词只回答课本里有的内容 —— 没学过的词建议查词典，这样不会记串。';
        mode = 'no_match';
      }
    } else {
      answer = '可以问我这些：\n' +
        '· quite 和 quiet 有什么区别\n' +
        '· belong 在第几单元\n' +
        '· holiday 怎么记\n' +
        '· 课本里学校用品有哪些词\n' +
        '· 我该复习什么';
      mode = 'no_match';
    }
  }

  /**
   * no_match 补「你是不是要找 X」（2026-09-19 加）。
   * 原来词表里没有就直接说没有 —— 学生输入的小拼写抖动（extra/eggs）会白跑一趟。
   * 用现成的编辑距离 + bigram 相似度找最近的 1-2 个词，写进回答**并**塞进 sources：
   * sources 是页面"练一下"的数据源，建议因此直接可练，不是一句干话。
   */
  if (mode === 'no_match' && idx && idx.items) {
    const t = normWord(parsed.word || '');
    if (t) {
      const near = idx.items
        .filter(function (it) { return it.norm !== t; })
        .map(function (it) {
          return { it: it, sim: Math.max(dlSim(t, it.norm), diceSet(ngrams(t, 2), ngrams(it.norm, 2))) };
        })
        .sort(function (a, b) { return b.sim - a.sim; })
        .slice(0, 2)
        .filter(function (x) { return x.sim > 0.42; });
      if (near.length) {
        answer += '\n\n你要找的是不是：';
        near.forEach(function (x) {
          answer += '\n· ' + x.it.display + '（' + x.it.meaning + '）';
          push(x.it, 'phonetic', 0.5);
        });
      }
    }
  }

  return {
    ok: true,
    mode: mode,
    intent: parsed.intent,
    word: parsed.word,
    words: parsed.words,
    answer: answer,
    sources: sources.slice(0, 6)
  };
}

module.exports = {
  ask, parseQuestion, buildIndex,
  similar, family, category,
  diffWords, composeCompare, composeAdvice, composeWeak, composeLocate,
  normalize, normWord, normCn, phones, damerau, dlSim, jaro, jaroWinkler,
  levenshtein, seqSim, diceSet, stemOf, familyForms,
  FAMILY_OVERRIDE, WEIGHTS
};
