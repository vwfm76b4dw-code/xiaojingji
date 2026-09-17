/**
 * 小鲸记单词 —— 基于 SM-2 间隔重复算法的背单词小程序
 *
 * 分三层，任何一层不可用都不影响下一层：
 *   ① 核心（算法 + 词库 + 复习 + 统计）—— 零外部依赖，永远可用
 *   ② AI 增强（云函数 GLM）—— 未开通云开发时静默降级，回退本地预置
 *   ③ 朗读评测（端上音素判定）—— 无需服务器，装了就可用
 */
const store = require('./utils/store.js');
const { todayStr } = require('./utils/date.js');

// 云开发环境 ID。留空则使用账号下的默认环境；如有多环境可填具体 ID。
const CLOUD_ENV = '';

App({
  globalData: {
    today: '',
    totalWords: 0,
    seedResult: null
  },

  onLaunch() {
    this.globalData.today = todayStr();

    // ---- ① 首次启动预置教材词库 ----
    // 放在云开发初始化之前：预置是纯本地操作，不依赖任何网络。
    // 这样用户在"AI 还没配好"的状态下打开，也有东西可学。
    try {
      const seed = require('./data/textbook-7a.js');
      this.globalData.seedResult = store.initSeed(seed.words);
      if (this.globalData.seedResult.seeded) {
        console.log('[app] 已预置教材词库', this.globalData.seedResult.count, '词');
      }
    } catch (e) {
      console.error('[app] 预置词库失败，不影响手动录入', e);
      this.globalData.seedResult = { seeded: false, reason: 'error' };
    }
    this.globalData.totalWords = store.countWords();

    // ---- ② 云开发（AI 增强用，尽力而为）----
    if (!wx.cloud) {
      console.warn('[app] 基础库版本过低，不支持云开发，AI 增强项不可用');
      return;
    }
    try {
      wx.cloud.init(CLOUD_ENV ? { env: CLOUD_ENV, traceUser: true } : { traceUser: true });
    } catch (e) {
      // 未开通云开发时会走到这里；不影响核心功能
      console.warn('[app] 云开发初始化未完成，AI 增强项将降级', e);
    }
  }
});
