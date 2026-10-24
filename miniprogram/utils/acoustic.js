/**
 * 端上声学判定 —— 录音 → MFCC → VTLN-DTW → 判定，**全程在手机上，零网络零额度**。
 *
 * ## 它解决什么问题
 * 原先每次朗读评测都要把录音送到云端 ASR 换成文字，既耗额度又要联网。
 * 本模块把这一步搬到端上：闭集 294 词的模板匹配，判定耗时约 20~60ms。
 *
 * ## 与 pron-judge.js 的分工（两条独立通道，别混）
 *   pron-judge.js：输入**识别出的文字**，按音素比对。需要先有 ASR 结果。
 *   本模块：输入**原始 PCM 采样**，直接与模板比。不需要 ASR，也就不需要额度。
 * 两者返回同一种结果结构，所以都能交给 pronounce 页的 applyResult() 渲染。
 *
 * ## 为什么阈值不可由用户调
 * 判定线（`ratio = 1`）来自 294 词 × 6 类扰动的实测标定，改它需要重跑
 * out/_asr_probe/calibrate.py。设置页的 passScore / borderlineScore 只影响
 * **分数显示**（见 scoreOf），不影响判定档位 —— 否则用户把滑块一拖，
 * 标定结论就被静默作废了。
 *
 * ## 静默失效的防线
 * 这套代码的失效模式都不抛异常：
 *   · 采样率不是 16k → 特征空间与模板不一致 → 全判错；
 *   · 模板被截断 → DTW 拿到半个序列 → 全判错；
 *   · 音频格式没解析对 → 采样值全是噪声 → 全判错。
 * 所以下面每一处都**显式校验并降级**，宁可回一句"这次没评上"，
 * 也不给一个看起来正常、实际全错的分数。
 */

const mfcc = require('./mfcc.js');
const dtwMod = require('./dtw.js');
const pack = require('./asr-pack.js');
/** 词表/索引/阈值随包（asr-templates-meta.js，生成物）。
 *  为什么不从磁盘读 json：meta 与 bin 必须同批生成，分开下载/存放就可能出现
 *  半新半旧的组合 —— 索引错位会让判定全错且不报错。随包保证永远同批。 */
const META = require('./asr-templates-meta.js');

/** 模板建立时的采样率。查询侧必须一致，否则频谱轴整体错位。 */
const TEMPLATE_SR = 16000;

/** 有效语音的最少帧数（10ms/帧）。低于此值判为「没听到声音」。 */
const MIN_SPEECH_FRAMES = 10;

let cache = null;          // { tpl } —— 解析一次后常驻
let lastLoadError = '';

/*------------------------- 资源加载 -------------------------*/

function fsApi() {
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return null;
  try { return wx.getFileSystemManager(); } catch (e) { return null; }
}

function pathOf(name) {
  return wx.env.USER_DATA_PATH + '/' + pack.DIR + '/' + name;
}

/**
 * 资源是否就绪（bin 在且字节数达标；meta 随包，不再依赖磁盘）。
 *
 * ⚠️ 这里**刻意不查 `pack.isConfigured()`**（fileID 是否回填）。
 * 原因：fileID 只在**下载**时才需要。资源已经躺在 USER_DATA_PATH 里时
 * （云存储下过、或本地预置过），通道就该可用 —— 要求 fileID 非空会把
 * "文件明明在却一直走云端"这种静默失效引入进来，而且本地开发根本没法测。
 * fileID 的检查留在 asr-pack.download() 里，那才是它该管的地方。
 */
function available() {
  try {
    return pack.status().complete === true;
  } catch (e) { return false; }
}

/**
 * 读模板并缓存。meta 来自随包模块，bin 来自 USER_DATA_PATH/asr/。
 *
 * 失败一律返回 null（不抛）——调用方据此降级到云端通道。
 * @returns {Object|null} 模板对象，可直接交给 dtw.js
 */
function load() {
  if (cache) return cache.tpl;

  const fs = fsApi();
  if (!fs) { lastLoadError = 'no-fs'; return null; }
  if (!available()) { lastLoadError = 'not-ready'; return null; }

  let bin;
  try {
    const ab = fs.readFileSync(pathOf('asr-templates.bin'));
    bin = ab instanceof ArrayBuffer ? new Int8Array(ab) : new Int8Array(ab.buffer || ab);
  } catch (e) {
    lastLoadError = 'bad-bin';
    return null;
  }

  // 结构自检：字段缺失或长度对不上，说明生成物坏了或 bin 与 meta 不是同一批。
  // 这里必须**拒绝**而不是尽力而为 —— 半个模板会让判定全错且毫无提示。
  const meta = META;
  if (!meta || !meta.words || !meta.index || !meta.alphas || !meta.dim) {
    lastLoadError = 'meta-incomplete';
    return null;
  }
  const needFrames = meta.index.reduce(function (a, x) { return a + (x.frames || 0); }, 0);
  // 严格相等而不是只查下限：bin 的字节必须与 meta 声明的帧数×维度**恰好**一致。
  // 只查下限的话，"bin 换了批次（帧数变了）而 meta 还是旧的"只要新文件更长就
  // 能混过去 —— 索引错位、判定全错且不报错。生成器产出的 bin 恰好就是
  // needFrames×dim 字节（int8），没有合法的"更大"情形。
  if (bin.length !== needFrames * meta.dim) {
    lastLoadError = bin.length < needFrames * meta.dim
      ? 'bin-truncated:' + bin.length + '<' + (needFrames * meta.dim)
      : 'bin-mismatch:' + bin.length + '!=' + (needFrames * meta.dim);
    return null;
  }
  if (meta.thresholds && meta.thresholds.length !== meta.words.length) {
    lastLoadError = 'thresholds-mismatch';
    return null;
  }

  const tpl = {
    dim: meta.dim,
    alphas: meta.alphas,
    quantScale: meta.quantScale || 4.0,
    words: meta.words,
    index: meta.index,
    thresholds: meta.thresholds,
    flat: bin
  };
  cache = { tpl: tpl };
  lastLoadError = '';
  return tpl;
}

/** 清缓存（设置页清空资源后调用，否则会继续用内存里的旧模板） */
function clearCache() { cache = null; }

/** 上次加载失败的原因（排查用，不展示给用户） */
function lastError() { return lastLoadError; }

/*------------------------- 判定 -------------------------*/

/** 把距离比映射成 0~1 的分数，锚点取自用户设置的及格线，保证与档位不矛盾。 */
function scoreOf(ratio, passScore, borderScore) {
  if (!isFinite(ratio) || ratio <= 0) return 1;
  if (ratio <= 1) return 1 - (1 - passScore) * ratio;
  if (ratio <= 1.35) return passScore - (passScore - borderScore) * (ratio - 1) / 0.35;
  if (ratio <= 2) return borderScore * (2 - ratio) / 0.65;
  return 0;
}

const VERDICT = {
  pass: '读得不错',
  borderline: '再试一次',
  fail: '这个词有点难'
};
const SUGGEST = {
  pass: '',
  borderline: '听上去接近了，慢一点、把每个音节读清楚',
  fail: '点下面的喇叭听标准发音，跟着读一遍'
};

function grayResult(reason, verdict, suggestion) {
  return {
    ok: false, band: 'gray', score: 0, scorePct: 0,
    reason: reason, via: 'ondevice-acoustic',
    detail: '', verdict: verdict, suggestion: suggestion, heard: ''
  };
}

/**
 * 用原始采样做端上判定。
 *
 * @param {string} expected 期望词（须在模板词表内）
 * @param {Float64Array|Array} samples 单声道采样，取值约 [-1,1]
 * @param {number} sampleRate 采样率；**必须是 16000**
 * @param {Object} [opt]
 *   @param {number} [opt.passScore=0.84]      仅影响分数显示
 *   @param {number} [opt.borderlineScore=0.68] 仅影响分数显示
 * @returns {Object} 与 pron-judge.js 同构的结果对象
 */
function judge(expected, samples, sampleRate, opt) {
  opt = opt || {};
  const passScore = opt.passScore === undefined ? 0.84 : opt.passScore;
  const borderScore = opt.borderlineScore === undefined ? 0.68 : opt.borderlineScore;

  // ① 采样率必须与模板一致。不一致时**不能**凑合算 ——
  //    频谱轴会整体错位，DTW 距离看起来正常但判定全错。
  if (sampleRate !== TEMPLATE_SR) {
    return grayResult('bad-samplerate:' + sampleRate, '这次没评上',
      '录音采样率不对，换一台设备再试');
  }

  const tpl = load();
  if (!tpl) {
    return grayResult('no-template-pack', '这次没评上',
      '端上发音包还没准备好，联网后再试');
  }

  // ② 期望词必须真有模板。没有就别硬算 —— 硬算只会给一个无意义的分数。
  if (tpl.words.indexOf(expected) < 0) {
    return grayResult('word-not-in-pack', '这次没评上',
      '这个词不在端上词库里，联网评测更准');
  }

  // ③ 特征提取
  let feat;
  try {
    feat = mfcc.extract(samples, { doVad: true, cmn: true, cmvn: true });
  } catch (e) {
    return grayResult('mfcc-failed', '这次没评上', '按住按钮再读一次');
  }
  if (!feat || !feat.frames) {
    return grayResult('empty-features', '这次没评上', '按住按钮再读一次');
  }
  if (feat.frames < MIN_SPEECH_FRAMES) {
    // 太短 = 基本没说话。如实说"没听到声音"，而不是判"读错了"。
    return {
      ok: false, band: 'borderline', score: 0, scorePct: 0,
      reason: 'no_speech', via: 'ondevice-acoustic', detail: '没听到声音',
      verdict: '没听清',
      suggestion: '再读一次，靠近手机一点，把整个单词读完',
      heard: ''
    };
  }

  // ④ VTLN-DTW 判定（对 5 档 α 取最小距离）
  let r;
  try {
    r = dtwMod.judge(tpl, feat.mfcc, expected, {});
  } catch (e) {
    return grayResult('dtw-failed', '这次没评上', '按住按钮再读一次');
  }
  if (!r || r.band === 'no-template') {
    return grayResult('no-template', '这次没评上', '联网评测更准');
  }

  const score = Math.max(0, Math.min(1, scoreOf(r.ratio, passScore, borderScore)));
  return {
    ok: r.band === 'pass',
    band: r.band,
    score: Math.round(score * 1000) / 1000,
    scorePct: Math.round(score * 100),
    reason: r.band === 'pass' ? 'acceptable' : (r.band === 'borderline' ? 'unclear' : 'mismatch'),
    via: 'ondevice-acoustic',
    // 端上路径拿不到"听成了什么"，如实说明判据，别编一个词出来
    detail: '端上比对（距离 ' + r.dist.toFixed(2) + ' / 线 ' + r.threshold.toFixed(2) +
            ' · α=' + r.alpha + '）',
    verdict: VERDICT[r.band],
    suggestion: SUGGEST[r.band],
    heard: ''
  };
}

module.exports = {
  TEMPLATE_SR: TEMPLATE_SR,
  MIN_SPEECH_FRAMES: MIN_SPEECH_FRAMES,
  available: available,
  load: load,
  judge: judge,
  clearCache: clearCache,
  lastError: lastError
};
