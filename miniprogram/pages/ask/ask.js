/**
 * 问词页 —— 学生问关于课本单词的问题，答案来自**本机检索**。
 *
 * ## 为什么改成端上优先
 * 原来这一步要连电脑上的 Python 服务（127.0.0.1:8766），手机上根本连不上，
 * 所以这个页面在真机上等于不存在。
 *
 * 而学生真正会问的问题，需要的原料**本来就在词卡里**：
 *   "geography 和哪个词容易混" → 词形 + 音素（端上算相似度）
 *   "怎么记住 holiday"          → 记忆钩子（词卡自带）
 *   "学校用品有哪些词"          → 主题标签（端上查索引）
 * 所以端上算完就能回答，不需要服务器，也不需要模型。
 *
 * ## 三层回答质量（逐层退让，但**任何一层都不为空**）
 *   ① 端上检索 + 模板作答   —— 永远可用，零依赖，离线也行
 *   ② 可选：云端润色        —— 云函数配好后交给模型组织语言，更自然（失败静默）
 *   ③ 检索不到时            —— 如实说"课本里没有"，并列出最接近的词供挑选
 */
const rag = require('../../utils/rag.js');
const cards = require('../../utils/cards.js');
const audioPack = require('../../utils/audio.js');
const schedule = require('../../utils/schedule.js');
const store = require('../../utils/store.js');
const { todayStr } = require('../../utils/date.js');

let _idx = null;          // 检索索引（惰性构建，295 词约 4ms）

Page({
  data: {
    question: '',
    asking: false,
    answer: '',
    sources: [],
    mode: '',
    viaText: '',          // 回答来源说明（端上算的 / 云端润色的）
    playingWord: '',
    /**
     * 示例问题。
     *
     * 每条都**实测答得出**才放上来（初版放了 belong / quiet，
     * 那两个词根本不在 295 词表里，点了一问就是"没找到" —— 示例反而成了打脸）。
     * describe 是给学生的说明，告诉他能问什么类型。
     */
    samples: [
      { q: 'everyone 和 everybody 有什么区别？', tag: '分辨两个词' },
      { q: 'holiday 怎么记？', tag: '记忆法' },
      { q: '课本里学校用品有哪些词？', tag: '找一类词' },
      { q: 'rock music 在第几单元？', tag: '翻课本' },
      { q: '我该复习什么？', tag: '学习建议' }
    ]
  },

  onLoad() {
    this.today = todayStr();
    this.ensureIndex();
  },

  onShow() {
    // 用户可能刚在「词库」页加了词 → 索引与词库长度不一致时重建
    if (_idx && _idx.items.length !== cards.allCards().length) {
      _idx = null;
      this.ensureIndex();
    }
  },

  /** 建检索索引（只建一次；失败不抛，页面仍可显示） */
  ensureIndex() {
    if (_idx) return _idx;
    try {
      _idx = rag.buildIndex(cards.allCards());
    } catch (e) {
      console.error('[ask] 建索引失败', e);
      _idx = null;
    }
    return _idx;
  },

  onInput(e) {
    this.setData({ question: e.detail.value });
  },

  useSample(e) {
    const i = Number(e.currentTarget.dataset.i);
    const s = this.data.samples[i];
    if (!s) return;
    this.setData({ question: s.q });
    this.ask();
  },

  ask() {
    const q = String(this.data.question || '').trim();
    if (!q) {
      wx.showToast({ title: '写个问题吧', icon: 'none' });
      return;
    }
    if (this.data.asking) return;

    this.setData({ asking: true, answer: '', sources: [], mode: '', viaText: '' });

    // 端上检索本身是同步的（几毫秒），但延迟一拍再算，
    // 让"查词典中…"有机会渲染出来 —— 快到没有反馈也是一种体验缺陷。
    setTimeout(() => {
      const idx = this.ensureIndex();
      if (!idx) {
        this.setData({
          asking: false, mode: 'error',
          answer: '词库还没准备好。先去「词库」页看看，或自己加几个词。'
        });
        return;
      }

      let r;
      try {
        // 带上真实学习数据：「我该复习什么」「哪些词总记不住」需要它
        const all = cards.allCards();
        const states = cards.allStates();
        const due = schedule.dueCards(all, states, this.today || todayStr());
        let studied = 0, fresh = 0;
        all.forEach(function (c) { states[c.id] ? studied++ : fresh++; });
        const stats = {
          dueCount: due.length,
          weakCount: store.weakIds().length,
          weakIds: store.weakIds(),
          studiedCount: studied,
          freshCount: fresh
        };
        r = rag.ask(q, all, { index: idx, stats: stats });
      } catch (e) {
        console.error('[ask] 检索异常', e);
        this.setData({ asking: false, mode: 'error', answer: '这次没查出来，换个说法再试' });
        return;
      }

      this.setData({
        asking: false,
        mode: r.mode,
        answer: r.answer || '课本词表里没找到相关的内容。',
        sources: r.sources || [],
        viaText: r.mode === 'no_match' ? '' : '答案来自本机词库检索'
      });

      this.maybeEnhance(q, r);
    }, 60);
  },

  /**
   * 云端润色（可选增强，失败**完全静默**）。
   *
   * 为什么静默：端上已经给出可用答案，润色只是锦上添花。
   * 这种情况下的任何错误提示都是打扰 —— 用户没有要求云服务，
   * 不该被云服务的失败影响。
   */
  maybeEnhance(question, localResult) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') return;
    if (!localResult.sources || localResult.sources.length === 0) return;

    // 整理材料：带上记忆钩子（那是回答质量的关键），并做去重
    const all = cards.allCards();
    const seen = {};
    const materials = [];
    localResult.sources.forEach(function (s) {
      const c = all.filter(function (x) { return x.prompt === s.word; })[0];
      if (!c || seen[c.id]) return;
      seen[c.id] = true;
      materials.push({
        word: c.prompt, meaning: c.answer,
        hook: c.hook || '', detail: c.detail || ''
      });
    });
    if (!materials.length) return;

    wx.cloud.callFunction({
      name: 'aiProxy',
      data: { action: 'askWord', question: question, materials: materials },
      success: res => {
        const r = res && res.result;
        const ans = r && r.ok && r.data && r.data.answer;
        // 只在"用户没换问题"时替换，避免把上一个问题的答案盖到新问题上
        if (ans && this.data.question.trim() === question) {
          this.setData({ answer: ans, mode: 'generated', viaText: 'AI 参考课本词库作答' });
        }
      },
      fail: () => { /* 静默：端上答案已经在页面上了 */ }
    });
  },

  /** 点来源词条：听它的发音（随包音频，离线也能听） */
  playSource(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;

    if (!this.audio) {
      this.audio = wx.createInnerAudioContext();
      this.audio.onEnded(() => this.setData({ playingWord: '' }));
      this.audio.onError(() => this.setData({ playingWord: '' }));
    }
    // 再点一次是"停止"
    if (this.data.playingWord === word) {
      try { this.audio.stop(); } catch (err) { /* 忽略 */ }
      this.setData({ playingWord: '' });
      return;
    }

    audioPack.resolveForPlay(word).then(r => {
      if (!r.ok || !r.src) {
        wx.showToast({ title: '这个词没有发音', icon: 'none' });
        return;
      }
      this.audio.src = r.src;
      this.audio.play();
      this.setData({ playingWord: word });
    });
  },

  copyAnswer() {
    if (!this.data.answer) return;
    wx.setClipboardData({ data: this.data.answer });
  },

  clearAll() {
    this.setData({ question: '', answer: '', sources: [], mode: '', viaText: '' });
  },

  goPronounce() {
    wx.switchTab({ url: '/pages/pronounce/pronounce' });
  },

  onUnload() {
    if (this.audio) {
      try { this.audio.destroy(); } catch (e) { /* 忽略 */ }
    }
  }
});
