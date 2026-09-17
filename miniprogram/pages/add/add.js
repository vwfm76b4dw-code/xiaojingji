const store = require('../../utils/store.js');
const cards = require('../../utils/cards.js');
const ai = require('../../utils/ai.js');

Page({
  data: {
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
    aiReady: true        // 云开发是否就绪（onLoad 时探测）
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    // 切换模式时清掉 AI 的临时结果，避免遗留上一次的预览
    this.setData({ mode: mode, aiMsg: '', aiItems: [], aiOk: false, aiDupCount: 0 });
  },

  onInput(e) {
    const key = e.currentTarget.dataset.k;
    this.setData({ [key]: e.detail.value });
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
    this.setData({ word: '', meaning: '', example: '', mnemonic: '' });
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
      if (r.saveFailed) title = '保存失败，请重试';
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
      if (r.saveFailed) title = '保存失败，请重试';
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

  /** 第四条录入来源：教材词库（独立页，按单元批量导入） */
  goCurriculum() {
    wx.navigateTo({ url: '/pages/curriculum/curriculum' });
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
    this.setData({ aiReady: ai.isAvailable() });
  }
});
