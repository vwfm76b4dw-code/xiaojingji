/**
 * 端上向量检索 —— 零依赖，可直接放进微信小程序
 *
 * 职责边界：本模块**只做数学**（余弦相似度 Top-K），不碰模型。
 * 查询向量的计算由调用方通过 wx.createInferenceSession 完成：
 *
 *   查询文本 → 加 bge 指令前缀 → tokenizer → bge ONNX → CLS 池化 → L2 归一化 → search()
 *
 * ## 为什么能这么快
 * 归一化后的向量，点积 == 余弦相似度。295 × 512 ≈ 15 万次乘加
 * （2026-10-17 前是 2768 × 512，换专属索引后降了一个量级），
 * 现代手机 JS 引擎 1ms 上下。所以不需要任何索引结构（HNSW 之类）——
 * 全量扫描比维护索引更简单，而且更快（n 太小）。
 *
 * ## 与既有检索的关系
 * 不要替换 utils/rag.js 的字符串/音素通道，而是**融合**：
 *   · 字符串/音素通道擅长「词形」相似 —— 「哪些词长得像 apple」
 *   · 向量通道擅长「语义」相似 —— 「学校用品有哪些词」
 * 两者互补，建议各取 Top-K 后按分数融合。
 */

/** int8 反量化：q / 127。归一化后向量各分量 ∈ [-1,1]，误差 ≤ 1/254 ≈ 0.004 */
function dequantize(buf, count, dim) {
  const out = new Float32Array(count * dim);
  for (let i = 0; i < out.length; i++) {
    // Buffer 里的字节按 int8 解读
    const b = buf[i];
    out[i] = (b > 127 ? b - 256 : b) / 127;
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} vectorsBin  vectors.bin 的内容
 * @param {Array} index                        index.json 的内容
 * @param {number} [dim]                       维度，默认从 meta 推断（512）
 */
function createSearcher(vectorsBin, index, dim) {
  const DIM = dim || 512;
  const bytes = vectorsBin instanceof Uint8Array ? vectorsBin : new Uint8Array(vectorsBin);
  const count = index.length;

  if (bytes.length !== count * DIM) {
    throw new Error('vectors.bin 体积与 index 不匹配：' + bytes.length + ' ≠ ' + count + '×' + DIM);
  }

  const vecs = dequantize(bytes, count, DIM);

  /**
   * @param {Float32Array|number[]} queryVec 已 L2 归一化的查询向量
   * @param {number} topK
   * @param {number} [minScore] 低于此分数的不返回（建议 0.3~0.4，需按实际调）
   * @returns {Array<{item, score, rank}>} 按分数降序
   */
  function search(queryVec, topK, minScore) {
    const K = topK || 5;
    const floor = minScore === undefined ? -1 : minScore;

    // 查询向量归一化（防止调用方忘了）
    let norm = 0;
    for (let d = 0; d < DIM; d++) norm += queryVec[d] * queryVec[d];
    norm = Math.sqrt(norm) || 1;

    // 全量扫描，维护一个长度 K 的小顶堆语义（这里直接用插入排序，K 很小）
    const top = [];
    for (let i = 0; i < count; i++) {
      let dot = 0;
      const base = i * DIM;
      for (let d = 0; d < DIM; d++) dot += vecs[base + d] * queryVec[d];
      const score = dot / norm;

      if (score < floor) continue;
      if (top.length < K) {
        top.push({ idx: i, score: score });
        top.sort(function (a, b) { return b.score - a.score; });
      } else if (score > top[K - 1].score) {
        top[K - 1] = { idx: i, score: score };
        top.sort(function (a, b) { return b.score - a.score; });
      }
    }

    return top.map(function (t, i) {
      return { item: index[t.idx], score: t.score, rank: i + 1 };
    });
  }

  return { search: search, count: count, dim: DIM };
}

module.exports = { createSearcher, dequantize };
