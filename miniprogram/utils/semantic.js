/**
 * 端侧语义检索通道（可选增强，全程降级安全）
 *
 * ## 它解决什么
 * utils/rag.js 现有的字符串/音素通道擅长「词形」相似（哪些词长得像 apple），
 * 但对「学校用品有哪些词」这类**语义**查询无能为力。
 * 本模块补上语义通道。
 *
 * ## 为什么所有资源都在本地文件系统，而不是随包
 * 主包静态体积已到 2002 KB / 2048 KB（98%），只剩 46 KB。
 * 光词表就要 107 KB —— 放不下。所以除本文件外，**全部资源走 USER_DATA_PATH**。
 *
 * ## 需要放进 USER_DATA_PATH 的四样东西
 *   semantic/vocab.txt          ~107 KB   词表（按 id 排序，一行一个 token）
 *   semantic/vectors.bin        ~148 KB   语料向量（int8，L2 归一化）
 *   semantic/index.json         ~32 KB    与 vectors.bin 行序严格一致
 *   semantic/bge-small-zh.onnx  45.3 MB   embedding 模型（fp16）
 * 2026-10-17 起语料是 wy7s_2024 专属 295 词（tools/build-semantic-295.js 抽行重组，
 * 主题命中 72%→94%，docs/语义检索-判定校准.md §9）；重建/上传见
 * tools/build-semantic-295.js 与 tools/upload-semantic-cloud.py。
 *
 * ## 降级契约（这是本模块最重要的设计）
 * 四样东西**任何一样缺失**，本通道就静默关闭：
 *   · isReady() 返回 false
 *   · search() 返回空数组，不抛错
 * 既有通道完全不受影响。这样即使模型没下载、下载失败、或用户清了缓存，
 * 问词页也只是少一路召回，不会报错、不会白屏。
 *
 * ## 用法
 * 在小程序页面或 utils 里引入本模块（按所在目录算相对路径），然后：
 *   sem.init();                       // 异步，可重复调用
 *   if (sem.isReady()) {
 *     sem.search('学校用品有哪些词', 5).then(function (hits) {
 *       // → [{ item: {word, meaning, unit}, score, rank }]
 *     });
 *   }
 *
 * 注意：本文件的注释里**不写 require(...) 字面量**。
 * tools/verify-package.js 的「require 路径可解析」检查是文本扫描、不剥注释，
 * 注释里出现 require 字面量会被误报成坏引用（这是该门禁的一个已知弱点）。
 */

const DIR = 'semantic';                 // USER_DATA_PATH 下的子目录
const FILES = {
  vocab: DIR + '/vocab.txt',
  vectors: DIR + '/vectors.bin',
  index: DIR + '/index.json',
  model: DIR + '/bge-small-zh.onnx'
};
const DIM = 512;
const SEQ_LEN = 32;
const PREFIX = '为这个句子生成表示以用于检索相关文章：';   // bge 的检索指令，只加在查询侧

/**
 * 默认最低余弦分。0.30 是按实测分布来的，不是拍脑袋：
 * 2026-09-30 在「全 2768 词表 + allowlist 过滤」上标定；2026-10-17 换
 * wy7s_2024 专属 295 词索引后复测，「学校用品」类查询 top-1 约 0.45~0.55，
 * 同主题词 ≥ 0.32，OOV 查询（量子力学/微积分）top-1 ≤ 0.18 —— 0.30 依旧
 * 把两类分开，且 0.45 档主题命中从 17/18 掉到 10/18，更紧不更好。
 * 不要为「多召回几个」调到 0.20：负样本 top-3 会开始出现无关词。
 */
const DEFAULT_MIN_SCORE = 0.30;

let fs = null;          // FileSystemManager
let root = '';          // USER_DATA_PATH
let ready = false;
let reason = 'not-initialized';
let session = null;
let tokenizer = null;
let searcher = null;
let index = null;
let initializing = false;
/**
 * 初始化期间的等待队列。
 * 为什么需要：init 是异步的（session.onLoad 才回调），而页面可能在
 * onShow 里调一次、用户输入时又调一次。若不排队，第二次调用会被直接拒绝，
 * 那次检索就静默丢了 —— 表现为「第一次问词没有语义召回，第二次才有」。
 */
let waiters = [];

/** 把一行行 token 还原成 {token: id} */
function buildVocab(text) {
  const lines = text.split('\n');
  const vocab = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (t) vocab[t] = i;
  }
  return vocab;
}

function abs(p) { return root + '/' + p; }

/** 只读探测：文件在不在、体积对不对 */
function probe() {
  const out = {};
  Object.keys(FILES).forEach(function (k) {
    try {
      const st = fs.statSync(abs(FILES[k]));
      out[k] = st && st.size ? st.size : 0;
    } catch (e) {
      out[k] = 0;
    }
  });
  return out;
}

/** 加载词表 + 向量 + 索引（同步，纯读文件） */
function loadAssets() {
  const vocabText = fs.readFileSync(abs(FILES.vocab), 'utf8');
  const vocab = buildVocab(vocabText);
  if (!vocab['[CLS]']) throw new Error('vocab.txt 不像 BERT 词表（缺 [CLS]）');

  const tokenizerMod = require('./bert-tokenizer.js');
  tokenizer = tokenizerMod.createTokenizer(vocab, {
    maxLength: SEQ_LEN,
    lowercase: false,            // bge-small-zh 的 normalizer 是 lowercase:false
    handleChineseChars: true
  });

  index = JSON.parse(fs.readFileSync(abs(FILES.index), 'utf8'));
  const bin = fs.readFileSync(abs(FILES.vectors));

  const searcherMod = require('./vector-search.js');
  searcher = searcherMod.createSearcher(bin, index, DIM);

  if (searcher.count !== index.length) throw new Error('向量数与索引数不一致');
}

/** 创建推理 session（异步，靠 onLoad 回调） */
function loadModel(cb) {
  if (typeof wx === 'undefined' || typeof wx.createInferenceSession !== 'function') {
    cb('no-inference-api');      // 基础库 < 2.30.0
    return;
  }
  try {
    session = wx.createInferenceSession({
      model: abs(FILES.model),
      precisionLevel: 0,           // 最低精度档：fp16 计算，最快
      allowQuantize: true,         // 让引擎内部量化（磁盘上仍是 fp16）
      allowNPU: false
    });
  } catch (e) {
    cb('create-failed: ' + (e && e.message));
    return;
  }
  session.onError(function (err) {
    cb('session-error: ' + JSON.stringify(err));
  });
  session.onLoad(function () {
    cb(null);
  });
}

/**
 * 初始化。可重复调用、可并发调用。
 * @param {Function} [cb] cb(err) —— err 为 null 表示就绪
 */
function init(cb) {
  // 已就绪：直接回调
  if (ready) { if (cb) cb(null); return; }
  // 正在初始化：排队等结果，不重复建 session
  if (initializing) { if (cb) waiters.push(cb); return; }

  // ★ 先看开关。关着就永远不就绪 —— 这样 ask.js 里的调用无需各自判断。
  //   为什么放在模块内而不是调用方：设置只有一个权威来源（utils/settings.js），
  //   判定逻辑散在调用方迟早会有一个人忘掉。
  //   reason 同步置为 disabled：否则 status().reason 会停在 'not-initialized'，
  //   设置页/诊断读到的是一句和真实原因无关的旧话。
  try {
    const settingsMod = require('./settings.js');
    if (!settingsMod.get('localModel')) {
      reason = 'disabled';
      if (cb) cb(new Error('disabled'));
      return;
    }
  } catch (e) { /* settings 读不到按关闭处理（保守） */
    reason = 'disabled';
    if (cb) cb(new Error('disabled'));
    return;
  }

  initializing = true;
  if (cb) waiters.push(cb);

  function finish(err) {
    initializing = false;
    const list = waiters; waiters = [];
    list.forEach(function (fn) { try { fn(err); } catch (e) { /* 调用方异常不该影响其它等待者 */ } });
  }

  try {
    if (typeof wx === 'undefined' || !wx.getFileSystemManager) {
      throw new Error('no-fs');
    }
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;

    const sizes = probe();
    const missing = Object.keys(sizes).filter(function (k) { return !sizes[k]; });
    if (missing.length) {
      throw new Error('资源缺失: ' + missing.join(','));
    }

    loadAssets();
    loadModel(function (err) {
      if (err) { ready = false; reason = err; finish(new Error(err)); return; }
      ready = true;
      reason = 'ok';
      finish(null);
    });
  } catch (e) {
    ready = false;
    reason = (e && e.message) || String(e);
    finish(e);
  }
}

/*----------------------------- 推理 -----------------------------*/

function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * 把一组非负小整数编成 int64 的 little-endian 字节流。
 *
 * 为什么不能直接传 Int32Array：引擎按 `type: 'int64'` 解读 `data`，
 * 即**每 8 字节一个元素**。传 4 字节/元素的 buffer 会让它读到错位的垃圾值。
 * 而小程序环境**没有 BigInt64Array**，所以只能手工拼。
 *
 * 这里的取值范围是安全的：BERT 的 token id 最大 21127、attention_mask 只 0/1，
 * 都远小于 2^31，所以低 4 字节存值、高 4 字节补 0 即可。
 */
function toInt64Buffer(arr) {
  const n = arr.length;
  const bytes = new Uint8Array(n * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    // little-endian 写入：低 32 位放值，高 32 位为 0（值恒非负）
    view.setUint32(i * 8, arr[i] >>> 0, true);
    view.setUint32(i * 8 + 4, 0, true);
  }
  return bytes.buffer;
}

/** 查询文本 → 归一化向量（Promise） */
function embed(text) {
  return new Promise(function (resolve, reject) {
    if (!session || !tokenizer) { reject(new Error('not-ready')); return; }
    const e = tokenizer.encode(PREFIX + text, SEQ_LEN);

    const ids = new Int32Array(SEQ_LEN);
    const mask = new Int32Array(SEQ_LEN);
    const tti = new Int32Array(SEQ_LEN);
    for (let i = 0; i < SEQ_LEN; i++) {
      ids[i] = e.input_ids[i];
      mask[i] = e.attention_mask[i];
      tti[i] = e.token_type_ids[i];
    }

    let p;
    try {
      p = session.run({
        input_ids: { shape: [1, SEQ_LEN], type: 'int64', data: toInt64Buffer(ids) },
        attention_mask: { shape: [1, SEQ_LEN], type: 'int64', data: toInt64Buffer(mask) },
        token_type_ids: { shape: [1, SEQ_LEN], type: 'int64', data: toInt64Buffer(tti) }
      });
    } catch (err) { reject(err); return; }

    Promise.resolve(p).then(function (res) {
      const out = res.last_hidden_state;
      if (!out || !out.data) { reject(new Error('输出张量缺失')); return; }
      const d = new Float32Array(out.data);
      // CLS 池化：取第 0 个 token 的 512 维
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = d[i];
      resolve(l2(v));
    }).catch(reject);
  });
}

/**
 * 语义检索。
 * @returns {Promise<Array<{item, score, rank}>>} 未就绪时返回空数组（不抛错）
 *
 * 注意：`threshold` 默认走 searchWithOptions 的 default，不要在调用方再叠一层固定值
 * —— 硬编码的 0.35 是按「全 2768 词表」拍脑袋的，对过滤后的 295 词偏松
 * （见 docs/语义检索-判定校准.md 的阈值转向表）。
 */
function search(query, topK) {
  return searchWithOptions(query, topK, {});
}

/**
 * 带选项的语义检索。
 *
 * @param {string} query
 * @param {number} [topK]
 * @param {Object} [opts]
 *   @param {number}   [opts.minScore]  低于此分数的命中丢弃。不传用 DEFAULT_MIN_SCORE。
 *   @param {Set<string>|Array<string>} [opts.allowlist]
 *       **全词表过滤**：命中项的 item.word 必须在集合里（小写比较）才返回，否则丢弃。
 *       历史（2026-09-30）：语义库曾是全 2768 词（19 套教材），不过滤会把其它教材的
 *       同词塞给只学 wy7s_2024 的学生 —— 「识别不准」的主因，当时靠调用方传
 *       cards.allCards() 的小写集合兜住。2026-10-17 起语料本身就是 wy7s_2024
 *       专属 295 词，allowlist 变成恒真的安全网：合约保留（未来若换教材/扩词表，
 *       重建索引前它仍是唯一的正确性防线），只是当前不再过滤掉任何东西。
 * @returns {Promise<Array<{item, score, rank}>>} 未就绪 / 空查询 / 全过滤完 都返回空数组
 */
function searchWithOptions(query, topK, opts) {
  if (!ready) return Promise.resolve([]);
  if (!query || !String(query).trim()) return Promise.resolve([]);
  const o = opts || {};
  const floor = (typeof o.minScore === 'number') ? o.minScore : DEFAULT_MIN_SCORE;
  const allow = o.allowlist
    ? (o.allowlist instanceof Set ? o.allowlist : new Set(
        Array.from(o.allowlist).map(function (w) { return String(w).toLowerCase(); })
      ))
    : null;

  return embed(String(query)).then(function (vec) {
    // 多捞一些再过滤 —— 词表过滤会砍掉大量命中，按 1:1 取 topK 容易拿到 < topK 条
    const preK = allow ? Math.max(topK * 4, topK * 2) : topK;
    const raw = searcher.search(vec, preK || 5, floor);
    if (!allow) return raw.slice(0, topK || 5);
    const filtered = [];
    for (let i = 0; i < raw.length && filtered.length < (topK || 5); i++) {
      const w = raw[i].item && String(raw[i].item.word).toLowerCase();
      if (w && allow.has(w)) filtered.push(raw[i]);
    }
    // 重新编号 rank，让下游拿到连续的 1..N
    filtered.forEach(function (f, i) { f.rank = i + 1; });
    return filtered;
  }).catch(function (err) {
    // 单次失败不影响通道状态，也不打扰用户
    if (typeof console !== 'undefined') console.warn('[semantic] 检索失败', err);
    return [];
  });
}

/** 诊断信息，供设置页/调试用 */
function status() {
  let enabled = false;
  try { enabled = !!require('./settings.js').get('localModel'); } catch (e) { enabled = false; }
  let sizes = null;
  if (fs && root) { try { sizes = probe(); } catch (e) { sizes = null; } }
  return {
    ready: ready,
    enabled: enabled,
    reason: reason,
    assets: sizes,
    vectors: searcher ? searcher.count : 0,
    dim: DIM
  };
}

/** 释放 session（切页或内存紧张时调） */
function release() {
  if (session && session.destroy) { try { session.destroy(); } catch (e) { /* ignore */ } }
  session = null; ready = false; reason = 'released';
}

module.exports = {
  init: init, search: search, searchWithOptions: searchWithOptions,
  isReady: function () { return ready; },
  status: status, release: release,
  PATHS: FILES, DIR: DIR, DEFAULT_MIN_SCORE: DEFAULT_MIN_SCORE
};
