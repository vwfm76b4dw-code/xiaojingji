const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const { todayStr } = require('../../utils/date.js');

const cardStore = require('../../utils/cards.js');

/**
 * 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词）。
 *
 * ⚠️ 注意命名：这里刻意叫 cardStore 而不是 cards —— 页面里有多个局部变量
 * 也叫 cards（学科筛选后的子集），同名会让"到底在读全量还是子集"变得极难看清。
 */
function activeCards() {
  return cardStore.allCards();
}

Page({
  data: {
    today: '',
    overall: { mastered: 0, learning: 0, fresh: 0, total: 0, percent: 0 },
    subjects: [],
    dueCount: 0,
    nextDue: '',
    points: 0,
    weakCount: 0,
    // 展开的学科（点一下展开卡列表）
    expanded: '',
    cardList: [],
    // 搜索
    keyword: '',
    searching: false,
    searchResults: []
  },

  onLoad() {
    this.today = todayStr();
    this.setData({ today: this.today });
    this.refresh();
  },

  onShow() {
    // 从添加页/教材导入页返回时词库可能变了，让缓存看到新内容
    cardStore.invalidate();
    this.refresh();
  },

  refresh() {
    const all = activeCards();
    const states = store.loadStates();
    const subjects = schedule.progressBySubject(all, states, this.today);
    const overall = schedule.overallProgress(all, states);
    const due = schedule.dueCards(all, states, this.today);

    this.setData({
      subjects: subjects,
      overall: overall,
      dueCount: due.length,
      nextDue: due.length === 0 ? schedule.nextDueDate(all, states, this.today) : '',
      points: schedule.pointsOf(states),
      weakCount: store.weakIds().length
    });
  },

  /*------------------------- 搜索 -------------------------*/

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  clearSearch() {
    this.setData({ keyword: '', searching: false, searchResults: [] });
  },

  /**
   * 搜索卡片：匹配 prompt / answer / hook / tags / source。
   * 本地全量扫描即可——几百到几千张卡在手机上也就几毫秒
   * （见 docs 里的向量检索基准，纯 JS 3 万条 1024 维才 31ms，这里只是字符串包含）。
   */
  doSearch() {
    const kw = String(this.data.keyword || '').trim().toLowerCase();
    if (!kw) {
      wx.showToast({ title: '输入关键词', icon: 'none' });
      return;
    }
    const all = activeCards();
    const states = store.loadStates();

    const hits = all.filter(c => {
      const hay = [
        c.prompt, c.answer, c.hook, c.source,
        (c.tags || []).join(' ')
      ].join(' ').toLowerCase();
      return hay.indexOf(kw) !== -1;
    }).map(c => {
      const st = states[c.id];
      let status = '未学', cls = 'gray';
      if (st) {
        if (st.interval >= schedule.MASTERED_INTERVAL) { status = '已掌握'; cls = 'green'; }
        else if (st.nextReview <= this.today) { status = '待复习'; cls = 'yellow'; }
        else { status = '复习中'; cls = 'gray'; }
      }
      return {
        id: c.id, prompt: c.prompt, answer: c.answer, hook: c.hook,
        subject: c.subject, source: c.source, status: status, cls: cls
      };
    });

    this.setData({ searching: true, searchResults: hits });
    if (hits.length === 0) {
      wx.showToast({ title: '没有匹配的卡片', icon: 'none' });
    }
  },

  goWeakPractice() {
    const p = store.loadPrefs();
    store.savePrefs({ subject: p.subject || 'all', scope: 'weak' });
    wx.switchTab({ url: '/pages/study/study' });
  },

  /*------------------------- 内容管理入口 -------------------------*/

  goAdd() { wx.navigateTo({ url: '/pages/add/add' }); },
  goCurriculum() { wx.navigateTo({ url: '/pages/curriculum/curriculum' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  /** 点学科：展开/收起该学科的卡列表 */
  toggleSubject(e) {
    const s = e.currentTarget.dataset.subject;
    if (this.data.expanded === s) {
      this.setData({ expanded: '', cardList: [] });
      return;
    }
    const sub = activeCards().filter(c => (c.subject || '未分类') === s);
    const states = store.loadStates();
    const list = sub.map(c => {
      const st = states[c.id];
      let status = '未学';
      let cls = 'gray';
      if (st) {
        if (st.interval >= schedule.MASTERED_INTERVAL) { status = '已掌握'; cls = 'green'; }
        else if (st.nextReview <= this.today) { status = '待复习'; cls = 'yellow'; }
        else { status = '复习中'; cls = 'gray'; }
      }
      return {
        id: c.id,
        prompt: c.prompt,
        answer: c.answer,
        hook: c.hook,                 // 列表里也露出钩子（这是本项目的卖点）
        difficulty: c.difficulty,
        status: status,
        cls: cls,
        source: c.source
      };
    });
    this.setData({ expanded: s, cardList: list });
  },

  /** 点卡片进详情页 */
  openCard(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/card/card?id=' + id });
  },

  goStudy() {
    wx.switchTab({ url: '/pages/study/study' });
  },

  /** 清空本机学习进度（危险操作，二次确认） */
  resetProgress() {
    wx.showModal({
      title: '清空学习进度？',
      content: '单词内容不会删，但所有复习记录、掌握度、积分会归零，无法恢复。',
      confirmText: '清空',
      confirmColor: '#D95F3B',
      success: res => {
        if (!res.confirm) return;
        store.clearStates();
        cardStore.invalidate();
        this.setData({ expanded: '', cardList: [] });
        this.refresh();
        wx.showToast({ title: '已清空进度', icon: 'none' });
      }
    });
  }
});
