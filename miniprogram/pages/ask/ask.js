/**
 * 问词页 —— 学生问关于课本单词的问题，答案来自**本机检索**。
 *
 * ## 为什么改成端上优先
 * 原来这一步要连电脑上的 Python 服务（127.0.0.1:8766），手机上根本连不上，
 * 所以这个页面在真机上等于不存在。
 *
 * 而学生真正会问的问题，需要的原料**本来就在词卡里**：
 *   "geography 和哪个词容易混" → 词形 + 音素（端上算相似度）
 *   "怎么记住 holiday"          → 记忆钩子（词卡自带）
 *   "学校用品有哪些词"          → 主题标签（端上查索引）
 * 所以端上算完就能回答，不需要服务器，也不需要模型。
 *
 * ## 三层回答质量（逐层退让，但**任何一层都不为空**）
 *   ① 端上检索 + 模板作答   —— 永远可用，零依赖，离线也行
 *   ② 可选：云端润色        —— 云函数配好后交给模型组织语言，更自然（失败静默）
 *   ③ 检索不到时            —— 如实说"课本里没有"，并列出最接近的词供挑选
 */
const rag = require('../../utils/rag.js');
const semantic = require('../../utils/semantic.js');
const settings = require('../../utils/settings.js');
const cards = require('../../utils/cards.js');
const audioPack = require('../../utils/audio.js');
const schedule = require('../../utils/schedule.js');
const store = require('../../utils/store.js');
const ai = require('../../utils/ai.js');
const { todayStr } = require('../../utils/date.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

let _idx = null;          // 检索索引（惰性构建，295 词约 4ms）

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    question: '',
    asking: false,
    answer: '',
    sources: [],
    mode: '',
    viaText: '',          // 回答来源说明（端上算的 / 云端润色的）
    aiBusy: false,        // AI 增强生成中（扫描条可见状态）
    playingWord: '',
    /**
     * 示例问题。
     *
     * 每条都**实测答得出**才放上来（初版放了 belong / quiet，
     * 那两个词根本不在 295 词表里，点了一问就是"没找到" —— 示例反而成了打脸）。
     * describe 是给学生的说明，告诉他能问什么类型。
     */
    samples: [
      { q: 'everyone 和 everybody 有什么区别？', tag: '分辨两个词' },
      { q: 'holiday 怎么记？', tag: '记忆法' },
      { q: '课本里学校用品有哪些词？', tag: '找一类词' },
      { q: 'rock music 在第几单元？', tag: '翻课本' },
      { q: '我该复习什么？', tag: '学习建议' }
    ]
  },

  onLoad() {
    this.today = todayStr();
    this.ensureIndex();
  },

  onShow() {
    // 用户可能刚在「词库」页加了词 → 索引与词库长度不一致时重建
    if (_idx && _idx.items.length !== cards.allCards().length) {
      _idx = null;
      this.ensureIndex();
    }
  },

  /** 建检索索引（只建一次；失败不抛，页面仍可显示） */
  ensureIndex() {
    if (_idx) return _idx;
    try {
      _idx = rag.buildIndex(cards.allCards());
    } catch (e) {
      console.error('[ask] 建索引失败', e);
      _idx = null;
    }
    return _idx;
  },

  onInput(e) {
    this.setData({ question: e.detail.value });
  },

  useSample(e) {
    const i = Number(e.currentTarget.dataset.i);
    const s = this.data.samples[i];
    if (!s) return;
    this.setData({ question: s.q });
    this.ask();
  },

  ask() {
    const q = String(this.data.question || '').trim();
    if (!q) {
      wx.showToast({ title: '写个问题吧', icon: 'none' });
      return;
    }
    if (this.data.asking) return;

    this.setData({ asking: true, answer: '', sources: [], mode: '', viaText: '' });

    // 端上检索本身是同步的（几毫秒），但延迟一拍再算，
    // 让"查词典中…"有机会渲染出来 —— 快到没有反馈也是一种体验缺陷。
    setTimeout(() => {
      const idx = this.ensureIndex();
      if (!idx) {
        this.setData({
          asking: false, mode: 'error',
          answer: '词库还没准备好。先去「词库」页看看，或自己加几个词。'
        });
        return;
      }

      let r;
      try {
        // 带上真实学习数据：「我该复习什么」「哪些词总记不住」需要它
        const all = cards.allCards();
        const states = cards.allStates();
        const due = schedule.dueCards(all, states, this.today || todayStr());
        let studied = 0, fresh = 0;
        all.forEach(function (c) { states[c.id] ? studied++ : fresh++; });
        const stats = {
          dueCount: due.length,
          weakCount: store.weakIds().length,
          weakIds: store.weakIds(),
          studiedCount: studied,
          freshCount: fresh
        };
        r = rag.ask(q, all, { index: idx, stats: stats });
      } catch (e) {
        console.error('[ask] 检索异常', e);
        this.setData({ asking: false, mode: 'error', answer: '这次没查出来，换个说法再试' });
        return;
      }

      this.setData({
        asking: false,
        mode: r.mode,
        answer: r.answer || '课本词表里没找到相关的内容。',
        sources: r.sources || [],
        viaText: r.mode === 'no_match' ? '' : '答案来自本机词库检索'
      });

      this.mergeSemantic(q, r);
      this.maybeEnhance(q, r);
    }, 60);
  },

  /**
   * 语义通道融合（2026-09-22 新增，2026-09-30 召回校准）。
   *
   * ## 为什么是「融合」而不是「替换」
   * 端侧向量检索有一条固有短板：**类别枚举查询会优先返回类别词本身**。
   * 实测「跟食物有关的词」返回的是 `food`，而不是 `dumpling` ——
   * 因为语料里 food 的释义就是「食物；食品」，与查询的语义距离更近。
   * 而 utils/rag.js 的字符串/音素通道和 data/topics.js 的主题索引恰好擅长这一类。
   * 所以三条路各管一段，本方法只**并入**语义命中的词，不动既有结果。
   *
   * ## 为什么必须按当前词表过滤（2026-09-30 加 allowlist）
   * 端上语义库在 2026-10-17 前覆盖 19 套教材共 2768 词，而当前学生用的
   * wy7s_2024 只有 295 词（当时真正带向量的仅 81 词）。不过滤的话，「学校用品」
   * 会命中北师版的 pencil case / schoolbag / dining hall，挤掉当前词表里
   * 真正学过的 eraser / textbook / notebook —— 用户看到的就是「识别不准，
   * 给了一堆我没学的词」。2026-10-17 起语料换成 wy7s_2024 专属 295 词
   * （主题命中 72%→94%，docs/语义检索-判定校准.md §9）。
   * 修法不是调阈值（阈值没法区别「同义词」和「跨教材的同义词」），
   * 是把召回结果限制在当前词卡集合里 —— 学生没学的词，再相关也不出现。
   * 专属索引后本页 allowlist 成为恒真安全网：将来换教材/扩词表、
   * 重建索引之前，它仍是唯一防越界的闸，不能拆。
   *
   * ## 为什么先 setData 再融合
   * 本地检索是同步的（几毫秒），语义通道要等模型推理（手机端 10~45ms）。
   * 先渲染本地结果，语义命中后再补进来 —— 用户不会为增强通道多等一帧。
   *
   * ## 为什么全程静默
   * 资源没下载、模型加载失败、基础库低于 2.30.0 —— 任何一种都只是
   * 「少一路召回」，不该弹提示、不该影响既有答案。
   */
  mergeSemantic(question, localResult) {
    /**
     * 先看设置里的开关 —— 2026-09-24 补。
     *
     * 原来这里**没有**任何开关判断，于是 `settings.localModel` 是个**死开关**：
     * 设置页明说「关掉这个开关……只是不再使用语义召回」，但本方法照样每次
     * 调 semantic.init() 把通道拉起来 —— 关掉只 release 一次，下次搜索又回来了。
     * 学生以为自己关掉了，实际没有；而项目里"死开关"是有前科的（见 recordUnknown）。
     *
     * 默认值是 false（模型 49 MB，不该未经同意就下载/加载），所以这也是
     * 「RAG 默认关闭、要显式开启」这条产品契约的唯一执行点。
     */
    let cfg = {};
    try { cfg = settings.load() || {}; } catch (e) { /* 读不到设置就按关闭处理 */ }
    if (!cfg.localModel) return;

    const self = this;

    // 当前词卡集合（小写）。cards.allCards() 返回的是当前激活词表（默认 wy7s_2024 295 词），
    // 也是其它两路召回的全部上下文。语义通道必须在同一个范围内打分，否则就是拿出
    // 学生没学的词当答案 —— 这是"识别不准"反馈的主要来源（见 __ semantic.js 注释）。
    let allowed = null;
    try {
      const all = cards.allCards() || [];
      allowed = new Set(all.map(function (c) { return String(c.prompt || c.word || '').toLowerCase(); }));
    } catch (e) { /* 词库读不到就不过滤（保守，至少语义通道自己还能用） */ }

    semantic.init(function (err) {
      if (err || !semantic.isReady()) return;      // 静默降级

      semantic.searchWithOptions(question, 5, { allowlist: allowed }).then(function (hits) {
        if (!hits || !hits.length) return;
        // 用户已经换了问题：这批结果作废，否则会把上一个问题的依据贴到新问题上
        if (self.data.question.trim() !== question) return;

        const seen = {};
        const merged = (self.data.sources || []).slice();
        merged.forEach(function (s) { if (s && s.word) seen[s.word.toLowerCase()] = true; });

        let added = 0;
        hits.forEach(function (h) {
          const w = h.item && h.item.word;
          if (!w) return;
          const key = w.toLowerCase();
          if (seen[key]) return;                     // 与既有通道去重
          seen[key] = true;
          merged.push({ word: w, meaning: h.item.meaning || '', via: 'semantic' });
          added++;
        });

        if (added) self.setData({ sources: merged });
      });
    });
  },

  /**
   * 云端 AI 增强（2026-09-19 重做，2026-09-30 改走网关）。
   *
   * 原来有三道闸把 AI 锁死：前端"本地检索无来源就不调"、云端"材料为空就拒绝"、
   * 提示词"名单外的词不许解释" —— 叠起来 AI 的回答跟本地模板几乎一字不差，
   * 学生看到的就是"根本没有 AI"（作者原话）。
   *
   * 现在：只要云可用就**必调**；有材料带材料（课本口径为主），没材料走超纲模式
   * （云端先声明"不在词表"再解释）；生成过程有可见状态（aiBusy 扫描条）。
   *
   * ## 2026-09-30：为什么必须改走 utils/ai.js（原来直调 wx.cloud.callFunction）
   * 原来是 `setData({aiBusy:true})` 之后直接 `wx.cloud.callFunction(...)`，
   * aiBusy 的复位挂在 `complete` 回调上。而 wx.cloud.callFunction 在云开发
   * 未开通/未初始化时是**同步抛异常** —— complete 永远不会执行，
   * 于是扫描条永久停留、按钮永久 disabled，还会弹一个裸报错。
   * 改成走 ai.askWord() 后：异常在网关内折算成 {ok:false}，
   * 且本方法用 try/finally 兜住 aiBusy，**任何路径都不会卡住**。
   *
   * ## 降级仍然保持"静默"，但限流要出声
   * 端上答案已经能用了，所以网络类失败一律不打扰（沿用原设计）。
   * 但**限流不一样**：它不是"这次没成"，而是"你今天问得够多了"——
   * 继续静默的话学生会反复点，以为页面坏了。所以限流时给一句可理解的话。
   */
  maybeEnhance(question, localResult) {
    if (!ai.isAvailable()) return;

    // 整理材料：带上记忆钩子（回答质量的关键），并去重；没有来源就给空数组（超纲模式）
    const all = cards.allCards();
    const seen = {};
    const materials = [];
    (localResult.sources || []).forEach(function (s) {
      const c = all.filter(function (x) { return x.prompt === s.word; })[0];
      if (!c || seen[c.id]) return;
      seen[c.id] = true;
      materials.push({
        word: c.prompt, meaning: c.answer,
        hook: c.hook || '', detail: c.detail || ''
      });
    });

    this.setData({ aiBusy: true });

    // try/finally 挂在**同步段**上不是为了捕获 await 的异常，而是为了
    // 兜住"setData 之后、Promise 建立之前"的任何抛出（那样 finally 也能复位）。
    let pending = null;
    try {
      pending = ai.askWord(question, materials);
    } catch (e) {
      // ai.askWord 契约上永不抛，这里是契约被破坏时的最后一道防线
      console.warn('[ask] AI 增强调用异常，已放弃（端上答案已在页面上）', e);
      this.setData({ aiBusy: false });
      return;
    }

    const self = this;
    Promise.resolve(pending).then(function (r) {
      // 只在"用户没换问题"时替换，避免把上一个问题的答案盖到新问题上
      if (self.data.question.trim() !== question) return;
      if (r && r.ok && r.answer) {
        self.setData({
          answer: r.answer,
          mode: 'generated',
          viaText: materials.length ? 'AI 结合课本词库生成' : 'AI 生成（超纲词）'
        });
        return;
      }
      // 限流：唯一需要出声的失败——它不是"这次没成"，是"今天到上限了"
      if (r && (r.code === 'RATE_LIMITED' || r.code === 'QUOTA_EXCEEDED')) {
        console.warn('[ask] AI 增强被限流 code=' + r.code);
        self.setData({ viaText: r.msg || 'AI 讲解今天到次数上限了' });
      }
      // 其余失败静默：端上答案已经在页面上了
    }).catch(function (e) {
      // 同上：网关不该 reject，真 reject 了也不能让页面报错
      console.warn('[ask] AI 增强结果处理异常，已降级', e);
    }).then(function () {
      // finally 语义：成功/失败/限流/异常都复位，扫描条不会永久停留
      if (self.data.question.trim() === question) self.setData({ aiBusy: false });
    });
  },

  /** 点来源词条：听它的发音（随包音频，离线也能听） */
  playSource(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;

    if (!this.audio) {
      this.audio = wx.createInnerAudioContext();
      this.audio.onEnded(() => this.setData({ playingWord: '' }));
      this.audio.onError(() => this.setData({ playingWord: '' }));
    }
    // 再点一次是"停止"
    if (this.data.playingWord === word) {
      try { this.audio.stop(); } catch (err) { /* 忽略 */ }
      this.setData({ playingWord: '' });
      return;
    }

    audioPack.resolveForPlay(word).then(r => {
      if (!r.ok || !r.src) {
        wx.showToast({ title: '这个词没有发音', icon: 'none' });
        return;
      }
      this.audio.src = r.src;
      this.audio.play();
      this.setData({ playingWord: word });
    });
  },

  copyAnswer() {
    if (!this.data.answer) return;
    wx.setClipboardData({ data: this.data.answer });
  },

  clearAll() {
    this.setData({ question: '', answer: '', sources: [], mode: '', viaText: '' });
  },

  goPronounce() {
    wx.switchTab({ url: '/pages/pronounce/pronounce' });
  },

  /**
   * 练这个词：来源词送进复习页的单卡模式（与卡详情页「练这一张」同一通道）。
   * 来源词在 rag 里只带 display 名，这里按 prompt 反查真实卡片拿 id。
   */
  practiceSource(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    const c = cards.allCards().filter(x => x.prompt === word)[0];
    if (!c) {
      wx.showToast({ title: '词库里没有这个词', icon: 'none' });
      return;
    }
    wx.setStorageSync('single_practice', c.id);
    wx.switchTab({ url: '/pages/study/study' });
  },

  /** 课本里没找到 → 引导去添加页（「去添加这个词」chip） */
  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' });
  },

  onUnload() {
    if (this.audio) {
      try { this.audio.destroy(); } catch (e) { /* 忽略 */ }
    }
  }
}));
