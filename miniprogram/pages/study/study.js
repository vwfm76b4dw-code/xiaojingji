const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const { sm2, GRADE } = require('../../utils/sm2.js');
const { todayStr } = require('../../utils/date.js');

const cards = require('../../utils/cards.js');
const settings = require('../../utils/settings.js');
const growth = require('../../utils/growth.js');
const copyMod = require('../../utils/growth-copy.js');
const sylMod = require('../../utils/syllable.js');   // 音节分色（背长词时看出节奏）   // 完成页文案（按日期轮换）   // 「再练一组」的额度读取（见 dailyLimits）
const audioPack = require('../../utils/audio.js');
const spellingMod = require('../../utils/spelling.js');
const sfx = require('../../utils/sfx.js');
const haptic = require('../../utils/haptic.js');   // 触感：处理函数第一行同步调（见模块注释的"及时"纪律）
const ipaMod = require('../../utils/ipa.js');
const phonemes = require('../../utils/phoneme-table.js');
const quotes = require('../../utils/quotes.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/**
 * 记忆技巧兜底源（契约 §2.5：tipFor(word) => {text, source}|null）。
 * Agent C 已落库（2026-09-25），此处从「拆串晚期绑定」恢复为字面量 require ——
 * 之所以曾用拆串拼接路径（require 参数内拼接文件名），是因为门禁静态校验
 * require 路径必须存在，而当时文件还没建；现在恢复字面量 —— 文件若被误删，
 * 启动即报错显式暴露，而不是静默退化成无钩子。
 */
const mnemonicMod = require('../../utils/mnemonic.js');

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

/**
 * 「来源」行该显示什么（2026-09-25 用户反馈：所有卡的来源都长一样）。
 *
 * 病根：词条的 source 是**册级常量**——预置 295 词同属一本教材，整行渲染出来
 * 每张卡都是同一句话（用户原话「所有单词展示均为 Junior High」指的就是这个：
 * 一行常量不是出处，是噪音）；导入册更极端——词条根本没有 source，行渲染成空壳。
 *
 * 规则（契约层，tools/verify-reviewUX.js 用同一组输入分别驱动 study/card 两页逐条钉住）：
 *   ① unit 优先 —— 它才是「这个词在哪一课」的有效信息（如 '7A Unit 1'）；
 *   ② source 只有在**不是纯学段标签**（'Junior High' / 'Primary School' / '初中'
 *      这类，对区分单词毫无信息量）且**去掉 unit 之后还有剩余信息**时才附加；
 *   ③ 两样都给不出 → 返回 ''，WXML 的 wx:if 不渲染这一行（不显示空壳）。
 *
 * 为什么放页面而不是 utils：它是纯呈现规则，且本域红线约束下无法新增第三个
 * 共享 util —— study / card 两处各持一份，一致性由门禁的行为断言（而非口头约定）保证。
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
    // source 惯例把 unit 拼在书名后面（'外研版…（2024新版）7A Starter'）：
    // 先剥掉 unit 再比对，否则同一信息渲染两遍（'7A Starter · 外研版…7A Starter'）。
    let rest = u ? s.split(u).join('') : s;
    rest = rest.replace(/^[\s·—\-–/、,，·]+|[\s·—\-–/、,，·]+$/g, '').trim();
    if (rest && !isStageLabel(rest) && rest !== u) parts.push(rest);
  }
  return parts.join(' · ');
}

/**
 * 给队列里的每张卡标注「是不是第一次学」以及三种反馈的后果。
 *
 * ## 为什么要标 isNew（2026-09-18 修）
 * SM-2 是**复习**算法，它假设材料已经学过。对从没见过的词，
 * "先自己回想"是做不到的 —— 学生只能蒙（蒙对了系统按 q=5 排到 6 天后）
 * 或直接点"不认识"。两条路都学不会这个词，因为整个流程里没有"记一遍"的动作。
 *
 * 所以新词要换一种呈现：**正面直接给答案**（先记一遍，这是学习阶段），
 * 学过了才进复习循环。这样「先回想再自评」这个机制才用在它该用的地方。
 *
 * ## 为什么要预演间隔
 * 原来三个按钮的后果对学生是不可见的，学生只能凭感觉点。
 * 把「下次 N 天」写在按钮上，选择才有依据（这也是 Anki 的标配做法）。
 *
 * 注意：这里只是**调用** sm2 三次做预演，SM-2 的公式一行都没动。
 */
function annotate(card, st, today, direction) {
  const base = st || store.newState(today);
  const isNew = !st;
  const view = Object.assign({}, card, { isNew: isNew });
  // 听写模式（中→英）：只换**呈现方向**，队列与 SM-2 判分完全不变
  view.reverse = direction === 'reverse';
  // 来源行（2026-09-25 修）：见 sourceLabel 的规则注释。'' 时 WXML 整行不渲染。
  view.srcText = sourceLabel(card.unit, card.source);
  // 音标（有就显示）：phoneme-table 是 ARPAbet，转 IPA 给学生看
  // forWord 支持多词条目（junior high / information technology…）——
  // 整条查表必然查不到，逐段拼才有音标。见 utils/ipa.js 的说明。
  view.phon = ipaMod.forWord(card.prompt, phonemes);

  /**
   * 记忆技巧兜底（契约 §2.5 的 B 侧接线）：
   * 词条自带 hook（教材新册导入的 mnemonic）优先，shortHook 次之 —— 这两样
   * toCard 已经放好；都没有时调 mnemonic.tipFor(word) 拿静态技巧。
   * 三者都无 → 不设 tipText，WXML 的 wx:if 不渲染区块（不显示空占位）。
   * typeof 守卫：契约只约束签名，实现存在与否要到运行时才知道。
   */
  if (!view.hook && !view.shortHook && mnemonicMod &&
      typeof mnemonicMod.tipFor === 'function') {
    try {
      const tip = mnemonicMod.tipFor(card.prompt);
      if (tip && tip.text) view.tipText = String(tip.text);
    } catch (e) {
      // 兜底失败只少一条提示，不能拦住复习 —— 所以这里吞掉异常
    }
  }

  if (isNew) {
    // 新词只走两档："记住了"进复习循环；"再看一遍"留在学习阶段
    view.nextKnow = sm2(base, GRADE.KNOW, today).interval;
    view.nextAgain = 0;          // 0 表示"本轮末尾重来"，不显示天数
  } else {
    view.nextKnow = sm2(base, GRADE.KNOW, today).interval;
    view.nextVague = sm2(base, GRADE.VAGUE, today).interval;
    view.nextForgot = sm2(base, GRADE.FORGOT, today).interval;
  }
  return view;
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    ready: false,
    queue: [],
    idx: 0,
    current: null, sylParts: null,
    flipped: false,
    leaving: false,
    entering: false,
    done: false,
    // 完成页上的一句话（按日期轮换，见 _onDone）
    doneSay: '',
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
    // 上一张的结果条（非阻塞反馈：评分后果常驻显示，替代会盖住下一张卡的 toast）
    lastResult: null,
    // 发音播放状态（背面 ▶ 发音按钮）
    playingWord: '',
    // 学后拼写轮（2026-09-19 重构）：整轮识别过完 → 最后统一拼一遍。
    // 为什么不在每个词后面立刻拼：刚看完就拼是**瞬时记忆**，测不出记没记住；
    // 隔一整轮再拼才是真的回忆。随机交替两种题型：逐字母点填（中译英）/ 四选一（英译中）。
    spellCheck: true,
    spellPending: false,   // （旧字段名，wxml 的 !spellPending 包裹仍在用；拼写轮用 spellRound）
    spellRound: false,
    spellMode: '',
    spellWord: null,
    spellSlots: [],
    spellBank: [],
    spellChoices: [],
    spellVerdict: null,
    // 显式验证态（2026-09-25 用户反馈）：字母落满**不再自动判分**，
    // spellReady 只负责点亮「验证」按钮；spellShaking 是"没填满就点验证"的防呆抖动
    spellReady: false,
    spellShaking: false,
    // 拼写轮的这个词是否属于"判错重学"段（WXML 据此挂「重学」标签）
    spellRetry: false,
    spellOkCount: 0,
    spellBadCount: 0,
    spellIdx: 0,
    spellTotal: 0,

    // ---- 筛选（本轮复习范围）----
    subjects: [],           // [{subject, count}]
    subject: 'all',         // 当前学科
    units: [],              // [{unit, count, learned}] —— 按单元学习用
    unit: 'all',            // 当前单元（'all' = 不限）
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
    // 「再练一组」：今天是否已买过（买过则额度已抬，入口置灰）
    extraBoughtToday: false,
    extraBatchPrice: growth.EXTRA_BATCH_PRICE,
    // 是否显示记忆钩子（来自设置）
    showHook: true,
    // 自动发音（来自设置，见 settings.DEFAULTS.autoSpeak 的注释）
    autoSpeak: true,
    // 当前单词的音节分段（null = 不分色，见 syllable.displayParts）
    sylParts: null,
    // 是否展开了完整钩子（默认收起，只显示一句话版）
    hookOpen: false
  },

  onLoad() {
    this.today = todayStr();
    this.states = store.loadStates();

    const prefs = store.loadPrefs();
    this.setData({
      subjects: schedule.subjectsOf(activeCards()),
      subject: prefs.subject || 'all',
      units: schedule.unitsOf(activeCards(), this.states),
      unit: prefs.unit || 'all',
      scope: prefs.scope || 'due',
      direction: prefs.direction === 'reverse' ? 'reverse' : 'forward',
      /**
       * 学后拼写的默认值现在** authoritatively 定义在 settings.DEFAULTS.spellCheck = true**
       * （2026-09-25 收编，见那里的注释）。这里的层级是：
       *   study_prefs.spellCheck（用户显式拨过开关）> settings 默认值。
       * 旧写法 `prefs.spellCheck !== false` 行为等价，但把"默认是什么"藏在了页面里，
       * 与 settings.js「所有参数集中在这里」的承诺矛盾 —— verify-pages 的注入契约
       * 注释也因此同步改写（注入现在代表"用户显式关闭"，不再是旧默认）。
       */
      spellCheck: prefs.spellCheck === undefined
        ? settings.get('spellCheck') !== false
        : prefs.spellCheck !== false,
      showHook: settings.get('showHook') !== false,
      autoSpeak: settings.get('autoSpeak') !== false
    });

    // 首次打开也要消费跨页请求（冷启动直接进复习页的路径：
    // 例如从卡详情页"练这一张"，此时页面实例还没建过，onShow 也会跑，
    // 但这里先消费一次能让首屏就是正确的队列，避免闪一下普通队列再被换掉）。
    this.consumePending();
    this.buildQueue();
  },

  onShow() {
    this.states = store.loadStates();

    /**
     * 跨页请求必须在 onShow 里消费 —— 这是 2026-09-18 修的一个真 bug 的根因。
     *
     * 复习页是 **tabBar 页面 = 长生命周期实例**：wx.switchTab 到**已经创建过**的
     * tabBar 页不会重跑 onLoad，只跑 onShow。于是所有"跳转前写 storage、
     * 指望 onLoad 里读到"的写法都只在**第一次**打开时有效，之后就静默失效：
     *   · 「练这一张」—— 标记留在 storage 里不被消费，等下一次 onLoad 才突然生效
     *     （用户看到的是"点了没反应"，隔很久再进复习页却莫名只出现那一张卡）；
     *   · 首页「错题重练」—— prefs 落了盘，但页面从不重读，this.data.scope 一直是旧值。
     * 所以跨页请求统一走 consumePending()，不再各页各写一套键。
     */
    if (this.consumePending()) {
      this.buildQueue();
      return;
    }

    // 无请求时保持原有行为：从其它页返回时刷新（可能有新到期的）
    if (this.singleId) this.buildQueue();
    else if (this.data.done) this.buildQueue();
    else this.refreshCounts();
  },

  /**
   * 消费「跨页请求」—— 别的页面跳进复习页时携带的一次性指令。
   *
   * 通道是 storage 里的两个键（都在这里**读后即删**）：
   *   single_practice  卡 id 字符串        → 单卡模式（卡详情页「练这一张」）
   *   pending_study    { scope?, unit?, subject? } → 指定复习范围
   *                    （首页「错题重练」、首页「按单元练」）
   *
   * ## 为什么必须读后即删
   * 不删就会**幽灵式生效**：用户这次的动作没生效，标记却留在盘上，
   * 等某次完全无关的切页（那时才跑到 onLoad）突然改变界面。
   * 这种"没人操作但状态变了"的现象是最难排查的一类 bug，
   * 所以"读了就删"是这个通道的纪律，而不是可选优化。
   *
   * ## 优先级与互斥
   * · 两者同时命中时以 single_practice 优先 —— 它更具体（就一张卡），
   *   而 pending_study 是更早的一次范围请求，已经过期了。
   * · 命中 single_practice 时不应用 pending_study 的范围：单卡模式下
   *   unit/scope 无意义（队列被固定成那一张），应用了反而会让"退出单卡模式后"
   *   的范围莫名其妙地变了。
   * · 命中 pending_study 时必须清掉 this.singleId：否则上一次的单卡模式会
   *   串到这次的范围请求上（表现是"点了错题重练，结果只出现一张卡"）。
   *
   * @returns true 表示消费到了请求（调用方据此重建队列，而不是只刷新计数）
   */
  consumePending() {
    let singleId = null;
    let pending = null;
    try {
      singleId = wx.getStorageSync('single_practice') || null;
      pending = wx.getStorageSync('pending_study') || null;
    } catch (e) {
      // 读失败按"无请求"处理：宁可这次少一次跳转生效，
      // 也不能让一次 storage 异常把整个复习页抛错（那是白屏级后果）。
      console.warn('[study] 读取跨页请求失败，按无请求处理', e);
      return false;
    }

    // 先删再应用：任何一条删除失败都不影响另一条，也不阻断本次消费
    // （盘坏了是盘的问题，不该让用户这次点击白点）。
    try { if (singleId) wx.removeStorageSync('single_practice'); }
    catch (e) { console.warn('[study] 清除单卡模式标记失败', e); }
    try { if (pending) wx.removeStorageSync('pending_study'); }
    catch (e) { console.warn('[study] 清除复习范围请求失败', e); }

    if (singleId) {
      this.singleId = singleId;
      return true;
    }

    // 空对象 / 字符串等脏值不算请求（键已删掉，不会变成幽灵）。
    // 必须至少有一个字段，否则 `{}` 会把 unit 意外重置成 'all'。
    const hasAny = pending && typeof pending === 'object' && !Array.isArray(pending) &&
      (pending.scope || pending.unit || pending.subject);
    if (!hasAny) return false;

    this.singleId = null;   // 见上方「互斥」：范围请求必须退出单卡模式

    /**
     * 指定了单元时不再叠加上一轮的学科筛选。
     *
     * 为什么：单元名已经唯一确定了这批词（"7A Unit 2" 就那 43 个），
     * 再和残留的 subject 求交集可能把队列筛空 —— 表现就是"点了没反应"，
     * 正是这次要修的毛病。而且首页「按单元练」上的数字是按 subject:'all' 算的，
     * 口径必须与点进去的队列一致（首页数字不能和复习页打架，这是本项目已立的规矩）。
     */
    const next = {
      subject: pending.subject || (pending.unit ? 'all' : (this.data.subject || 'all')),
      scope: pending.scope || this.data.scope || 'due',
      // 没指定单元就回到"不限"：与旧 goWeakPractice 的口径一致
      // （错题本是全库范围，不该被上一轮选过的单元困住）。
      unit: pending.unit || 'all'
    };

    /**
     * 落盘：这样切走再回来（走 onLoad 读 prefs 的那条路）仍保持这次的范围，
     * 与 applyFilter 的做法一致 —— 一次性请求负责「立刻生效」，
     * prefs 负责「之后还记得」。
     *
     * ⚠️ 必须是**局部合并**，不能直接把 next 整个写进去（2026-09-30 修）。
     * store.savePrefs 是 `setStorageSync(KEY, prefs)` —— **整对象替换**，
     * 而 next 只含 subject/scope/unit 三个字段。原来的写法等于把
     * `direction`（听写模式）与 `spellCheck`（学后拼写）**静默抹掉**：
     * 用户在复习页拨了听写、或在设置里关了拼写，只要点一次首页的
     * 「错题重练」/「按单元练」，冷启动后设置就复原了 —— 症状是
     * 「我明明设了，刷新一下就没了」，而界面上没有任何提示。
     *
     * 为什么必须以 store.loadPrefs() 为底而不是照抄 applyFilter 的写法：
     * applyFilter 之所以看起来"带全字段"，是因为它**从 this.data 组装**，
     * 而 direction/spellCheck 本来就在 this.data 里（onLoad 从 prefs 读的），
     * 所以它恰好不丢字段 —— 但那是**巧合，不是设计**。这里 next 的三个字段
     * 是从 pending 与 this.data 拼出来的，语义上属于"局部更新"，
     * 就该按局部更新的方式落盘。两个调用点形态不同、理由不同，
     * 这里不再假装它们是同一件事。
     */
    store.savePrefs(Object.assign(store.loadPrefs(), {
      subject: next.subject,
      scope: next.scope,
      unit: next.unit
    }));
    this.setData({
      subject: next.subject,
      scope: next.scope,
      unit: next.unit,
      done: false,          // 上一轮若停在完成态，这里要回到复习态
      filterOpen: false
    });
    return true;
  },

  /*------------------------- 队列 -------------------------*/

  /**
   * 「什么情况下才该按每日上限（每日新词 / 每日复习上限）裁剪队列」。
   *
   * 规则本体已上移到 utils/schedule.js 的 shouldApplyDailyLimits() —— 因为首页
   * deck.refresh 也要问同一个问题，而它不该 require 一个页面（页面实例不可被
   * 纯函数复用，也没法在 Node 里直测）。这里只剩"把本页的 unit 传进去"。
   *
   * ## 为什么必须只有一份（2026-09-19 扩到跨页）
   * 这个判据是一条**业务规则**，不是三个碰巧写对的表达式。散成多份，
   * 任何一次改动（加一个 scope、给某个入口开口子）都只会改到其中一两处，
   * 于是"首页数字与复习页队列打架"又会回来 —— 那正是本项目反复踩过、
   * 并且已经立过规矩要消灭的那类缺陷。
   *
   * 现实证据有两处：
   *   · 抽取前 refreshCounts 的条件比 buildQueue 少一个 `!singleMode`（不可达，没暴露）；
   *   · deck.refresh 按全库算数字、完全不看 unit（可达，学生一选单元就打架）。
   * 收敛到一处，这两类分叉就没有发生的入口。
   *
   * @param scope 该队列所属的 scope。⚠️ 不是每次都用 this.data.scope ——
   *              countDueInScope 回答的是"切到 due 会给我多少张"，那里必须传 'due'。
   * @param singleMode 该队列是否处于单卡模式
   */
  shouldApplyLimits(scope, singleMode) {
    return schedule.shouldApplyDailyLimits({
      scope: scope, unit: this.data.unit, singleMode: singleMode
    });
  },

  /**
   * 花积分解锁「再练一组」：今天的新词与复习额度各加一批。
   *
   * 与成长看板页里的同名动作是**同一笔交易**（同一个存储键、同一个价格），
   * 两处入口都指向它 —— 学生不必先想到"去某个页面才能多练"。
   *
   * 失败情形全部给出可执行的话，不弹一个看不懂的错：
   *   积分不够 → 差多少；今天已买 → 明说；写盘失败 → 让重试。
   */
  buyExtraBatch() {
    const self = this;
    if (this.data.extraBoughtToday) {
      wx.showToast({ title: '今天已经解锁过了', icon: 'none' });
      return;
    }
    const price = growth.EXTRA_BATCH_PRICE;

    // 现算余额：不缓存，避免"买了之后余额没刷新"导致能重复买
    let balance = 0;
    try {
      const states = store.loadStates();
      const pts = growth.pointsBreakdown({
        states: states,
        pron: store.loadPronRecords(),
        spell: store.loadSpellRecords(),
        mastered: schedule.masteredCount(cards.allCards(), states),
        bestStreak: 0
      });
      balance = growth.balanceOf(pts.total, Number(wx.getStorageSync(growth.SPENT_KEY)) || 0);
    } catch (e) { balance = 0; }

    if (balance < price) {
      wx.showToast({ title: '还差 ' + (price - balance) + ' 积分', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '再练一组',
      content: '花 ' + price + ' 积分，今天再多练 ' + growth.EXTRA_BATCH_SIZE + ' 张（只限今天）。',
      confirmText: '解锁',
      success: function (res) {
        if (!res.confirm) return;
        let spent = 0;
        try { spent = Number(wx.getStorageSync(growth.SPENT_KEY)) || 0; } catch (e) { spent = 0; }
        let ok = true;
        try {
          wx.setStorageSync(growth.SPENT_KEY, spent + price);
          wx.setStorageSync(growth.EXTRA_KEY, self.today);
        } catch (e) { ok = false; }
        if (!ok) {
          wx.showToast({ title: store.saveFailureText(), icon: 'none' });
          return;
        }
        self.setData({ extraBoughtToday: true });
        wx.showToast({ title: '已解锁 ' + growth.EXTRA_BATCH_SIZE + ' 张', icon: 'none' });
        // 重新建队列：额度变了，能拿到的卡也变了
        self.buildQueue({ keepIfEmpty: true });
      }
    });
  },

  /**
   * 进入完成态时统一做两件事：**给一句话** + **放结算音**。
   *
   * 为什么合成一个方法：完成态有 5 个入口（空队列 / 拼写轮走完 / 跳过拼写 / 整轮走完），
   * 分散着写就会出现"某一条路径忘了放音"或"某一条忘了给文案" ——
   * 而这类遗漏在界面上只表现为"这次没什么感觉"，没人会当成 bug 报上来。
   *
   * ## 为什么不复用 sfx.playOk
   * 结算是**一段**（3~5 音上行琶音，620ms），答对是一声（160~220ms）。
   * 混用会让"今天练完了"和"这个词对了"听起来一样重，成就感就被稀释了。
   *
   * ## 空队列不放音
   * "今天没有要复习的词"不是成就，放庆祝音会很怪（像是在庆祝你不用学）。
   *
   * @param {boolean} [empty] 是否属于"没词可练"的空态
   * @returns {string} 完成页上的一句话（取自 utils/growth-copy.js，按日期轮换）
   */
  _onDone(empty) {
    if (empty) {
      try { return copyMod.pick('empty', null, this.today); } catch (e) { return ''; }
    }
    sfx.play('finish');
    try {
      const states = store.loadStates();
      let repairs = [];
      try {
        const v = wx.getStorageSync(growth.REPAIR_KEY);
        repairs = Array.isArray(v) ? v : [];
      } catch (e) { repairs = []; }

      const st = growth.streakOf(
        growth.activeDates(states, store.loadPronRecords(), store.loadSpellRecords()),
        this.today, { repairs: repairs });

      // 连胜里程碑优先报（比泛泛的"今天练完了"更值得说一句）
      const ms = copyMod.milestoneScene(st.current);
      if (ms) return copyMod.pick(ms, { n: st.current }, this.today);
      return copyMod.pick('goalDone', null, this.today);
    } catch (e) { return ''; }
  },

  /**
   * 当前单词的音节分段（供分色展示）。
   *
   * 返回 null 表示**不分色**，模板直接渲染原词。三种情况会是 null：
   *   · 中文释义（没有音节概念，染色像界面坏了）
   *   · 单音节词（只有一段，染色没有信息量）
   *   · 混入非拉丁字符的脏数据（如 `race（v.）`）
   * 判断逻辑集中在 syllable.displayParts，这里只负责取。
   */
  _sylOf(card) {
    if (!card) return null;
    try { return sylMod.displayParts(card.prompt); } catch (e) { return null; }
  },

  /**
   * 今天是否买过「再练一组」。
   *
   * 存储的是**日期串**而不是布尔：隔天自动失效，不需要任何清理任务
   * （清缓存/换设备也不会留下"永久解锁"的脏状态）。
   */
  _extraBoughtToday() {
    try {
      return wx.getStorageSync(growth.EXTRA_KEY) === this.today;
    } catch (e) { return false; }
  },

  /**
   * 设置里的学习量上限 —— 集中一处构造，避免两处各写一遍字段名。
   *
   * ## 「再练一组」的接线（2026-09-24 补）
   * 成长看板里花 100 积分买的「再练一组」，本质是**把今天的额度抬一批**。
   * 原来只写了存储键、没人读它 —— 用户花了积分什么都不发生，
   * 属于项目里出现过多次的"死功能"（买了没用）。这里补上读取。
   *
   * 口径：新词与复习**各加一批**。只加复习不加新词的话，
   * "今天想多背几个新词"的人买了也用不上 —— 而他恰恰是最愿意花积分的那种。
   *
   * 读不到/日期不是今天 → 当作没买（隔天自动失效，不需要清理任务）。
   */
  /**
   * 设置里的学习量上限 —— 集中一处构造，避免两处各写一遍字段名。
   *
   * ## 「自动学习量」（2026-09-30 新增）
   * settings.autoDaily=true 时，把 base 的两个字段换成 utils/learn-advisor.js
   * 算出的今日推荐值。它是**本地规则引擎、零 LLM**（理由与纪律见那个模块的注释）；
   * 这里只负责"开 → 用推荐；关 → 用手动"，不在本页内拼规则。
   *
   * ## 为什么 advisor 的输入要现算（不从卡片页/复习页缓存抄）
   * 复习页是 tabBar 长生命周期页，从 buildQueue 反流回来的 states 可能滞后；
   * 而 advisor 本来就是**为当下这一分钟**回答"今天该给多少"的——拿现读的
   * states + 现算的 todayPlan 才不会让"刚练完一通"被错算成"还没开始"。
   * 现算的开销量级可忽略：7 天窗口扫一遍 history，几百条。
   *
   * ## 「再练一组」与自动学习量的叠加
   * 今天的「再练一组」是学生**手动花的积分**——它必须凌驾于任何自动推荐。
   * 顺序 =（autoDaily ? 推荐值 : 手动值） + extraBatch —— 推荐负责"基础量"，
   * 再练一组负责"今天的额外量"，两者不打架。
   */
  dailyLimits() {
    const base = {
      dailyNewWords: settings.get('dailyNewWords'),
      dailyReviewMax: settings.get('dailyReviewMax')
    };

    // 自动学习量（默认关）：开 → 用 advisor 推荐值替换手动值（覆盖关系不是叠加）
    if (settings.get('autoDaily')) {
      try {
        const advisorMod = require('../../utils/learn-advisor.js');
        const rec = advisorMod.recommend({
          states: this.states,
          pron: store.loadPronRecords(),
          spell: store.loadSpellRecords(),
          cards: activeCards(),
          today: this.today,
          current: base,
          currentStreak: 0 /* 本页只用到它是几天活跃，连胜本身就是从它推的——传 0 没问题 */,
          todayPlan: this.countDueInScope(activeCards(), store.weakIds())
        });
        base.dailyNewWords = rec.newWords;
        base.dailyReviewMax = rec.reviewMax;
      } catch (e) {
        // advisor 失败时回落手动值，不能让一次异常把"今日任务"打成空
        console.warn('[study] learn-advisor 失败，使用手动学习量', e);
      }
    }

    let extra = 0;
    if (this._extraBoughtToday()) extra = growth.EXTRA_BATCH_SIZE;

    if (!extra) return base;
    return {
      dailyNewWords: (Number(base.dailyNewWords) || 0) + extra,
      dailyReviewMax: (Number(base.dailyReviewMax) || 0) + extra,
      extraBatch: extra                     // 界面据此提示"已解锁额外 N 张"
    };
  },

  /**
   * 按上面那个判据决定要不要过限流，并统一返回**同一形状**的结果。
   *
   * 不过限流时返回等价的"零裁剪"结果（queue 原样、hidden* 为 0），而不是 null ——
   * 调用方因此不必再写一遍 `limitInfo ? limitInfo.x : 0`。少一处能写错的地方，
   * 就少一次"两处口径分叉"的机会（那正是 2026-09-18 出过的事）。
   */
  applyLimitsIfNeeded(picked, scope, singleMode) {
    if (!this.shouldApplyLimits(scope, singleMode)) {
      return { queue: picked, hiddenNew: 0, hiddenReview: 0 };
    }
    return schedule.applyDailyLimits(picked, this.states, this.dailyLimits());
  },

  /**
   * 「还有 N 个词待复习」里的那个 N ——
   * 语义是 **"如果现在切到今日待复习，会给我多少张"**。
   *
   * ## 为什么不能用全库到期数（2026-09-19 修）
   * 原来这里（以及 buildQueue）取的是 schedule.dueCards(全部卡片)，**不按 subject/unit 过滤**。
   * 于是学生选了 `7A Unit 4`（队列 49 张），完成页却显示「还有 275 个词待复习」——
   * 275 是全库口径，与他自己刚选的范围毫无关系。数字和动作对不上，正是本项目一直在消灭的东西。
   *
   * ## 为什么还要过一遍限流（2026-09-19 再修，同一个洞的另一半）
   * 上一轮只把**范围**（subject/unit）对齐了，漏了**上限**：
   * scope='all' + 不限单元时 N 是全库到期数（如 287），而点过去后队列会被每日上限
   * 裁到 38 —— 数字与动作仍然不等。上一轮留下的正是这一半。
   *
   * 那一行的动作是"把 scope 切到 due"（见 study.wxml），切过去之后队列就是
   * pickCards(scope:'due', 当前 subject/unit) 再过 applyLimitsIfNeeded 的结果。
   * 所以这里走**同一条计算路径**：schedule.dailyQueue() —— 首页 deck.refresh 的
   * 「今天要练的」也走它。三处数字因此天然自洽，而不是靠"三处记得写一样"。
   *
   * 判据的 singleMode 传 false：这一行回答的是一个**假设动作**（切到 due）的结果，
   * 而那个动作只在非单卡模式下可达 —— 单卡模式练完时 onGrade 已把 singleId 与
   * singleMode 一起清掉（见那里"练完即退出"的注释），而这一行所在的完成页
   * 只在 done 为真时渲染（study.wxml 的 `<block wx:if="{{done}}">`）。
   * 也就是 `done === true` 蕴含 `singleMode === false`，传 false 与真实可达状态一致。
   */
  countDueInScope(cards, weak) {
    return schedule.dailyQueue(cards, this.states, this.today,
      { subject: this.data.subject, scope: 'due', unit: this.data.unit, singleMode: false },
      weak, this.dailyLimits()).queue.length;
  },

  /**
   * 只刷新计数，不重建队列（避免复习中途把队列洗掉）。
   *
   * 2026-09-18 修：原来 dueCountNow 用的是未限流的 picked.length，
   * 而 buildQueue 用的是限流后的 —— 于是复习到第 3 张时切走再切回来，
   * 顶部会变成"229 个"，而进度条还是"3/10"，同一个页面自己跟自己矛盾。
   * 现在两处用同一个 applyDailyLimits，口径统一。
   *
   * 2026-09-19：限流条件收敛到 shouldApplyLimits()，不再在这里重写一遍。
   * 抽取时**行为不变**：原来这里比 buildQueue 少一个 `!singleMode`，补上它不影响
   * 任何可达路径 —— refreshCounts 只有两个调用点（onShow 的无请求分支、
   * onGrade 的"练完最后一题"），两处的 singleMode 都必为 false（理由见
   * countDueInScope 的注释：done 为真蕴含 singleMode 为假；而 onShow 那条
   * `if (this.singleId) buildQueue()` 已经把单卡模式分流走了）。
   * 所以这个 `!singleMode` 本来就是"写对了但用不上"，补上是为了让判据只有一份。
   */
  refreshCounts() {
    const cards = activeCards();
    const weak = store.weakIds();
    const dueInScope = this.countDueInScope(cards, weak);
    let picked = schedule.pickCards(cards, this.states, this.today,
      { subject: this.data.subject, scope: this.data.scope, unit: this.data.unit }, weak);

    // 限流走全页唯一判据，见 shouldApplyLimits()
    picked = this.applyLimitsIfNeeded(picked, this.data.scope, this.data.singleMode).queue;

    this.setData({
      weakCount: weak.length,
      dueCountNow: picked.length,
      totalDue: dueInScope,
      // 单元进度会随复习变化（learned/count），这里一并刷新
      units: schedule.unitsOf(cards, this.states)
    });
  },

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.keepIfEmpty] 范围内没有下一批时**一点界面都不动**，
   *   直接返回 false 交给调用方处置（见 again()：完成页上点「再来一轮」时，
   *   空队列会把学生刚看到的这一轮成绩洗掉）。默认 false = 照旧切到完成页。
   * @returns {boolean} 是否真的建出了下一批（false = 该范围内没有可练的卡）
   */
  buildQueue(opts) {
    const keepIfEmpty = !!(opts && opts.keepIfEmpty);
    // 新一轮 = 连对清零。不清的话，上一轮攒到 C6 的音高会带到新一轮的第一张，
    // 学生听到"第一个词就最高音"，递进感直接失效。
    this._combo = 0;
    this._spellCombo = 0;
    sfx.reset();                       // 顺便清掉冷却窗，否则新一轮第一个音可能被上一轮的残留挡掉
    const cards = activeCards();
    const weak = store.weakIds();
    const dueInScope = this.countDueInScope(cards, weak);

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
          { subject: this.data.subject, scope: this.data.scope, unit: this.data.unit }, weak);
      }
    } else {
      picked = schedule.pickCards(cards, this.states, this.today,
        { subject: this.data.subject, scope: this.data.scope, unit: this.data.unit }, weak);
    }

    /**
     * 应用「学习量」设置（每日新词 / 每日复习上限）。
     *
     * 为什么必须做：学生设了"每天 10 个新词"，如果队列还是把 295 个词全排上，
     * 那个数字对初中生是劝退的，而且**设置项就是假的**。
     * 只在"到期"这个 scope 下限制 —— 学生主动选「全部单词」是想过一遍，
     * 那时再卡上限会显得莫名其妙。
     *
     * 2026-09-18 再放宽一档：**学生显式选了单元时也不限流**。
     * 理由与上面同源：学生说"我明天听写 Unit 2"，系统只给他 43 个里的 10 个，
     * 就是把他明确的意图打了折 —— 而"按单元学习"这个功能的用途正是
     * "我只要这一单元"，与限流直接冲突。单元规模本身可控（当前每单元 33~49 词），
     * 不会出现"一开就 200 张"的劝退场景。
     * 于是选单元时 hiddenNew / hiddenReview 自然为 0，完成页那句
     * 「词库里还有 N 个词没练」也不再出现 —— 这是对的，因为量已经给满了。
     *
     * 2026-09-19：这段条件（含 !singleMode）收敛到 shouldApplyLimits()，
     * 与 refreshCounts / countDueInScope 共用同一份判据 —— 三处各写一遍
     * 必然在某次改动后分叉，而分叉的症状正是"顶部数字与进度条自相矛盾"。
     */
    const limitInfo = this.applyLimitsIfNeeded(picked, this.data.scope, singleMode);
    picked = limitInfo.queue;

    /**
     * 「到期队列的同到期日洗牌」（2026-09-30 用户反馈「单词顺序是不是得随机打乱一下」）。
     *
     * ## 为什么在这里洗而不是 schedule.pickCards 里洗
     * pickCards 是任何"想知道这范围有几张、哪张该先出"的调用方的入口（spelling 页、
     * deck.refresh 等），顺序信息对这些调用方**有意义**（错得多的在前、新卡在前）。
     * 洗不洗是**呈现层**的选择 —— 只有"学生马上要按这个顺序看卡"的那个环节才该洗。
     * dailyQueue 同样在出口洗（见 schedule.js），含义与本路径一致。
     *
     * ## 为什么排完限流之后才洗
     * 洗牌先于限流的话，applyDailyLimits 的"取前 N 张"会把同一到期日按字母序截断——
     * 与"洗过一次再截"在概率上差异巨大（前 N 张会偏向字母小的）。
     * 限流之后洗，拿到的是**学生真的会见到的那 N 张**的随机排列。
     *
     * ## 仅 due + 非单卡模式
     * scope='all' / 'weak' 时学生主动要"完整过一遍"或"只练错题"，那才是他真正的目的，
     * 乱序反而会让他失去"过完整本"的进度感。单卡模式的队列被固定成一张，
     * 洗它也是空操作。
     */
    if (this.data.scope === 'due' && !singleMode) {
      picked = schedule.shuffleByDueDate(picked, this.states);
    }

    /**
     * keepIfEmpty：范围内确实没有下一批 → 直接返回，**不碰任何界面**。
     *
     * 放在这里（而不是下面的空分支里）有两个原因：
     *   · 下面那次 setData 会改 dueCountNow/hiddenNew 等字段，虽然完成页的
     *     成绩不在这批字段里，但"保持当前界面"就该是一点都不动；
     *   · 早返回顺带省掉 annotate() 的三次 sm2 预演（空队列本来就是空循环，
     *     主要是让意图明确：探测模式不做任何多余的事）。
     */
    if (picked.length === 0 && keepIfEmpty) return false;

    // 标注每张卡：是不是第一次学 + 三种反馈的后果（供按钮显示"下次 N 天"）
    const self = this;
    const annotated = picked.map(function (c) {
      return annotate(c, self.states[c.id], self.today, self.data.direction);
    });
    picked = annotated;

    this.setData({
      ready: true,
      singleMode: singleMode,
      weakCount: weak.length,
      dueCountNow: picked.length,
      totalDue: dueInScope,
      // 被上限挡在今天的量（界面提示"还有 N 个明天继续"）
      hiddenNew: limitInfo.hiddenNew,
      hiddenReview: limitInfo.hiddenReview,
      /**
       * 「再练一组」今天买过没有。
       *
       * 必须每次建队列都重读，不能只在 onLoad 读一次 ——
       * 学生从成长看板买完再切回复习页时**不重跑 onLoad**（tabBar 页只跑 onShow），
       * 只读一次的话按钮会一直是"可买"状态，点下去才被云端的余额拦住，
       * 而"点了没反应"正是最伤信任的一类毛病。
       */
      extraBoughtToday: this._extraBoughtToday()
    });

    if (picked.length === 0) {
      this.setData({
        done: true, doneSay: this._onDone(true), queue: [], current: null, sylParts: null,
        total: 0, reviewed: 0, progress: 0
      });
      return false;
    }

    // 每轮开始时清空重排计数 —— 否则第二轮会继承上一轮的计数，
    // 导致"该重排的词不再重排"（且这种 bug 只在做第二轮时出现，很难复现）
    this.retryCount = {};

    this.setData({
      done: false,
      queue: picked,
      idx: 0,
      current: picked[0],
      sylParts: this._sylOf(picked[0]),
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
    // 首张卡也是"新词出现"（若是新词）——自动发音与后续换卡同一触发口径
    this._autoSpeakCurrent();

    return true;
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

  /**
   * 选单元（2026-09-18 新增）。
   *
   * 这是学生最常用的筛选 —— "明天听写 Unit 2，我只背这一单元"。
   * 与选学科同样走 applyFilter（统一的"换范围会重建队列"路径）。
   */
  pickUnit(e) {
    const u = e.currentTarget.dataset.unit;
    if (u === this.data.unit) return;
    this.applyFilter({ unit: u });
  },

  pickScope(e) {
    const s = e.currentTarget.dataset.scope;
    if (s === this.data.scope) return;
    this.applyFilter({ scope: s });
  },

  /**
   * 听写模式（中→英）开关：只改**呈现方向**，队列/评分/SM-2 一概不动。
   * 真实场景：明天听写，考的是"听中文写英文" —— 正向卡（看英文想中文）练不到这个方向。
   */
  setDirection(e) {
    const d = e.currentTarget.dataset.dir === 'reverse' ? 'reverse' : 'forward';
    if (d === this.data.direction) return;
    this.applyFilter({ direction: d });
  },

  /** 学后拼写开关（默认开）：不改队列与排期，只在评分后插入一次客观拼写 */
  toggleSpellCheck() {
    const next = !this.data.spellCheck;
    this.setData({ spellCheck: next });
    store.savePrefs(Object.assign(store.loadPrefs(), { spellCheck: next }));
  },

  /**
   * 手动发音：随包/云端取材（audioPack 一条链），再点一次是停止。
   * 取材、复用 InnerAudioContext、播放状态的公共部分在 _speak ——
   * 自动发音（_autoSpeakCurrent）与手动点按共用同一个 context，
   * 否则两条各建播放器会出现"自动读还没停、手动点又叠一层"的混音。
   */
  playWord() {
    const card = this.data.current;
    if (!card) return;
    if (this.data.playingWord === card.id) {
      if (!this.audio) return;
      try { this.audio.stop(); } catch (err) { /* 忽略 */ }
      this.setData({ playingWord: '' });
      return;
    }
    this._speak(card.prompt, card.id, true);
  },

  /**
   * 发音公共路径。
   * @param {boolean} manual 手动点按时取材失败要给一句实话（"这个词没有发音"）；
   *   自动发音失败则**静默** —— 学习流程不该被一次取材失败弹窗打断。
   */
  _speak(word, cardId, manual) {
    const self = this;
    // 录音期间强制静音沿用 sfx 的口令（pronounce 页录音时任何出声都会
    // 污染声学判定，见 utils/sfx.js setMuted 的注释）——自动发音不另立规则。
    if (sfx.isMuted && sfx.isMuted()) return;
    if (settings.get('autoSpeak') === false && !manual) return;
    audioPack.resolveForPlay(word).then(function (r) {
      if (!r || !r.ok || !r.src) {
        if (manual) wx.showToast({ title: '这个词没有发音', icon: 'none' });
        return;
      }
      if (!self.audio) {
        self.audio = wx.createInnerAudioContext();
        self.audio.onEnded(function () { self.setData({ playingWord: '' }); });
        self.audio.onError(function () { self.setData({ playingWord: '' }); });
      }
      self.audio.stop();
      self.audio.src = r.src;
      self.audio.play();
      self.setData({ playingWord: cardId });
    }).catch(function () { /* 取材链的异常转静默：见 manual 分支的理由 */ });
  },

  /**
   * 自动发音（2026-09-25 用户反馈「背这个单词需要同步朗读」）。
   * 只在卡片**出现**时被调用（buildQueue 首张 / _advanceTo 换卡），且只对
   * 「新词的正面」出声 —— 旧词正面是考题（先自己回想），出新词的音等于放答案；
   * 翻到答案面的自动读在 flipCard 里，两边合计恰好覆盖 brief 的两个触发点。
   * 听写（reverse）正面给的是中文，更不能出声。
   */
  _autoSpeakCurrent() {
    const card = this.data.current;
    if (!card) return;
    if (card.reverse || !card.isNew) return;
    this._speak(card.prompt, card.id, false);
  },

  /** 自动发音开关（设置面板）：settings 落盘，立即生效，无需重启 */
  toggleAutoSpeak() {
    const next = !this.data.autoSpeak;
    this.setData({ autoSpeak: next });
    settings.save({ autoSpeak: next });
  },

  goSpelling() {
    wx.navigateTo({ url: '/pages/spelling/spelling' });
  },

  onHide() {
    // 切走时停声：tabBar 页面长生命周期，不节制的音频会在别的页面继续响
    if (this.audio) { try { this.audio.stop(); } catch (err) { /* 忽略 */ } }
    if (this.data.playingWord) this.setData({ playingWord: '' });
  },

  applyFilter(patch) {
    const restart = () => {
      const next = Object.assign(
        { subject: this.data.subject, scope: this.data.scope, unit: this.data.unit,
          direction: this.data.direction, spellCheck: this.data.spellCheck }, patch);
      store.savePrefs(next);
      this.states = store.loadStates();
      this.setData({
        subject: next.subject,
        scope: next.scope,
        unit: next.unit,
        direction: next.direction,
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

  /**
   * 一键只练错题（完成页那行「错题本里攒了 N 个 → 专项重练」）。
   *
   * ⚠️ 必须把 unit 一起重置成 'all'（2026-09-19 修）。
   *
   * 那行文案的主语是「**错题本**里攒了 N 个」，而 N 是 weakCount = weakIds().length，
   * 即**全库**错题数 —— 错题本这个概念在全项目都是全库口径（deck 的错题本入口
   * goWeakPractice 也重置 unit 走全库）。
   *
   * 原来只 applyFilter({scope:'weak'})，保留了当前单元，动作于是变成
   * "全库错题 ∩ 当前单元"：学生看到「攒了 2 个」，点进去却是「错题本已清空」
   * （当前单元内 0 个）—— 数字与动作打架，正是本项目一直在消灭的毛病。
   *
   * 这里选择"让动作与文案的主语一致"（点它 = 练整个错题本），而不是把 N 改成
   * "当前范围内的错题数"：后者会让同一个错题本出现两种范围（deck 全库、study 按单元），
   * 而错题本在全项目只有一个口径。
   */
  practiceWeak() {
    if (this.data.weakCount === 0) {
      wx.showToast({ title: '还没有答错过的卡', icon: 'none' });
      return;
    }
    this.applyFilter({ scope: 'weak', unit: 'all' });
  },

  /*------------------------- 翻卡与评分 -------------------------*/

  flipCard() {
    if (this.data.leaving || this.data.done) return;
    // 触感（2026-09-25）：守卫之后第一句同步调 —— "及时"的纪律见 utils/haptic.js
        const flipped = !this.data.flipped;
    this.setData({ flipped: flipped });
    // 翻到答案面自动读一遍（用户反馈「背这个单词需要同步朗读」）。
    // 正面只在"新词出现"时读（buildQueue / _advanceTo），这里不重复触发 ——
    // 否则旧词正面也出声，等于把"先自己回想"的考题念了答案（答案虽是释义，
    // 但声音先到会瓦解回忆的窗口）。
    if (flipped && this.data.current) {
      this._speak(this.data.current.prompt, this.data.current.id, false);
    }
  },

  onGrade(e) {
    if (this.data.leaving || this.data.done) return;
    if (!this.data.flipped) return;              // 未翻面不许评分（主动回忆）

    // 触感：评分是提交类操作，medium 档；守卫之后第一句，见 utils/haptic.js
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
      wx.showToast({ title: store.saveFailureText(), icon: 'none', duration: 1800 });
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
      // 抖动挂在 .grade（评分按钮区），不是卡片 —— 理由见 study.wxml / study.wxss 注释。
      // ⚠️ 这个 340 必须与 app.wxss 的 `.shake { animation: shake 340ms ... }` 相等，
      //    且**不得早于动画时长**，否则抖动会在播完前被摘掉（上一版 360ms 动画配 340ms
      //    摘类 = 截断在 94%）。改任一边都要同步另一边。
      setTimeout(() => this.setData({ shaking: false }), 340);
    }

    /**
     * 当天重排：答错（或新词选"再看一遍"）时把这张卡挪到队尾，本轮末尾再考一次。
     *
     * ## 为什么必须有这个（2026-09-18 修）
     * 原来点"不认识"→ sm2 给出 interval=1 → **这个词今天再也不出现**。
     * 于是学生的行为是：看一眼答案，1 天后再见，那时还是不认识，
     * 再点"不认识"…… 而每点一次 EF 就掉一截（实测三次触底 1.3），
     * 永远停在 1 天的循环里。**系统里没有任何路径能让一个生词被真正学会。**
     *
     * 这和 Anki 的做法对齐：答错的卡回到 relearning 队列当天重考，直到答对才毕业。
     * SM-2 的公式一行没动 —— 重排纯粹是**页面层的调度**，不改变写回的状态
     * （落库的仍是 sm2 算出的正常结果，下次到期日按算法来）。
     *
     * ## 为什么要限次数
     * 学生的直觉是"再看一眼就能记住"，但连看 5 次还记不住的词，看第 6 次也没用。
     * 上限 2 次：既给了"当天学会"的机会，又不会让一轮做不完（否则是另一种挫败）。
     */
    const RETRY_LIMIT = 2;
    this.retryCount = this.retryCount || {};
    const needRetry = (q === GRADE.FORGOT) || (card.isNew && q === GRADE.VAGUE);
    const retried = this.retryCount[card.id] || 0;
    const didRetry = needRetry && retried < RETRY_LIMIT;
    if (didRetry) this.retryCount[card.id] = retried + 1;
    if (didRetry) card.retryBack = true;   // 这张回来时正面挂「本轮再来」——用户反馈"怎么就直接划过去了"的可见答案

    // 结果条要说清"接下来发生什么"。
    //
    // ⚠️ 2026-09-19 改：原来是 wx.showToast（icon:none 居中悬浮 1100ms）——
    // 而换卡动画 190ms 就把下一张卡推进来，结果 toast 悬浮在**下一张卡的单词上**，
    // 学生看到的是"点了认识，单词被一块黑东西盖住"。这是作者点名的问题。
    // 改为常驻结果条（.result-strip，非阻塞，见 study.wxml）：内容一样，
    // 但它躺在按钮下方自己的行里，不与卡片重叠，还能回头看上一张的结果。
    let resultText;
    if (card.isNew) {
      resultText = q === GRADE.KNOW
        ? '记住了 · ' + next.interval + ' 天后复习'
        : (didRetry ? '再看一遍 · 本轮末尾再来' : '这个词下次见面 · ' + next.interval + ' 天后');
    } else {
      resultText = q === GRADE.KNOW ? ('认识 · ' + next.interval + ' 天后')
        : q === GRADE.VAGUE ? ('模糊 · ' + next.interval + ' 天后')
        : (didRetry ? '没关系 · 本轮末尾再考你一次' : '这个词下次见面 · ' + next.interval + ' 天后');
    }

    const isLast = this.data.idx >= this.data.queue.length - 1;
    const reviewed = this.data.reviewed + 1;

    /**
     * 当天重排：答错（或新词选"再看一遍"）时把这张卡挪到队尾，本轮末尾再考一次。
     *
     * ## 为什么必须有这个（2026-09-18 修）
     * 原来点"不认识"→ sm2 给出 interval=1 → **这个词今天再也不出现**。
     * 于是学生的行为是：看一眼答案，1 天后再见，那时还是不认识，
     * 再点"不认识"…… 而每点一次 EF 就掉一截（实测三次触底 1.3），
     * 永远停在 1 天的循环里。**系统里没有任何路径能让一个生词被真正学会。**
     *
     * 这和 Anki 的做法对齐：答错的卡回到 relearning 队列当天重考，
     * 直到答对才毕业。SM-2 的公式一行没动 —— 重排纯粹是**页面层的调度**，
     * 不写回状态（写回的是 sm2 算出的正常结果，下次到期仍是按算法来的）。
     *
     * ## 为什么要限次数
     * 学生的认知是"再看一眼就能记住"，但连看 5 次还记不住的词，再看第 6 次也没用。
     * 上限 2 次：既给了"当天学会"的机会，又不会让一轮做不完（否则是另一种挫败）。
     * 超过上限时给一句实话（见上面的结果条文案），比无限重排更尊重学生的时间。
     */
    // 重排产生的队列变化（queue / total）在下面的 setData 里一并提交
    const queue = didRetry ? this.data.queue.concat([card]) : this.data.queue;

    /**
     * 换卡的界面推进数据。2026-09-19 拆出来：学后拼写开启时，
     * 这批数据先**挂起**（_spellGradeState），拼完这个词再提交并推进。
     */
    const advanceData = {
      leaving: true,
      queue: queue,
      total: queue.length,
      streak: streak,
      bestStreak: best,
      showBadge: showBadge,
      // 结果条内容随换卡一起提交（离开动画期间就已就位，不闪）
      lastResult: { word: card.prompt, text: resultText, soft: !!(needRetry && didRetry) },
      roundKnow: this.data.roundKnow + (q === GRADE.KNOW ? 1 : 0),
      roundVague: this.data.roundVague + (q === GRADE.VAGUE ? 1 : 0),
      roundForgot: this.data.roundForgot + (q === GRADE.FORGOT ? 1 : 0)
    };

    // 收集本轮词汇：整轮过完后统一进拼写轮（识别与产出分开，测真回忆不测瞬时记忆）
    if (!this._roundWords) this._roundWords = [];
    if (this._roundWords.indexOf(card) === -1) this._roundWords.push(card);

    /**
     * 反馈音效（2026-09-24 改为**连对递进**）。
     *
     * 连对计数器只用于**声音**，不重新引入"连对 N"的界面标签 ——
     * 那个标签是 2026-09-19 用户点名删掉的（当时的理由：数字挂在界面上像考核）。
     * 声音不需要被"看见"，它只在耳朵里形成一条上行线，作用一样但不说教。
     *
     * 计数规则（宽严相济）：
     *   认识 → +1（音高随连对上升：C5→E5→G5→C6）
     *   模糊 → 不变（不算对也不算错 —— 它本来就是"说不清"的那一档）
     *   不认识 → 归零（但只响一次低沉音，不叠加惩罚感；连错 3 次起自动变轻，见 sfx.js）
     */
    this._combo = this._combo || 0;
    if (q === GRADE.KNOW) {
      this._combo += 1;
      sfx.playOk(this._combo);
    } else if (q === GRADE.FORGOT) {
      this._combo = 0;
      sfx.playBad();
    } else {
      sfx.play('tap');
    }

    this.setData(advanceData);
    this._advanceTo(isLast, reviewed);
  },

  /*------------------------- 拼写轮（整轮过完后的产出检验） -------------------------*/

  /** 开始拼写轮：本轮的词洗牌，逐个拼（逐字母点填 / 四选一交替） */
  _startSpellRound(words) {
    const list = words.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    this._spellList = list;
    this._spellIdx = 0;
    this._spellLog = [];
    // 重学段双账本（2026-09-25 用户反馈「不能只靠自评」）：
    //   pendingRetry —— 本段判错、等待追加到队尾的词；追加后即清空，防无限循环
    //   everRetried  —— 本轮已被重学过的词；二次判错不再追加
    //   （连错两遍还不会的词看第三遍也没用 —— 与识别轮 retryCount 上限同一哲学）
    this._spellPendingRetry = [];
    this._spellEverRetried = [];
    this.setData({ spellRound: true, spellIdx: 0, spellTotal: list.length,
                   spellOkCount: 0, spellBadCount: 0 });
    this._spellWord();
  },

  /** 拼写轮的一个词：偶数位=逐字母点填（中译英），奇数位=四选一（英译中） */
  _spellWord() {
    const card = this._spellList[this._spellIdx];
    // 重学词（判错后追加回来的）**强制逐字母拼写**：它挂在队尾是因为"没拼出来"，
    // 用四选一再考一遍测不出"会拼"，重学就失去了意义。节奏交替只对首遇词生效。
    const isRetry = !!(this._spellEverRetried &&
                       this._spellEverRetried.indexOf(card.id) >= 0);
    const mode = (this._spellIdx % 2 === 0 || isRetry) ? 'spell' : 'choice';
    // spellRetry：本轮判错后被追加回来的词，卡头挂「重学」标签 ——
    // 让学生明确知道"这是刚才错的那个"，而不是莫名又见到一次
    this.setData({ spellWord: card, spellMode: mode, spellVerdict: null,
                   spellReady: false, spellShaking: false,
                   spellRetry: this._spellEverRetried &&
                               this._spellEverRetried.indexOf(card.id) >= 0 });

    if (mode === 'spell') {
      // 字母槽：目标词的字母逐个占位；空格自动落位不进槽
      const target = String(card.prompt || '');
      const bank = target.replace(/[^A-Za-z]/g, '').split('');
      // 干扰字母：词长 ≥4 时混入 2 个，逼真回忆而不是机械排列
      if (bank.length >= 4) {
        const POOL = 'abcdefghijklmnoprstuvw';
        bank.push(POOL[Math.floor(Math.random() * POOL.length)]);
        bank.push(POOL[Math.floor(Math.random() * POOL.length)]);
      }
      for (let i = bank.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = bank[i]; bank[i] = bank[j]; bank[j] = t;
      }
      this.setData({
        spellSlots: target.split('').map(ch => /[A-Za-z]/.test(ch)
          ? { need: true, ch: '', state: 'empty' }
          : { need: false, ch: ch, state: 'fixed' }),
        spellBank: bank.map(ch => ({ ch: ch, used: false }))
      });
    } else {
      // 英译中：正确释义 + 同轮其它词的释义做干扰项
      const pool = [];
      (this.data.queue || []).forEach(function (c) {
        if (c.id !== card.id && c.answer && pool.indexOf(c.answer) === -1) pool.push(c.answer);
      });
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      const choices = [card.answer].concat(pool.slice(0, 3));
      for (let i = choices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = choices[i]; choices[i] = choices[j]; choices[j] = t;
      }
      this.setData({ spellChoices: choices });
    }
  },

  /**
   * 点字母库：填进第一个空槽（点一个填一个）。
   * 2026-09-25 改：填满**不再自动判分**（用户反馈"判完瞬间就划走"）——
   * 落满只把 spellReady 点亮，交给「验证」按钮；学生手指还停在屏上的那几百毫秒
   * 不该替他做提交决定，错因也只有在他主动提交后才能停留给他看。
   */
  onBankTap(e) {
    if (this.data.spellVerdict) return;
    // 落槽震动已砍（2026-09-26 用户反馈"震得很麻"）：spelling/study/quiz 三页
    // 都只留低频事件震动（评分/验证/跳过），字母落槽/退格这类高频操作不碰振动器。
    const i = e.currentTarget.dataset.i;
    const bank = this.data.spellBank;
    if (!bank[i] || bank[i].used) return;
    const slots = this.data.spellSlots;
    const pos = slots.findIndex(s => s.need && s.state === 'empty');
    if (pos === -1) return;
    slots[pos] = { need: true, ch: bank[i].ch, state: 'filled', from: i };
    bank[i].used = true;
    sfx.play('tap');
    const allFilled = slots.every(s => !s.need || s.state !== 'empty');
    this.setData({ spellSlots: slots, spellBank: bank, spellReady: allFilled });
  },

  /** 点已填的槽：退回字母库（发现点错可以改） */
  onSlotTap(e) {
    if (this.data.spellVerdict) return;
    const i = e.currentTarget.dataset.i;
    const slots = this.data.spellSlots;
    const s = slots[i];
    if (!s || s.fixed || s.state !== 'filled') return;
    // 退格震动已砍（同上）
    const bank = this.data.spellBank;
    if (s.from !== undefined && bank[s.from]) bank[s.from].used = false;
    slots[i] = { need: true, ch: '', state: 'empty' };
    // 退格后重算 spellReady：填满→退一个→「验证」必须回到未就绪，
    // 否则残留的就绪态会让 verifySpell 放行一份残缺答案
    const ready = slots.every(x => !x.need || x.state !== 'empty');
    this.setData({ spellSlots: slots, spellBank: bank, spellReady: ready });
  },

  /**
   * 显式验证（2026-09-25 用户点名的交互）：点了才判分。
   * 判完的错因（逐格红绿 + 错因行）停留到学生手动点「下一张」——
   * 不设任何自动推进定时器。原来的"自动判分"正是"直接划过去"的元凶。
   */
  verifySpell() {
    if (!this.data.spellRound || this.data.spellMode !== 'spell' ||
        this.data.spellVerdict) return;
    const full = this.data.spellSlots.every(s => !s.need || s.state !== 'empty');
    if (!full) {
      // 防呆：没填满就点验证 —— 抖按钮 + 一句实话，而不是静默失败或替他判
            this.setData({ spellShaking: true });
      wx.showToast({ title: '还有字母没填完', icon: 'none' });
      // 340 与 app.wxss .shake 动画时长同源（见 onGrade 里的同步注释），不得单方改动
      setTimeout(() => this.setData({ spellShaking: false }), 340);
      return;
    }
    haptic.tap('medium');
    this._judgeSlots();
  },

  /** 槽满自动判分：逐槽标色 + 错因 + 记录（拼写错误分析的数据源） */
  _judgeSlots() {
    const card = this.data.spellWord;
    // typed 必须**全槽拼接**（含 fixed 槽的空格/连字符/撇号）：
    // spelling.judge 的目标串保留这些字符，若只取 need 槽，
    // 「go straight on」这类多词短语在字母全放对时会被判"写错了字母"
    //（实测：'gostraighton' vs 'go straight on' → 前后缀对齐后中段多出空格）。
    // 独立拼写页（pages/spelling）的 cells 本就是全槽拼接，两处口径必须一致。
    const typed = this.data.spellSlots.map(s => s.ch).join('');
    const v = spellingMod.judge(typed, card.prompt);
    const letters = String(card.prompt || '').replace(/[^A-Za-z]/g, '').split('');
    let li = 0;
    const slots = this.data.spellSlots.map(function (s) {
      if (!s.need) return s;
      const okc = s.ch === letters[li]; li++;
      return Object.assign({}, s, { state: okc ? 'ok' : 'bad' });
    });
    store.addSpellRecord(card.id, { date: this.today, typed: typed, ok: v.ok, errType: v.errType });
    // 判错的词进重学账本：本轮末尾再呈现一遍（见 _extendSpellRound）。
    // 只进呈现队列，**不碰 SM-2** —— 拼写轮本来就是识别轮之后的验证层，
    // 这里的错已经由 addSpellRecord 记账，再写一次排期就是双重惩罚。
    if (!v.ok &&
        this._spellEverRetried.indexOf(card.id) === -1 &&
        this._spellPendingRetry.indexOf(card) === -1) {
      this._spellPendingRetry.push(card);
    }
    // 拼写轮自己一套连对（与识别轮分开）：两个练习的难度不同，
    // 混用一个计数器会让"识别连对 8 次"顺带把拼写的音高也顶到最高，失去递进的意义。
    this._spellCombo = this._spellCombo || 0;
    if (v.ok) { this._spellCombo += 1; sfx.playOk(this._spellCombo); }
    else { this._spellCombo = 0; sfx.playBad(); }
    this.setData({
      spellSlots: slots, spellVerdict: v,
      // 判完就绪态必须熄灭：这个答案已经提交过了，「验证」按钮随之消失
      spellReady: false,
      spellOkCount: this.data.spellOkCount + (v.ok ? 1 : 0),
      spellBadCount: this.data.spellBadCount + (v.ok ? 0 : 1)
    });
  },

  /** 英译中四选一：选项点选也是一次提交，触感与判分同步 */
  spellChoicePick(e) {
    if (this.data.spellVerdict) return;
        const chosen = e.currentTarget.dataset.a;
    const card = this.data.spellWord;
    const ok = chosen === card.answer;
    store.addSpellRecord(card.id, { date: this.today, typed: chosen, ok: ok,
      errType: ok ? '' : '释义选错了' });
    // 四选一判错与逐字母判错同账本：验证层哪里暴露的弱点，重学段就在哪里补
    if (!ok && this._spellEverRetried &&
        this._spellEverRetried.indexOf(card.id) === -1 &&
        this._spellPendingRetry.indexOf(card) === -1) {
      this._spellPendingRetry.push(card);
    }
    this._spellCombo = this._spellCombo || 0;
    if (ok) { this._spellCombo += 1; sfx.playOk(this._spellCombo); }
    else { this._spellCombo = 0; sfx.playBad(); }
    this.setData({
      spellVerdict: { ok: ok, errType: ok ? '' : '释义选错了', nodes: [], hint: '', chosen: chosen },
      spellOkCount: this.data.spellOkCount + (ok ? 1 : 0),
      spellBadCount: this.data.spellBadCount + (ok ? 0 : 1)
    });
  },

  /** 拼写轮的"继续"：下一个词，或收轮进完成页 */
  /**
   * 拼写轮的「继续」：下一个词 → 有重学债先还 → 收轮进完成页。
   * 2026-09-25 关键改动：推进只发生在学生手动点「下一张」时（触感同步），
   * 判分后的错因想看多久看多久 —— 不存在任何自动推进路径。
   */
  spellNext() {
    if (!this.data.spellRound) return;
        this._spellAdvance();
  },

  /**
   * 单词跳过 = 「看答案」（2026-09-25 修）：先把正确答案亮出来，再由学生手动进下一词。
   *
   * ## 为什么不能像旧实现那样静默划走
   * 界面文案承诺的是"点'跳过'直接看答案"，旧实现却只做 _spellAdvance ——
   * 想看答案的学生得到的是"什么都没看见就换了词"。跳过的学习价值恰恰在"揭晓"：
   * 把正确拼写填进每个字母槽（状态 peek），与判错停留同一节奏（手动点「下一个」）。
   *
   * ## 为什么不判分、不记账、不进重学段
   * 跳过是"看答案"，不是"答对"也不是"答错"：
   *   · 不写 spell_records —— 没有学生产出的输入，写进去会污染统计页的拼写错误分析；
   *   · 不动 ok/bad 计数（不标绿红）—— 计数器回答的是"你拼出了多少"，跳过没有产出；
   *   · 不进 _spellPendingRetry —— 重学段的意义是"再给一次回忆机会"，
   *     刚看过答案立刻重考测的是瞬时记忆（与 _judgeSlots 的队尾哲学一致）。
   *   · 槽位状态用 peek 而不是 ok：绿色已被"判对"占用，黄色"揭晓"才不会
   *     让学生误以为跳过也被记成拼对（配色见 study.wxss 的 .sp-slot.peek 注释）。
   */
  spellSkipWord() {
    if (this.data.spellVerdict) return;   // 已判/已亮过就不再动 —— 与其它拼写处理器同一守卫
        const card = this.data.spellWord;
    if (this.data.spellMode === 'spell') {
      // 取字母口径与 _judgeSlots 一致：只取 A-Za-z、按序对应各 need 槽
      //（空格/连字符等 fixed 槽本来就带着正确字符，不需要动）
      const letters = String(card.prompt || '').replace(/[^A-Za-z]/g, '').split('');
      let li = 0;
      const slots = this.data.spellSlots.map(function (s) {
        if (!s.need) return s;
        const ch = letters[li]; li += 1;
        return Object.assign({}, s, { ch: ch, state: 'peek' });
      });
      this.setData({
        spellSlots: slots,
        // verdict 的结构走判分同款（wxml 靠它亮出"下一个"按钮），peek 标记"这是揭晓不是判决"
        spellVerdict: { ok: false, peek: true, errType: '', nodes: [],
          hint: '这是正确答案 · 记住它，点「下一个」继续' }
      });
    } else {
      // 四选一：不需要动 slots —— wxml 的 verdict 分支会自动把正确项标 on
      //（chosen 留空，没有任何选项被标为"选错的"）
      this.setData({
        spellVerdict: { ok: false, peek: true, errType: '已看答案', chosen: null, nodes: [], hint: '' }
      });
    }
  },

  /** 推进一格；队列见底时先问重学账本，还清了才收轮 */
  _spellAdvance() {
    this._spellIdx += 1;
    if (this._spellIdx >= this._spellList.length && this._extendSpellRound()) {
      // 重学段已追加到队尾：继续走，不进完成页
      this.setData({ spellIdx: this._spellIdx });
      this._spellWord();
      return;
    }
    if (this._spellIdx >= this._spellList.length) {
      this.setData({ spellRound: false, done: true, doneSay: this._onDone(), leaving: false, current: null, sylParts: null,
        quote: quotes.todayQuote(this.today) });
      this.refreshCounts();
      return;
    }
    this.setData({ spellIdx: this._spellIdx });
    this._spellWord();
  },

  /**
   * 重学段（2026-09-25 新增）：本轮判错的词**追加到队尾**再过一遍。
   *
   * ## 为什么是"本轮尾部"而不是立刻重考
   * 刚判完错立刻重考，测的是瞬时记忆（答案还在眼前）；隔几个词再回来，
   * 才算得上第二次回忆机会 —— 与识别轮"答错挪到队尾"同一调度哲学。
   *
   * ## 为什么不动 SM-2
   * 拼写轮是识别评分之后的**验证层**：错误事实已由 addSpellRecord 记账
   * （统计页的错误原因分析吃这份数据），再触发一次排期写入等于对同一个
   * 错误双重惩罚。这里只影响本轮呈现顺序，跨轮记忆强度仍由识别轮评分决定。
   *
   * @returns {boolean} 是否真的追加了（false = 没有重学债，调用方收轮）
   */
  _extendSpellRound() {
    if (!this._spellPendingRetry || !this._spellPendingRetry.length) return false;
    const retryCards = this._spellPendingRetry.slice();
    this._spellPendingRetry = [];
    const self = this;
    retryCards.forEach(function (c) {
      self._spellEverRetried.push(c.id);   // 先记账：重学段里再错也不追加第二次
      self._spellList.push(c);
    });
    this.setData({ spellTotal: this._spellList.length });
    return true;
  },

  /** 跳过拼写轮（直接看完成页） */
  skipSpellRound() {
    this.setData({ spellRound: false, done: true, doneSay: this._onDone(), leaving: false, current: null, sylParts: null,
      quote: quotes.todayQuote(this.today) });
    this.refreshCounts();
  },

  /**
   * 换卡推进（从 onGrade 拆出）：学后拼写关闭时在评分后 190ms 调用；
   * 开启时由 spellContinue 在拼完后调用。逻辑与拆分前逐行一致。
   */
  _advanceTo(isLast, reviewed) {
    setTimeout(() => {
      if (isLast) {
        // 完成条件：已经是最后一题**且没有刚追加的重排卡**
        // （追加过的话 queue 变长了，isLast 是按旧长度算的，所以这里要再判一次）
        const stillMore = this.data.idx < this.data.queue.length - 1;
        if (stillMore) {
          const idx = this.data.idx + 1;
          this.setData({
            idx: idx,
            current: this.data.queue[idx],
            sylParts: this._sylOf(this.data.queue[idx]),
            flipped: false,
            leaving: false,
            entering: true,
            hookOpen: false,
            reviewed: reviewed,
            progress: Math.round((idx + 1) / this.data.queue.length * 100)
          });
          this._autoSpeakCurrent();   // 新词正面自动读（旧词正面不读，见方法注释）
          setTimeout(() => {
            this.setData({ entering: false, showBadge: false });
          }, 320);
          return;
        }
        /**
         * 练完即毕业：在这里清掉单卡模式标记 —— 兑现 buildQueue 里
         * "单卡模式：只练指定的这一张，练完即退出该模式"那句注释。
         *
         * ## 为什么必须清
         * 复习页是 tabBar 页，实例**不会被销毁**（见 onShow 的说明）。
         * 不清 this.singleId 的话，这个实例会永远停在那一张卡上循环，
         * 而 tabBar 页没有"退出"这个动作 —— 用户除了杀掉小程序或删掉这张卡，
         * 没有任何办法自己出来。这是"注释承诺了、实现没兑现"。
         *
         * ## 为什么只在"完成"时清，而不是每张卡评分后就清
         * 单卡模式只有一张卡，中途退出再回来仍应停在那张卡上 —— 用户还没做完，
         * 这是合理的；一评分就清会让他下次进来面对普通队列，反而把这张卡弄丢了。
         * 清掉之后 again()（再来一轮）会自然回到普通队列：那一张已经练完，
         * 该给他今天的正常任务，而不是又一张同一张卡。
         */
        this.singleId = null;

        /**
         * 整轮识别完成 → **拼写轮**（2026-09-19 重构）：
         * 刚看完就拼是瞬时记忆，没意义 —— 先把整轮的词都过一遍，
         * 隔了一轮再来拼，才是真的回忆。逐字母点填 / 四选一交替。
         * 单卡模式不进拼写轮（那一张刚单独练完）。
         *
         * 2026-09-21 修：此处原先写的是裸标识符 `singleMode` —— 它在
         * `buildQueue()` 内部（本函数作用域链上看不到），只有 `this.data.singleMode`
         * 才是当前队列的模式。非严格模式下读取未声明标识符抛 ReferenceError，
         * 而异常发生在 setTimeout 回调里、无人捕获；此时 `leaving: true` 已提交，
         * 卡片已滑出而完成页不再渲染，`onGrade`/`flipCard` 首行的 `leaving` 守卫
         * 又挡住一切交互 —— 页面彻底冻结，用户只能杀掉小程序。
         * 之所以长期没被发现：4 道门禁加载本页前都强制注入 `spellCheck=false`，
         * 而该值默认为 true，这个分支从未被门禁执行到。
         */
        if (this.data.spellCheck && !this.data.singleMode && this._roundWords && this._roundWords.length) {
          this.setData({
            reviewed: reviewed, progress: 100, leaving: false, entering: false,
            current: null, sylParts: null, hookOpen: false
          });
          this._startSpellRound(this._roundWords);
          return;
        }

        this.setData({
          done: true, doneSay: this._onDone(), leaving: false, current: null, sylParts: null,
          reviewed: reviewed, progress: 100,
          // 标记已清，界面状态同步复位 —— 否则完成页还带着单卡模式的痕迹
          singleMode: false,
          // 完成页收一句当日名言：坚持的正反馈放在收获的时刻
          quote: quotes.todayQuote(this.today)
        });
        this.refreshCounts();
      } else {
        const idx = this.data.idx + 1;
        this.setData({
          idx: idx,
          current: this.data.queue[idx],
          // 音节分色必须与 current 一起换（2026-09-27 修）：WXML 正面/听写背面在
          // sylParts 非空时渲染它的字母**代替**单词 —— 这里漏设的话 sylParts 停在
          // buildQueue 的首卡，每轮第 2 张起全部显示当册第一个词（stillMore 分支
          // 一直带着它，所以只有"重排回来的末尾卡"显示正确，正常推进反而全错）。
          sylParts: this._sylOf(this.data.queue[idx]),
          flipped: false,
          leaving: false,
          entering: true,
          // 换卡时收起钩子详情：否则下一张进来直接是展开态，很突兀
          hookOpen: false,
          reviewed: reviewed,
          progress: Math.round((idx + 1) / this.data.queue.length * 100)
        });
        this._autoSpeakCurrent();   // 与 stillMore 分支同款：新词正面出声，旧词不出
        setTimeout(() => {
          this.setData({ entering: false, showBadge: false });
        }, 320);
      }
    }, 190);
  },

  goDeck() { wx.switchTab({ url: '/pages/deck/deck' }); },
  // 2026-09-25 底部栏整理：stats 退出 tabBar，switchTab 只对 tabBar 页有效
  // （对普通页静默失败），必须 navigateTo。
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); },

  /**
   * 展开/收起完整记忆钩子。
   *
   * 用 catchtap 绑定（在 WXML 里），否则点它会连带触发翻卡。
   */
  toggleHookDetail() {
    this.setData({ hookOpen: !this.data.hookOpen });
  },

  /**
   * 再来一轮。
   *
   * 正常用途是"被每日上限挡住的词继续练" —— 完成页那行
   * 「词库里还有 N 个词没练（…）今天的量已经做完了 —— 想继续可以再练一轮」
   * 说的就是这件事。有下一批时行为与以前完全一致：正常重建队列、不清零统计。
   *
   * ⚠️ 边界（2026-09-19 修）：范围内**确实没有下一批**时不能重建队列。
   * 原来直接 buildQueue()，空队列会走它的空分支 → done=true、total=0、reviewed=0；
   * 而完成页的成绩块渲染条件是 `total > 0`，于是学生**刚看到的这一轮成绩当场消失**：
   * 页面从「这一轮完成了 · 2」变成「今日已完成 · 0」。成绩是学生刚挣到的正反馈，
   * 不能因为一次点击就抹掉。
   *
   * 所以空批次时给一句实话并**保持当前界面**（什么都不 setData）。
   * 拦在 again() 而不是 buildQueue 里：onLoad/onShow/applyFilter 走的仍是
   * 原来的空分支（那时"没有可练的"就是要显示完成页，是正确的）。
   */
  again() {
    this.states = store.loadStates();
    if (this.buildQueue({ keepIfEmpty: true })) return;
    wx.showToast({ title: '这个范围暂时没有要复习的词', icon: 'none' });
  }
}));
