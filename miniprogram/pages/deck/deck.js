const store = require('../../utils/store.js');
const quotes = require('../../utils/quotes.js');
const schedule = require('../../utils/schedule.js');
const { todayStr } = require('../../utils/date.js');

const cardStore = require('../../utils/cards.js');
const settings = require('../../utils/settings.js');
const growth = require('../../utils/growth.js');
const bootPrep = require('../../utils/boot-prep.js');   // 启动资源准备管线（首启预热小条的数据源）
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新



/**
 * 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词）。
 *
 * ⚠️ 注意命名：这里刻意叫 cardStore 而不是 cards —— 页面里有多个局部变量
 * 也叫 cards（学科筛选后的子集），同名会让"到底在读全量还是子集"变得极难看清。
 */
function activeCards() {
  return cardStore.allCards();
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）。显式声明过「wxml 引用字段必须在 data 初始化」的门禁；
    // withTheme 只在缺失时兜底，声明后由它的 onShow 刷新接管
    themeClass: 'theme-paper',
    today: '',
    overall: { mastered: 0, learning: 0, fresh: 0, total: 0, percent: 0 },
    subjects: [],
    // 按单元练：[{ unit, count, learned, due }]，只在单元数 > 1 时才渲染
    units: [],
    dueCount: 0,
    // 副文案前缀：当前范围的单元名（'' = 不限，全库）。见 refresh() 的 scopeLabel
    scopeLabel: '',
    nextDue: '',
    points: 0,
    // 连胜与累计天数（成长看板的入口数字）
    streakDays: 0,
    streakLabel: '',
    activeDays: 0,
    weakCount: 0,
    // 展开的学科（点一下展开卡列表）
    expanded: '',
    cardList: [],
    // 搜索
    keyword: '',
    searching: false,
    searchResults: [],

    // 启动资源准备小条（boot-prep）：null = 不显示。非 null 时
    // { done, total, percent, stageLabel }。WXML 引用字段必须在 data 初始化（项目门禁）
    prepBar: null
  },

  onLoad() {
    this.today = todayStr();
    this.setData({ today: this.today });
    this.refresh();
    this.syncPrepBar();
  },

  onShow() {
    // 从添加页/教材导入页返回时词库可能变了，让缓存看到新内容
    cardStore.invalidate();
    this.refresh();
    this.syncPrepBar();
  },

  onHide() {
    // 资源准备小条的轮询停掉：页面不可见时刷新 setData 毫无意义
    this.stopPrepPoll();
  },

  onUnload() {
    this.stopPrepPoll();
  },

  /*------------------------- 启动资源准备小条 -------------------------*/

  /**
   * 同步资源准备小条（boot-prep 管线的唯一 UI 出口）。
   *
   * ## 出现条件（verify-boot.js 有断言）
   * 管线已启动（started）且没跑完（未 settled 或没 doneAll）→ 显示；
   * 全部完成（doneAll）或管线从未启动 → 不显示并停轮询。
   *
   * ## 为什么是 1 秒轮询而不是订阅回调
   * 管线每完成一个 3KB 小文件都会变一次状态，订阅意味着要么 294 次 setData
   * （其中绝大多数只前进 1/295，用户根本看不出差别），要么管线里再做节流 ——
   * 把 UI 的刷新节奏塞进管线状态机。轮询把节流权留在 UI 侧：1 秒一次 setData，
   * 成本可忽略；管线的状态机因此保持纯净（只有状态，没有通知）。
   *
   * ## 收起（dismiss）的语义
   * 用户点「收起」= 本次会话不再打扰（_prepDismissed 会话级内存标记，
   * 不落盘）：下载在后台继续，下次冷启动若还没下完会再次出现。
   * 不做成"永久关闭"：资源没备齐这个事实不该被一个 ✕ 永久掩盖。
   */
  syncPrepBar() {
    if (this._prepDismissed) return;
    let st = null;
    try { st = bootPrep.status(); } catch (e) { st = null; }
    // 终态判定：doneAll（全部就绪）直接收；settled 但没跑满（部分失败）也停
    // 轮询 —— 状态不会再自己变化，继续轮询是空转，小条转为"待补下"文案静置
    if (!st || !st.started || st.doneAll || st.settled) {
      if (this.data.prepBar) this.setData({ prepBar: null });
      this.stopPrepPoll();
      // settled 未跑满：不再轮询，但若还挂着小条，换成如实交代失败的一句话
      if (st && st.started && st.settled && !st.doneAll && !this._prepDismissed) {
        this.setData({ prepBar: {
          done: st.done, total: st.total, percent: st.percent,
          stageLabel: '部分资源待补下（重启小程序自动继续）'
        }});
      }
      return;
    }
    this.setData({
      prepBar: {
        done: st.done, total: st.total, percent: st.percent,
        stageLabel: st.stageLabel
      }
    });
    if (!this._prepTimer) {
      const self = this;
      this._prepTimer = setInterval(function () { self.syncPrepBar(); }, 1000);
    }
  },

  /** 用户点「收起」：本次会话不再出现（见 syncPrepBar 的收起语义） */
  dismissPrep() {
    this._prepDismissed = true;
    this.stopPrepPoll();
    if (this.data.prepBar) this.setData({ prepBar: null });
  },

  stopPrepPoll() {
    if (this._prepTimer) { clearInterval(this._prepTimer); this._prepTimer = null; }
  },

  refresh() {
    const all = activeCards();
    const states = store.loadStates();
    const subjects = schedule.progressBySubject(all, states, this.today);
    const overall = schedule.overallProgress(all, states);
    const weak = store.weakIds();

    /**
     * 当前学习范围 —— 与复习页 onLoad 读的是**同一份 prefs**。
     *
     * prefs.unit 不是"复习页的私有筛选"，它是学生**当前选择的学习范围**：
     * 它已经落盘，复习页 onLoad 会照着它建队列。首页的「今天要练的」既然叫
     * "今天要练的"，就该反映**他当前范围内**今天要练多少，而不是假装没有单元筛选
     * 这回事 —— 否则学生看到一个数字、点进去拿到另一个，又回到"点了没反应 /
     * 数字与动作打架"这一类毛病（2026-09-19 修的就是这一处）。
     */
    const prefs = store.loadPrefs();
    const subject = prefs.subject || 'all';
    const unit = prefs.unit || 'all';

    /**
     * 「今日待复习」数字必须和复习页**同口径**（2026-09-18 起，2026-09-19 补齐范围）。
     *
     * 历史：原来是全库 due.length（显示 229 而点进去只有 10 张 —— 被每日上限限流）。
     * 改成同一个 applyDailyLimits 后数字对上了，但**范围**还漏着：
     * prefs.unit='7A Starter' 时首页仍按全库算 38，而复习页会读 prefs 建 33 张的队列。
     *
     * 现在整体走 schedule.dailyQueue()：范围（subject/unit）+ 上限判据（与
     * study.js 的 shouldApplyLimits 同一个纯函数）+ 限流，三步一次算完。
     * 于是"首页这个数字"与"点「开始」后的队列长度"必然相等，而不是靠两页记得写一样。
     */
    const limited = schedule.dailyQueue(all, states, this.today,
      { subject: subject, unit: unit, scope: 'due' }, weak, {
        dailyNewWords: settings.get('dailyNewWords'),
        dailyReviewMax: settings.get('dailyReviewMax')
      });
    const todayTotal = limited.queue.length;
    let todayNew = 0;
    limited.queue.forEach(function (c) { if (!states[c.id]) todayNew += 1; });

    /**
     * 范围文案：让学生看得出"现在是有范围的"。
     *
     * 不这么做的话，选了「7A Starter」之后首页那个 33 是**神秘数字** ——
     * 学生没有任何线索知道它为什么不是 38。只加在既有那行副文案的开头，
     * 不新增卡片、不动布局（作者对界面错位很敏感）。
     * 单元比学科更具体，两者同时存在时只说单元。
     */
    const scopeLabel = unit !== 'all' ? unit : (subject !== 'all' ? subject : '');

    /**
     * 「下一批到期」也要跟着范围走：它回答的是"我这个范围内下次什么时候有活"。
     * 若仍取全库，选了单元的学生会看到一个属于**别的单元**的日期 —— 同样是数字与
     * 范围打架。这里用 scope 'all' 取该范围的全部卡（不按到期过滤），再找最早未来到期日。
     */
    const scopedPool = schedule.pickCards(all, states, this.today,
      { subject: subject, unit: unit, scope: 'all' }, weak);

    /**
     * 按单元练：每个单元那一行"点进去实际会给多少张"。
     *
     * ⚠️ 这里**不能**套 applyDailyLimits：学生显式选了单元时复习页不限流
     * （见 study.js buildQueue 的说明），所以该单元真实张数就是 pickCards 的结果。
     * 若这里照旧限流，首页会显示 10 而点进去是 43 —— 首页数字和复习页打架，
     * 正是这个项目已经立过规矩要消灭的现象。
     *
     * 两个口径（与 practiceUnit 的 scope 分支一一对应，见 wxml 的 data-scope）：
     *   due > 0 → 显示今天到期的 N 张，点进去走 scope 'due'，队列就是这 N 张；
     *   due = 0 → 显示该单元词总数，点进去走 scope 'all'，队列就是整单元。
     *             due 为 0 时**不能**只显示"已练完"就完了：词都掌握了、今天不到期，
     *             但学生明天要听写，此刻恰恰最需要整单元过一遍（那是死路）。
     *             总数取自 unitsOf 的 count —— 它与 pickCards 的单元过滤用的是
     *             同一个判据（c.unit || UNGROUPED_UNIT），所以两处数字必然相等。
     *
     * ⚠️ 这一组刻意用 subject:'all'：单元名已经唯一确定了这批词，再和学科求交集
     * 可能把队列筛空（"点了没反应"），这也是 study.consumePending 的既有口径。
     *
     * 开销：7 个单元 × 295 词的全表过滤，量级可忽略（纯字符串比较，毫秒级）。
     */
    const self = this;
    const units = schedule.unitsOf(all, states).map(function (u) {
      const queue = schedule.pickCards(all, states, self.today,
        { subject: 'all', scope: 'due', unit: u.unit }, weak);
      return Object.assign({}, u, { due: queue.length });
    });

    /**
     * 连胜与累计天数（2026-09-24 加）。
     *
     * 首页顶部常驻，是留存的第一杠杆 —— 用户打开就看见"连续几天"，才会在意断不断。
     * 口径与成长看板页**完全一致**（同一个 growth 模块 + 同一份护身符记录），
     * 两处数字一旦打架，用户会立刻怀疑数据是假的。
     *
     * 只算一次：连胜要遍历全部复习/朗读/拼写记录，重复算三遍纯属浪费。
     */
    const streak = growth.streakOf(
      growth.activeDates(states, store.loadPronRecords(), store.loadSpellRecords()),
      this.today,
      { repairs: (function () {
          try { const v = wx.getStorageSync(growth.REPAIR_KEY); return Array.isArray(v) ? v : []; }
          catch (e) { return []; }
        })() }
    );
    const streakLabel = streak.todayDone ? '天连胜 · 今天已打卡'
      : (streak.current > 0 ? '天连胜 · 今天还差一点'
        : (streak.activeDays > 0 ? '今天重新开始' : '今天开始连胜'));

    this.setData({
      subjects: subjects,
      overall: overall,
      dueCount: todayTotal,          // 今日计划张数（与复习页一致）
      // 时长估计（按钮副文案"约 N 分钟"）：按每张约 45 秒（读题+回忆+评分）向上取整。
      // 是估计不是承诺 —— 文案用"约"，误差对学生是可接受的。
      dueMins: Math.max(1, Math.round(todayTotal * 0.75)),
      // 今日一句（按日期轮换）：督促但不施压的正反馈，放在任务卡下面顺手看到
      quote: quotes.todayQuote(self.today),
      // 称号：积分里程碑（积分从"数字"变成"身份"——100 新秀 / 500 能手 / 1500 掌门 / 4000 传说）
      title: (function (pts) {
        if (pts >= 4000) return '词海传说';
        if (pts >= 1500) return '背诵掌门';
        if (pts >= 500) return '单词能手';
        if (pts >= 100) return '单词新秀';
        return '初出茅庐';
      })(schedule.pointsOf(states)),

      /* 连胜与累计天数：上面算好的，直接用（别在这里再算一遍） */
      streakDays: streak.current,
      streakLabel: streakLabel,
      activeDays: streak.activeDays,
      todayNew: todayNew,            // 其中新词
      todayReview: todayTotal - todayNew,
      scopeLabel: scopeLabel,        // 副文案前缀：让"有范围"这件事可见
      /**
       * 词库里还剩多少没学 —— **保持全库口径，不跟范围走**。
       *
       * 它讲的是"库存"，与"今天要练多少"不是一回事：这句话的主语是"词库"，
       * 学生问的是"我这一整本词书还有多少没碰过"。若改成按单元算，学完一个单元后
       * 这里会变成「词库里还有 0 个词没学」—— 对"词库"这个词是**假话**，
       * 而且会让学生误以为整本书背完了。所以它保持全库，也不加范围前缀
       * （加了就等于暗示它是当前范围的数字）。
       */
      // 今日进度（今日任务卡的进度条）：已学 = 所有卡的历史里 date==today 的条数。
      // 全库百分比是一辈子的数字（1% 永远在爬），学生要看到的是"今天这一块走到哪了"。
      todayPlan: todayTotal + (function () {
        let n = 0;
        Object.keys(states).forEach(function (id) {
          ((states[id] || {}).history || []).forEach(function (h) {
            if (h.date === self.today) n++;
          });
        });
        return n;
      })(),
      todayDone: (function () {
        let n = 0;
        Object.keys(states).forEach(function (id) {
          ((states[id] || {}).history || []).forEach(function (h) {
            if (h.date === self.today) n++;
          });
        });
        return n;
      })(),
      freshTotal: schedule.freshCount(all, states),
      nextDue: todayTotal === 0 ? schedule.nextDueDate(scopedPool, states, this.today) : '',
      points: schedule.pointsOf(states),
      weakCount: weak.length,
      units: units
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

  /**
   * 错题重练：把"只看错题"作为一次性请求交给复习页。
   *
   * 为什么光 savePrefs 不够（2026-09-18 修的真 bug）：
   * 复习页是 tabBar 长生命周期实例，wx.switchTab 到已创建的页面**不重跑 onLoad**，
   * 只跑 onShow；而 prefs 只在 onLoad 里读一次。于是 prefs 落了盘，
   * 页面的 this.data.scope 却仍是 'due' —— 首页显示"错题本 11 个"，
   * 点进去还是普通队列。
   *
   * 现在 savePrefs 保留（负责"切走再回来还记得"），
   * 真正让页面**立刻**切过去的是 pending_study，由 study.js 的
   * consumePending() 在 onShow 里读后即删。
   */
  goWeakPractice() {
    const p = store.loadPrefs();
    store.savePrefs({ subject: p.subject || 'all', scope: 'weak' });
    try {
      wx.setStorageSync('pending_study', { scope: 'weak' });
    } catch (err) {
      // 写不进去只影响"这次立刻生效"，prefs 那份仍会在下次 onLoad 生效 —— 不至于白点
      console.warn('[deck] 写入错题重练请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  },

  /**
   * 按单元练：只练点中的那一单元（首页的直白入口）。
   *
   * 场景来自作者原话："明天听写 Unit 2，我只背这一单元。"
   * 这个筛选原来只藏在复习页的筛选面板里，学生打开首页看不到。
   *
   * 与 goWeakPractice 同一条通道（pending_study，读后即删）——
   * 复习页是 tabBar 长生命周期实例，写 prefs 不会让它立刻换范围。
   *
   * ## scope 由该行"今天有没有到期的"决定（2026-09-18 修）
   * 原来固定送 scope 'due'，于是**已学过且今天都不到期的单元点进去是空的**：
   * 首页那一行写着"已练完"，点进去也是"今日已完成"—— 对"明天听写"的场景是死路。
   * 现在 due = 0 的单元送 scope 'all'（整单元过一遍），due > 0 仍送 'due'。
   * 两者的数字口径见 refresh() 里 units 的注释，与 wxml 的 data-scope 同源。
   *
   * dataset 缺失时兜底 'due'：宁可这次点进去是空的（完成页），
   * 也不能因为一个笔误把整单元的几十张卡硬塞给学生。
   */
  practiceUnit(e) {
    const unit = e.currentTarget.dataset.unit;
    if (!unit) return;
    const scope = e.currentTarget.dataset.scope === 'all' ? 'all' : 'due';
    try {
      wx.setStorageSync('pending_study', { unit: unit, scope: scope });
    } catch (err) {
      console.warn('[deck] 写入按单元练请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  },

  /*------------------------- 内容管理入口 -------------------------*/

  goAdd() { wx.navigateTo({ url: '/pages/add/add' }); },
  goCurriculum() { wx.navigateTo({ url: '/pack-curriculum/pages/curriculum/curriculum' }); },
  goSpelling() { wx.navigateTo({ url: '/pages/spelling/spelling' }); },

  /**
   * 问词入口（2026-09-25 底部栏整理）：ask 页退出 tabBar 后 switchTab 对它失效
   * （switchTab 只能跳 tabBar 页，对普通页静默失败），必须 navigateTo。
   */
  goAsk() { wx.navigateTo({ url: '/pages/ask/ask' }); },

  /**
   * 积分说明：点了印章弹这个。积分的"用"是身份与节奏——
   * 它只增不减（不清进度也不清），由每日完成量自然累积。
   */
  explainPoints() {
    wx.showModal({
      title: '积分怎么来？',
      content: '每拼对/认出一个词都有积分：认识 +4 · 模糊 +2 · 拼对 +3 · 朗读读准 +5。'
        + '积分只增不减，攒到 100/500/1500/4000 会升级称号：新秀 → 能手 → 掌门 → 传说。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  /** 去成长看板（连胜 / 累计天数 / 护身符 / 检查点 / 积分 / 进步榜） */
  goGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }); },

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

  /**
   * 「开始」—— 开始今天的任务。
   *
   * ⚠️ 必须显式把范围压成"当前 prefs 的 subject/unit + scope 'due'"，
   * 而不能只 switchTab。复习页是 tabBar 长生命周期实例，不写 pending_study 时
   * 它保持上一次的范围 —— 学生若刚点过「错题重练」（prefs.scope='weak'），
   * 首页写着「今天要练的 33」、点进去却是错题本，数字与动作又打架。
   *
   * 为什么 unit 也要带上：consumePending 对"没指定单元"的请求会把 unit 重置成
   * 'all'（那是给错题重练用的口径），只送 {scope:'due'} 会把学生刚选好的单元丢掉。
   * 带上它，复习页拿到的范围就与首页这个数字**逐字一致**。
   */
  goStudy() {
    const p = store.loadPrefs();
    try {
      wx.setStorageSync('pending_study', {
        scope: 'due',
        unit: p.unit || 'all',
        subject: p.subject || 'all'
      });
    } catch (err) {
      // 写不进去只影响"这次立刻对齐"，prefs 那份仍会让复习页 onLoad 拿到同样的范围
      console.warn('[deck] 写入今日任务请求失败', err);
    }
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
}));
