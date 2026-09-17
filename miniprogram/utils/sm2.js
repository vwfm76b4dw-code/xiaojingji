/**
 * SM-2 间隔重复算法（三档简化版）—— 本作品的技术核心。
 * 参考：Piotr Woźniak, SuperMemo 2 (1987)，公开算法。
 * 纯函数、零依赖，Node 与小程序环境均可运行。
 */
const { addDays, todayStr } = require('./date.js');

// 三档反馈 → 质量分 q（q >= 3 视为记住）
const GRADE = { KNOW: 5, VAGUE: 3, FORGOT: 1 };

/**
 * @param {Object} item 单词记录，含 ef / reps / interval
 * @param {number} q    质量分：5=认识 3=模糊 1=不认识
 * @param {string} [today] 本地日期 YYYY-MM-DD，缺省取当天
 * @returns {Object} 更新后的记录（含 nextReview）
 */
function sm2(item, q, today) {
  // 步骤1 更新难度系数 EF（下限 1.3，防止连续答错时间隔崩塌）
  let ef = item.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;

  let reps = item.reps;
  let interval = item.interval;

  // 步骤2 是否记住决定间隔走向
  if (q < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps = reps + 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }

  // 步骤3 下次复习日期 = 今天 + interval 天
  const base = today || todayStr();
  return Object.assign({}, item, {
    ef: Math.round(ef * 100) / 100,
    reps: reps,
    interval: interval,
    nextReview: addDays(base, interval)
  });
}

module.exports = { sm2, GRADE };
