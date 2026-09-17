const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const asr = require('../../utils/asr.js');          // 本地服务（降级路径）
const voice = require('../../utils/voice.js');      // 插件优先的语音适配层
const judgeCore = require('../../utils/pron-judge.js');  // 端上判定（纯 JS）
const settings = require('../../utils/settings.js');
const audioPack = require('../../utils/audio.js');   // 随包预置发音（1MB，离线可用）
const { todayStr } = require('../../utils/date.js');
const cards = require('../../utils/cards.js');

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

/**
 * 朗读记录统一走 store（不再自己管 storage key）。
 *
 * 为什么要改：原先本页写 'pron_records'，而设置页的"清空朗读记录"删的是
 * 'memcards_pron_records' —— 两个键，按钮点了等于没点。
 * 同一份数据只能有一个 owner，这个 owner 是 store。
 */
function saveRecord(wordId, entry) {
  return store.addPronRecord(wordId, entry);
}

Page({
  data: {
    ready: false,
    cfg: {},              // 必须在 data 里——WXML 要读它
    card: null,
    idx: 0,
    total: 0,

    // 录音状态
    recording: false,
    recordingMs: 0,
    recSec: '0.0',
    _stopRequested: false,

    // 评测状态
    judging: false,
    result: null,          // {band, score, heard, verdict, suggestion}

    // 服务状态
    // 三态：checking / ok / fail —— 避免"初值 false 先闪一条黄条再消失"
    service: 'checking',
    serviceMsg: '',

    // 播放状态
    playing: false,

    // 本轮统计
    stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 },
    finished: false,

    // 是否已展示答案（先读后看）
    revealed: false
  },

  onLoad(query) {
    this.today = todayStr();
    const cfg = settings.load();
    this.cfg = cfg;                      // 逻辑用 this.cfg
    this.setData({ cfg: cfg });          // 模板用 data.cfg（两者都要）
    this.recorder = wx.getRecorderManager();
    this.audio = wx.createInnerAudioContext();
    this.setupRecorder();
    this.setupAudio();

    this.checkVoice();

    this.buildQueue(query && query.id);
  },

  onUnload() {
    this.cleanup();
    if (this.audio) {
      try { this.audio.destroy(); } catch (e) { /* 忽略 */ }
    }
  },

  /** 页面隐藏时也要停：否则录音继续跑满 10 秒、定时器在已卸载页面上刷数据 */
  onHide() {
    this.cleanup();
  },

  cleanup() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._pluginStarted) {
      try { voice.stopRecognition(); } catch (e) { /* 忽略 */ }
      this._pluginStarted = false;
    }
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (this.data.recording) {
      try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
    }
    if (this.data.playing) {
      try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    }
    if (this.data.recording || this.data.playing) {
      this.setData({ recording: false, recordingMs: 0, playing: false });
    }
  },

  /**
   * 检测**识别**能力，决定用哪条通道。
   *
   * 优先级：微信插件 > 云函数 > 本地服务 > 离线
   *
   * 为什么云函数排在本地服务前面：本地服务要求"电脑开机 + 同一 WiFi"，
   * 换台手机就废——这正是要消灭的依赖。云函数 Key 不进代码、任何网络都能调。
   *
   * ⚠️ 注意：识别与**播放**的优先级不同（播放首选随包音频，见 playAudio）。
   *    两者共用一个 this.voiceBackend 是为了少一处状态，但语义以识别为准。
   *
   * 探测顺序是**惰性**的：插件不可用时才去探云函数，云函数不通才去探本地服务。
   * 避免每次进页面都打三次网络请求。
   */
  checkVoice() {
    const cap = voice.capability();

    // ① 插件（免费、端上，但需主体有权限）
    if (cap.plugin) {
      this.voiceBackend = 'plugin';
      this.setData({ service: 'ok', serviceMsg: '', voiceMode: 'plugin' });
      return;
    }

    // ② 云函数（任何手机可用）
    if (asr.cloudReady()) {
      asr.cloudStatus().then(r => {
        if (r && r.ok) {
          this.voiceBackend = 'cloud';
          this.setData({ service: 'ok', serviceMsg: '', voiceMode: 'cloud' });
          return;
        }
        // 云函数存在但没配服务 / 没部署 → 继续往下探
        this.tryLocalService(r && r.code);
      });
      return;
    }

    // ③ 本地服务（开发期）
    this.tryLocalService('NO_CLOUD');
  },

  /** 探测本地服务（最后的识别通道），失败则进入离线态 */
  tryLocalService(cloudCode) {
    asr.health().then(r => {
      const ok = !!r.ok;
      this.voiceBackend = ok ? 'local' : 'offline';
      this.setData({
        service: ok ? 'ok' : 'fail',
        // 离线时给出路：还能看单词、看钩子、按排期复习
        serviceMsg: ok ? '' : '现在不能听你读。先自己读一遍，再看答案。',
        voiceMode: ok ? 'local' : 'offline'
      });
      if (!ok && cloudCode) console.log('[pron] 识别通道均不可用，云函数状态：' + cloudCode);
    });
  },

  /*------------------------- 队列 -------------------------*/

  buildQueue(onlyId) {
    const cards = activeCards();

    if (onlyId) {
      const one = cards.filter(c => c.id === onlyId);
      if (one.length) {
        this.setData({
          ready: true, card: one[0], idx: 0, total: 1,
          stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 }
        });
        return;
      }
    }

    // 默认：取今日到期的卡，最多 sessionSize 张
    const states = store.loadStates();
    const due = schedule.dueCards(cards, states, this.today);
    const n = Math.max(1, this.cfg.sessionSize || 10);
    const queue = due.slice(0, n);

    if (queue.length === 0) {
      this.setData({ ready: true, finished: true, card: null, total: 0 });
      return;
    }

    this.queue = queue;
    this.setData({
      ready: true, finished: false,
      card: queue[0], idx: 0, total: queue.length,
      stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 },
      revealed: false, result: null
    });
  },

  /*------------------------- 录音 -------------------------*/

  /**
   * 初始化本地录音管理器 —— 只在"本地服务"这条降级路径上用到。
   * 插件路径不需要它（插件内部自己录音并上传识别）。
   */
  setupRecorder() {
    this.recorder.onStart(() => {
      if (this.data._stopRequested) {
        this.setData({ _stopRequested: false });
        try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
        return;
      }
      this.setData({ recording: true, result: null, recordingMs: 0, recSec: '0.0' });
      this._timer = setInterval(() => {
        const ms = this.data.recordingMs + 100;
        this.setData({ recordingMs: ms, recSec: (ms / 1000).toFixed(1) });
      }, 100);
    });

    this.recorder.onStop(res => {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this.setData({ recording: false });
      const ms = res.duration || this.data.recordingMs;
      if (ms < 400 || !res.tempFilePath) {
        wx.showToast({ title: '按住按钮读完整个单词', icon: 'none' });
        return;
      }
      // 按通道分流：云端与本地服务都要先录音，但之后的处理不同
      if (this.voiceBackend === 'cloud') {
        this.judgeViaCloud(res.tempFilePath);
      } else {
        this.judgeViaLocal(res.tempFilePath);
      }
    });

    this.recorder.onError(() => {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this.setData({ recording: false });
      wx.showToast({ title: '录音失败，检查麦克风权限', icon: 'none' });
    });
  },

  /**
   * 录音入口：插件优先。
   *
   * 两条路径的实现细节差别很大：
   *   · 插件（WechatSI）：start 后**自动**在云端识别，stop 时直接给文本
   *   · 本地服务：先用 RecorderManager 录成文件，再上传给服务识别
   * 所以这里按后端分流，而不是硬套一条路。
   */
  startRecord() {
    if (!this.data.card || this.data.judging) return;
    if (this.data.playing) this.stopAudio();

    // 离线：没有识别能力。但**不静默**——告诉学生"可以先自己读，再对答案"
    // 这是"任何手机可用"的底线：功能降级，但流程不中断。
    if (this.voiceBackend === 'offline') {
      wx.showToast({
        title: '现在不能听你读，先自己读一遍再看答案',
        icon: 'none', duration: 2400
      });
      this.setData({ revealed: true });
      return;
    }

    if (this.voiceBackend === 'plugin') {
      this._pluginStarted = true;
      this.startPluginTimer();
      voice.recognizeOnce({ duration: 10000 }).then(r => {
        this.stopPluginTimer();
        if (!r.ok) {
          wx.showToast({ title: voice.hintFor(r.code), icon: 'none', duration: 2000 });
          return;
        }
        // 插件的 duration 是真实录音时长
        if (r.duration && r.duration < 400) {
          wx.showToast({ title: '按住按钮读完整个单词', icon: 'none' });
          return;
        }
        this.judgeText(r.text, r.duration);
      });
      return;
    }

    // 云端 / 本地服务路径：都要先本地录音，再由 onStop 决定发去哪里
    this.startLocalRecord();
  },

  stopRecord() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.voiceBackend === 'plugin') {
      // 插件：stop 会触发 onStop，识别结果在那里回来
      if (this._pluginStarted) {
        voice.stopRecognition();
        this._pluginStarted = false;
      }
      return;
    }
    if (this.data.recording) {
      this.recorder.stop();
    } else {
      this.setData({ _stopRequested: true });
    }
  },

  /** 插件的录音计时（插件不提供 onStart 事件，用本地计时器显示秒数） */
  startPluginTimer() {
    this.setData({ recording: true, recordingMs: 0, recSec: '0.0', result: null });
    this._timer = setInterval(() => {
      const ms = this.data.recordingMs + 100;
      this.setData({ recordingMs: ms, recSec: (ms / 1000).toFixed(1) });
    }, 100);
  },

  stopPluginTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.setData({ recording: false });
  },

  /** 本地服务路径的录音（原有逻辑，保留作为降级） */
  startLocalRecord() {
    this.setData({ _stopRequested: false });
    this.recorder.start({
      duration: 10000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'wav'
    });
  },

  /*------------------------- 评测 -------------------------*/

  /**
   * 用识别文本做判定 —— **完全在端上跑**（pron-judge.js，纯 JS 音素比对）。
   *
   * 这是"任何手机可用"的核心：判定不需要任何服务器。
   * 插件只负责"把声音转成文字"，剩下的判断题小程序自己算。
   */
  judgeText(heard, durationMs) {
    const card = this.data.card;
    if (!card) return;
    this.setData({ judging: true, result: null });

    // 判定（同步、极快，实测 <5ms）
    let res;
    try {
      res = judgeCore.judge(card.prompt, heard, judgeCore.vocabList(), {
        passScore: this.cfg.passScore,
        borderlineScore: this.cfg.borderlineScore
      });
    } catch (e) {
      console.error('[pron] 判定异常', e);
      this.setData({ judging: false });
      wx.showToast({ title: '这次没评上，再读一次', icon: 'none' });
      return;
    }

    this.applyResult(res, durationMs);
  },

  /** 把判定结果落到界面与记录（插件/本地两条路径共用） */
  applyResult(res, durationMs) {
    const card = this.data.card;
    const band = res.band;

    const stats = Object.assign({}, this.data.stats);
    if (band === 'pass') stats.pass += 1;
    else if (band === 'borderline') stats.borderline += 1;
    else if (band === 'fail') stats.fail += 1;

    this.setData({
      judging: false,
      result: {
        band: band,
        score: res.score,
        scorePct: res.scorePct,
        heard: res.heard,
        verdict: res.verdict,
        suggestion: res.suggestion
      },
      revealed: true,
      stats: stats
    });

    saveRecord(card.id, {
      date: this.today,
      band: band,
      score: res.score,
      heard: res.heard,
      ms: durationMs || this.data.recordingMs
    });

    if (band !== 'pass' && this.cfg.autoPlayAudio) {
      if (this._autoTimer) clearTimeout(this._autoTimer);
      this._autoTimer = setTimeout(() => {
        this._autoTimer = null;
        this.playAudio();
      }, 320);
    }
  },

  /** 走本地服务评测（降级路径） */
  /**
   * 云端通道：录音 → 云函数识别成文字 → **端上判定**。
   *
   * 为什么判定仍在端上：识别只负责"把声音变成文字"，
   * 而"这段文字像不像期望的那个词"是纯计算，端上音素判定 <5ms 就能算完。
   * 好处有三：① 省一次往返 ② 判定逻辑不依赖服务商（换 ASR 服务商不影响评分口径）
   * ③ 云端只存"文字"不存"分数"，评分标准改了不需要重新部署服务。
   */
  judgeViaCloud(filePath) {
    const card = this.data.card;
    if (!card) return;
    this.setData({ judging: true, result: null });

    asr.recognizeCloud(filePath).then(r => {
      if (!r.ok) {
        this.setData({ judging: false });
        wx.showToast({ title: asr.hintFor(r.code), icon: 'none', duration: 2200 });
        return;
      }
      const heard = String(r.text || '').trim();
      if (!heard) {
        // 识别成功但没听到内容 —— 如实说"没听到声音"，而不是报"读错了"
        this.setData({ judging: false });
        wx.showToast({ title: '没听到声音，再读一次', icon: 'none' });
        return;
      }
      // 交给端上判定引擎（与插件通道共用同一套评分口径）
      this.judgeText(heard, this.data.recordingMs);
    });
  },

  judgeViaLocal(filePath) {
    const card = this.data.card;
    if (!card) return;
    this.setData({ judging: true, result: null });

    asr.pronounce(card.prompt, filePath).then(r => {
      if (!r.ok) {
        this.setData({ judging: false });
        wx.showToast({ title: asr.hintFor(r.code), icon: 'none', duration: 2200 });
        return;
      }
      this.applyResult({
        band: r.band, score: r.score, scorePct: Math.round((r.score || 0) * 100),
        heard: r.heard, verdict: r.verdict, suggestion: r.suggestion
      }, this.data.recordingMs);
    });
  },

  /** "不会读"：直接听发音并记录为待加强 */
  markUnknown() {
    if (!this.data.card || this.data.judging) return;   // 评测中不许，避免两张卡叠显
    const stats = Object.assign({}, this.data.stats);
    stats.unknown += 1;
    this.setData({
      revealed: true,
      result: {
        band: 'unknown', score: 0, heard: '',
        verdict: '先听一遍', suggestion: '跟着读两遍，下次再考你'
      },
      stats: stats
    });
    saveRecord(this.data.card.id, {
      date: this.today, band: 'unknown', score: 0, heard: '', ms: 0
    });
    if (this.cfg.autoPlayAudio) this.playAudio();
  },

  /*------------------------- 播放发音 -------------------------*/

  setupAudio() {
    this.audio.onEnded(() => this.setData({ playing: false }));
    this.audio.onError(() => {
      this.setData({ playing: false });
      wx.showToast({ title: '发音播放失败', icon: 'none' });
    });
  },

  /**
   * 播放单词发音。
   *
   * 顺序：**随包预置音频 → 插件合成 → 本地服务**。
   *
   * 为什么把随包音频放在最前：它是唯一"零延迟 + 离线可用 + 零成本"的方案
   * （294 词共 1MB，已打进包）。插件需要主体有权限、本地服务需要电脑开机，
   * 这两条都不能作为首选。只有用户**自己录入**的词（不在 295 词表内）
   * 才没有预置音频，那时才走插件。
   */
  playAudio() {
    const card = this.data.card;
    if (!card) return;
    if (this.data.playing) { this.stopAudio(); return; }

    audioPack.resolveForPlay(card.prompt).then(r => {
      if (r.ok && r.src) { this._playUrl(r.src); return; }
      // 预置和插件都不行 → 最后试本地服务（开发期可能开着）
      if (this.voiceBackend === 'local') { this.playLocalAudio(card.prompt); return; }
      wx.showToast({ title: '这个词还没有发音，可以查词典', icon: 'none' });
    });
  },

  /** 用本地服务的预生成音频（开发期兜底） */
  playLocalAudio(word) {
    this._playUrl(asr.audioUrl(word));
  },

  _playUrl(url) {
    try {
      this.audio.src = url;
      this.audio.play();
      this.setData({ playing: true });
    } catch (e) {
      console.warn('[pron] 播放失败', e);
      this.setData({ playing: false });
      wx.showToast({ title: '发音播放失败', icon: 'none' });
    }
  },

  stopAudio() {
    try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    this.setData({ playing: false });
  },

  /**
   * 重播：与 playAudio 不同，它**不 toggle**。
   * 点第二次应该重播，而不是停止 —— 否则学生按了没声音会以为坏了。
   */
  replay() {
    const card = this.data.card;
    if (!card) return;
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    this.setData({ playing: false });
    this.playAudio();
  },

  /*------------------------- 前进 -------------------------*/

  next() {
    if (this.data.judging) return;
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (!this.queue) {
      this.setData({ finished: true });
      return;
    }
    const nextIdx = this.data.idx + 1;
    if (nextIdx >= this.queue.length) {
      this.setData({ finished: true, card: null });
      return;
    }
    this.stopAudio();
    this.setData({
      idx: nextIdx,
      card: this.queue[nextIdx],
      result: null,
      revealed: false,
      recordingMs: 0
    });
  },

  revealAnswer() {
    this.setData({ revealed: true });
  },

  restart() {
    this.buildQueue();
  },

  /** 占位：录音时用 catchtouchmove 挂住，防止页面跟着手指滚动 */
  noop() {},

  goStudy() { wx.switchTab({ url: '/pages/study/study' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
});
