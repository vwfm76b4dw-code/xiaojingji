/**
 * 日期工具 —— 统一按本地时区取年月日。
 * 禁止使用 toISOString()（UTC 偏移会导致日期错一天）。
 */

/**
 * 规范日期串：必须是 YYYY-MM-DD（月/日各两位，零填充）。
 *
 * 为什么月/日必须两位：全项目按**字典序**比较日期串（dueWords 用 `w.nextReview <= today`）。
 * '2026-1-5' 与 '2026-09-16' 逐字符比到第 6 位时 '1'(0x31) > '0'(0x30)，
 * 于是 '2026-1-5' 被判定为"还没到期" —— 而且它永远大于任何真实日期，
 * 该词**永久进不了复习队列**，界面上什么都看不出来（静默丢词，比报错危险）。
 * 本项目自己产出的日期都走 formatDate 的 pad()，所以收紧到两位不会误伤。
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function todayStr() {
  return formatDate(new Date());
}

/**
 * 是否是合法日期串。
 * 逐字段回读校验，除了格式，还能挡住 '2026-02-30'、'2026-13-01' 这类
 * "格式对但日子根本不存在"的串 —— new Date 会把它们静默进位成 3 月 2 日。
 */
function isValidDateStr(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) return false;
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
}

/**
 * 日期串 + 天数。
 *
 * 非法入参**既不抛错、也不产出 'NaN-NaN-NaN'**：那一串一旦写进 nextReview，
 * 按字典序 'N'(78) > '2'(50) 会恒大于任何真实日期，该词就永远进不了复习队列
 * —— 表现是"静默丢词"，比报错更危险。
 * 因此：非法基准日按"今天"处理、非法天数按 0 处理，返回值永远是合法日期串。
 */
function addDays(dateStr, days) {
  const base = isValidDateStr(dateStr) ? dateStr : todayStr();
  const n = Number(days);
  const parts = base.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + (Number.isFinite(n) ? n : 0));
  return formatDate(d);
}

/** '2026-09-11' → '9月11日'；非法入参返回空串，界面不显示 'undefined月undefined日' */
function shortCN(dateStr) {
  if (!isValidDateStr(dateStr)) return '';
  const parts = dateStr.split('-').map(Number);
  return parts[1] + '月' + parts[2] + '日';
}

module.exports = { pad, formatDate, todayStr, isValidDateStr, addDays, shortCN };
