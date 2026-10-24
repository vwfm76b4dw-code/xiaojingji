/**
 * 小鲸记单词 —— 基于 SM-2 间隔重复算法的背单词小程序
 *
 * 分三层，任何一层不可用都不影响下一层：
 *   ① 核心（算法 + 词库 + 复习 + 统计）—— 零外部依赖，永远可用
 *   ② AI 增强（云函数 GLM）—— 未开通云开发时静默降级，回退本地预置
 *   ③ 朗读评测（端上音素判定）—— 无需服务器，装了就可用
 */
const store = require('./utils/store.js');
const cards = require('./utils/cards.js');
const bootPrep = require('./utils/boot-prep.js');
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

    // ---- ①b 存量词条单元归属回填（一次性，幂等）----
    // 必须在 initSeed 之后：新装的设备刚灌入的词自带 unit，这一步扫不到东西；
    // 而老设备（seeded_v1 已置位、词库里 295 条旧词没有 unit）靠这一步补上，
    // 否则「按单元学习」在真机上永远只有「未分组」。
    // 用 try 包住：回填失败只该少个单元筛选，绝不能让 onLaunch 挂掉。
    try {
      const bf = store.backfillUnits(require('./data/textbook-7a.js').words);
      if (bf.backfilled > 0) {
        console.log('[app] 单元归属回填', bf.backfilled, '词');
        // 缓存失效放在 app 侧：store.js 不能 require cards.js（cards → store 会成环），
        // 而 app.js 是组合根，两边都 require 得起，这个决定只有它有资格做。
        // 不失效的话，页面读到的还是回填前那份卡片投影，界面上依旧「未分组」。
        cards.invalidate();
      } else if (bf.reason === 'save_failed') {
        console.warn('[app] 单元归属回填写盘失败，本次跳过');
      }
    } catch (e) {
      console.warn('[app] 单元归属回填异常，不影响其它功能', e);
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

    // ---- ③ 启动资源准备管线（模板 → 294 发音 → 语义模型）----
    //
    // 2026-09-25 起，原来 ③④ 两段"各自为政"的 autoDownloadOnLaunch 收编进
    // utils/boot-prep.js 一条管线（用户点名：第一次启动先把所有资源下好，
    // 每次启动先把模型加载进去）。收编的两个理由：
    //   ① 音频 294 个若继续"用到才下"，第一次离线使用每个词都要等一次网络
    //      往返 —— 首启全量预热（并发≤3、断点续传）是资源层的编排职责，
    //      分散在两个 pack 模块里谁也做不了；
    //   ② 模板下载完必须立刻 acoustic.load() 预热进内存 —— 原链路只下载
    //      不加载，朗读页第一次判定要现场读 785KB，"模板在下但没进内存"
    //      正是"每次启动都慢一拍"的来源。
    //
    // 管线自身保证：不阻塞首屏（整条异步链、onDone 可选）、失败重试一次、
    // 进度持久化（清单 ver 不变则跳过已完成）、任何失败都不影响 ①② 的
    // 核心学习功能。失败静默的兜底在朗读页的四通道账本里（可诊断、可行动），
    // 启动侧不需要也不应该弹窗。
    //
    // 仍排在云开发 init 之后：管线全程走 wx.cloud.downloadFile，
    // 没 init 过会每一步都失败（管线能扛住，但没必要白跑）。
    try {
      bootPrep.run();
    } catch (e) {
      console.warn('[app] 资源准备管线未能启动（不影响学习功能）', e);
    }
  }
});
