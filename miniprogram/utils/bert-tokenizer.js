/**
 * BERT WordPiece Tokenizer —— 零依赖 JS 实现，可直接放进微信小程序
 *
 * ## 为什么需要自己写
 * 端侧 Embedding 的链路是：文本 → tokenizer → token ids → ONNX 模型 → 向量。
 * 模型那一段微信有官方推理引擎，但 **tokenizer 小程序里没有** ——
 * 没有任何库，必须自己实现。这是端侧 RAG 路线唯一缺的组件。
 *
 * ## 严格对齐 HuggingFace 的 BertTokenizer
 * 配置来自 all-MiniLM-L6-v2 的 tokenizer.json：
 *   normalizer     : BertNormalizer { clean_text: true, handle_chinese_chars: true,
 *                                     strip_accents: null(=跟随 lowercase), lowercase: true }
 *   pre_tokenizer  : BertPreTokenizer
 *   model          : WordPiece { unk_token: '[UNK]', continuing_subword_prefix: '##' }
 *   post_processor : TemplateProcessing [CLS] A [SEP]
 * 四步的顺序不能换：clean → 中文字符加空格 → 小写 → 去音标重音 → 按标点切分 → WordPiece。
 *
 * ## 已核对的常量
 * [PAD]=0  [UNK]=100  [CLS]=101  [SEP]=102  [MASK]=103（与 BERT 标准一致）
 */

/*========================= 一、字符分类（对齐 BERT 的 _is_* 实现）=========================*/

/**
 * 空白判定。BERT 用的是：' ' / '\t' / '\n' / '\r' 或 Unicode 类别为 Zs。
 * JS 的 \s 已覆盖大部分，这里补上 Zs 里 \s 漏掉的几个。
 */
function isWhitespace(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return true;
  const cp = ch.codePointAt(0);
  return (cp >= 0x2000 && cp <= 0x200A) || cp === 0x00A0 || cp === 0x1680
    || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000;
}

/**
 * 控制字符判定。注意：\t \n \r 属于空白，**不算**控制字符（BERT 原实现如此）。
 * 覆盖 C0(0x00-0x1F) / DEL+ C1(0x7F-0x9F) / 以及常见 C 类（用 Unicode 属性兜底）。
 */
function isControl(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return false;
  if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) return true;
  // 其余用 Unicode 类别 C* 兜底（Node 支持 \p{C}）
  return /^\p{C}$/u.test(ch);
}

/** CJK 汉字判定（含扩展区），用于 handle_chinese_chars */
function isChineseChar(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0x3400 && cp <= 0x4DBF)
    || (cp >= 0x20000 && cp <= 0x2A6DF)
    || (cp >= 0x2A700 && cp <= 0x2B73F)
    || (cp >= 0x2B740 && cp <= 0x2B81F)
    || (cp >= 0x2B820 && cp <= 0x2CEAF)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

/** 标点判定：BERT 按 Unicode 类别 P* 切分 */
function isPunctuation(ch) {
  return /^\p{P}$/u.test(ch);
}

/*========================= 二、normalizer =========================*/

/** BertNormalizer：clean_text → handle_chinese_chars → lowercase → strip_accents */
function normalize(text, opts) {
  const doLower = opts.lowercase !== false;
  const stripAccents = opts.stripAccents === null || opts.stripAccents === undefined
    ? doLower                       // 原实现：strip_accents 未指定时跟随 do_lower_case
    : opts.stripAccents;

  let out = '';

  // ① clean_text：去控制字符，空白统一成空格
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xFFFD || isControl(ch)) continue;
    out += isWhitespace(ch) ? ' ' : ch;
  }

  // ② handle_chinese_chars：每个汉字两侧补空格（这样汉字会各自成为独立 token）
  if (opts.handleChineseChars !== false) {
    let withSpaces = '';
    for (const ch of out) {
      withSpaces += isChineseChar(ch) ? (' ' + ch + ' ') : ch;
    }
    out = withSpaces;
  }

  // ③ lowercase
  if (doLower) out = out.toLowerCase();

  // ④ strip_accents：NFD 分解后去掉组合音标（é → e + ́ → e）
  if (stripAccents) {
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  return out;
}

/*========================= 三、pre_tokenizer =========================*/

/** BertPreTokenizer：空白切分 + 标点单独成 token */
function preTokenize(text) {
  const tokens = [];
  let buf = '';
  const flush = function () { if (buf) { tokens.push(buf); buf = ''; } };

  for (const ch of text) {
    if (isWhitespace(ch)) {
      flush();
    } else if (isPunctuation(ch)) {
      flush();
      tokens.push(ch);        // 标点单独成一个 token
    } else {
      buf += ch;
    }
  }
  flush();
  return tokens;
}

/*========================= 四、WordPiece =========================*/

/**
 * 贪心最长匹配优先（longest-match-first）。
 * 匹配不到整词时退化为子词：后续片段加 `##` 前缀。
 * 任何位置都匹配不上就整体返回 [UNK]（这是 BERT 的行为，不是逐字符退）。
 */
function wordPiece(token, vocab, unkToken, maxCharsPerWord) {
  const chars = Array.from(token);
  if (chars.length > maxCharsPerWord) return [unkToken];

  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let cur = null;
    while (start < end) {
      let sub = chars.slice(start, end).join('');
      if (start > 0) sub = '##' + sub;
      if (Object.prototype.hasOwnProperty.call(vocab, sub)) { cur = sub; break; }
      end--;
    }
    if (cur === null) return [unkToken];   // 整词作废
    out.push(cur);
    start = end;
  }
  return out;
}

/*========================= 五、对外接口 =========================*/

/**
 * @param {Object} vocab  { token: id }，来自 tokenizer.json 的 model.vocab
 * @param {Object} [opts] { maxLength, lowercase, stripAccents, handleChineseChars }
 */
function createTokenizer(vocab, opts) {
  opts = opts || {};
  const o = {
    lowercase: opts.lowercase !== false,
    stripAccents: opts.stripAccents === undefined ? null : opts.stripAccents,
    handleChineseChars: opts.handleChineseChars !== false,
    maxCharsPerWord: opts.maxCharsPerWord || 100
  };
  const UNK = '[UNK]', CLS = '[CLS]', SEP = '[SEP]', PAD = '[PAD]';
  const maxLength = opts.maxLength || 128;

  /** 文本 → token 字符串数组（不含特殊 token） */
  function tokenize(text) {
    const norm = normalize(String(text == null ? '' : text), o);
    const words = preTokenize(norm);
    const out = [];
    words.forEach(function (w) {
      wordPiece(w, vocab, UNK, o.maxCharsPerWord).forEach(function (t) { out.push(t); });
    });
    return out;
  }

  /**
   * 文本 → { input_ids, attention_mask, token_type_ids }
   * 结构对齐 BERT：[CLS] + tokens + [SEP] + [PAD]×
   */
  function encode(text, overrideMaxLen) {
    const len = overrideMaxLen || maxLength;
    let toks = tokenize(text);
    // 留出 [CLS] 与 [SEP]
    if (toks.length > len - 2) toks = toks.slice(0, len - 2);
    const ids = [vocab[CLS], ...toks.map(function (t) { return vocab[t] !== undefined ? vocab[t] : vocab[UNK]; }), vocab[SEP]];
    const mask = ids.map(function () { return 1; });
    while (ids.length < len) { ids.push(vocab[PAD]); mask.push(0); }
    return {
      input_ids: ids,
      attention_mask: mask,
      token_type_ids: ids.map(function () { return 0; })
    };
  }

  /** ids → 文本（用于自检与调试） */
  function decode(ids, skipSpecial) {
    const rev = {};
    Object.keys(vocab).forEach(function (k) { rev[vocab[k]] = k; });
    const specials = { [vocab[PAD]]: 1, [vocab[CLS]]: 1, [vocab[SEP]]: 1 };
    return ids
      .filter(function (i) { return !(skipSpecial && specials[i]); })
      .map(function (i) { return rev[i] !== undefined ? rev[i] : UNK; })
      .join(' ')
      .replace(/ ##/g, '');
  }

  return { tokenize, encode, decode, vocabSize: Object.keys(vocab).length };
}

module.exports = { createTokenizer, normalize, preTokenize, wordPiece, isChineseChar, isWhitespace, isControl, isPunctuation };
