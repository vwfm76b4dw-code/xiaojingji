/**
 * 单词拼写页 —— 产出型练习（看中文 → 写英文）。
 *
 * ## 与复习页的分工（功能分区）
 *   复习页 = 识别（看英文想中文，自评三档）
 *   拼写页 = 产出（看中文写英文，客观判分）—— 听写场景的正主
 *
 * ## 判分与排期
 * 客观判分不经学生自评：拼对 → q=3（通过但保守推进），拼错 → q=1（重学，
 * 当日重排至队尾，上限 2 次 —— 与复习页同口径）。错因分类与逐字高亮由
 * utils/spelling.js 负责，本页只管流程与呈现。
 *
 * ## 记录
 * 每次作答写 spell_records（按词存，留 20 条），统计页据此做**历史维度**
 * 的错误原因分析 —— 本页"记录"分区只展示本轮，累计口径在统计页。
 */
const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const sm2 = require('../../utils/sm2.js').sm2;
const { todayStr } = require('../../utils/date.js');
const cards = require('../../utils/cards.js');
const settings = require('../../utils/settings.js');
const audioPack = require('../../utils/audio.js');
const spelling = require('../../utils/spelling.js');
const haptic = require('../../utils/haptic.js');   // 触感：字母落槽/退槽/检查提交（"及时"纪律见模块注释）
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

const QUEUE_CAP = 10;      // 一轮最多 10 个词（与"每日新词 10"的体感一致）
const RETRY_LIMIT = 2;     // 拼错重排上限（与复习页同口径）
const Q_OK = 3;            // 拼对：通过，保守推进（能认出 ≠ 能拼出）
const Q_BAD = 1;           // 拼错：重学

function activeCards() { return cards.allCards(); }

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    ready: false,
    // 范围
    scope: 'due',            // due | weak | all
    unit: 'all',
    units: [],
    // 队列
    queue: [],
    idx: 0,
    current: null,
    total: 0,
    reviewed: 0,
    // 作答
    typed: '',
    cells: [],               // 槽位：[{ch, fixed, answer}]；fixed=连字符等预填位
    letters: [],             // 字母卡片池：[{ch, id, used}]
    canCheck: false,         // 所有可填槽位都已填 → 允许检查
    phase: 'input',          // input | result
    verdict: null,           // spelling.judge 的结果 {ok, errType, nodes, hint}
    // SM-2 写盘失败标记（2026-09-30）：为 true 时结果态显示「再试一次」入口。
    // 必须显式声明 —— 本项目有"wxml 引用字段必须在 data 初始化"的门禁纪律。
    saveFailed: false,
    // 本轮统计（记录分区）
    log: [],                 // [{word, typed, ok, errType}]
    okCount: 0,
    badCount: 0,
    typeSummary: [],         // [{type, count}]
    // 状态
    done: false,
    playingWord: ''
  },

  onLoad() {
    this.today = todayStr();
    this.states = store.loadStates();
    this.retryCount = {};

    const prefs = store.loadPrefs();
    this.setData({
      scope: prefs.spellScope || 'due',
      unit: prefs.spellUnit || 'all',
      // 不算 subjects：本页范围只有 due/weak/all，从不按学科筛 ——
      // 原来这里每次 onLoad 都白算一遍学科统计，wxml 从未渲染它（2026-09-25 删）
      units: schedule.unitsOf(activeCards(), this.states)
    });
    this.buildQueue();
  },

  onShow() {
    this.states = store.loadStates();
  },

  /*------------------------- 范围 -------------------------*/

  pickScope(e) {
    const s = e.currentTarget.dataset.scope;
    if (s === this.data.scope) return;
    this.setData({ scope: s });
    store.savePrefs(Object.assign(store.loadPrefs(), { spellScope: s }));
    this.buildQueue();
  },

  pickUnit(e) {
    const u = e.currentTarget.dataset.unit;
    if (u === this.data.unit) return;
    this.setData({ unit: u });
    store.savePrefs(Object.assign(store.loadPrefs(), { spellUnit: u }));
    this.buildQueue();
  },

  /*------------------------- 队列 -------------------------*/

  buildQueue() {
    const weak = store.weakIds();
    let picked = schedule.pickCards(activeCards(), this.states, this.today,
      { subject: 'all', scope: this.data.scope, unit: this.data.unit }, weak);

    // 错题本按错误次数优先（与复习页同口径）
    // 随机打乱：拼写顺序可预测时学生能背位置，不能背单词
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = picked[i]; picked[i] = picked[j]; picked[j] = t;
    }
    picked = picked.slice(0, QUEUE_CAP);

    this.retryCount = {};
    this.setData({
      ready: true,
      queue: picked,
      idx: 0,
      current: picked[0] || null,
      total: picked.length,
      reviewed: 0,
      done: false,
      phase: 'input',
      typed: '',
      verdict: null,
      saveFailed: false,
      log: [],
      okCount: 0,
      badCount: 0,
      typeSummary: []
    });
    this.setupPool(picked[0] || null);
  },

  again() {
    this.buildQueue();
  },

  /*------------------------- 作答：字母卡片 -------------------------*/

  /**
   * 为当前词生成字母池。
   *
   * 池里**必然含干扰字母**（utils/spelling.js 的 buildLetterPool），
   * 否则「点击拼词」会退化成「排序」—— 学生只需要把给定字母排好序，
   * 而排序调用的是位置记忆，不是拼写记忆。
   */
  setupPool(card) {
    const p = spelling.buildLetterPool(card ? card.prompt : '');
    this.setData({
      cells: p.cells,
      letters: p.letters,
      typed: p.cells.map(function (c) { return c.ch; }).join(''),
      canCheck: false
    });
  },

  /** 点字母卡片 → 填进第一个空槽 */
  tapLetter(e) {
    if (this.data.phase !== 'input') return;
    // 落槽震动已砍（2026-09-26 用户反馈"震得很麻"）：8 字母单词拼完震 9 次。
    // 评分/检查/跳过等低频事件保留震动（haptic 内也有 200ms 简并冷却兜底）。
    const id = Number(e.currentTarget.dataset.id);

    const letters = this.data.letters.map(function (c) { return Object.assign({}, c); });
    let li = -1;
    for (let i = 0; i < letters.length; i++) {
      if (letters[i].id === id) { li = i; break; }
    }
    if (li < 0 || letters[li].used) return;      // 已用过的卡片不再响应（WXSS 的 opacity 只是视觉）

    const cells = this.data.cells.map(function (c) { return Object.assign({}, c); });
    let pos = -1;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i].fixed && !cells[i].ch) { pos = i; break; }
    }
    if (pos < 0) return;                          // 已填满

    cells[pos].ch = letters[li].ch;
    letters[li].used = true;
    this.commit(cells, letters);
  },

  /**
   * 点已填槽位 → **该槽及其之后**的字母一起退回池里。
   *
   * 为什么不是只退一个：槽位是顺序填充的，只退中间一个会留下空洞
   * （前面空、后面满），下次点击又填回最前面的空位，字母会「跳位」，
   * 看起来像点错了。整段退回的语义是「撤销到这一步」，与直觉一致。
   */
  tapSlot(e) {
    if (this.data.phase !== 'input') return;
    // 退槽震动已砍（同上：高频噪声）
    const idx = Number(e.currentTarget.dataset.index);
    const cells = this.data.cells.map(function (c) { return Object.assign({}, c); });
    if (!cells[idx] || cells[idx].fixed || !cells[idx].ch) return;

    const letters = this.data.letters.map(function (c) { return Object.assign({}, c); });
    for (let i = idx; i < cells.length; i++) {
      if (cells[i].fixed || !cells[i].ch) continue;
      const ch = cells[i].ch;
      cells[i].ch = '';
      // 同字母可能有多张卡片，退回任意一张未使用的即可（多重集不变）
      for (let k = 0; k < letters.length; k++) {
        if (letters[k].ch === ch && letters[k].used) { letters[k].used = false; break; }
      }
    }
    this.commit(cells, letters);
  },

  /** 把槽位状态同步成 typed（judge 的入参），并判断能否检查 */
  commit(cells, letters) {
    const typed = cells.map(function (c) { return c.ch; }).join('');
    const filled = cells.every(function (c) { return c.fixed || c.ch; });
    this.setData({
      cells: cells,
      letters: letters,
      typed: typed,
      canCheck: filled
    });
  },

  /*------------------------- 作答 -------------------------*/

  /**
   * 键盘接线决策（Agent C，2026-09-25）：本页**不接** xj-keyboard。
   * 全库 grep 过 `<input`：本页 wxml 一个输入框都没有（原来的 onInput 处理器
   * 没有任何绑定指向它，是历史遗留死代码，已删）。输入交互是"字母槽点填"，
   * 本来就不弹系统键盘；而且槽点填刻意混入干扰字母（见 setupPool 注释）——
   * 若换成自由键盘，拼写就退化成听写，与"逼真回忆"的设计目标相反。
   */

  check() {
    if (this.data.phase !== 'input' || !this.data.current) return;
        const card = this.data.current;
    const v = spelling.judge(this.data.typed, card.prompt);

    // 记录（本轮 + 累计）：错因分类是历史分析的原材料
    const log = this.data.log.concat([{
      word: card.prompt, typed: String(this.data.typed || '').trim(),
      ok: v.ok, errType: v.errType
    }]);
    const typeSummaryMap = {};
    log.forEach(l => { if (!l.ok) typeSummaryMap[l.errType] = (typeSummaryMap[l.errType] || 0) + 1; });
    const typeSummary = Object.keys(typeSummaryMap).map(t => ({ type: t, count: typeSummaryMap[t] }));

    this.setData({
      phase: 'result',
      verdict: v,
      log: log,
      okCount: log.filter(l => l.ok).length,
      badCount: log.filter(l => !l.ok).length,
      typeSummary: typeSummary
    });

    // 拼写记录（累计）—— 统计页"拼写表现"的数据源
    store.addSpellRecord(card.id, {
      date: this.today, typed: String(this.data.typed || '').trim(),
      ok: v.ok, errType: v.errType
    });

    /**
     * 写 SM-2：拼对 q=3 保守推进，拼错 q=1 重学。
     *
     * ⚠️ 守卫必须按 `setState` 的**真实返回契约**写（2026-09-30 修）：
     * utils/cards.js 的 setState 返回的是 **`{ ok }` 对象**，不是布尔。
     * 原来的 `if (!cards.setState(card.id, next))` 里这个对象**永远为真**，
     * 于是 `!对象` 恒为 false —— 守卫从来没生效过，写盘失败时静默继续，
     * 学生看到"检查过了"，进度却没落盘，冷启动后这个词又从零开始。
     * （cards.js 的函数头注释本来就写着「页面必须检查返回值」，
     * 这次是调用方没照做，属于典型的"契约写在注释里、没人在读"。）
     */
    const q = v.ok ? Q_OK : Q_BAD;
    const st = this.states[card.id] || store.newState(this.today);
    const next = sm2(st, q, this.today);
    next.history = (st.history || []).concat([{ date: this.today, q: q, interval: next.interval }]);

    const saved = cards.setState(card.id, next);
    if (!saved || saved.ok !== true) {
      /**
       * 写盘失败：必须**如实告诉学生**，而且不能就这么算了 ——
       * 前面已经 setData 到 phase:'result'、也已经记了 spell_records，
       * 但 SM-2 进度没落盘。不给入口的话，学生只能看着一个假的"结果"，
       * 而进度条还在往前走。所以这里给出「再试一次」，
       * 让失败可见、可重试（重试会重新走一遍判分与落盘）。
       */
      this.setData({ saveFailed: true });
      wx.showToast({ title: store.saveFailureText(), icon: 'none', duration: 2000 });
      return;
    }
    this.setData({ saveFailed: false });
    this.states[card.id] = next;

    // 拼错重排至队尾（上限 2 次，与复习页同口径）
    if (!v.ok) {
      const retried = this.retryCount[card.id] || 0;
      if (retried < RETRY_LIMIT) {
        this.retryCount[card.id] = retried + 1;
        this.setData({ queue: this.data.queue.concat([card]), total: this.data.queue.length + 1 });
      }
    }
  },

  /**
   * 写盘失败后的「再试一次」入口（2026-09-30 新增）。
   *
   * ## 为什么必须有这个入口
   *
   * check() 里 `setData({ phase:'result' })` 发生在**落盘之前**（判分要先出结果，
   * 界面才有东西可显示）。所以一旦写盘失败，界面停在"已判分"的样子，
   * 而 SM-2 进度**没有**推进 —— 这时如果只有「下一个」，学生就只有两条路：
   * 跳过（这个词的进度永远丢了，且无人告知）或反复点（每次都失败）。
   * 两个都不对，所以要给一个能把这次落盘**重做一遍**的入口。
   *
   * ## 语义：重试这一次作答，不是重做整轮
   *
   * 直接把 phase 打回 'input' 并把当前词重排到队尾 —— 队列是
   * `queue[idx]` 这张卡，重排后它还会再出现一次，届时会**重新判分、
   * 重新落盘**。判错本来就有 RETRY_LIMIT=2 的重排机制，这里复用同一条路，
   * 不新增第二套"重试"概念。
   */
  retrySave() {
    if (!this.data.current) return;
    const card = this.data.current;
    if ((this.retryCount[card.id] || 0) < RETRY_LIMIT) {
      this.retryCount[card.id] = (this.retryCount[card.id] || 0) + 1;
      this.setData({
        queue: this.data.queue.concat([card]),
        total: this.data.queue.length + 1
      });
    }
    // 回到 input：字母池重置，学生可以再拼一次（答案不会被提前泄露 ——
    // verdict 已清空，且 setupPool 只看 card.prompt，不看上一轮作答）
    this.setData({ phase: 'input', verdict: null, saveFailed: false });
    this.setupPool(card);
  },

  /** 结果态 → 下一张（或完成） */
  next() {
    if (this.data.phase !== 'result') return;
    const isLast = this.data.idx >= this.data.queue.length - 1;
    if (isLast) {
      this.setData({
        done: true, current: null, reviewed: this.data.reviewed + 1, progress: 100
      });
      return;
    }
    const idx = this.data.idx + 1;
    this.setData({
      idx: idx,
      current: this.data.queue[idx],
      reviewed: this.data.reviewed + 1,
      phase: 'input',
      typed: '',
      verdict: null,
      playingWord: ''
    });
    this.setupPool(this.data.queue[idx]);
  },

  playWord() {
    const card = this.data.current;
    if (!card) return;
    if (!this.audio) {
      this.audio = wx.createInnerAudioContext();
      this.audio.onEnded(() => this.setData({ playingWord: '' }));
      this.audio.onError(() => this.setData({ playingWord: '' }));
    }
    if (this.data.playingWord === card.id) {
      try { this.audio.stop(); } catch (err) { /* 忽略 */ }
      this.setData({ playingWord: '' });
      return;
    }
    audioPack.resolveForPlay(card.prompt).then(r => {
      if (!r || !r.ok || !r.src) {
        wx.showToast({ title: '这个词没有发音', icon: 'none' });
        return;
      }
      this.audio.stop();
      this.audio.src = r.src;
      this.audio.play();
      this.setData({ playingWord: card.id });
    });
  },

  onHide() {
    if (this.audio) { try { this.audio.stop(); } catch (err) { /* 忽略 */ } }
    if (this.data.playingWord) this.setData({ playingWord: '' });
  },

  onUnload() {
    if (this.audio) { try { this.audio.destroy(); } catch (err) { /* 忽略 */ } }
  },

  goStudy() {
    const p = store.loadPrefs();
    try {
      wx.setStorageSync('pending_study', { scope: 'due', unit: p.unit || 'all', subject: p.subject || 'all' });
    } catch (err) { console.warn('[spelling] 写入复习请求失败', err); }
    wx.switchTab({ url: '/pages/study/study' });
  }
}));
