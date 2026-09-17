/**
 * AI 结果校验与降级策略 —— 纯函数，零依赖，Node 可直接测试。
 *
 * 职责边界：提示词归云函数（服务端资产），**校验归前端**。
 * 模型输出是不可信输入（可能被注入、可能格式错乱），前端必须自己再过一遍，
 * 不能因为"是自己家的云函数返回的"就免检。
 */

/**
 * 单词合法性：纯英文，允许连字符与撇号，最多三个词（如 look after / a bit）。
 * 上限三词是为了挡住模型把整句英文当"单词"返回——我们只要词条，不要句子。
 */
const WORD_RE = /^[A-Za-z][A-Za-z'\-]*(?: [A-Za-z][A-Za-z'\-]*){0,2}$/;
const MAX_ITEMS = 50;
const MAX_WORD = 60;
const MAX_MEANING = 200;

/** 清洗：先折叠空白去首尾，再剥掉模型爱加的成对引号，最后截断 */
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, max);
}

/**
 * 归一化 AI 返回的词条：清洗 → 校验 → 去重（忽略大小写）→ 截断。
 * 非法条目直接丢弃而不是报错——AI 多给了垃圾不该让整个流程失败。
 */
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < raw.length && out.length < MAX_ITEMS; i++) {
    const it = raw[i] || {};
    const word = cleanText(it.word, MAX_WORD);
    const meaning = cleanText(it.meaning, MAX_MEANING);
    if (!word || !meaning || !WORD_RE.test(word)) continue;
    const key = word.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ word: word, meaning: meaning });
  }
  return out;
}

/** 按已有词库拆分：fresh = 新词，dup = 已存在（用于提示"跳过 N 个"） */
function partitionNew(items, existingWords) {
  const have = Object.create(null);
  (existingWords || []).forEach(function (w) {
    if (w && w.word) have[String(w.word).toLowerCase()] = true;
  });
  const fresh = [], dup = [];
  (items || []).forEach(function (it) {
    if (have[String(it.word).toLowerCase()]) dup.push(it);
    else fresh.push(it);
  });
  return { fresh: fresh, dup: dup };
}

/**
 * 失败时的用户提示（统一文案，避免界面各处自己编）。
 * 原则：说清楚"发生了什么 + 现在能怎么办"，不出现错误码、不出现"异常""失败"这类裸报错词。
 */
function degradeHint(action, code) {
  if (action === 'parseBatch') {
    if (code === 'NO_CLOUD') return 'AI 未开通，请用「批量粘贴」按 单词 释义 的格式录入';
    if (code === 'NO_ITEMS') return 'AI 没认出单词，改用「批量粘贴」更稳妥';
    return 'AI 暂时联系不上，请用「批量粘贴」录入';
  }
  if (action === 'genExample') return '例句没生成出来，可以自己写一句更贴生活的';
  if (action === 'genMnemonic') return '记忆法没生成出来，可以自己拆一下词根';
  return 'AI 暂时不可用';
}

module.exports = { WORD_RE, MAX_ITEMS, cleanText, normalizeItems, partitionNew, degradeHint };
