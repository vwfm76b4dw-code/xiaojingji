/**
 * ARPAbet → IPA 显示转换（音标标在卡片上，"有音标就标音标"）。
 *
 * 数据源：utils/phoneme-table.js（866 词，CMUdict 来源，ARPAbet 记音）。
 * ARPAbet 是机器可读的音素序列，学生看不懂 —— 转成国际音标（IPA）再上界面。
 *
 * 转换规则（教学用简化版，不是严格词典音标）：
 *   · 每个音素映射一个 IPA 符号；重音数字 1/2 转成 ˈ/ˌ 加在对应元音前
 *   · 卷舌音 ER0 → ə（英式习惯），ER1/ER2 → ɜː
 */
const MAP = {
  // 元音（单音素）
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'e', ER: 'ər', EY: 'eɪ', IH: 'ɪ', IY: 'i',
  OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
  // 辅音
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ',
  HH: 'h', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n',
  NG: 'ŋ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't',
  TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ'
};

/**
 * @param arpabet 形如 "AE1 B S AH0 N T"
 * @returns IPA 字符串如 "əˈbæsənt"；查不到/空 → ''
 */
function toIPA(arpabet) {
  const tokens = String(arpabet || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  let out = '';
  tokens.forEach(function (tok) {
    const m = /^([A-Z]+)(\d)?$/.exec(tok);
    if (!m) return;
    const ph = m[1];
    const stress = m[2];
    let sym = MAP[ph];
    if (!sym) return;
    // ER 带重音读长音（ɜr），轻读卷舌弱化
    if (ph === 'ER') sym = stress === '1' || stress === '2' ? 'ɜːr' : 'ər';
    if (stress === '1') sym = 'ˈ' + sym;
    else if (stress === '2') sym = 'ˌ' + sym;
    out += sym;
  });
  return out;
}

module.exports = { toIPA, forWord };

/**
 * 取一个词条的音标 —— **支持多词条目**（2026-09-25 加）。
 *
 * ## 为什么需要它
 * 预置词表里有 21 条词组（`junior high` / `information technology` /
 * `red scarf` / `in the end`…），而 phoneme-table 是按**单个词**建的，
 * 整条查表必然查不到 → 这些词条在界面上**完全没有音标**。
 *
 * 偏偏词组是最需要音标提示的：学生不知道重音落在哪个词、
 * 也不知道两个词之间怎么连读。所以逐段查、再拼起来。
 *
 * ## 为什么有一段查不到就整条不给
 * "半截音标"比"没有音标"更容易误导 —— 学生会以为整条的读音就是那个残缺的形态。
 * 宁可空着（界面 wx:if 会自然不渲染），也不给错的。
 *
 * @param {string} word 词条（可含空格、连字符）
 * @param {Object} table phoneme-table（词 → ARPAbet 串）
 * @returns {string} IPA，查不到返回 ''
 */
function forWord(word, table) {
  const raw = String(word == null ? '' : word).trim().toLowerCase();
  if (!raw) return '';
  const t = table || {};

  // ① 整条直接命中（绝大多数是这种情况）
  if (t[raw]) return toIPA(t[raw]);

  // ② 多词/连字符条目：逐段查再拼
  const parts = raw.split(/[\s\-]+/).filter(Boolean);
  if (parts.length < 2) return '';

  const got = parts.map(function (p) { return t[p] ? toIPA(t[p]) : ''; });
  if (got.some(function (x) { return !x; })) return '';
  return got.join(' ');
}
