/**
 * 端上 DTW 判定 —— 闭集模板匹配（纯 JS，零依赖）。
 *
 * ## 它替代了什么
 * 原方案每次朗读评测都要把录音送到云端 ASR 换文字（消耗额度、需要联网）。
 * 本模块把这一步搬到手机上：录音 → MFCC → 与 295 词模板比对 → 判定。
 * **零额度、零网络、离线可用。**
 *
 * ## 为什么是 DTW 而不是神经网络
 * 见 utils/mfcc.js 文件头：295 词是闭集，期望词已知，问题退化成孤立词识别。
 *
 * ## VTLN：本方案能成立的关键
 * 模板是成年播音员的录音，用户是初中生 —— 声道长度差可达 25%，
 * 表现为频谱整体缩放。实测（out/_asr_probe/）：
 *   13 维 MFCC + CMN，±25% 缩放时同词/异词距离完全重叠（平衡准确率 66-88%）；
 *   降到 8 维 + CMVN，并让模板侧带一组缩放副本（α 搜索），四类扰动全部 100%。
 * 所以模板侧**预计算 5 档 α**，查询时取 min —— 代价是模板体积 ×5，
 * 换掉的是「跨说话人直接不可用」这个致命缺陷。
 *
 * ## 模板数据结构（由 tools/build-asr-templates.py 产出）
 *   {
 *     dim: 8,
 *     alphas: [0.8, 0.9, 1.0, 1.1, 1.2],
 *     quantScale: 4.0,               // int8 量化：±4σ 映射到 ±127
 *     words: ['absent', ...],
 *     index: [{ off, frames }, ...], // 与 words × alphas 行主序对应
 *     flat: Int8Array                // 量化后的 MFCC 序列
 *   }
 */

const DEFAULT_ALPHAS = [0.80, 0.90, 1.00, 1.10, 1.20];

/**
 * Sakoe-Chiba 带宽。
 *
 * 固定带宽是陷阱：两词帧数差超过带宽时路径不可达，距离变成 Infinity，
 * 表现出来像「完美可分」，实际是把样本悄悄丢掉了。所以下限取 |n−m|+10。
 */
function autoBand(n, m) {
  return Math.max(Math.floor(0.35 * Math.max(n, m)), Math.abs(n - m) + 10);
}

/**
 * DTW 距离（按路径长度归一化）。
 *
 * @param {Float64Array} a 查询特征，行主序
 * @param {Float64Array} b 模板特征，行主序
 * @param {number} dim 维度
 * @param {number} [band] 带宽；不传则自适应
 * @returns {number} 归一化距离；路径不可达返回 Infinity
 */
function dtw(a, b, dim, band) {
  const n = Math.floor(a.length / dim);
  const m = Math.floor(b.length / dim);
  if (n === 0 || m === 0) return Infinity;
  const w = band === undefined || band === null ? autoBand(n, m) : band;

  const INF = Infinity;
  let prev = new Float64Array(m + 1).fill(INF);
  let cur = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;

  for (let i = 1; i <= n; i++) {
    cur.fill(INF);
    const j0 = Math.max(1, i - w);
    const j1 = Math.min(m, i + w);
    const ai = (i - 1) * dim;
    for (let j = j0; j <= j1; j++) {
      const bj = (j - 1) * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) {
        const d = a[ai + k] - b[bj + k];
        s += d * d;
      }
      const cost = Math.sqrt(s);
      let best = prev[j - 1];
      if (prev[j] < best) best = prev[j];
      if (cur[j - 1] < best) best = cur[j - 1];
      cur[j] = best === INF ? INF : cost + best;
    }
    const t = prev; prev = cur; cur = t;
  }
  const total = prev[m];
  return total === INF ? INF : total / (n + m);
}

/** 把 int8 量化值还原成浮点特征 */
function dequantize(flat, off, frames, dim, scale) {
  const out = new Float64Array(frames * dim);
  for (let i = 0; i < frames * dim; i++) {
    out[i] = flat[off + i] / 127 * scale;
  }
  return out;
}

/**
 * 单个词的 VTLN 距离：对该词的 5 档 α 模板取最小距离。
 *
 * @param {Float64Array} query 查询特征（已 CMN+CMVN）
 * @param {Object} tpl 模板对象
 * @param {number} wi 词索引
 * @returns {{dist: number, alpha: number}} 最小距离及其对应的 α
 */
function wordDistance(query, tpl, wi) {
  const nA = tpl.alphas.length;
  const dim = tpl.dim;
  let best = Infinity, bestAlpha = 1;
  for (let a = 0; a < nA; a++) {
    const idx = tpl.index[wi * nA + a];
    if (!idx || !idx.frames) continue;
    const t = dequantize(tpl.flat, idx.off, idx.frames, dim, tpl.quantScale);
    const d = dtw(query, t, dim);
    if (d < best) { best = d; bestAlpha = tpl.alphas[a]; }
  }
  return { dist: best, alpha: bestAlpha };
}

/**
 * 判定。
 *
 * ## 阈值语义（2026-09-24 修正，此前是错的）
 * `tpl.thresholds[wi]` **就是判定线本身**（= 该词「最近异词距离」× 0.85，
 * 由 out/_asr_probe/build_templates.py 按 calibrate.py 的实测标定生成）。
 * 所以 `passRatio` 默认 **1.0** —— 直接拿阈值当 pass 线。
 *
 * ⚠️ 旧版默认 `passRatio = 0.85`，把线又压了一层，实际判定线只有
 *    0.85 × 0.85 = 0.7225 × 最近异词距离。294 词 × 6 类扰动的实测结论是：
 *    那样只放行 **75.4%** 的合格朗读 —— 每 4 个读对的学生就有 1 个被判错，
 *    而且**不报错**，只是永远过不了关。这是本项目最危险的一类缺陷。
 *    修好后同词通过 98.8% / 异词拒识 99.9%（见 calibrate-result.json）。
 *
 * 想调松紧请改 build_templates.py 的系数并重跑 calibrate.py，
 * **不要**在调用处随手传 passRatio —— 那会把标定结果废掉且无从追溯。
 *
 * @param {Object} tpl 模板对象
 * @param {Float64Array} query 查询特征
 * @param {string} expected 期望词
 * @param {Object} [opt]
 *   @param {number} [opt.passRatio=1.0]    距离 ≤ 阈值×passRatio → pass
 *   @param {number} [opt.borderRatio=1.35] 距离 ≤ 阈值×borderRatio → borderline
 *   @param {number} [opt.threshold]        覆盖模板里的阈值（仅用于测试）
 * @returns {{ok, band, dist, threshold, ratio, alpha}}
 */
function judge(tpl, query, expected, opt) {
  opt = opt || {};
  const passRatio = opt.passRatio === undefined ? 1.0 : opt.passRatio;
  const borderRatio = opt.borderRatio === undefined ? 1.35 : opt.borderRatio;

  const wi = tpl.words.indexOf(expected);
  if (wi < 0) return { ok: false, band: 'no-template', dist: Infinity };

  const own = wordDistance(query, tpl, wi);
  const threshold = (tpl.thresholds && tpl.thresholds[wi]) || opt.threshold || 1.0;

  let band;
  if (own.dist <= threshold * passRatio) band = 'pass';
  else if (own.dist <= threshold * borderRatio) band = 'borderline';
  else band = 'fail';

  return {
    ok: true,
    band: band,
    dist: own.dist,
    threshold: threshold,
    ratio: own.dist / threshold,
    alpha: own.alpha
  };
}

/**
 * 关于「拒识」（学生读成了别的词）—— 已考虑，暂不做。
 *
 * 做法本可以是：判 fail 时再把查询与全部 293 个词的模板比一遍，找出最近的，
 * 于是能提示「你是不是读成了 bit？」。没做的原因纯粹是**代价**：
 * 293 词 × 5 档 α ≈ 1470 次 DTW，每次约 3600 次内层迭代 —— 合计约 500 万次运算，
 * 在手机上会给"松手到出结果"之间加进可感知的停顿，而它只在 fail 时才需要。
 *
 * 现有阈值已经把「读成别的词」判成 fail（异词拒识 99.9%），只是说不出读成了哪个。
 * 若将来要做，正确姿势是**只在 fail 分支**做，并且先用 α=1.0 粗筛取 top-K 再精算。
 */
module.exports = {
  dtw: dtw,
  autoBand: autoBand,
  dequantize: dequantize,
  wordDistance: wordDistance,
  judge: judge,
  DEFAULT_ALPHAS: DEFAULT_ALPHAS
};
