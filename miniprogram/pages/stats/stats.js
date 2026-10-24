const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const chart = require('../../utils/chart.js');
const analysis = require('../../utils/analysis.js');
const spellingMod = require('../../utils/spelling.js');
const { todayStr } = require('../../utils/date.js');

const cards = require('../../utils/cards.js');
const ai = require('../../utils/ai.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

/**
 * 组 → 该组含有的画布对应的补画方法（与 stats.wxml 的 groups.gN 分区一一对应）。
 *
 * 为什么必须是**一张账目表**而不是散在各分支里的 if：组收起期间 wx:if 把画布
 * 节点摘掉了，refresh 里的 draw* 拿到 null 节点早返（本页固定契约），展开组必须
 * 补画该组**全部**画布，漏一块就是"展开后白板"。散装 if 的写法每加一块画布
 * 要记得回来改两处（refresh 的 nextTick 清单 + toggleGroup 的分支），漏一处
 * 就是 2026-09-27 用户反馈「很多 UI 展开之后就没有了」的病根形态——本页
 * refresh 的 nextTick 清单就真的漏过 drawForgetLine（现行病例，同日修）。
 * 改成表之后加画布 = 在对应组多写一个方法名，verify-visual 的 R1 会拿
 * wxml 的画布归属与这张表逐组对账，漏记直接红。
 *
 * g1（进度与习惯）没有画布，也进表：R1 会断言 data.groups 的键与这张表的键
 * 相等 —— 以后新增分组忘了登记，门禁同样红。
 */
const GROUP_DRAWS = {
  g1: [],
  g2: ['drawCurve', 'drawSediment'],
  g3: ['drawForgetLine'],
  g4: ['drawReviewDist', 'drawWeekday', 'drawSubjectBars']
};

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    ready: false,
    overall: null,
    self: null,
    points: 0,
    curveSummary: '',
    // 复习量分布（按复习次数）
    reviewDist: [],
    // 各学科掌握情况
    subjects: [],

    /* ---- 学习分析（utils/analysis.js 的 analyze() 结果）----
     * 与上面的 overall/self/points 是**两套口径**，所以用独立字段名盛放，互不覆盖：
     *   overall/self 来自 utils/schedule.js（实时排期视角）
     *   analysis 来自 utils/analysis.js（历史分析视角，多了连续性/沉淀指数/遗忘）
     */
    analysis: null,
    // 沉淀指数的分解项，额外带 weightPct —— 权重是 0.3 这种小数，
    // 直接写进 WXML 做 `{{item.weight * 100}}` 会渲染成 30.000000000000004。
    sedimentBreakdown: [],
    // forgetting.worst 只给 wordId，这里补上词形（界面不能拿 id 给用户看）
    forgotWords: [],
    // 空态开关：无数据时显示引导文案，而不是一排 0
    hasReviewEvents: false,
    hasStudied: false,
    hasPron: false,
    // reviewsPerMature 为 null 表示"还没有已牢记的词"，不是"效率为 0"
    hasEfficiency: false,
    // 分组折叠状态（2026-09-19：13 个区块一条长道 → 4 组可折叠，默认只全开前两组）
    groups: { g1: true, g2: true, g3: true, g4: false },
    // 预先算好的展示值，避免把算术散进 WXML
    activeRatePct: 0,
    streakHint: '',
    growthText: '',
    weekdayHint: '',

    /* ---- AI 学习分析（runAiAnalysis 的产物与失败指引）----
     * ⚠️ 只在这里初始化，refresh() 不再重置：stats 是 tabBar 长生命周期页，
     * 每次 onShow 都跑 refresh，原实现把 aiAnalysis 一并清空 —— 学生切个 tab
     * 回来，刚生成的分析就没了。AI 文本只归 runAiAnalysis 管（开始时清、
     * 成功时写、失败时清并写 aiFailHint）。
     */
    aiAnalysis: '',
    aiBusy: false,
    // AI 分析失败的人话指引：与朗读页同款的"可行动失败"—— aiProxy 未部署时
    // 原实现只弹一句"网络不太好"的瞬时 toast，学生重试一百次也不会好。
    // 指引常驻在分析卡里，含精确的部署/配置步骤
    aiFailHint: ''
  },

  onLoad() {
    this.today = todayStr();
    this.refresh();
  },

  onShow() {
    // 主题重绘契约（2026-09-27 钉死）：六个 draw 全部走 refresh()→nextTick，
    // 颜色在**绘制时**经 theme.accentColor() 现取 —— 从设置页换完主题回到本页
    // 必经这里，画布随新主题重画，不需要额外的主题变更事件。
    // 为什么不监听某个"主题变了"的全局通知：本页所有画布本来就是每次 onShow
    // 全量重画的（数据也可能在别页变过），多一条事件通道只会多一种漏接的可能。
    // refresh 的 nextTick 清单完整性由 verify-visual 的 R3 钉死，漏一个 draw 即红。
    this.refresh();
  },

  /**
   * 分组展开/收起。
   *
   * ⚠️ 展开含 canvas 的组必须**补画**：组收起期间 wx:if 把画布节点摘掉了，
   * refresh 里的 draw* 拿到 null 节点早返（本页固定契约）——
   * 不补画的话，展开后用户看到的是一块空白画布。
   */
  toggleGroup(e) {
    const g = e.currentTarget.dataset.g;
    if (!g || !this.data.groups || !(g in this.data.groups)) return;
    // 用户亲手拨过 g4 之后，refresh() 不再自动接管它的开合（见 refresh 的注释）
    if (g === 'g4') this._g4Manual = true;
    const groups = Object.assign({}, this.data.groups);
    groups[g] = !groups[g];
    this.setData({ groups: groups }, () => {
      if (!groups[g]) return;
      this.redrawGroup(g);
    });
  },

  /**
   * 展开一个组后，按 GROUP_DRAWS 账目表补画该组**全部**画布。
   *
   * 为什么在 setData 回调之后还要再包一层 wx.nextTick：setData 回调虽在渲染
   * 完成后触发，但真机上"刚由 wx:if 插入的 canvas 节点"立即查询仍有拿不到
   * node 的案例；refresh() 的首屏补画统一走 nextTick，这里沿用同一节奏 ——
   * 同一页不搞两套时序。拿不到节点时 initCanvas 照契约 resolve(null)，
   * draw 内部早返，不报错也不画半截。
   */
  redrawGroup(g) {
    const draws = GROUP_DRAWS[g] || [];
    wx.nextTick(() => {
      draws.forEach(name => { this[name](); });
    });
  },

  refresh() {
    const cards = activeCards();
    const states = store.loadStates();

    const overall = schedule.overallProgress(cards, states);
    const self = schedule.selfCheck(cards, states);
    const curve = schedule.intervalCurve(states);
    const points = schedule.pointsOf(states);
    const weakIds = store.weakIds();

    // 逐卡进度分布：按复习次数分档，看"多少卡已经进入第 N 轮"
    const buckets = { 未学: 0, '1 轮': 0, '2 轮': 0, '3 轮': 0, '4 轮+': 0 };
    cards.forEach(c => {
      const st = states[c.id];
      if (!st || !(st.history || []).length) { buckets['未学']++; return; }
      const n = st.history.length;
      if (n === 1) buckets['1 轮']++;
      else if (n === 2) buckets['2 轮']++;
      else if (n === 3) buckets['3 轮']++;
      else buckets['4 轮+']++;
    });

    // 错题本按学科的分布 —— 知道"哪科薄弱"才能针对性补
    const weakBySubject = {};
    cards.forEach(c => {
      if (weakIds.indexOf(c.id) === -1) return;
      const s = c.subject || '未分类';
      weakBySubject[s] = (weakBySubject[s] || 0) + 1;
    });
    const weakList = Object.keys(weakBySubject)
      .map(s => ({ subject: s, count: weakBySubject[s] }))
      .sort((a, b) => b.count - a.count);

    let curveSummary = '还没有复习记录';
    if (curve.length >= 2) {
      const first = curve[0].y, last = curve[curve.length - 1].y;
      const times = Math.round(last / (first || 1));
      curveSummary = '第 ' + curve.length + ' 次复习的平均间隔已到 ' + last +
        ' 天（第 1 次是 ' + first + ' 天，约 ' + times + ' 倍）';
    } else if (curve.length === 1) {
      curveSummary = '首轮平均间隔 ' + curve[0].y + ' 天';
    }

    /* ================= 学习分析（utils/analysis.js）=================
     * 一次性算完所有指标：页面若逐个调用，会出现"连击按上一份快照算"这类
     * 彼此不自洽的数字。集中计算保证同一份数据快照。
     */
    const an = analysis.analyze(cards, states, this.today, {
      windowDays: 30,
      pronRecords: store.loadPronRecords()
    });

    // 近 14 天每日忘记率（遗忘统计的折线图数据）
    const forgetDaily = analysis.dailyForget(cards, states, this.today, 14);

    // forgetting.worst 只返回 wordId，用户看不懂。补词形。
    // 词条可能已被删除（历史还在），这种情况给出可读的占位而不是空白。
    const wordById = {};
    cards.forEach(c => { wordById[c.id] = c.prompt || ''; });
    const forgotWords = (an.forgetting.worst || []).map(w => ({
      wordId: w.wordId,
      word: wordById[w.wordId] || '（词条已删除）',
      count: w.count
    }));

    // 拼写表现（历史维度：spell_records 聚合 —— 拼写练习是产出型任务，
    // "能认出来"≠"能拼出来"，错误原因分布直接指导练什么）
    const wordByIdSpell = {};
    cards.forEach(c => { wordByIdSpell[c.id] = c.prompt || ''; });
    const spell = spellingMod.analyze(store.loadSpellRecords(), wordByIdSpell);

    // 发音薄弱词 top10（analysis.pronunciation.worst 此前算了没接线 ——
    // "分析功能不完整"最直接的一块：练完朗读却看不到"我哪个词最差"）
    const pronWorst = ((an.pronunciation && an.pronunciation.worst) || []).map(w => ({
      wordId: w.wordId,
      word: wordById[w.wordId] || '（词条已删除）',
      trouble: w.trouble,
      attempts: w.attempts
    }));

    /**
     * 连续天数的鼓励语 —— 本页最重要的正反馈，措辞决定它是"刻薄"还是"温和"。
     * 口径见 analysis.streak：今天没学但昨天学了仍算连续，所以这里只区分
     * "活着（含今天没学）"与"已断"，不去指责用户。
     */
    const sk = an.streak;
    let streakHint = '';
    if (an.events > 0) {
      if (sk.alive) {
        streakHint = sk.current >= sk.longest
          ? '这是你目前为止最长的连续记录，别断'
          : '历史最长 ' + sk.longest + ' 天，再坚持 ' + (sk.longest - sk.current) + ' 天追平';
      } else {
        streakHint = '已中断 ' + sk.daysSinceLast + ' 天。今天复习一张，连续天数就从 1 重新开始';
      }
    }

    /**
     * 间隔增长倍率。与既有的"间隔增长曲线"卡片是同一现象的两种口径：
     * 曲线卡片画形状与数值，这里只补一句"涨了多少倍"，所以放在效率卡片里。
     * growth 为 null 表示首轮平均间隔是 0（无法定义倍数，而不是"增长 0 倍"），
     * 此时留空由 wx:if 隐掉 —— 界面上不能出现"增长 null 倍"。
     */
    const g = an.growth || {};
    const growthText = Number.isFinite(g.growth) && g.growth > 0
      ? '平均复习间隔已拉到首轮的 ' + g.growth + ' 倍（' + g.first + ' 天 → ' + g.last + ' 天）'
      : '';

    /**
     * 星期分布的一句话解读。
     * 只在样本 ≥3 次的那天里找"忘记率最高"的：1 次记录就能刷出 100%，
     * 拿它去指点用户"周二别背单词"是拿噪音当结论。
     */
    let weekdayHint = '柱子是各天的复习次数。';
    const risky = (an.weekday || [])
      .filter(w => w.value >= 3)
      .sort((a, b) => b.forgotRate - a.forgotRate)[0];
    if (risky && risky.forgotRate > 0) {
      weekdayHint = '柱子是各天的复习次数；' + risky.label + '的忘记率最高（' +
        risky.forgotRate + '%），那天可以少排点新词。';
    }

    // 沉淀指数分解：把 0.3 这类权重折成 30，避免 WXML 里做浮点乘法
    const sedimentBreakdown = (an.sediment.breakdown || []).map(b => ({
      key: b.key,
      note: b.note,
      ratio: b.ratio,
      points: b.points,
      weightPct: Math.round(b.weight * 100)
    }));

    this.setData({
      ready: true,
      overall: overall,
      self: self,
      points: points,
      curveSummary: curveSummary,
      reviewDist: Object.keys(buckets).map(k => ({ label: k, value: buckets[k] })),
      subjects: schedule.progressBySubject(cards, states, this.today),
      weakCount: weakIds.length,
      weakList: weakList,
      analysis: an,
      sedimentBreakdown: sedimentBreakdown,
      forgotWords: forgotWords,
      pronWorst: pronWorst,
      spell: spell,
      hasSpell: spell.hasData,
      forgetDaily: forgetDaily,
      hasReviewEvents: an.events > 0,
      hasStudied: an.retention.studied > 0,
      hasPron: an.pronunciation.attempts > 0,
      hasEfficiency: an.efficiency.reviewsPerMature !== null,
      /* g4 只在用户**没亲手拨过**时自动开合（2026-09-27 修）：原实现每次 onShow
       * 都把 g4 硬掰回"有朗读记录=开"，学生手动收起后重进页面又被顶开——
       * 重渲染不尊重既有交互状态，与"展开后内容没了"是同一家族的病。
       * 为什么用实例标记 _g4Manual 而不是 data 字段：它是交互史，不参与渲染，
       * 进 data 还得白跑一次 setData；stats 现为 navigateTo 页，实例随离开销毁，
       * 会话级标记正好与页面生命周期同长（重进一页重新给自动开合，合理）。
       * 行为断言在 verify-visual R4。 */
      groups: Object.assign({}, this.data.groups,
        (!this._g4Manual && an.pronunciation.attempts > 0) ? { g4: true } : {}),
      activeRatePct: Math.round(an.activeRate * 100),
      streakHint: streakHint,
      growthText: growthText,
      weekdayHint: weekdayHint
    });

    wx.nextTick(() => {
      /* 六个 draw 一个不落（2026-09-27 修「展开/重进后内容没了」的现行病例）：
       * 原清单漏了 drawForgetLine —— g3 默认展开，c-forget 首帧在页面上却
       * **永远没人画**，学生看到空白的忘记率折线，收起 g3 再展开才补出来
       * （toggleGroup 的补画路径一直在，refresh 这条路漏了）。这份清单与
       * GROUP_DRAWS 账目表的逐组对账由 verify-visual R1/R3 双闸钉死。 */
      this.drawCurve();
      this.drawSubjectBars();
      this.drawReviewDist();
      this.drawWeekday();
      this.drawSediment();
      this.drawForgetLine();
    });
  },

  /**
   * 取 canvas 节点并初始化画布。取不到节点时 resolve(null)。
   *
   * **调用方必须判空早返**：这是本项目的固定契约 —— 首帧找不到节点
   * （元素还没渲染完、或被 wx:if 隐藏）是正常情况，不是错误。
   *
   * 查询本身也可能直接抛错（宿主没有 createSelectorQuery，或查询对象不完整）。
   * 这里把构造这一步也包住并 resolve(null)：否则异常会在 Promise 执行器里变成
   * 无人处理的 rejection —— 真机上是控制台红字，测试里则静默累积。
   */
  initCanvas(id, height) {
    return new Promise(resolve => {
      let q;
      try {
        q = wx.createSelectorQuery().in(this);
      } catch (e) {
        return resolve(null);
      }
      q.select('#' + id).fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) return resolve(null);
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const w = res[0].width || 320;
        const h = height || res[0].height || 170;
        chart.setup(canvas, ctx, w, h);
        resolve({ ctx: ctx, w: w, h: h });
      });
    });
  },

  /** 间隔增长曲线 —— 本项目的"可视化记忆科学" */
  drawCurve() {
    const curve = schedule.intervalCurve(store.loadStates());
    // 2026-09-19 修：原来 curve 为空时直接 return，画布一片空白。
    // chart.drawLine 本来就支持 emptyText 空态（是 stats 绕过了它）—— 补画空态文案。
    this.initCanvas('c-curve', 180).then(node => {
      if (!node) return;
      const data2 = curve.map(p => ({ label: '第' + p.x + '次', value: p.y }));
      chart.drawLine(node.ctx, { width: node.w, height: node.h }, data2, {
        // 主题跟随（2026-09-25）：canvas 拿不到 CSS 变量，主题色必须在**绘制时现取**——
        // 本页所有 draw 都跑在 onShow→nextTick 里，设置页换完主题返回立即生效
        lineColor: theme.accentColor(),
        pointColor: theme.accentColor(),
        fillColor: theme.accentSoft(),
        emptyText: '复习第一个单词后，这条线会开始生长'
      });
    });
  },

  /** 各学科卡片量（水平条，便于看分布） */
  drawSubjectBars() {
    const cards = activeCards();
    const states = store.loadStates();
    const subs = schedule.progressBySubject(cards, states, this.today);
    if (subs.length === 0) return;
    const h = chart.heightForRows(subs.length, 34);
    this.initCanvas('c-subjects', h).then(node => {
      if (!node) return;
      const items = subs.map(s => ({
        label: s.subject, value: s.total, sub: s.total + ' 张'
      }));
      chart.drawHBar(node.ctx, { width: node.w, height: h }, items, {
        color: theme.accentColor()   // 主题跟随，同 drawCurve 的注释
      });
    });
  },

  /** 复习轮次分布：多少卡已经进入第 N 轮 */
  drawReviewDist() {
    const dist = this.data.reviewDist || [];
    if (dist.length === 0) return;
    this.initCanvas('c-rotdist', 160).then(node => {
      if (!node) return;
      chart.drawBars(node.ctx, { width: node.w, height: node.h }, dist, {
        color: theme.accentColor(),   // 主题跟随（柱色原先写死 COLOR.green）
        emptyText: '还没有复习记录'
      });
    });
  },

  /**
   * 星期分布柱状图（7 根柱）。
   *
   * 必须传 xLabels：chart.drawBars 默认按 24 小时分布标 0/6/12/18/23 时刻，
   * 套在 7 根柱上会画出"0时 / 6时"，横轴含义就错了。
   */
  drawWeekday() {
    const an = this.data.analysis;
    const days = (an && an.weekday) || [];
    if (days.length === 0) return;
    this.initCanvas('c-weekday', 150).then(node => {
      if (!node) return;
      const data2 = days.map(d => ({ label: d.label, value: d.value }));
      chart.drawBars(node.ctx, { width: node.w, height: node.h }, data2, {
        xLabels: days.map(d => d.label),
        color: theme.accentColor(),   // 主题跟随（柱色原先写死 COLOR.green）
        emptyText: '还没有复习记录'
      });
    });
  },

  /**
   * 记忆沉淀指数环形图。
   *
   * 环形图已在 utils/chart.js 里写好但一直无人调用 —— 沉淀指数是 0-100 的
   * 单一刻度值，正好是它唯一的适用场景（其余图表是分布/趋势）。
   */
  drawSediment() {
    const an = this.data.analysis;
    if (!an || !an.sediment) return;
    const score = an.sediment.score || 0;
    // 2026-09-19 修"圆环不是圆的"：.chart-ring 的 CSS 是 120×120 正方形，
    // 但这里硬传 height=150 → canvas 背板被竖向拉伸 1.25 倍，arc 画出来成椭圆。
    // 不再覆盖高度，让 initCanvas 直接用 CSS 实际尺寸。
    this.initCanvas('c-sediment').then(node => {
      if (!node) return;
      chart.drawRing(node.ctx, { width: node.w, height: node.h }, score, {
        color: theme.accentColor(),   // 主题跟随（环色原先写死 COLOR.green）
        subLabel: '沉淀指数'
      });
    });
  },

  /**
   * 近 14 天忘记率折线（遗忘统计区块）：人是视觉动物 ——
   * 一条起伏的线比"忘记率 23%"更能让学生看见"哪天没守住"。
   */
  drawForgetLine() {
    const days = this.data.forgetDaily || [];
    // 2026-09-25 修「忘记率折线被压扁」：JS 硬传 height=150 而 wxml 内联是
    // height: 140px —— canvas 背板按 150 逻辑像素画、CSS 按 140 显示，
    // 纵向被压掉 6.7%，网格与标签随之变形。这是 stats 圆环 2026-09-19 同款病
    // （drawSedrum 硬传 150 / CSS 120），修法同款：不再传高度，让 CSS 当唯一真相。
    this.initCanvas('c-forget').then(node => {
      if (!node) return;
      const data2 = days.map(d => ({ label: d.label, value: d.rate }));
      chart.drawLine(node.ctx, { width: node.w, height: node.h }, data2, {
        // 2026-09-25 修「忘记率线是绿的」：原写法 chart.COLOR.red || chart.COLOR.green，
        // 而 COLOR 表里从来没有 red 这个键（红色档叫 brick）—— 恒真回退绿，
        // "忘记率"与"复习量"两条线成了同一种颜色。用 brick（--red 的手工副本）：
        // 这里是"遗忘"的语义红，不是主题强调色，不跟 accentColor 走（樱贝换的
        // --red 是界面层 token，画布内主题红要做需另给 theme 导出，超出本尾巴范围）。
        lineColor: chart.COLOR.brick,
        emptyText: '复习几天后，这条线会展示你的忘记率起伏'
      });
    });
  },

  /**
   * AI 分析失败码 → 可行动的人话指引。
   * 与朗读页 cloudGuide 同一纪律：说清"谁的问题 + 具体怎么做"，
   * 不出现裸错误码；aiProxy 未部署时精确到开发者工具里的右键项。
   */
  aiFailHintFor(code) {
    if (code === 'NOT_DEPLOYED') {
      return 'AI 分析函数还没部署（需要作者操作）：在微信开发者工具左侧目录找到 '
        + 'cloudfunctions/aiProxy，右键 →「上传并部署：云端安装依赖（不上传 node_modules）」，'
        + '部署完成后回本页再点一次「生成我的建议」。';
    }
    if (code === 'NO_KEY' || code === 'NOT_CONFIGURED') {
      return '云端模型密钥还没配（需要作者操作）：云开发控制台 → 云函数 → aiProxy → 配置，'
        + '填写 AGNES_API_KEY 或 GLM_API_KEY，保存后重试。';
    }
    if (code === 'TIMEOUT') return '模型响应超时了，稍等几秒再点一次。';
    // 限流（2026-09-30 云函数侧加配额后新增）：要说清"不是坏了，是到上限了，
    // 明天/等一会儿就好"，否则学生会当成故障反复点。
    if (code === 'RATE_LIMITED') return '刚点得有点密，等一会儿再点一次。';
    if (code === 'QUOTA_EXCEEDED') return '今天的 AI 次数用完了，明天再来点一次。';
    if (code === 'NO_OPENID') return '拿不到用户标识（需要作者操作）：退出小程序重新进入即可恢复。';
    if (code === 'NO_CLOUD') return '本机未开通云开发，AI 分析不可用。';
    return '网络不太好，稍后再试。';
  },

  /**
   * AI 学习分析：把统计页聚合好的指标发给 aiProxy，生成对"这位学生"的
   * 个性化建议（5 条，每条=事实+App 内可执行的动作）。
   *
   * 2026-09-25 失败分支重做（用户反馈"分析那什么你也还没有做"）：
   * 原实现所有失败都折成一句"网络不太好，稍后再试"的瞬时 toast —— 但
   * aiProxy 从未部署时 errMsg 是 "cloud function not found"，把它说成网络
   * 问题是在撒谎，重试永远不会好；且 toast 转瞬即逝，界面上不留任何痕迹。
   * 现在：失败折算成 aiFailHint 常驻分析卡（含部署/配置的具体步骤），
   * aiBusy 由 complete 兜底复位 —— 任何分支都不会永转圈或静默空转。
   */
  runAiAnalysis() {
    if (this.data.aiBusy) return;
    if (!ai.isAvailable()) {
      this.setData({ aiFailHint: '本机未开通云开发，AI 分析不可用。' });
      wx.showToast({ title: '本机未开通云开发，AI 分析不可用', icon: 'none' });
      return;
    }
    const an = this.data.analysis || {};
    const payload = {
      stats: {
        掌握进度: (this.data.overall ? this.data.overall.percent : 0) + '%',
        积分: this.data.points,
        连续天数: an.streak ? an.streak.current : 0,
        历史最长连续: an.streak ? an.streak.longest : 0,
        错题数: this.data.weakCount,
        忘记率: an.forgetting ? an.forgetting.rate + '%' : '',
        最常忘的词: (this.data.forgotWords || []).slice(0, 3).map(w => w.word + '(忘' + w.count + '次)').join('、') || '无',
        最常拼错的词: (this.data.spell && this.data.spell.worst || []).slice(0, 3).map(w => w.word + '(' + w.fail + '次)').join('、') || '无',
        近14天有复习的天数: (this.data.forgetDaily || []).filter(d => d.reviews > 0).length,
        拼写正确率: (this.data.spell && this.data.spell.hasData) ? this.data.spell.rate + '%' : '还没拼过',
        拼写易错类型: ((this.data.spell && this.data.spell.errTypes) || []).slice(0, 2).map(t => t.type).join('、') || '无',
        朗读读准率: (an.pronunciation && an.pronunciation.attempts > 0) ? an.pronunciation.passRate + '%' : '还没朗读过',
        今日待复习: this.data.overall ? this.data.overall.learning : 0
      }
    };
    const self = this;
    this.setData({ aiBusy: true, aiAnalysis: '', aiFailHint: '' });

    /**
     * 2026-09-30：改走 utils/ai.js 网关 + aiBusy 用 finally 兜底。
     *
     * 原来直接 `wx.cloud.callFunction({... complete: () => setData({aiBusy:false})})`。
     * 云开发未开通时它会**同步抛异常** —— complete 不会执行，
     * aiBusy 永远为 true → 按钮永久 disabled、扫描条永久停留，还会弹裸报错。
     * 现在异常在 ai.analysis() 内折算成 {ok:false}，且下面的 finally 保证复位。
     */
    let pending = null;
    try {
      pending = ai.analysis(payload.stats);
    } catch (e) {
      console.warn('[stats] AI 分析调用异常，已放弃', e);
      this.setData({ aiBusy: false, aiAnalysis: '', aiFailHint: this.aiFailHintFor('CLOUD_FAIL') });
      return;
    }

    Promise.resolve(pending).then(function (r) {
      if (r && r.ok && r.analysis) {
        self.setData({ aiAnalysis: r.analysis, aiFailHint: '' });
        return;
      }
      // 失败一律折成常驻指引卡（含部署/配置/限流的具体修法），不弹瞬时 toast
      const code = (r && r.code) || 'BAD_RESPONSE';
      console.warn('[stats] AI 分析失败 code=' + code, (r && r.msg) || '');
      self.setData({ aiAnalysis: '', aiFailHint: self.aiFailHintFor(code) });
    }).catch(function (e) {
      // 网关契约上不 reject；真 reject 也不能让页面报错
      console.warn('[stats] AI 分析结果处理异常，已降级', e);
      self.setData({ aiAnalysis: '', aiFailHint: self.aiFailHintFor('CLOUD_FAIL') });
    }).then(function () {
      // finally 语义：任何路径都复位，按钮不会永久 disabled
      self.setData({ aiBusy: false });
    });
  },

  /**
   * 去错题本练。
   *
   * ⚠️ 光 savePrefs + switchTab 不够（2026-09-19 修，与 deck.goWeakPractice 同一个 bug）。
   * 复习页是 tabBar 长生命周期实例：wx.switchTab 到**已经创建过**的它不重跑 onLoad，
   * 只跑 onShow；而 prefs 只在 onLoad 里读一次。于是 prefs 落了盘，页面的
   * this.data.scope 却仍是旧值 —— 本页写着"错题本 N 个"，点进去还是普通队列。
   * 真正让它**立刻**切过去的是 pending_study，由 study.consumePending() 读后即删。
   *
   * 只送 {scope:'weak'}（不带 unit）：错题本是**全库**口径，consumePending 对
   * "没指定单元"的请求会把 unit 重置成 'all' —— 与 deck 的错题本入口逐字一致，
   * 不会出现"同一个错题本，两个入口两种范围"。
   */
  goWeak() {
    const p = store.loadPrefs();
    store.savePrefs({ subject: p.subject || 'all', scope: 'weak' });
    try {
      wx.setStorageSync('pending_study', { scope: 'weak' });
    } catch (err) {
      // 写不进去只影响"这次立刻生效"，prefs 那份仍会在下次 onLoad 生效 —— 不至于白点
      console.warn('[stats] 写入错题重练请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  },

  /**
   * 去复习：落到「今日待复习」。
   *
   * ⚠️ 只 switchTab 不够（2026-09-19 修）：复习页是 tabBar 长生命周期实例，
   * 它会保持上一次的范围/状态 —— 若学生刚点过「专项重练」（prefs.scope='weak'），
   * 或上一次恰好停在完成页，切过去看到的是错题本/完成页，而不是"今日待复习"。
   * 照 deck.goStudy 补 pending_study。
   *
   * unit 必须一起带：consumePending 对"没指定单元"的请求会把 unit 重置成 'all'
   * （那是给错题重练用的口径），只送 scope 会把学生刚选好的单元丢掉。
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
      console.warn('[stats] 写入今日任务请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  },

  goDeck() {
    wx.switchTab({ url: '/pages/deck/deck' });
  },

  /**
   * 点"最需要回看的词 / 最需要练的词"里的某个词 → 直达单卡复习。
   * 2026-09-19 加：分析页原来只能"看"，数字与行动是断开的 —— 学生看到
   * "abandon 忘过 3 次"却没有任何下一步。现在点词即练（single_practice 通道）。
   */
  practiceWord(e) {
    const id = e.currentTarget.dataset.wid;
    if (!id) return;
    const c = cards.getCard(id);
    if (!c) {
      wx.showToast({ title: '这个词已不在词库里', icon: 'none' });
      return;
    }
    try { wx.setStorageSync('single_practice', id); } catch (err) {
      console.warn('[stats] 写入单卡请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  }
}));
