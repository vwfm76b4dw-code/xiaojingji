const settings = require('../../utils/settings.js');
const asr = require('../../utils/asr.js');
const store = require('../../utils/store.js');

Page({
  data: {
    cfg: {},
    // 服务状态
    asrOk: false,
    asrMsg: '正在检查…',
    asrBase: '',
    editingBase: false,
    draftBase: '',
    // 统计
    vocabSize: 0,
    audioCached: 0
  },

  onLoad() {
    this.setData({
      cfg: settings.load(),
      asrBase: asr.base(),
      draftBase: asr.base()
    });
    this.checkService();
  },

  onShow() {
    this.setData({ cfg: settings.load() });
  },

  /**
   * 显示**真实**的语音能力状态。
   *
   * 原来这里只探本机服务（127.0.0.1:8766），而那在手机上必然失败，
   * 界面把原因说成「网络不太好」—— 与真实原因（根本没有本地服务）不符，
   * 属于误导。现在按代码里实际的优先级逐层报告。
   */
  checkService() {
    const voice = require('../../utils/voice.js');
    const cap = voice.capability();

    // ① 插件（免费、端上）
    if (cap.plugin) {
      this.setData({ asrOk: true, asrMsg: '朗读就绪 · 使用微信语音插件', voiceMode: 'plugin' });
      return;
    }
    // ② 云函数（任何手机可用，需部署）
    if (asr.cloudReady && asr.cloudReady()) {
      asr.cloudStatus().then(r => {
        if (r && r.ok) {
          this.setData({ asrOk: true, asrMsg: '朗读就绪 · 云端识别（' + (r.provider || '') + '）', voiceMode: 'cloud' });
          return;
        }
        // 云函数在但没配服务
        this.setData({
          asrOk: false,
          voiceMode: 'offline',
          asrMsg: r && r.code === 'NOT_CONFIGURED'
            ? '云端识别未配置（需在云开发控制台配语音服务密钥）'
            : '云端识别未就绪：' + ((r && r.msg) || '未知原因')
        });
      });
      return;
    }
    // ③ 都没有
    this.setData({
      asrOk: false,
      voiceMode: 'offline',
      asrMsg: '识别功能未开通 —— 但听发音、背单词、按排期复习都正常'
    });
  },

  /** 打开开发指引（教怎么配置识别通道，而不是让学生改 IP） */
  showSetupGuide() {
    wx.showModal({
      title: '怎么开通朗读识别',
      content: '需要在「微信开发者工具 → 云开发」里开通环境，'
        + '然后部署 asrProxy 云函数并配置语音服务密钥。'
        + '这一步由开发者完成，配置后本页会自动显示"朗读就绪"。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /*------------------------- 参数调节 -------------------------*/

  /** 数值型参数：+/- 步进（比滑块更精确，也更好点） */
  step(e) {
    const key = e.currentTarget.dataset.k;
    const delta = Number(e.currentTarget.dataset.d);
    const min = Number(e.currentTarget.dataset.min);
    const max = Number(e.currentTarget.dataset.max);
    const cur = Number(this.data.cfg[key]) || 0;
    let next = cur + delta;
    if (next < min) next = min;
    if (next > max) next = max;
    if (next === cur) return;
    const cfg = settings.save({ [key]: next });
    this.setData({ cfg: cfg });
  },

  /** 开关型参数 */
  toggle(e) {
    const key = e.currentTarget.dataset.k;
    const cfg = settings.save({ [key]: !this.data.cfg[key] });
    this.setData({ cfg: cfg });
  },

  /** 阈值这类连续参数：用几个预设档位（比滑块好操作） */
  pickThreshold(e) {
    const level = e.currentTarget.dataset.level;
    // 三档：宽松 / 标准 / 严格
    const PRESET = {
      loose: { passScore: 0.78, borderlineScore: 0.60 },
      normal: { passScore: 0.84, borderlineScore: 0.68 },
      strict: { passScore: 0.90, borderlineScore: 0.75 }
    };
    const cfg = settings.save(PRESET[level] || PRESET.normal);
    this.setData({ cfg: cfg });
    wx.showToast({ title: '判定尺度：' + ({ loose: '宽松', normal: '标准', strict: '严格' }[level] || '标准'), icon: 'none' });
  },

  /** 当前尺度名（用于界面高亮） */
  thresholdLevel() {
    const p = this.data.cfg.passScore;
    if (p <= 0.80) return 'loose';
    if (p >= 0.88) return 'strict';
    return 'normal';
  },

  resetAll() {
    wx.showModal({
      title: '恢复默认设置？',
      content: '只重置学习量、朗读、反馈等参数，学习进度不受影响。',
      success: res => {
        if (!res.confirm) return;
        const cfg = settings.reset();
        this.setData({ cfg: cfg });
        wx.showToast({ title: '已恢复默认', icon: 'none' });
      }
    });
  },

  /*------------------------- 服务地址 -------------------------*/

  editBase() {
    this.setData({ editingBase: true, draftBase: asr.base() });
  },

  onBaseInput(e) {
    this.setData({ draftBase: e.detail.value });
  },

  cancelBase() {
    this.setData({ editingBase: false });
  },

  saveBase() {
    const url = String(this.data.draftBase || '').trim();
    if (!/^https?:\/\/.+/.test(url)) {
      wx.showToast({ title: '地址要以 http:// 开头', icon: 'none' });
      return;
    }
    asr.setBase(url);
    this.setData({ asrBase: url, editingBase: false });
    wx.showToast({ title: '已保存，正在测试', icon: 'none' });
    this.checkService();
  },

  testService() {
    wx.showLoading({ title: '测试中' });
    asr.health().then(r => {
      wx.hideLoading();
      if (r.ok) {
        wx.showModal({
          title: '朗读服务正常',
          content: '词表 ' + (r.vocab || 0) + ' 词\nASR ' + (r.asr ? '已加载' : '待加载'),
          showCancel: false
        });
      } else {
        wx.showModal({
          title: '连不上朗读服务',
          content: '请在电脑上运行：\npython -m server.asr_service\n\n'
                 + '真机调试时，地址要用电脑的局域网 IP（不是 127.0.0.1）',
          showCancel: false
        });
      }
      this.checkService();
    });
  },

  /** 预生成发音音频（首次部署后跑一次，之后播放零延迟） */
  prepareAudio() {
    wx.showLoading({ title: '生成中，可能较慢' });
    wx.request({
      url: asr.base() + '/api/audio/prepare',
      method: 'POST',
      data: {},
      timeout: 600000,
      success: res => {
        wx.hideLoading();
        const d = res.data || {};
        wx.showModal({
          title: '发音音频',
          content: '新生成 ' + (d.made || 0) + ' 个\n已存在 ' + (d.skipped || 0) + ' 个'
                 + (d.failed ? '\n失败 ' + d.failed + ' 个' : ''),
          showCancel: false
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '生成失败，检查服务是否启动', icon: 'none' });
      }
    });
  },

  /** 清空朗读记录 */
  clearPronRecords() {
    wx.showModal({
      title: '清空朗读记录？',
      content: '会清掉所有朗读评测历史（读对/读错的记录），学习进度不受影响。',
      success: res => {
        if (!res.confirm) return;
        if (store.clearPronRecords()) {
          wx.showToast({ title: '已清空', icon: 'none' });
        } else {
          wx.showToast({ title: '清空失败', icon: 'none' });
        }
      }
    });
  },

  /**
   * 去朗读页。
   *
   * ⚠️ 必须用 switchTab —— pronounce 是 tabBar 页，
   * navigateTo 跳 tabBar 页会静默失败（只有控制台报错，界面完全没反应）。
   */
  goPronounce() {
    wx.switchTab({
      url: '/pages/pronounce/pronounce',
      fail: () => wx.showToast({ title: '打开失败，请点底部「朗读」', icon: 'none' })
    });
  }
});
