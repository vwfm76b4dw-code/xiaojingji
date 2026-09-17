/**
 * 可配置参数 —— "产品"与"demo"的区别就在这些开关。
 *
 * 设计原则：
 *   ① 每个参数都有**合理默认值**，用户不配置也能直接用；
 *   ② 参数改动立即生效（下次进入页面读取），不需要重启；
 *   ③ 所有参数集中在这里，避免散落各处导致"想改不知道去哪改"。
 */
const KEY = 'settings';

const DEFAULTS = {
  // ---- 学习量 ----
  dailyNewWords: 10,      // 每日新词数（首次学习的词）
  dailyReviewMax: 30,     // 每日复习上限（防止词库大了之后一打开就 200 张）
  sessionSize: 10,        // 单轮复习张数（一轮做完给正反馈）

  // ---- 语音能力 ----
  // auto  = 优先用微信插件（任何手机可用），不可用时退回本地服务
  // local = 强制用本地服务（开发调试用）
  voiceBackend: 'auto',

  // ---- 朗读练习（ASR）----
  pronounceEnabled: true,     // 是否开启朗读练习
  pronounceFirst: true,       // 复习时先朗读再翻卡（练发音）
  passScore: 0.84,            // 判定通过阈值（音素相似度）
  borderlineScore: 0.68,      // "再读一次"阈值，低于此判错
  autoPlayAudio: true,        // 判定不通过时自动播放标准发音
  recordUnknown: true,        // 记录"不会读"的词（供后续重点练）

  // ---- 反馈与体验 ----
  showHook: true,             // 翻卡时显示记忆钩子
  soundFeedback: true,        // 判定结果音效（暂未实现，预留）
};

function load() {
  try {
    const v = wx.getStorageSync(KEY);
    return Object.assign({}, DEFAULTS, (v && typeof v === 'object') ? v : {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(patch) {
  try {
    const next = Object.assign(load(), patch || {});
    wx.setStorageSync(KEY, next);
    return next;
  } catch (e) {
    console.error('[settings] 保存失败', e);
    return load();
  }
}

function get(key) {
  const v = load();
  return key in v ? v[key] : DEFAULTS[key];
}

function reset() {
  try {
    wx.removeStorageSync(KEY);
    return Object.assign({}, DEFAULTS);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

module.exports = { KEY, DEFAULTS, load, save, get, reset };
