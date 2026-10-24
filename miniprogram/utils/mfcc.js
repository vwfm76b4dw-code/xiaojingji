/**
 * 端上 MFCC 特征提取 —— 纯 JS，零依赖，跑在手机上。
 *
 * ## 它在这条链路里的位置
 *   录音 PCM → **本模块提特征** → dtw.js 与模板比对 → 判定
 * 全程不联网、不消耗任何额度，这是「把语音识别搬回端上」的第一步。
 *
 * ## 为什么不用通用 ASR 模型
 * 主包只剩几十 KB，而 Whisper-tiny int8 就要 39 MB（详见 README「包体积」）。
 * 但本项目有个别人没有的强约束：**295 个词是闭集，评测时永远知道期望词**。
 * 于是问题从「转写成任意文字」退化成「这段录音像不像 X 词」——
 * 孤立词识别，MFCC + DTW 就够了，零模型文件。
 *
 * ## 参数必须与 tools/ 下的 Python 参考实现逐值一致
 *   tools/asr-dtw/mfcc_dtw.py 是基准，本文件是它的 JS 移植。
 *   两者算出的特征若不一致，模板（离线用 Python 算）与查询（端上用 JS 算）
 *   就落在不同的特征空间里，距离尺度全错。改动任何常量都要重跑差分对照。
 *
 * ## 实测依据（2026-09-24，out/_asr_probe/）
 *   13 维 MFCC + CMN 对 ±25% 的声道长度差异不可分（平衡准确率 66-88%）；
 *   降到 8 维并加 CMVN 后配合模板侧 α 搜索，四类扰动全部达到 100%。
 *   所以这里固定 n_mfcc=8，且**不加 delta**（加了没有额外收益，白费算力）。
 */

const SR = 16000;          // 录音采样率，与 RecorderManager 的 sampleRate 一致
const FRAME = 400;         // 25ms 窗
const HOP = 160;           // 10ms 移
const N_FFT = 512;
const N_MELS = 26;
const N_MFCC = 8;          // 见文件头：13 维在跨说话人上反而更差
const PREEMPH = 0.97;
const FMIN = 20;
const FMAX = 8000;         // = SR/2
const LOG_FLOOR = 1e-10;

const N_BINS = N_FFT / 2 + 1;

/*-------------------------- 预计算常量 --------------------------*/

/** 汉明窗。periodic（0.54-0.46cos(2πn/N)），与 scipy get_window('hamming',N) 一致 */
const WINDOW = (function () {
  const w = new Float64Array(FRAME);
  for (let n = 0; n < FRAME; n++) {
    w[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / FRAME);
  }
  return w;
})();

/** 旋转因子表：TW[k] = exp(-2πi k / N_FFT)，第 len 级按 N_FFT/len 步长取 */
const TW_RE = new Float64Array(N_FFT / 2);
const TW_IM = new Float64Array(N_FFT / 2);
(function () {
  for (let k = 0; k < N_FFT / 2; k++) {
    const a = -2 * Math.PI * k / N_FFT;
    TW_RE[k] = Math.cos(a);
    TW_IM[k] = Math.sin(a);
  }
})();

/** 梅尔三角滤波器组，N_MELS × N_BINS */
const MEL_FB = (function () {
  const hz2mel = f => 2595 * Math.log10(1 + f / 700);
  const mel2hz = m => 700 * (Math.pow(10, m / 2595) - 1);
  const m0 = hz2mel(FMIN), m1 = hz2mel(FMAX);
  const bins = new Int32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    const hz = mel2hz(m0 + (m1 - m0) * i / (N_MELS + 1));
    bins[i] = Math.floor((N_FFT + 1) * hz / SR);
  }
  const fb = new Float64Array(N_MELS * N_BINS);
  for (let i = 0; i < N_MELS; i++) {
    let l = bins[i], c = bins[i + 1], r = bins[i + 2];
    if (c <= l) c = l + 1;
    if (r <= c) r = c + 1;
    for (let k = l; k < c && k < N_BINS; k++) fb[i * N_BINS + k] = (k - l) / (c - l);
    for (let k = c; k < r && k < N_BINS; k++) fb[i * N_BINS + k] = (r - k) / (r - c);
  }
  return fb;
})();

/** DCT-II ortho 矩阵，只算 k=1..N_MFCC（k=0 被丢弃） */
const DCT_M = (function () {
  const m = new Float64Array(N_MFCC * N_MELS);
  for (let k = 1; k <= N_MFCC; k++) {
    const scale = 2 * Math.sqrt(1 / (2 * N_MELS));
    for (let n = 0; n < N_MELS; n++) {
      m[(k - 1) * N_MELS + n] = scale * Math.cos(Math.PI * k * (2 * n + 1) / (2 * N_MELS));
    }
  }
  return m;
})();

/*-------------------------- 基元 --------------------------*/

/** 原地基 2 FFT（输入实数填在 re，im 全 0） */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = TW_RE[k * step], wi = TW_IM[k * step];
        const a = i + k, b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
      }
    }
  }
}

/**
 * 能量端点检测：裁掉首尾静音。
 *
 * 为什么必须做：DTW 逐帧比对，干净模板的首尾是低能量谱、带噪录音的首尾是噪声谱，
 * 差异被全额计入路径代价。实测不做 VAD 时加噪样本的平衡准确率从 100% 掉到 45%。
 *
 * @param {Float32Array|Float64Array} x 单声道波形
 * @param {Object} [opt] rel=0.06 阈值比例 / pad=3 前后余量帧 / minKeep=6 最少保留帧
 * @returns {{data: Float64Array, from: number, to: number}} 裁剪结果
 */
function vad(x, opt) {
  opt = opt || {};
  const rel = opt.rel === undefined ? 0.06 : opt.rel;
  const pad = opt.pad === undefined ? 3 : opt.pad;
  const minKeep = opt.minKeep === undefined ? 6 : opt.minKeep;

  const n = x.length;
  if (n < FRAME) return { data: new Float64Array(x), from: 0, to: n };

  const nFrames = 1 + Math.floor((n - FRAME) / HOP);
  const rms = new Float64Array(nFrames);
  let peak = 0;
  for (let t = 0; t < nFrames; t++) {
    let s = 0;
    const off = t * HOP;
    for (let i = 0; i < FRAME; i++) {
      const v = x[off + i];
      s += v * v;
    }
    rms[t] = Math.sqrt(s / FRAME + 1e-12);
    if (rms[t] > peak) peak = rms[t];
  }

  const thr = peak * rel;
  let first = -1, last = -1;
  for (let t = 0; t < nFrames; t++) {
    if (rms[t] >= thr) { if (first < 0) first = t; last = t; }
  }
  if (first < 0 || (last - first + 1) < minKeep) {
    return { data: new Float64Array(x), from: 0, to: n };
  }

  const a = Math.max(0, first - pad);
  const b = Math.min(nFrames, last + 1 + pad);
  const from = a * HOP;
  const to = Math.min(n, b * HOP + FRAME);
  return { data: new Float64Array(x.slice(from, to)), from: from, to: to };
}

/*-------------------------- 主入口 --------------------------*/

/**
 * 提取 MFCC（含 VAD / CMN / CMVN）。
 *
 * @param {Float32Array|Float64Array|number[]} samples 16kHz 单声道 PCM
 * @param {Object} [opt]
 *   @param {boolean} [opt.doVad=true]   是否先做端点检测
 *   @param {boolean} [opt.cmn=true]     倒谱均值归一化
 *   @param {boolean} [opt.cmvn=true]    再除以每维标准差
 * @returns {{frames: number, dim: number, mfcc: Float64Array}} 行主序，长度 frames*dim
 */
function extract(samples, opt) {
  opt = opt || {};
  const doVad = opt.doVad !== false;
  const cmn = opt.cmn !== false;
  const cmvn = opt.cmvn !== false;

  let x;
  if (doVad) {
    x = vad(samples).data;
  } else {
    x = samples instanceof Float64Array ? samples : new Float64Array(samples);
  }

  // 预加重：首样本保持原值，避免人为尖峰
  const pre = new Float64Array(x.length);
  pre[0] = x[0] || 0;
  for (let i = 1; i < x.length; i++) pre[i] = x[i] - PREEMPH * x[i - 1];

  let nFrames = 1 + Math.floor((pre.length - FRAME) / HOP);
  if (nFrames < 1) nFrames = 1;

  const mfcc = new Float64Array(nFrames * N_MFCC);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const off = t * HOP;
    // 加窗 + 补零到 N_FFT
    for (let i = 0; i < N_FFT; i++) {
      const idx = off + i;
      re[i] = (idx < pre.length && i < FRAME) ? pre[idx] * WINDOW[i] : 0;
      im[i] = 0;
    }
    fft(re, im);

    // 功率谱
    const power = new Float64Array(N_BINS);
    for (let k = 0; k < N_BINS; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }

    // 梅尔滤波 + log
    const logmel = new Float64Array(N_MELS);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const base = m * N_BINS;
      for (let k = 0; k < N_BINS; k++) {
        const w = MEL_FB[base + k];
        if (w !== 0) s += w * power[k];
      }
      logmel[m] = Math.log(s > LOG_FLOOR ? s : LOG_FLOOR);
    }

    // DCT（取 k=1..N_MFCC）
    for (let k = 0; k < N_MFCC; k++) {
      let s = 0;
      const base = k * N_MELS;
      for (let n = 0; n < N_MELS; n++) s += DCT_M[base + n] * logmel[n];
      mfcc[t * N_MFCC + k] = s;
    }
  }

  // CMN / CMVN：逐维去均值（跨说话人最关键的一步）
  if (cmn || cmvn) {
    for (let k = 0; k < N_MFCC; k++) {
      let mu = 0;
      for (let t = 0; t < nFrames; t++) mu += mfcc[t * N_MFCC + k];
      mu /= nFrames;
      for (let t = 0; t < nFrames; t++) mfcc[t * N_MFCC + k] -= mu;
      if (cmvn) {
        let sd = 0;
        for (let t = 0; t < nFrames; t++) {
          const v = mfcc[t * N_MFCC + k];
          sd += v * v;
        }
        sd = Math.sqrt(sd / nFrames) + 1e-8;
        for (let t = 0; t < nFrames; t++) mfcc[t * N_MFCC + k] /= sd;
      }
    }
  }

  return { frames: nFrames, dim: N_MFCC, mfcc: mfcc };
}

module.exports = {
  extract: extract,
  vad: vad,
  SR: SR, FRAME: FRAME, HOP: HOP, N_FFT: N_FFT,
  N_MELS: N_MELS, N_MFCC: N_MFCC,
  PREEMPH: PREEMPH, FMIN: FMIN, FMAX: FMAX,
  WINDOW: WINDOW, MEL_FB: MEL_FB, DCT_M: DCT_M
};
