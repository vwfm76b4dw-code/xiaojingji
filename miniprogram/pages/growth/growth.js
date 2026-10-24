/**
 * 增长看板页 —— 连胜 / 累计天数 / 护身符 / 检查点 / 积分 / 进步榜。
 *
 * ## 这个页面存在的理由
 * 背单词最大的敌人不是"难"，是"没意思、看不到进展、断一次就放弃"。
 * 这一页把三件事摆到明面上：
 *   ① **看得见的进展** —— 连胜、累计天数、已掌握词数（三个数都不因断签清零）
 *   ② **看得见的下一步** —— 今天还差几个、下一个检查点还差多少
 *   ③ **看得见的回报** —— 积分能换成什么（护身符 / 再练一组），不是个摆设数字
 *
 * ## 设计立场（都来自 docs/增长机制研究与文案库.md 的取舍结论）
 * · **不设段位升降、不展示完整榜单**：几十人规模下那是负向机制（详见 utils/rank.js）
 * · **连胜归零不清累计天数**：断签挽回的关键是"别让他觉得白干了"
 * · **护身符上限 2 张**：无限囤会让连胜失去真实性
 * · **积分不做装饰品**：能换的都是"能继续学下去的东西"
 */
const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const settings = require('../../utils/settings.js');
const growth = require('../../utils/growth.js');
const copy = require('../../utils/growth-copy.js');
const rank = require('../../utils/rank.js');
const quiz = require('../../utils/quiz.js');
const advisor = require('../../utils/learn-advisor.js');   // 本地学习量推荐（纯本地、零 LLM）
const { todayStr } = require('../../utils/date.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/** 存储读取：任何一个键坏了都不能让整页白屏，统一走这个 */
function readJSON(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? fallback : v;
  } catch (e) { return fallback; }
}
function writeJSON(key, val) {
  try { wx.setStorageSync(key, val); return true; } catch (e) { return false; }
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    ready: false,
    today: '',

    // 连胜三件套
    streak: 0, best: 0, activeDays: 0,
    todayDone: false, atRisk: false,

    // 今日目标
    goal: { done: 0, goal: 10, met: false, percent: 0, remain: 0 },

    // 护身符
    charms: { available: 0, earned: 0, used: 0, max: 2, nextFreeAt: 0 },
    charmPrice: growth.CHARM_PRICE,

    // 检查点
    checkpoints: { list: [], passedCount: 0, total: 0, next: null },

    // 单元测验（主动验收，与检查点互补）
    quizPassed: 0,
    quizTotal: 0,

    // 积分
    points: { review: 0, spell: 0, pron: 0, checkpoint: 0, total: 0 },
    balance: 0,
    title: { name: '', toNext: 0, nextName: '', percent: 0 },
    spends: growth.SPENDS,
    extraBoughtToday: false,
    extraBatchPrice: growth.EXTRA_BATCH_PRICE,

    // 断签状态
    broken: false,
    bridged: 0,               // 本次进页自动用掉的护身符张数

    // 排行榜
    rankOn: false,
    rankNick: '',
    rankList: [],
    rankMe: null,
    rankTotal: 0,
    rankErr: '',

    // 大英雄卡数字口径的可见说明（2026-09-30 用户反馈「怎么这么随机」）。
    // 设计：默认收起一行字"这三个数是怎么算的？"，点开才放完整说明。
    // 为什么用折叠而不是工具提示：tooltip 在小程序里只能弹，modal 又太重，
    // 把答案直接放在数字下面、默认收起、点开读完整版 —— 是本页其它卡片
    // （检查点、测验、进步榜）已经在用的节奏，同一种"有疑问点进去"的肌肉记忆。
    heroExplainOpen: false,

    // 学习建议卡：可展开的本地推荐
    adviceOpen: false,
    advice: null,  // advisor.recommend() 的结果，ready 后填

    // 文案
    say: ''
  },

  onLoad() {
    this.today = todayStr();
    this.setData({ today: this.today });
  },

  onShow() {
    this.refresh();
  },

  /*------------------------- 计算与渲染 -------------------------*/

  refresh() {
    const today = this.today;
    const cfg = settings.load();
    const states = store.loadStates();
    const pron = store.loadPronRecords();
    const spell = store.loadSpellRecords();

    const dates = growth.activeDates(states, pron, spell);
    let repairs = readJSON(growth.REPAIR_KEY, []);
    if (!Array.isArray(repairs)) repairs = [];
    const bought = Number(readJSON(growth.BOUGHT_KEY, 0)) || 0;

    /* ---- ① 断签自动兜底：有护身符就默默盖住（不等用户点）---- */
    const bridged = this._autoBridge(dates, repairs, bought);
    if (bridged > 0) repairs = readJSON(growth.REPAIR_KEY, []);

    /* ---- ② 连胜 ---- */
    const st = growth.streakOf(dates, today, { repairs: repairs });

    /* ---- ③ 护身符账本 ---- */
    const charms = growth.charmsOf(st.best, bought, repairs.length);

    /* ---- ④ 今日目标 ---- */
    const goal = growth.dailyGoalOf(states, today, cfg.dailyLimit);

    /* ---- ⑤ 积分与称号 ---- */
    const mastered = schedule.masteredCount(store.loadCards(), states);
    // 单元测验的奖励：可推导（通过单元数 × 单价），所以不需要单独记账
    const quizRecs = quiz.recordsOf(readJSON(quiz.QUIZ_KEY, {}));
    const quizBonus = quiz.bonusOf(quizRecs);
    const points = growth.pointsBreakdown({
      states: states, pron: pron, spell: spell,
      mastered: mastered, bestStreak: st.best, quizBonus: quizBonus
    });
    const spent = Number(readJSON(growth.SPENT_KEY, 0)) || 0;
    const balance = growth.balanceOf(points.total, spent);
    const title = growth.titleOf(points.total);
    const checkpoints = growth.checkpointsOf(mastered, st.best);

    const extraDay = readJSON(growth.EXTRA_KEY, '');
    const extraBoughtToday = extraDay === today;

    /* 学习建议（本地，零 LLM）：
     * advisor 的输入与上面计算同一来源，保证推荐与展示的"近 7 天活跃"是同一份。
     * 失败时不渲染卡片（advice 留 null，wxml 的 wx:if 不展开），不影响主流程。 */
    let advice = null;
    try {
      const todayPlanCount = schedule.dailyQueue(store.loadCards(), states, today,
        { subject: 'all', unit: 'all', scope: 'due' }, store.weakIds(), {
          dailyNewWords: settings.get('dailyNewWords'),
          dailyReviewMax: settings.get('dailyReviewMax')
        }).queue.length;
      const rec = advisor.recommend({
        states: states,
        pron: pron,
        spell: spell,
        cards: store.loadCards(),
        today: today,
        current: { dailyNewWords: cfg.dailyNewWords, dailyReviewMax: cfg.dailyReviewMax },
        currentStreak: st.current,
        todayPlan: todayPlanCount
      });
      /* UI 派生字段：百分比的忘记率要显示 "32%" 而不是 0.32；
       * summarize 是一句"近 7 天 X 天 / 共 Y 次 / 忘记率 Z%"的事实播报，
       * 具体推荐值由 rec.reason 承担（"为什么是这个数"），两者职责分开 ——
       * reason 可以放在按钮上方的解释行，summary 放在顶部小字。 */
      advice = Object.assign({}, rec, { summary: advisor.summarize(rec) });
      if (advice.inputs && advice.inputs.forget14 !== null && advice.inputs.forget14 !== undefined) {
        advice.inputs.forget14Pct = Math.round(advice.inputs.forget14 * 100);
      }
    } catch (e) { advice = null; }

    /* ---- ⑥ 文案 ---- */
    let say;
    if (goal.met) {
      say = copy.pick('goalDone', null, today);
    } else if (st.atRisk) {
      say = copy.pick('streakRisk', { n: st.current, r: goal.remain }, today);
    } else if (st.todayDone) {
      const msScene = copy.milestoneScene(st.current);
      say = msScene ? copy.pick(msScene, { n: st.current }, today)
                    : copy.pick('streakDone', { n: st.current }, today);
    } else if (goal.done > 0) {
      say = copy.pick('goalRemain', { r: goal.remain }, today);
    } else if (!st.current && st.activeDays > 0) {
      say = copy.pick('broken', { m: mastered, d: st.activeDays }, today);
    } else {
      say = copy.pick('hello', null, today);
    }

    this.setData({
      ready: true,
      streak: st.current,
      best: st.best,
      activeDays: st.activeDays,
      todayDone: st.todayDone,
      atRisk: st.atRisk,
      goal: goal,
      charms: charms,
      checkpoints: checkpoints,
      points: points,
      balance: balance,
      title: title,
      extraBoughtToday: extraBoughtToday,
      quizPassed: Object.keys(quizRecs).filter(function (k) { return quizRecs[k].passedAt; }).length,
      quizTotal: quiz.unitsOf(store.loadCards(), states).length,
      broken: !st.current && st.activeDays > 0 && !st.todayDone,
      bridged: bridged,
      say: say,
      advice: advice
    });

    this._loadRank();
  },

  /**
   * 断签自动兜底：把断掉的那几天用护身符盖住。
   *
   * 为什么**自动**而不是让用户点：会来看这一页的人本来就还没放弃；
   * 真正流失的人是"断了就再也不打开" —— 他们需要的是**下次打开时连胜还在**，
   * 而不是一个需要他先点的按钮。所以这里默默盖住，只在文案里提一句。
   *
   * @returns {number} 本次用掉的护身符张数
   */
  _autoBridge(dates, repairs, bought) {
    const gap = growth.gapInfo(dates, this.today, repairs);
    if (gap.gapDays === 0 || !gap.hasHistory) return 0;

    const st = growth.streakOf(dates, this.today, { repairs: repairs });
    const charms = growth.charmsOf(st.best, bought, repairs.length);
    const plan = growth.bridgePlan(gap.gapDays, charms.available, 0);
    if (plan.autoUse <= 0) return 0;

    // 只盖"有护身符"的那部分；盖不满就不盖（避免出现"盖了 1 天还显示断签"的半截状态）
    if (plan.needManual > 0) return 0;

    const next = repairs.concat(gap.missedDates.slice(0, plan.autoUse));
    if (!writeJSON(growth.REPAIR_KEY, next)) return 0;
    return plan.autoUse;
  },

  /*------------------------- 排行榜 -------------------------*/

  _loadRank() {
    const on = rank.isOn();
    this.setData({ rankOn: on, rankNick: rank.nick() || rank.defaultNick() });
    if (!on) { this.setData({ rankList: [], rankMe: null, rankTotal: 0, rankErr: '' }); return; }

    const self = this;
    rank.submit().then(function (sub) {
      if (sub && sub.ok && sub.me) self.setData({ rankMe: sub.me });
      return rank.fetchTop();
    }).then(function (r) {
      if (!r || !r.ok) {
        self.setData({ rankErr: (r && r.msg) || '榜单暂时看不了' });
        return;
      }
      self.setData({
        rankList: r.list || [], rankMe: r.me || self.data.rankMe,
        rankTotal: r.total || 0, rankErr: ''
      });
    }).catch(function () {
      self.setData({ rankErr: '榜单暂时看不了' });
    });
  },

  /** 开关排行榜。开 → 上报并拉榜；关 → 真删记录（不是隐藏） */
  toggleRank() {
    const self = this;
    if (this.data.rankOn) {
      wx.showModal({
        title: '退出排行榜',
        content: '会从云端删掉你的成绩记录，之后榜单上看不到你。本机的学习数据不受影响。',
        confirmText: '退出',
        confirmColor: '#D95F3B',
        success: function (res) {
          if (!res.confirm) return;
          rank.turnOff().then(function () {
            self.setData({ rankOn: false, rankList: [], rankMe: null, rankTotal: 0 });
            wx.showToast({ title: '已退出排行榜', icon: 'none' });
          });
        }
      });
      return;
    }
    rank.setNick(this.data.rankNick);
    rank.setOn(true);
    this.setData({ rankOn: true, rankErr: '' });
    this._loadRank();
  },

  /** 改昵称（1~8 字，默认是匿名的「同学1234」） */
  editNick() {
    const self = this;
    wx.showModal({
      title: '榜单上的名字',
      content: '1~8 个字。建议不要用真名，同学之间认得出就够了。',
      editable: true,
      placeholderText: this.data.rankNick || rank.defaultNick(),
      success: function (res) {
        if (!res.confirm) return;
        const v = String(res.content || '').trim();
        if (!v) return;
        rank.setNick(v);
        self.setData({ rankNick: rank.nick() });
        if (self.data.rankOn) self._loadRank();
      }
    });
  },

  refreshRank() { this._loadRank(); },

  /*------------------------- 积分用途 -------------------------*/

  /** 兑换护身符（上限 2 张，满了不让买 —— 不能无限囤） */
  buyCharm() {
    const self = this;
    const c = this.data.charms;
    if (c.earned >= c.max) {
      wx.showToast({ title: '最多带 ' + c.max + ' 张，先用掉再买', icon: 'none' });
      return;
    }
    if (this.data.balance < growth.CHARM_PRICE) {
      wx.showToast({ title: '还差 ' + (growth.CHARM_PRICE - this.data.balance) + ' 积分', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '兑换护身符',
      content: '花 ' + growth.CHARM_PRICE + ' 积分换 1 张。断签时自动用掉一张，连胜不断。',
      confirmText: '兑换',
      success: function (res) {
        if (!res.confirm) return;
        const bought = (Number(readJSON(growth.BOUGHT_KEY, 0)) || 0) + 1;
        const spent = (Number(readJSON(growth.SPENT_KEY, 0)) || 0) + growth.CHARM_PRICE;
        writeJSON(growth.BOUGHT_KEY, bought);
        writeJSON(growth.SPENT_KEY, spent);
        wx.showToast({ title: '护身符 +1', icon: 'none' });
        self.refresh();
      }
    });
  },

  /**
   * 解锁「再练一组」：当日目标完成后，再给一批。
   *
   * 为什么这是最有价值的积分用途：每日限流本来是保护（防一次练太多），
   * 但对想多练的学生它就是**阻碍** —— 他今天想多背 10 个，系统说"明天吧"。
   * 让他花积分继续，等于把"限流"从墙变成了可解锁的门。
   */
  buyExtraBatch() {
    const self = this;
    if (this.data.extraBoughtToday) {
      wx.showToast({ title: '今天已经解锁过了', icon: 'none' });
      return;
    }
    if (this.data.balance < growth.EXTRA_BATCH_PRICE) {
      wx.showToast({ title: '还差 ' + (growth.EXTRA_BATCH_PRICE - this.data.balance) + ' 积分', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '再练一组',
      content: '花 ' + growth.EXTRA_BATCH_PRICE + ' 积分，今天再多练 ' +
        growth.EXTRA_BATCH_SIZE + ' 张（只限今天）。',
      confirmText: '解锁',
      success: function (res) {
        if (!res.confirm) return;
        const spent = (Number(readJSON(growth.SPENT_KEY, 0)) || 0) + growth.EXTRA_BATCH_PRICE;
        writeJSON(growth.SPENT_KEY, spent);
        writeJSON(growth.EXTRA_KEY, self.today);
        wx.showToast({ title: '已解锁，去复习页看看', icon: 'none' });
        self.refresh();
      }
    });
  },

  /** 积分说明：把"积分从哪来、能干什么"一次讲清 */
  explainPoints() {
    const p = this.data.points;
    wx.showModal({
      title: '积分从哪来',
      content: '复习：认识 +4 · 模糊 +2 · 不认识 +0（不扣分）\n'
        + '拼写：拼对 +3\n'
        + '朗读：读准 +5 · 接近 +2\n'
        + '过检查点另有奖励\n\n'
        + '当前：复习 ' + p.review + ' + 拼写 ' + p.spell + ' + 朗读 ' + p.pron
        + ' + 检查点 ' + p.checkpoint + (p.quiz ? ' + 单元测验 ' + p.quiz : '')
        + ' = ' + p.total,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /*------------------------- 跳转 -------------------------*/

  /** 展开/收起「这三个数是怎么算的」（顶部大英雄卡的口径说明） */
  toggleHeroExplain() {
    this.setData({ heroExplainOpen: !this.data.heroExplainOpen });
  },

  /** 展开/收起「学习建议」卡 */
  toggleAdvice() {
    this.setData({ adviceOpen: !this.data.adviceOpen });
  },

  /**
   * 应用本地推荐：把 advisor 的建议值写入 settings.dailyNewWords/dailyReviewMax。
   * 只在开关已开时提供入口；写入后立即在 settings 也可见（同一份 settings）。
   * 为什么不直接由 advisor 写盘：设置页的"家长控制"拦不住 advisor 写盘 ——
   * 但 advisor 是**推荐层**，写盘是**用户决策**，两者必须分得开。
   */
  applyAdvice() {
    const a = this.data.advice;
    if (!a || !a.adjusted) return;
    settings.save({
      dailyNewWords: a.newWords,
      dailyReviewMax: a.reviewMax
    });
    wx.showToast({ title: '已采用推荐的学习量', icon: 'none' });
    // 重新计算 advice：它的 reason 会基于新 current 值变化（"加点冲量"等可能消失）
    this.refresh();
  },

  goStudy() { wx.switchTab({ url: '/pages/study/study' }); },
  goSpelling() { wx.navigateTo({ url: '/pages/spelling/spelling' }); },
  goQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }); },
  // 2026-09-25 底部栏整理：stats 退出 tabBar，switchTab 只对 tabBar 页有效
  // （对普通页静默失败），必须 navigateTo。
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); },
  // 社交域入口（D 域新增，页面在 pack-social 分包）
  goFriends() { wx.navigateTo({ url: '/pack-social/pages/friends/friends' }); },

  /** 检查点详情：点一下就说明"这关是什么、过了给多少" */
  tapCheckpoint(e) {
    const i = e.currentTarget.dataset.i;
    const cp = (this.data.checkpoints.list || [])[i];
    if (!cp) return;
    wx.showModal({
      title: cp.name,
      content: (cp.kind === 'mastered'
          ? '掌握 ' + cp.at + ' 个词（一个词连续记住 21 天算掌握）'
          : '连续学习 ' + cp.at + ' 天')
        + '\n过了给 ' + cp.reward + ' 积分。\n'
        + (cp.passed ? '这一关已经过了。' : '还没到，继续。'),
      showCancel: false,
      confirmText: '知道了'
    });
  }
}));
