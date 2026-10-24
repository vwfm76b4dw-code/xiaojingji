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
   * 变体判定：判断「候选词是不是期望词的形态变化」（复数/时态/比较级）。
   *
   * 判据演进（三次踩坑）：
   *   v1 前缀匹配：hobby→hobbies 词干从 'hobby' 变 'hobbi'，indexOf 失效
   *   v2 编辑距离：hobbies vs hobby 距离是 3（y→i 加 es），仍判不出
   *   v3 **正则剥离词缀后比词干** —— 建模的是「英语构词法」本身，方向是对的
   *
   * ## v3 的两个 bug（2026-09-30 修；这是学生直接受害的判定错误）
   *
   * **bug 1：两处 `.replace(/([a-z])<0x01>$/, '$1')` 是永不匹配的死代码。**
   * 那两行的正则里嵌了一个**字面 0x01 控制字节**（本意应是反引用 `\1`
   * 写坏成了控制字符）。它不是恒等操作，而是**永远匹配不上**，
   * 于是注释宣称的「末尾重复字母另处理」「双写另处理」**从来没发生过**。
   *
   * ⚠️ 顺带排除一个看起来很自然的"修法"：**不能**简单改成真正的反引用
   * `/([a-z])\1$/`。那样 `kiss → kis`、`miss → mis`、`pass → pas`，
   * 会把**更多**课本基词变坏 —— 比现在的 bug 更广。重复辅音还原必须
   * 限定在英语里真正会双写的辅音上（见 DOUBLE_CONSONANTS）。
   *
   * **bug 2（学生受害的直接原因）：`/s$/` 对基词也生效，去缀不对称。**
   * v3 的规则链是**无条件顺序剥离**，没有「这个词确实带这个后缀」的判断：
   *   `kiss`   → ies?no ied?no es?no **s$ → `kis`** → 后续都不匹配 → `kis`
   *   `kissed` → ies?no ied?no es?no s$?no ing?no ... **ed$ → `kiss`** → `kiss`
   * 两侧得到 `kis` vs `kiss`，判不等 → **不是变体** → 触发词表否决 →
   * 本已 0.917 分（过阈值）的正确答案被改判 `fail` / `other_word`。
   * `miss ← missed` 同理。而 `fill ← filled` 恰好躲过，因为 `fill` 不以 s 结尾，
   * 剥出来还是 `fill` —— 这正是「只测一个词看不出 bug」的原因。
   * kiss / miss 都是 `wy7s_2024`（外研版七上）的真实课本词，不是边缘词。
   *
   * ## v4 的修法：生成**全部候选词干**再求交集
   *
   * 不再「两侧各剥一次然后比」，而是**各自剥出所有可能的词干，
   * 只要两个集合有交集就是变体**：
   *   · 不对称自然消失：`kiss` 的候选含 `kiss` 本身，`kissed` 的候选含 `kiss`
   *   · 真实后缀形态仍能识别：`hobbies→{hobbies,hobby}`、`studies→{study}`、
   *     `boxes→{box}`、`running→{runn,run}`、`stopped→{stopped,stopp,stop}`
   *   · 基词自身永远在候选里，基词与任意形态都能对上
   *
   * v3 修好的既有场景（hobby/hobbies、holiday/holidays）必须保持不回归 ——
   * 回归用例见 tools/verify-p1-client.js。
   */

  /** 英语里会双写的辅音字母。还原时只认这些，避免把 kiss→kis 这类基词也毁掉 */
  const DOUBLE_CONSONANTS = 'bdgklmnprt';

  /**
   * 还原末尾重复辅音：runn→run, stopp→stop, bigg→big, popped→pop。
   * 不是英语双写惯用字母就不动（kiss / miss / pass 保持原样）。
   *
   * @param {string} w 单词
   * @returns {string} 还原后的词；不适用时原样返回
   */
  const undouble = (w) => {
    const n = w.length;
    if (n >= 3 && w[n - 1] === w[n - 2] && DOUBLE_CONSONANTS.indexOf(w[n - 1]) !== -1) {
      return w.slice(0, -1);
    }
    return w;
  };

  /**
   * 一个词的**全部候选词干**（数组去重，至少含原词本身）。
   *
   * 每条规则**独立试一次**，而不是串成一条链 —— 这是 v3→v4 的关键：
   * 串起来时前一条规则的副作用会污染后一条（`/s$/` 把 `kiss` 变成 `kis`，
   * 后面就再也回不到 `kiss`）；独立试探保证每种构词路径都被考虑到。
   *
   * @param {string} w 已 normalize 的单个词
   * @returns {string[]} 候选词干列表
   */
  const stemsOf = (w) => {
    const out = [];
    /** @param {string} x 候选词干 @returns {void} */
    const add = (x) => {
      if (x && x.length >= 2 && out.indexOf(x) === -1) out.push(x);
    };

    add(w);                                        // 基词自身（kiss 的正解就在这里）
    add(w.replace(/ies$/, 'y'));                   // studies → study
    add(w.replace(/ied$/, 'y'));                   // tried → try
    if (/([^aeiou])es$/.test(w)) add(w.replace(/([^aeiou])es$/, '$1'));  // boxes → box
    /**
     * 复数 / 第三人称 `-s`。这条**必须对所有词都试**（holidays → holiday
     * 走的就是它：holiday+s 是 -ays 不是 -ies，之前按"s 结尾就不剥"的
     * 粗守卫会把 holiday/holidays 判成两个词，那是 v3 修好过的场景，不能丢）。
     *
     * 那 v3 的病根怎么不算回来了？—— 因为 v3 拿的是**唯一**的剥离结果去比，
     * `kiss` 被这一条改写成 `kis` 就再也回不去了；而v4 里 `kiss` 本身
     * 早已在上面的 add(w) 里，`kis` 只是**多出来的一个候选**。
     * 判据是「两集合有交集」，多一个候选只会让匹配更宽松，
     * 不会像 v3 那样把唯一的正确答案改坏。
     * 残留风险仅限于 `kis`/`pas` 这类无意义短串恰好也是别的词 —— 课本词表里没有。
     */
    add(w.replace(/s$/, ''));                     // books → book, holidays → holiday
    add(w.replace(/ing$/, ''));                    // running → runn
    add(w.replace(/ed$/, ''));                     // kissed → kiss, filled → fill
    add(w.replace(/ier$/, 'y'));                   // happier → happy
    add(w.replace(/iest$/, 'y'));                  // happiest → happy
    add(w.replace(/er$/, ''));                     // bigger → bigg
    add(w.replace(/est$/, ''));                    // biggest → bigg

    // 辅音重复还原 —— v3 里那两行死代码真正想做的事（限定英语双写辅音）
    for (let i = 0; i < out.length; i++) add(undouble(out[i]));

    return out;
  };

  /**
   * 候选词干集合求交集：任一共同词干即视为同一词的形态变化。
   *
   * @param {string} cand 候选词（ASR 听到的）
   * @param {string} exp 期望词
   * @returns {boolean} 是否为同一词的形态变化
   */
  const isVariantOf = (cand, exp) => {
    if (cand === exp) return true;
    if (!cand || !exp) return false;
    // 只对单词语判变体；短语交给「包含」逻辑
    if (cand.indexOf(' ') !== -1 || exp.indexOf(' ') !== -1) return false;
    const a = stemsOf(cand);
    const b = stemsOf(exp);
    for (let i = 0; i < a.length; i++) {
      if (b.indexOf(a[i]) !== -1) return true;
    }
    return false;
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
      // 长度护栏：候选音素比期望长很多时衰减（防"读了一长串"蒙分）。
      // 豁免：**形态变体**（kissing←kiss / kissed←kiss）多出来的音素是
      // 构词后缀的一部分，不是蒙分——ASR 又常把短促的尾音听成 -ing/-ed，
      // 学生明明读对了却被护栏压穿 borderline 线判 fail（kiss←kissing
      // 实测 0.8667 → 0.6713 < 0.68，DEV-P1-LENGTH-GUARD-FALSE-FAIL）。
      // 判据与词表否决共用 isVariantOf（词干交集），短语不参与豁免；
      // 非变体的长串（notebook←book 这类）照旧衰减。实测分布见
      // tools/analyze-len-guard.js 修前/修后两份 JSON（2026-10-17）。
      const isVar = spNorm.indexOf(' ') === -1 && isVariantOf(spNorm, expNorm);
      if (!isVar && c.phones.length - expPhones.length > 1) {
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

  /**
   * 字母兜底的分数**封顶 borderline，永不判 pass**（2026-09-30）。
   *
   * ## 为什么这不是调阈值能解决的
   * sPhone 与 sChar 是**两种量纲**：前者量「发音像不像」，后者量「是不是同一个词」。
   * 代码用 Math.max 合并两者，等于把「词形相似」当「发音相似」用。
   * 后果实测：holiday←holliday 得 0.91、kiss←kis 得 0.871，都判 pass ——
   * 而后者（s 尾读成 z）是**真实的读音错误**，不是容错。
   * 提到 0.88 只能盖住 0.871 那批，0.91 那批照样 pass —— 阈值治不了量纲错。
   *
   * ## 触发前提是可机械验证的，不是"感觉像 letters"
   * 实测穷举（音素表内 866 词两两互判，抽样 4189 对）：**letters 单独定出 pass 的对数 = 0**。
   * 也就是说 via=letters 只在「听到的词查不到音素」（sPhone=0）时发生；
   * 只要听到的词在表内，sPhone 就有值，letters 永远轮不到定档。
   * ⚠️ 这条互斥性被 tools/verify-p1-client.js ⑧ 钉住：将来若有人把 letters 的
   * 触发条件改宽（例如改成「音素相似度低于 X 就落 letters」），会静默吃掉
   * phoneme 路径的正确判定 —— 那时门禁会红。
   *
   * ## 为什么封顶 borderline 而不是 fail
   * fail 的文案是「这个词有点难」；na 的文案是「暂时评不了」。
   * 而这个分支的真实成因是**工具能力不足**（听到的词不在音素表内，
   * 无从判断发音），不是学生读错 —— 判 fail 是冤枉，判 na 是放弃反馈。
   * borderline 至少还承认"听到了这个词，只是没判断准"。
   * 配套文案见 suggestMap 的 lettersOnly 分支：**如实交代是识别没听准**，
   * 否则学生会以为是自己读得不好，反复练一个已经会读的词。
   *
   * ## 为什么判据用 via 而不是分数
   * 分数是连续的、随 ASR 输出浮动；via 是**离散的判据**（听到的词在不在音素表），
   * 可以用门禁机械断言。靠阈值把关则每次 ASR 换服务商都要重调。
   */
  if (via === 'letters' && band === 'pass') {
    band = 'borderline';
    // reason 沿用现有取值集合，**不新增 'letters_only'**：
    // 实测 reason 既不落盘（saveRecord 只存 date/band/score/heard/ms），
    // 也不被 analysis.js 读 —— 加一个没人读的字段就是死代码。
    // 「letters 路径占比」这个统计需求应该走门禁实测，不该靠运行时留痕。
    reason = 'unclear';
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

  /**
   * letters 路径专属文案：只有「因工具能力不足而降档」时用。
   *
   * 为什么必须和普通 borderline 分开：普通 borderline 的成因是**发音接近但不确定**
   * （真的读得不准），提示「慢一点、把每个音节读清楚」是对的；
   * 而 letters 分支的成因是「ASR 听到的词不在音素表内，无从判断」——
   * 同一个词，学生可能读得完全正确（ASR 转写误差），也可能读错（真的没读对），
   * **文本层无法区分**（两种情形的输入完全一样，见上方注释）。
   * 对一个实际读对了的学生说「慢一点」是误导，会让他反复练一个已经会读的词。
   * 所以这里如实交代工具边界，把"是不是没读准"这件事还给语音本身去判断。
   */
  const suggest = (via === 'letters' && band === 'borderline')
    ? '这次没能听准，没法判断你的读音 —— 跟标准发音比一比再读一次吧'
    : suggestMap[band];

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
    suggestion: suggest,
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
