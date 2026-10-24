/**
 * 触感反馈 —— wx.vibrateShort 的唯一接线点（2026-09-25 新增）。
 *
 * ## 为什么独立成模块，而不是各页面直接调 wx.vibrateShort
 *   ① 真机上无振动器/权限受限时 vibrateShort 会 fail（开发者工具则直接没有
 *      这个 API），必须统一 try + fail 回调兜底 —— 散在各页面必然有漏网处，
 *      而漏网的形态是"某一次点击抛异常"或"静默没感觉"，都很难归因到这里；
 *   ② 震动强度的语义集中在这里（tap=light / confirm=medium），各页面各写
 *      各的字符串迟早漂移（本项目已经见过"cooldown 时长两处各写一遍"的教训）。
 *
 * ## 为什么不做成"异步队列/可取消"的复杂封装
 * vibrateShort 是系统瞬时行为，没有"取消"的概念；造出cancel()只会是假 API。
 *
 * ## "及时"的纪律（为什么要求处理函数第一行同步调）
 * 震动必须与视觉反馈**同时**发生才叫触感。放在 setData 之后或回调里，
 * 学生先看到界面变了、后感到震动，等于没有震动。所以接线点一律放在
 * 处理函数守卫之后的第一条可执行语句 —— 守卫命中说明这次点击没有产生
 * 交互（按钮 disabled / 动画中），不该震。
 */
const TYPES = ['heavy', 'medium', 'light'];

/**
 * 触发一次短震动。
 *
 * @param {string} [type] 'light'（默认，轻点）| 'medium'（提交类操作）| 'heavy'（暂未使用）
 *   为什么给 type 而不是给语义化方法名（tap/confirm/...）：
 *   语义化名字会诱导调用方"多造几档"，而 vibrateShort 真实只有三档；
 *   两档语义 + 直传系统枚举，是抽象与平台能力刚好对齐的最小封装。
 */
function tap(type) {
  try {
    if (typeof wx === 'undefined' || typeof wx.vibrateShort !== 'function') return;
    wx.vibrateShort({
      type: TYPES.indexOf(type) >= 0 ? type : 'light',
      // 无振动器设备走 fail：触感缺失是环境问题，绝不能表现为用户可见的错误
      fail: function () { /* 静默 */ }
    });
  } catch (e) { /* 触感失败不能打断任何主流程 */ }
}

module.exports = { tap, TYPES };
