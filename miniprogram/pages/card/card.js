/**
 * 卡片详情页 —— 看一张词的全部信息，以及它的算法状态与复习历史。
 *
 * 这个页面的价值：让"算法在做什么"变得可解释。
 * 学生在这里能看到 EF（难度系数）、间隔、下次复习时间、以及每次评分的记录，
 * 从而理解"为什么今天让我复习这个词"——而不是把排期当成黑箱。
 */
const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const cards = require('../../utils/cards.js');
const audioPack = require('../../utils/audio.js');
const { todayStr } = require('../../utils/date.js');
const ipaMod = require('../../utils/ipa.js');
const phonemes = require('../../utils/phoneme-table.js');
const sylMod = require('../../utils/syllable.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/**
 * 「来源」行规则 —— 与 pages/study/study.js 的 sourceLabel **同一套契约**
 *（unit 优先 / 学段常量不显示 / 全无则空）。为什么是两份实现而不是共享 util：
 * 本域改动红线约束下无法新增第三个共享模块，一致性由 tools/verify-reviewUX.js
 * 用同一组输入分别驱动两个页面断言同一输出 —— 门禁保证而非口头保证。
 */
const STAGE_LABELS = ['junior high', 'junior high school', 'senior high',
  'senior high school', 'primary school', 'elementary school', 'junior school',
  '初中', '初中英语', '小学', '小学英语', '高中'];

function isStageLabel(s) {
  return STAGE_LABELS.indexOf(String(s || '').trim().toLowerCase()) >= 0;
}

function sourceLabel(unit, source) {
  const u = String(unit || '').trim();
  const s = String(source || '').trim();
  const parts = [];
  if (u && !isStageLabel(u)) parts.push(u);
  if (s && !isStageLabel(s)) {
    let rest = u ? s.split(u).join('') : s;   // 剥掉 source 末尾的 unit（详见 study.js 同名注释）
    rest = rest.replace(/^[\s·—\-–/、,，·]+|[\s·—\-–/、,，·]+$/g, '').trim();
    if (rest && !isStageLabel(rest) && rest !== u) parts.push(rest);
  }
  return parts.join(' · ');
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    playingWord: '',
    ready: false,
    card: null,
    // 来源行（sourceLabel 产物；'' 时 wxml 整行不渲染）
    srcText: '',
    // 音标与音节分段（口径同复习页）
    phon: '',
    sylParts: null,
    state: null,
    // 人类可读的状态行
    statusText: '',
    statusClass: 'gray',
    // 该卡的历史（最近几条）
    history: [],
    // 同一批（同来源单元）的邻卡
    siblings: []
  },

  onLoad(query) {
    const id = query && query.id;
    if (!id) {
      this.setData({ ready: true });
      return;
    }

    const card = cards.getCard(id);
    if (!card) {
      // 卡不存在（比如词库被清空后从旧链接进来）：给空态而不是白屏
      this.setData({ ready: true });
      return;
    }

    const today = todayStr();
    const st = cards.getState(id);

    // 状态文案：让用户看懂这张卡现在处于什么阶段
    let statusText = '还没学过';
    let statusClass = 'gray';
    if (st) {
      if (st.interval >= schedule.MASTERED_INTERVAL) {
        statusText = '已掌握（间隔 ' + st.interval + ' 天）';
        statusClass = 'green';
      } else if (st.nextReview <= today) {
        statusText = '待复习（应于 ' + st.nextReview + '）';
        statusClass = 'yellow';
      } else {
        statusText = '复习中 · 下次 ' + st.nextReview + '（' + st.interval + ' 天间隔）';
        statusClass = 'gray';
      }
    }

    // 历史倒序（最近的在上面）
    const history = st && Array.isArray(st.history)
      ? st.history.slice().reverse().map(function (h) {
          const q = Number((h || {}).q);
          return {
            date: (h && h.date) || '',
            grade: q >= 5 ? '认识' : (q >= 3 ? '模糊' : '不认识'),
            cls: q >= 5 ? 'green' : (q >= 3 ? 'yellow' : 'red'),
            interval: (h && h.interval) || 0
          };
        })
      : [];

    // 同批的其他卡（便于"这一批还有哪些"）
    // 按 batch 分组；没有 batch 的老数据按 source 兜底，避免退化成"全库前 8 张"
    const sameGroup = function (c) {
      if (card.batch) return c.batch === card.batch;
      return card.source ? c.source === card.source : false;
    };
    const sibs = cards.allCards()
      .filter(function (c) { return c.id !== id && sameGroup(c); })
      .slice(0, 8)
      .map(function (c) { return { id: c.id, prompt: c.prompt }; });

    this.setData({
      ready: true,
      card: card,
      state: st,
      statusText: statusText,
      statusClass: statusClass,
      history: history,
      siblings: sibs,
      /**
       * 音标 + 音节分段（2026-09-25 加）。
       *
       * 卡详情页此前**完全没有音标** —— 而它正是学生"点开看一个词到底怎么回事"
       * 的地方，恰恰最需要"怎么读"。口径与复习页保持一致（同一个 ipa / syllable 模块），
       * 两处不一致会让人怀疑数据。
       */
      phon: ipaMod.forWord(card.prompt, phonemes),
      sylParts: sylMod.displayParts(card.prompt),
      srcText: sourceLabel(card.unit, card.source)
    });

    // 词库被清空时 card.subject 可能为空，标题要兜一下
    wx.setNavigationBarTitle({ title: (card.subject || '词') + ' · 卡片' });
  },

  /** 跳另一张卡 */
  openCard(e) {
    const id = e.currentTarget.dataset.id;
    wx.redirectTo({ url: '/pages/card/card?id=' + id });
  },

  /** 把这句钩子复制走（学生可能想抄进本子） */
  copyHook() {
    if (!this.data.card) return;
    const c = this.data.card;
    wx.setClipboardData({
      data: c.prompt + ' → ' + c.answer +
        (c.hook ? '\n记忆钩子：' + c.hook : '') +
        // 来源行与界面同口径（sourceLabel 产物）：常量级学段标签不值得进学生的摘抄
        (this.data.srcText ? '\n来源：' + this.data.srcText : '')
    });
  },

  /**
   * 从卡详情直接练这一张。
   *
   * 实现方式：把卡片 id 写进 single_practice，跳到复习页由它消费。
   * 消费方**必须读后即删**（见 study.js），否则下次正常进复习页
   * 会莫名其妙只出现这一张卡 —— 那是最难排查的一类"幽灵状态"。
   */
  /**
   * 发音：随包音频，离线可听；再点一次是停止。
   * 卡详情页是"看这个词的全部信息"的地方，却一直听不到它 —— 补上。
   */
  playWord() {
    const c = this.data.card;
    if (!c) return;
    if (!this.audio) {
      this.audio = wx.createInnerAudioContext();
      this.audio.onEnded(() => this.setData({ playingWord: '' }));
      this.audio.onError(() => this.setData({ playingWord: '' }));
    }
    if (this.data.playingWord === c.id) {
      try { this.audio.stop(); } catch (err) { /* 忽略 */ }
      this.setData({ playingWord: '' });
      return;
    }
    audioPack.resolveForPlay(c.prompt).then(r => {
      if (!r || !r.ok || !r.src) {
        wx.showToast({ title: '这个词没有发音', icon: 'none' });
        return;
      }
      this.audio.stop();
      this.audio.src = r.src;
      this.audio.play();
      this.setData({ playingWord: c.id });
    });
  },

  onUnload() {
    if (this.audio) { try { this.audio.destroy(); } catch (err) { /* 忽略 */ } }
  },

  practiceOne() {
    if (!this.data.card) return;
    wx.setStorageSync('single_practice', this.data.card.id);
    wx.switchTab({ url: '/pages/study/study' });
  },

  /**
   * 删除这个单词。
   *
   * 为什么放在详情页：词库列表页已经并入卡组页（那里是浏览+筛选的入口），
   * 删除属于低频且危险的操作，放在"看到这个词的全部信息"的详情页里更合适——
   * 用户是看着内容决定删的，而不是在列表里手滑长按。
   *
   * 二次确认是必须的：词条与学习进度同记录（见 utils/store.js 的数据模型说明），
   * 删除会**连带丢掉这个词的全部复习历史**，不可恢复。
   */
  removeCard() {
    const c = this.data.card;
    if (!c) return;
    wx.showModal({
      title: '删除「' + c.prompt + '」？',
      content: '这个词的复习进度与历史记录会一起删除，无法恢复。',
      confirmText: '删除',
      confirmColor: '#D95F3B',
      success: (res) => {
        if (!res.confirm) return;
        const ok = store.removeWord(c.id);
        if (!ok) {
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          return;
        }
        cards.invalidate();
        wx.showToast({ title: '已删除', icon: 'none' });
        // 延迟返回，让用户看到提示；返回上一页而不是停在一个"卡片不存在"的空页
        setTimeout(() => {
          const pages = getCurrentPages();
          if (pages.length > 1) wx.navigateBack();
          else wx.switchTab({ url: '/pages/deck/deck' });
        }, 600);
      }
    });
  },

  goDeck() { wx.switchTab({ url: '/pages/deck/deck' }); }
}));
