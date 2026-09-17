const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const { sm2, GRADE } = require('../../utils/sm2.js');
const { todayStr } = require('../../utils/date.js');

const cards = require('../../utils/cards.js');
const settings = require('../../utils/settings.js');

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

Page({
  data: {
    ready: false,
    queue: [],
    idx: 0,
    current: null,
    flipped: false,
    leaving: false,
    entering: false,
    done: false,
    reviewed: 0,
    total: 0,
    progress: 0,
    // 连对
    streak: 0,
    bestStreak: 0,
    showBadge: false,
    // 本轮统计
    roundKnow: 0,
    roundVague: 0,
    roundForgot: 0,
    // 抖动反馈
    shaking: false,

    // ---- 筛选（本轮复习范围）----
    subjects: [],           // [{subject, count}]
    subject: 'all',         // 当前学科
    scope: 'due',           // due | all | weak
    weakCount: 0,           // 错题本里的卡数
    dueCountNow: 0,         // 当前筛选下的待复习数
    // 筛选面板是否展开
    filterOpen: false,
    // 单卡模式（从卡详情页"练这一张"进来）：只练指定的一卡
    singleMode: false,
    // 被「学习量」上限挡在今天的词数（0 = 没挡）
    hiddenNew: 0,
    hiddenReview: 0,
    // 是否显示记忆钩子（来自设置）
    showHook: true,
    // 是否展开了完整钩子（默认收起，只显示一句话版）
    hookOpen: false
  },

  onLoad() {
    this.today = todayStr();
    this.states = store.loadStates();

    // 从卡详情页"练这一张"跳过来的单卡模式。
    // **读后即删**：不清掉的话，下次从 tabBar 正常进复习页会莫名其妙
    // 只出现这一张卡，而且状态会一直粘着 —— 属于最难排查的幽灵状态。
    let singleId = null;
    try {
      singleId = wx.getStorageSync('single_practice') || null;
      if (singleId) wx.removeStorageSync('single_practice');
    } catch (e) {
      console.warn('[study] 读取单卡模式标记失败', e);
    }
    this.singleId = singleId;

    const prefs = store.loadPrefs();
    this.setData({
      subjects: schedule.subjectsOf(activeCards()),
      subject: prefs.subject || 'all',
      scope: prefs.scope || 'due',
      showHook: settings.get('showHook') !== false
    });
    this.buildQueue();
  },

  onShow() {
    this.states = store.loadStates();
    // 从其它页返回时刷新（可能有新到期的）
    if (this.singleId) this.buildQueue();
    else if (this.data.done) this.buildQueue();
    else this.refreshCounts();
  },

  /*------------------------- 队列 -------------------------*/

  /** 只刷新计数，不重建队列（避免复习中途把队列洗掉） */
  refreshCounts() {
    const cards = activeCards();
    const weak = store.weakIds();
    const due = schedule.dueCards(cards, this.states, this.today);
    const picked = schedule.pickCards(cards, this.states, this.today,
      { subject: this.data.subject, scope: this.data.scope }, weak);
    this.setData({
      weakCount: weak.length,
      dueCountNow: picked.length,
      totalDue: due.length
    });
  },

  buildQueue() {
    const cards = activeCards();
    const weak = store.weakIds();
    const due = schedule.dueCards(cards, this.states, this.today);

    // 单卡模式：只练指定的这一张，练完即退出该模式
    let picked;
    let singleMode = false;
    // 先把 this.singleId 取到局部变量：下面的 filter 回调是**普通函数**，
    // 里面的 this 不是页面实例（恒为 undefined），直接写 this.singleId 会永远匹配不到。
    const wantId = this.singleId;
    if (wantId) {
      const one = cards.filter(function (c) { return c.id === wantId; });
      if (one.length > 0) {
        picked = one;
        singleMode = true;
      } else {
        // 卡已被删/清空：静默退回普通队列，不要让用户卡在空白页
        console.warn('[study] 单卡模式的卡已不存在，退回普通队列');
        this.singleId = null;
        picked = schedule.pickCards(cards, this.states, this.today,
          { subject: this.data.subject, scope: this.data.scope }, weak);
      }
    } else {
      picked = schedule.pickCards(cards, this.states, this.today,
        { subject: this.data.subject, scope: this.data.scope }, weak);
    }

    /**
     * 应用「学习量」设置（每日新词 / 每日复习上限）。
     *
     * 为什么必须做：学生设了"每天 10 个新词"，如果队列还是把 295 个词全排上，
     * 那个数字对初中生是劝退的，而且**设置项就是假的**。
     * 只在"到期"这个 scope 下限制 —— 学生主动选「全部单词」是想过一遍，
     * 那时再卡上限会显得莫名其妙。
     */
    let limitInfo = null;
    if (!singleMode && this.data.scope === 'due') {
      limitInfo = schedule.applyDailyLimits(picked, this.states, {
        dailyNewWords: settings.get('dailyNewWords'),
        dailyReviewMax: settings.get('dailyReviewMax')
      });
      picked = limitInfo.queue;
    }

    this.setData({
      ready: true,
      singleMode: singleMode,
      weakCount: weak.length,
      dueCountNow: picked.length,
      totalDue: due.length,
      // 被上限挡在今天的量（界面提示"还有 N 个明天继续"）
      hiddenNew: limitInfo ? limitInfo.hiddenNew : 0,
      hiddenReview: limitInfo ? limitInfo.hiddenReview : 0
    });

    if (picked.length === 0) {
      this.setData({
        done: true, queue: [], current: null,
        total: 0, reviewed: 0, progress: 0
      });
      return;
    }

    this.setData({
      done: false,
      queue: picked,
      idx: 0,
      current: picked[0],
      flipped: false,
      leaving: false,
      entering: false,
      reviewed: 0,
      total: picked.length,
      progress: 0,
      streak: 0,
      bestStreak: 0,
      roundKnow: 0,
      roundVague: 0,
      roundForgot: 0
    });
  },

  /*------------------------- 筛选 -------------------------*/

  toggleFilter() {
    this.setData({ filterOpen: !this.data.filterOpen });
  },

  /** 选学科：换范围后重建队列（会问一下，避免误丢当前进度） */
  pickSubject(e) {
    const s = e.currentTarget.dataset.subject;
    if (s === this.data.subject) return;
    this.applyFilter({ subject: s });
  },

  pickScope(e) {
    const s = e.currentTarget.dataset.scope;
    if (s === this.data.scope) return;
    this.applyFilter({ scope: s });
  },

  applyFilter(patch) {
    const restart = () => {
      const next = Object.assign(
        { subject: this.data.subject, scope: this.data.scope }, patch);
      store.savePrefs(next);
      this.states = store.loadStates();
      this.setData({
        subject: next.subject,
        scope: next.scope,
        filterOpen: false,
        done: false
      });
      this.buildQueue();
    };

    // 复习到一半换范围会丢掉当前轮次，先确认
    if (this.data.reviewed > 0 && !this.data.done) {
      wx.showModal({
        title: '换一批？',
        content: '当前这一轮还没做完，换范围会重新开始。',
        confirmText: '换',
        success: res => { if (res.confirm) restart(); }
      });
      return;
    }
    restart();
  },

  /** 一键只练错题 */
  practiceWeak() {
    if (this.data.weakCount === 0) {
      wx.showToast({ title: '还没有答错过的卡', icon: 'none' });
      return;
    }
    this.applyFilter({ scope: 'weak' });
  },

  /*------------------------- 翻卡与评分 -------------------------*/

  flipCard() {
    if (this.data.leaving || this.data.done) return;
    this.setData({ flipped: !this.data.flipped });
  },

  onGrade(e) {
    if (this.data.leaving || this.data.done) return;
    if (!this.data.flipped) return;              // 未翻面不许评分（主动回忆）

    /**
     * 档位合法性守卫 —— 缺了它，脏值会一路写进 SM-2 与历史记录。
     *
     * 只有 5(认识) / 3(模糊) / 1(不认识) 三个合法值。
     * 为什么要显式挡住其余值：q 从 WXML 的 dataset 传来，类型是字符串，
     * 且事件绑定写错、dataset 字段改名、或外部脚本注入都能送出任意值。
     * 一旦放进 sm2()：
     *   · q=0/2 → 被当作"不认识"，但历史里记下的是原始脏值，统计口径就歪了
     *   · q=99  → `q >= 3` 成立，白送一次"模糊"，EF 还照涨
     *   · q=NaN → `next.interval` 变 NaN，这个词的排期从此彻底失效，
     *             且 NaN 会顺着曲线与平均值污染整个统计页
     * 这类损坏是**静默且不可逆**的（历史记录一旦写入就带着脏值），
     * 所以必须在入口拦住，而不是指望下游各自容错。
     */
    const raw = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.q : undefined;
    const q = Number(raw);
    if (q !== GRADE.KNOW && q !== GRADE.VAGUE && q !== GRADE.FORGOT) return;

    const card = this.data.current;
    const st = this.states[card.id] || store.newState(this.today);

    const next = sm2(st, q, this.today);
    next.history = (st.history || []).concat([{
      date: this.today, q: q, interval: next.interval
    }]);

    // 立即落库，防中途退出丢记录。
    // **必须检查返回值**：写盘失败（存储配额满等）时如果照样推进，
    // 用户会看到"认识 → 下一张"，但这个词的进度根本没保存，
    // 重启后又从零开始 —— 而且全程没有任何提示，是最伤信任的一类 bug。
    // 失败时的处理：不推进，让用户再点一次，并明确告知原因。
    if (!store.setState(card.id, next)) {
      wx.showToast({ title: '保存失败，请再试一次', icon: 'none', duration: 1800 });
      this.setData({ leaving: false });
      return;
    }
    this.states[card.id] = next;
    cards.invalidate();                          // 让卡片缓存看到新状态

    let streak = this.data.streak;
    let best = this.data.bestStreak;
    let showBadge = false;
    if (q === GRADE.KNOW) {
      streak += 1;
      if (streak > best) best = streak;
      if (streak >= 3 && streak % 3 === 0) showBadge = true;
    } else {
      streak = 0;
    }

    const shaking = q === GRADE.FORGOT;
    if (shaking) {
      this.setData({ shaking: true });
      setTimeout(() => this.setData({ shaking: false }), 340);
    }

    wx.showToast({
      title: q === GRADE.KNOW ? ('认识 · ' + next.interval + ' 天后')
           : q === GRADE.VAGUE ? ('模糊 · ' + next.interval + ' 天后')
           : '1 天后再见',
      icon: 'none',
      duration: 900
    });

    const isLast = this.data.idx >= this.data.queue.length - 1;
    const reviewed = this.data.reviewed + 1;

    this.setData({
      leaving: true,
      streak: streak,
      bestStreak: best,
      showBadge: showBadge,
      roundKnow: this.data.roundKnow + (q === GRADE.KNOW ? 1 : 0),
      roundVague: this.data.roundVague + (q === GRADE.VAGUE ? 1 : 0),
      roundForgot: this.data.roundForgot + (q === GRADE.FORGOT ? 1 : 0)
    });

    setTimeout(() => {
      if (isLast) {
        this.setData({
          done: true, leaving: false, current: null,
          reviewed: reviewed, progress: 100
        });
        this.refreshCounts();
      } else {
        const idx = this.data.idx + 1;
        this.setData({
          idx: idx,
          current: this.data.queue[idx],
          flipped: false,
          leaving: false,
          entering: true,
          // 换卡时收起钩子详情：否则下一张进来直接是展开态，很突兀
          hookOpen: false,
          reviewed: reviewed,
          progress: Math.round((idx + 1) / this.data.queue.length * 100)
        });
        setTimeout(() => {
          this.setData({ entering: false, showBadge: false });
        }, 320);
      }
    }, 190);
  },

  goDeck() { wx.switchTab({ url: '/pages/deck/deck' }); },
  goStats() { wx.switchTab({ url: '/pages/stats/stats' }); },

  /**
   * 展开/收起完整记忆钩子。
   *
   * 用 catchtap 绑定（在 WXML 里），否则点它会连带触发翻卡。
   */
  toggleHookDetail() {
    this.setData({ hookOpen: !this.data.hookOpen });
  },

  /** 再来一轮 */
  again() {
    this.states = store.loadStates();
    this.buildQueue();
  }
});
