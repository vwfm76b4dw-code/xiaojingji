/**
 * 主题桥 —— pack-social 两页面对 utils/theme.js 的防御式接线。
 *
 * ## 为什么存在这个文件（为什么不是各页面各自 require）
 * utils/theme.js 由并行 Agent 同轮开发中，最终导出形态未冻结
 * （Behavior / themeClass() 函数 / data 预置值都可能）。小程序的 require
 * 在模块缺失时会**同步抛错**，直接写在页面顶层会让整页 JS 求值失败，
 * "没就绪的装饰"不能带崩"核心功能页"。桥是唯一的隔离层。
 *
 * ## 约定（写进 tools/verify-social.js 的门禁断言）
 * resolveThemeClass() 恒返回字符串：解析成功 = 主题类名（如 'theme-dark'）；
 * 任何失败（模块缺失 / 导出形态不认识 / 模块自身抛错）= ''，即默认主题。
 * 页面只写 class="page {{themeClass}}"，不感知主题实现细节。
 *
 * ## 为什么不用 behaviors 静态接线
 * Behavior 实例没有公开的判别 API（框架不给 isBehavior 之类的可靠标记），
 * 把普通对象塞进 behaviors 数组会直接抛错。在 onLoad 时序里动态解析、
 * 解析不出就保持默认，是"赌形态"和"崩页面"之外唯一两全的做法。
 * 若 theme.js 最终定型为 Behavior，这里升级成 behaviors 接线是一行改动。
 */

function resolveThemeClass() {
  let mod = null;
  // 2026-09-25 聚合期修正：theme.js 已落地，改回静态字面量 require，让打包期的
  // 坏引用检查真正生效。此前的"常量拼接"是为并行开发期"模块可能不存在"做的规避，
  // 但顺带把多写的一层 ../（../../ 解析到项目根外）也藏住了——两层问题一起消除。
  // try/catch 保留：运行期防御，桥的职责仍是"主题缺失不带崩页面"。
  try {
    mod = require('../utils/theme.js');
  } catch (e) {
    return '';
  }
  try {
    if (!mod) return '';
    // 形态一：mixin 函数（模块本身就是"取主题类名"的函数）
    if (typeof mod === 'function') return String(mod() || '');
    // 形态二：显式函数 API（themeClass()）
    if (typeof mod.themeClass === 'function') return String(mod.themeClass() || '');
    // 形态三：对象预置 data（Behavior/普通对象都有 data.themeClass 的可能；
    // 读它的初值，运行时变化交给页面 onShow 或主题模块自己的生命周期）
    if (mod.data && typeof mod.data.themeClass === 'string') return mod.data.themeClass;
  } catch (e) {
    // 主题模块自身抛错同样不带崩页面：回默认主题
    return '';
  }
  return '';
}

module.exports = { resolveThemeClass: resolveThemeClass };
