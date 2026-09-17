const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const chart = require('../../utils/chart.js');
const analysis = require('../../utils/analysis.js');
const { todayStr } = require('../../utils/date.js');

const cards = require('../../utils/cards.js');

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

Page({
  data: {
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
    // 预先算好的展示值，避免把算术散进 WXML
    activeRatePct: 0,
    streakHint: '',
    growthText: '',
    weekdayHint: ''
  },

  onLoad() {
    this.today = todayStr();
    this.refresh();
  },

  onShow() {
    this.refresh();
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

    // forgetting.worst 只返回 wordId，用户看不懂。补词形。
    // 词条可能已被删除（历史还在），这种情况给出可读的占位而不是空白。
    const wordById = {};
    cards.forEach(c => { wordById[c.id] = c.prompt || ''; });
    const forgotWords = (an.forgetting.worst || []).map(w => ({
      wordId: w.wordId,
      word: wordById[w.wordId] || '（词条已删除）',
      count: w.count
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
      hasReviewEvents: an.events > 0,
      hasStudied: an.retention.studied > 0,
      hasPron: an.pronunciation.attempts > 0,
      hasEfficiency: an.efficiency.reviewsPerMature !== null,
      activeRatePct: Math.round(an.activeRate * 100),
      streakHint: streakHint,
      growthText: growthText,
      weekdayHint: weekdayHint
    });

    wx.nextTick(() => {
      this.drawCurve();
      this.drawSubjectBars();
      this.drawReviewDist();
      this.drawWeekday();
      this.drawSediment();
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
    if (curve.length === 0) return;
    this.initCanvas('c-curve', 180).then(node => {
      if (!node) return;
      const data2 = curve.map(p => ({ label: '第' + p.x + '次', value: p.y }));
      chart.drawLine(node.ctx, { width: node.w, height: node.h }, data2, {
        lineColor: chart.COLOR.green,
        emptyText: '还没有复习记录'
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
      chart.drawHBar(node.ctx, { width: node.w, height: h }, items, {});
    });
  },

  /** 复习轮次分布：多少卡已经进入第 N 轮 */
  drawReviewDist() {
    const dist = this.data.reviewDist || [];
    if (dist.length === 0) return;
    this.initCanvas('c-rotdist', 160).then(node => {
      if (!node) return;
      chart.drawBars(node.ctx, { width: node.w, height: node.h }, dist, {
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
    this.initCanvas('c-sediment', 150).then(node => {
      if (!node) return;
      chart.drawRing(node.ctx, { width: node.w, height: node.h }, score, {
        subLabel: '沉淀指数'
      });
    });
  },

  /** 去错题本练 */
  goWeak() {
    const store2 = require('../../utils/store.js');
    const p = store2.loadPrefs();
    store2.savePrefs({ subject: p.subject || 'all', scope: 'weak' });
    wx.switchTab({ url: '/pages/study/study' });
  },

  goStudy() {
    wx.switchTab({ url: '/pages/study/study' });
  },

  goDeck() {
    wx.switchTab({ url: '/pages/deck/deck' });
  }
});
