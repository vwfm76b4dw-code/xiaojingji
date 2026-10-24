const store = require('../../utils/store.js');
const cards = require('../../utils/cards.js');
const ai = require('../../utils/ai.js');
// 小鲸键盘接线（契约 §2.3）：过滤复用组件的纯逻辑核心，不另写一份 ——
// 两处各写一遍"联想怎么过滤"迟早口径漂移（与 syllable/quiz 抽纯函数同一理由）
const asr = require('../../utils/asr.js');
const kbCore = require('../../components/xj-keyboard/keyboard-core.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    mode: 'single',
    word: '',
    meaning: '',
    example: '',
    mnemonic: '',
    batch: '',

    // ---- AI 智能录入状态 ----
    aiText: '',
    aiBusy: false,      // 解析中
    aiItems: [],        // 解析结果预览（待用户确认）
    aiMsg: '',          // 失败提示 / 降级说明
    aiDupCount: 0,      // 与现有词库重复、已被剔除的条数
    aiOk: false,        // 本次解析是否成功（决定显示预览还是提示）

    // ---- 单条 AI 生成状态 ----
    exBusy: false,
    mnBusy: false,
    aiReady: true,       // 云开发是否就绪（onLoad 时探测）

    // ---- 小鲸键盘（单词字段专用，契约 §2.3）----
    kbOpen: false,       // 键盘面板是否展开
    kbSuggestions: [],   // 联想候选（页面用 cards 词表前缀匹配好 ≤5 条，组件保持纯 UI）
    voiceEnabled: false, // 云识别可用才亮语音键（onLoad 探测，置灰时组件内 toast 兜底）
    recognizing: false   // 语音识别中：word 行显示"聆听中…"，替代会打断输入流的 toast
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    // 切换模式时清掉 AI 的临时结果，避免遗留上一次的预览
    // kbOpen 一并收起：键盘面板是页面级停靠层，不随单词字段的 wx:if 消失 ——
    // 切到"批量粘贴"还挂着字母键盘就是界面事故
    this.setData({ mode: mode, aiMsg: '', aiItems: [], aiOk: false, aiDupCount: 0, kbOpen: false });
  },

  onInput(e) {
    const key = e.currentTarget.dataset.k;
    this.setData({ [key]: e.detail.value });
  },

  /*---------------- 小鲸键盘（单词字段，契约 §2.3）----------------*/

  openWordKb() {
    this.setData({ kbOpen: true });
    this._refreshSuggestions();
  },

  closeWordKb() {
    this.setData({ kbOpen: false });
  },

  /**
   * 联想候选：当前词表前缀匹配 ≤5 条（组件只渲染不过滤 —— 契约 §2.3 的分工）。
   * 词表取 cards.allCards() 的 prompt（含用户已录与教材已导入的词）：
   * 联想的意义是"提示已在库里的词"，随口编的词不在库里，不在提示范围。
   */
  _refreshSuggestions() {
    const prompts = cards.allCards().map(function (c) { return c.prompt; });
    this.setData({ kbSuggestions: kbCore.filterSuggestions(prompts, this.data.word, 5) });
  },

  onWordInput(e) {
    this.setData({ word: e.detail.value });
    this._refreshSuggestions();
  },

  onWordSuggestion(e) {
    this.setData({ word: e.detail.value });
    this._refreshSuggestions();   // 候选命中后按新值重算：完全同名不再推荐（核心函数的行为）
  },

  /** 完成 = 收键盘。保存另有「保存」按钮 —— 两个动作语义分开，误触代价才小 */
  onWordSubmit() {
    this.setData({ kbOpen: false });
  },

  /*---------------- 语音录入（按住说，松手出词） ----------------*/

  /**
   * 语音链路：组件按住/松手 → 本页 → RecorderManager(mp3/16k) → asr.recognizeCloud。
   * 录音参数与朗读页同一套：wav 录音在腾讯 ASR 端解不开（InvalidParameterValue，
   * 见 pronounce.js 2026-09-19 的实测记录），mp3 三方全兼容 —— 不另起炉灶。
   */
  onVoice(e) {
    const start = !!(e.detail && e.detail.start);
    if (start) this._startVoice(); else this._stopVoice();
  },

  _startVoice() {
    if (!this.recorder) {
      const rec = wx.getRecorderManager();
      rec.onStop(res => this._onVoiceFile(res && res.tempFilePath));
      rec.onError(() => {
        this.setData({ recognizing: false });
        wx.showToast({ title: '没录上音，请检查麦克风权限', icon: 'none' });
      });
      this.recorder = rec;
    }
    this.recorder.start({
      duration: 6000,               // 单词最长 6 秒足够；到点自动 onStop 兜底按住不松的人
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    });
    this.setData({ recognizing: true });
  },

  _stopVoice() {
    if (this.recorder) this.recorder.stop();
  },

  _onVoiceFile(filePath) {
    if (!filePath) {
      this.setData({ recognizing: false });
      return;
    }
    asr.recognizeCloud(filePath).then(r => {
      this.setData({ recognizing: false });
      if (!r || !r.ok) {
        wx.showToast({ title: asr.hintFor(r && r.code), icon: 'none' });
        return;
      }
      // 云端识别回的可能是整句话或中文：只取打头的英文段当单词。
      // 为什么不原样填入 —— word 字段的规范形是"纯英文词条"，混入标点/释义
      // 会让卡片索引键脏掉（race（v.）的教训：括注进键是有意设计，意外标点不是）。
      const m = String(r.text || '').toLowerCase().match(/[a-z][a-z'-]*/);
      if (!m) {
        wx.showToast({ title: '没听清是哪个单词，再试一次', icon: 'none' });
        return;
      }
      this.setData({ word: m[0], kbOpen: true });   // 展开键盘让学生确认/补字母
      this._refreshSuggestions();
    });
  },

  saveSingle() {
    const r = store.addWord({
      word: this.data.word,
      meaning: this.data.meaning,
      example: this.data.example,
      mnemonic: this.data.mnemonic
    });
    if (!r.ok) {
      wx.showToast({ title: r.msg, icon: 'none' });
      return;
    }
    wx.showToast({ title: '已加入今日复习', icon: 'none' });
    // kbSuggestions 一并清空：word 已清空，旧候选留着会显示"与输入无关的联想"
    this.setData({ word: '', meaning: '', example: '', mnemonic: '', kbSuggestions: [] });
  },

  saveBatch() {
    const r = store.addBatch(this.data.batch);
    if (!r.ok) {
      // 三种失败要分开说：① 写盘失败 ② 这些词全都在词库里 ③ 格式没认出来。
      // ② 若沿用 ③ 的文案，用户会去改格式白费功夫 ——
      // AI 路径（runAiParse）同场景说的是「这些词都已经在词库里了」，两条路径口径必须一致。
      // ① 判定必须用 saveFailed：ok:false 时 added 恒为 0（store 的三条 return 路径都是），
      // 所以原先的 `r.added > 0` 是**恒假的死分支** —— 写盘失败会被说成"没有可识别的词条"。
      let title = '没有可识别的词条';
      if (r.saveFailed) title = store.saveFailureText();
      else if (r.dupSkipped > 0 && r.dupSkipped === r.skipped.length) title = '这些词都已经在词库里了';
      wx.showToast({ title: title, icon: 'none' });
      return;
    }
    const extra = r.skipped.length > 0 ? '，跳过 ' + r.skipped.length + ' 条' : '';
    cards.invalidate();          // 让卡片缓存看到新词，否则返回列表看不到刚加的内容
    wx.showToast({ title: '已添加 ' + r.added + ' 个词' + extra, icon: 'none', duration: 1200 });
    this.setData({ batch: '' });
  },

  /*------------------------ AI 智能录入 ------------------------*/

  /** 第一步：解析。结果只进预览，不落库——用户确认后才写入 */
  runAiParse() {
    if (this.data.aiBusy) return;

    const text = this.data.aiText.trim();
    if (!text) {
      wx.showToast({ title: '先写点想录的单词', icon: 'none' });
      return;
    }

    this.setData({ aiBusy: true, aiMsg: '', aiItems: [], aiOk: false, aiDupCount: 0 });

    ai.parseBatch(text, store.loadWords()).then((r) => {
      this.setData({ aiBusy: false });
      if (!r.ok) {
        this.setData({ aiOk: false, aiMsg: r.msg });
        return;
      }
      this.setData({
        aiOk: true,
        aiItems: r.items,
        aiDupCount: r.dupCount,
        aiMsg: r.items.length === 0 ? '这些词都已经在词库里了' : ''
      });
    });
  },

  /** 从预览里剔除某一项（AI 可能多识别出不想要的词） */
  dropAiItem(e) {
    const i = Number(e.currentTarget.dataset.i);
    const items = this.data.aiItems.slice();
    items.splice(i, 1);
    this.setData({ aiItems: items });
  },

  /** 第二步：确认落库 */
  confirmAiItems() {
    const items = this.data.aiItems;
    if (items.length === 0) {
      wx.showToast({ title: '没有可添加的词', icon: 'none' });
      return;
    }

    const r = store.addItems(items);
    if (!r.ok) {
      // 与 saveBatch 三分支同口径：写盘失败 / 这些词全都在词库里 / 没有可用条目。
      // 全重复时 addItems 返回 ok:false 且 added=0 —— 若沿用"保存失败"，
      // 用户会以为是故障去重试，实际上再试多少次结果都一样。
      // 反过来，写盘失败必须用 saveFailed 判定（理由见 saveBatch）。
      let title = '没有可识别的词条';
      if (r.saveFailed) title = store.saveFailureText();
      else if (r.dupSkipped > 0 && r.dupSkipped === r.skipped.length) title = '这些词都已经在词库里了';
      wx.showToast({ title: title, icon: 'none' });
      return;
    }

    let msg = '已添加 ' + r.added + ' 个词';
    if (r.skipped.length > 0) msg += '，跳过 ' + r.skipped.length + ' 个';
    wx.showToast({ title: msg, icon: 'none', duration: 1400 });
    this.setData({ aiText: '', aiItems: [], aiOk: false, aiMsg: '', aiDupCount: 0 });
  },

  /** 解析失败时的退路：带着已写的内容切到批量粘贴 */
  switchToBatch() {
    this.setData({ mode: 'batch', batch: this.data.aiText, aiMsg: '', aiItems: [], aiOk: false });
  },

  /**
   * 第四条录入来源：教材词库（分包内的独立页，按单元批量导入）。
   *
   * ⚠️ 路径带 `pack-curriculum/` 前缀 —— 2026-09-24 起教材页与 24 册数据
   * 整体搬进分包（主包只剩 46 KB，装不下 293 KB 的教材模块）。
   * 主包**不能引用分包资源**，但 `navigateTo` 分包页面是官方支持的正常用法，
   * 跳转时微信会自动下载该分包。
   */
  goCurriculum() {
    wx.navigateTo({ url: '/pack-curriculum/pages/curriculum/curriculum' });
  },

  /*---------------- 单条模式下的 AI 辅助生成 ----------------*/

  genExample() {
    const word = this.data.word.trim();
    if (!word || this.data.exBusy) {
      if (!word) wx.showToast({ title: '先填单词', icon: 'none' });
      return;
    }
    this.setData({ exBusy: true });
    ai.genExample(word, this.data.meaning).then((r) => {
      this.setData({ exBusy: false });
      if (!r.ok) {
        wx.showToast({ title: r.msg, icon: 'none', duration: 1600 });
        return;
      }
      this.setData({ example: r.value });
      wx.showToast({
        title: r.fromPreset ? '已填入词库现成例句' : '例句已生成',
        icon: 'none'
      });
    });
  },

  genMnemonic() {
    const word = this.data.word.trim();
    if (!word || this.data.mnBusy) {
      if (!word) wx.showToast({ title: '先填单词', icon: 'none' });
      return;
    }
    this.setData({ mnBusy: true });
    ai.genMnemonic(word).then((r) => {
      this.setData({ mnBusy: false });
      if (!r.ok) {
        wx.showToast({ title: r.msg, icon: 'none', duration: 1600 });
        return;
      }
      this.setData({ mnemonic: r.value });
      wx.showToast({
        title: r.fromPreset ? '已填入词库现成记忆法' : '记忆法已生成',
        icon: 'none'
      });
    });
  },

  /** AI 是否可用（不可用时界面如实说明，而不是点下去才报错） */
  onLoad() {
    this.setData({
      aiReady: ai.isAvailable(),
      // 语音键亮不亮跟着云走：asr.recognizeCloud 只在 cloudReady 时能出结果，
      // 不ready 就置灰（组件内点它有 toast 兜底解释，页面不必重复拦截）
      voiceEnabled: asr.cloudReady()
    });
  }
}));
