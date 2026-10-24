/**
 * 单元测验页 —— 阶段验收（研究建议的第四步）。
 *
 * ## 与成长看板的检查点是什么关系
 * 看板里的**检查点**是被动里程碑（掌握到 25 个词自动达成）；
 * 这里是**主动验收**：点进去答题，答够 80% 才算过。
 * 两者并存：前者给"我在进步"的持续感，后者给"这一单元拿下了"的阶段性成就感。
 *
 * ## 三个阶段（同一页内切换，不跳页）
 *   units   —— 单元列表（锁定 / 可考 / 已过 + 最好成绩）
 *   running —— 逐题作答（四选一 / 逐字母点填交替）
 *   result  —— 得分、通过与否、错题、重考入口
 *
 * ## 两个刻意的设计
 *   ① **重考没有惩罚**：最好成绩只增不减，错题不扣分。学生会因此敢重考，
 *      而重考正是我们想要的（他得把错的再看一遍）。
 *   ② **答完不自动跳下一题**：先让他看清正确答案。验收的教学价值就在这一刻，
 *      自动跳走等于把最有用的信息闪过去了。
 */
const store = require('../../utils/store.js');
const cardsMod = require('../../utils/cards.js');
const settings = require('../../utils/settings.js');
const growth = require('../../utils/growth.js');
const quiz = require('../../utils/quiz.js');
const sfx = require('../../utils/sfx.js');
const haptic = require('../../utils/haptic.js');   // 触感：选项点选/字母落槽/验证提交（"及时"纪律见模块注释）
const { todayStr } = require('../../utils/date.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

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
    stage: 'units',          // units | running | result

    units: [],               // [{unit, total, learned, ready, missing, best, passed}]
    totalUnits: 0,
    passedUnits: 0,

    // 规则常量（模板直接读，避免把数字写死在 WXML 里两处维护）
    passPct: quiz.PASS_PCT,
    passBonus: quiz.PASS_BONUS,

    // 运行态
    questions: [],
    qi: 0,
    q: null,                 // 当前题
    unitLabel: '',           // 当前在考哪个单元
    progress: 0,             // 0~100
    answered: false,         // 本题是否已作答
    picked: '',              // 选择题选了哪个
    verdict: null,           // {ok, right}
    slots: [],               // 拼写题：字母槽
    bank: [],                // 拼写题：字母库
    // 未填满点「验证」的防呆抖动（与识别轮 .grade 的抖动同一层哲学）
    spellShaking: false,

    // 结果
    result: null,            // {correct,total,pct,passed,perfect,wrongIds}
    firstPass: false,
    gained: 0,
    say: ''
  },

  onLoad() {
    this.today = todayStr();
  },

  onShow() {
    if (this.data.stage === 'units') this.refreshUnits();
  },

  /*------------------------- 单元列表 -------------------------*/

  refreshUnits() {
    const cards = cardsMod.allCards();
    const states = store.loadStates();
    const recs = quiz.recordsOf(readJSON(quiz.QUIZ_KEY, {}));

    const units = quiz.unitsOf(cards, states).map(function (u) {
      const r = recs[u.unit];
      return Object.assign({}, u, {
        best: r ? r.best : 0,
        passed: !!(r && r.passedAt)
      });
    });

    this.setData({
      ready: true,
      stage: 'units',
      units: units,
      totalUnits: units.length,
      passedUnits: units.filter(function (u) { return u.passed; }).length
    });
  },

  /** 开始某单元的测验 */
  startUnit(e) {
    const unit = e.currentTarget.dataset.unit;
    const row = this.data.units.filter(function (u) { return u.unit === unit; })[0];
    if (!row) return;
    if (!row.ready) {
      wx.showToast({ title: '这个单元还有 ' + row.missing + ' 个词没学过', icon: 'none' });
      return;
    }

    const cards = cardsMod.allCards();
    const built = quiz.buildQuiz(cards, store.loadStates(), unit, {
      weakIds: store.weakIds()
    });
    if (!built.questions.length) {
      wx.showToast({ title: '这个单元暂时出不了题', icon: 'none' });
      return;
    }

    this._answers = {};
    this._unit = unit;                 // 结果页要写记录、重考要复用，必须留住
    sfx.reset();
    this.setData({
      stage: 'running',
      questions: built.questions,
      qi: 0,
      unitLabel: unit,
      result: null,
      firstPass: false,
      gained: 0
    });
    this._showQuestion(0);
  },

  /*------------------------- 答题 -------------------------*/

  _showQuestion(i) {
    const list = this.data.questions;
    const q = list[i];
    if (!q) return;

    const patch = {
      qi: i,
      q: q,
      answered: false,
      picked: '',
      verdict: null,
      // 上一题残留的防呆抖动必须清掉，否则下一题的「验证」按钮一进场就是抖的
      spellShaking: false,
      progress: Math.round(i / list.length * 100)
    };

    if (q.type === quiz.TYPE_SPELL) {
      // 字母槽 + 字母库：与拼写轮同一套结构（用户已经熟悉这个交互）
      patch.slots = q.cells.map(function (c) {
        return c.fixed
          ? { need: false, ch: c.ch, state: 'fixed' }
          : { need: true, ch: '', state: 'empty' };
      });
      patch.bank = q.letters.map(function (l, idx) {
        return { id: idx, ch: l.ch, used: false };
      });
    } else {
      patch.slots = [];
      patch.bank = [];
    }
    this.setData(patch);
  },

  /** 选择题：点一个选项（点选即提交 —— 选择题没有"验证"的中间态，触感与判分同步） */
  tapChoice(e) {
    if (this.data.answered) return;
        const v = e.currentTarget.dataset.v;
    this._answers[this.data.q.id] = v;
    const ok = quiz.normAnswer(v) === quiz.normAnswer(this.data.q.answer);
    if (ok) sfx.playOk(1); else sfx.playBad();
    this.setData({
      answered: true,
      picked: v,
      verdict: { ok: ok, right: this.data.q.answer }
    });
  },

  /**
   * 拼写题：点字母库填进第一个空槽。
   * 2026-09-25 改：填满**不再自动判分**（与复习页拼写轮同一口径）——
   * 自动判分等于替学生做了提交决定，错因在他手指还停在屏上时一闪而过；
   * 判分权交给 verifySpell（显式「验证」按钮）。
   */
  tapBank(e) {
    if (this.data.answered) return;
    const id = e.currentTarget.dataset.id;
    const bank = this.data.bank;
    const b = bank[id];
    if (!b || b.used) return;
    // 落槽震动已砍（2026-09-26 用户反馈"震得很麻"）：高频字母操作不碰振动器，
    // 判分/验证这类低频事件保留（haptic 内有 200ms 简并冷却兜底）。

    const slots = this.data.slots;
    const pos = slots.findIndex(function (s) { return s.need && s.state === 'empty'; });
    if (pos === -1) return;

    slots[pos] = { need: true, ch: b.ch, state: 'filled', from: id };
    bank[id] = { id: id, ch: b.ch, used: true };
    sfx.play('tap');
    this.setData({ slots: slots, bank: bank });
  },

  /** 拼写题：点已填的槽退回（发现点错可以改） */
  tapSlot(e) {
    if (this.data.answered) return;
    // 退槽震动已砍（同上）
    const i = e.currentTarget.dataset.i;
    const slots = this.data.slots;
    const s = slots[i];
    if (!s || !s.need || s.state !== 'filled') return;
    const bank = this.data.bank;
    if (s.from !== undefined && bank[s.from]) {
      bank[s.from] = { id: s.from, ch: bank[s.from].ch, used: false };
    }
    slots[i] = { need: true, ch: '', state: 'empty' };
    this.setData({ slots: slots, bank: bank });
  },

  /**
   * 显式验证（2026-09-25 用户点名）：填满后点「验证」才判分；
   * 判完的逐槽红绿与正确答案停留到手动点「下一题」——本页本来就没有
   * 判后自动跳题（那是验收的教学价值所在），这里补齐的是"判分时机"的对称要求。
   */
  verifySpell() {
    if (this.data.answered || !this.data.q ||
        this.data.q.type !== quiz.TYPE_SPELL) return;
    const full = this.data.slots.every(function (s) { return !s.need || s.state !== 'empty'; });
    if (!full) {
      // 防呆：没填满就点验证 —— 抖动 + 一句实话；不静默失败，也不替学生判
            this.setData({ spellShaking: true });
      wx.showToast({ title: '还有字母没填完', icon: 'none' });
      // 340ms 与 app.wxss .shake 动画时长同源，改任一边必须同步另一边
      setTimeout(() => this.setData({ spellShaking: false }), 340);
      return;
    }
    haptic.tap('medium');
    this._judgeSpell();
  },

  _judgeSpell() {
    // typed 必须**全槽拼接**（含 fixed 槽的空格/连字符/撇号）：
    // 答案比对用的是 q.answer = card.prompt 原文（含空格），只取 need 槽的话，
    // 「go straight on」这类多词短语在字母全放对时会被判错
    //（'gostraighton' !== 'go straight on'）。与 pages/spelling 的 cells 口径一致。
    const typed = this.data.slots
      .map(function (s) { return s.ch; })
      .join('');
    this._answers[this.data.q.id] = typed;
    const ok = quiz.normAnswer(typed) === quiz.normAnswer(this.data.q.answer);

    // 逐槽标绿/标红：错在哪一格一眼看到（与拼写轮同口径）
    const letters = String(this.data.q.answer || '').replace(/[^A-Za-z]/g, '').split('');
    let li = 0;
    const slots = this.data.slots.map(function (s) {
      if (!s.need) return s;
      const good = s.ch === letters[li]; li += 1;
      return Object.assign({}, s, { state: good ? 'ok' : 'bad' });
    });

    if (ok) sfx.playOk(1); else sfx.playBad();
    this.setData({
      slots: slots,
      answered: true,
      verdict: { ok: ok, right: this.data.q.answer }
    });
  },

  /** 下一题 / 看结果 */
  nextQuestion() {
    if (!this.data.answered) return;
    const next = this.data.qi + 1;
    if (next >= this.data.questions.length) {
      this._finish();
      return;
    }
    this._showQuestion(next);
  },

  /*------------------------- 结果 -------------------------*/

  _finish() {
    const r = quiz.scoreQuiz(this.data.questions, this._answers);
    const merged = quiz.mergeResult(
      readJSON(quiz.QUIZ_KEY, {}), this._unit, r, this.today);
    writeJSON(quiz.QUIZ_KEY, merged.records);

    /**
     * 首次通过才给积分。
     *
     * ⚠️ 这里**不做任何"加分"写盘** —— 积分是可推导的：
     * 记录里一旦有了 `passedAt`，`growth.pointsBreakdown({quizBonus})` 下次算的时候
     * 自然会把 `quiz.bonusOf(records)` 计入。写两次反而会重复计分。
     * 所以这里只写记录，积分由推导得出。
     */
    const gained = merged.firstPass ? quiz.PASS_BONUS : 0;

    if (r.passed) sfx.play('milestone'); else sfx.play('tap');

    this.setData({
      stage: 'result',
      result: r,
      firstPass: merged.firstPass,
      gained: gained,
      progress: 100,
      say: r.perfect ? '全对，这一单元没有漏洞'
        : (r.passed ? '这一单元拿下了' : '还差一点，再来一次')
    });
  },

  /** 重考同一单元 */
  retry() {
    const unit = this._unit;
    const fakeEvent = { currentTarget: { dataset: { unit: unit } } };
    this.startUnit(fakeEvent);
  },

  /** 回到单元列表 */
  backToUnits() {
    this.refreshUnits();
  },

  /*------------------------- 跳转 -------------------------*/

  goGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }); },
  goStudy() { wx.switchTab({ url: '/pages/study/study' }); }
}));
