const store = require('../../utils/store.js');
const schedule = require('../../utils/schedule.js');
const asr = require('../../utils/asr.js');          // 本地服务（降级路径）
const voice = require('../../utils/voice.js');      // 插件优先的语音适配层
const judgeCore = require('../../utils/pron-judge.js');  // 端上判定（纯 JS）
const acoustic = require('../../utils/acoustic.js');     // 端上声学判定（零额度、可离线）
const asrPack = require('../../utils/asr-pack.js');      // 端上模板包下载（走 utils/resources.js）
const wav = require('../../utils/wav.js');               // wav → PCM，端上声学判定的入口
const sfx = require('../../utils/sfx.js');               // 反馈音（录音期间必须静音，见 _muteForRecord）
const settings = require('../../utils/settings.js');
const audioPack = require('../../utils/audio.js');   // 随包预置发音（1MB，离线可用）
const ipaMod = require('../../utils/ipa.js');       // 音标（ARPAbet → IPA），与复习页/卡片页同源
const phonemes = require('../../utils/phoneme-table.js');
const { todayStr } = require('../../utils/date.js');
const cards = require('../../utils/cards.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/** 取当前全部卡片（内容来自本机词库，含用户自己录入与教材导入的词） */
function activeCards() {
  return cards.allCards();
}

/**
 * 给卡片补上音标（2026-09-30）。
 *
 * ## 为什么必须在这里做，而不是让 WXML 直接调
 * WXML 不能调函数；更重要的是**只在 setData 时算一次**，
 * 而不是每次渲染都查表（295 词的表虽小，但渲染是热路径）。
 *
 * ## 口径与复习页/卡片页完全一致
 * 三处都用 `ipaMod.forWord(card.prompt, phonemes)`：
 *   · 同一个 ipa 模块 → 同一套 ARPAbet→IPA 映射，不会两页音标不一样
 *   · forWord 支持多词条目（junior high），整条查表查不到时逐段拼
 *   · 查不到返回 ''，WXML 的 wx:if 自然不渲染 → 不会出现「/ /」
 *
 * ## 为什么用 Object.assign 造新对象而不是直接改 card
 * card 来自 cards.allCards()，那是**缓存里的共享对象**（cards.js 注释明说
 * "返回的数组可安全传阅，不会被内部修改"）。往共享对象上挂 phon 会污染
 * 复习页/统计页拿到的同一份数据 —— 属setData 之外的越界写。
 *
 * @param {Object} card 原卡片
 * @returns {Object} 带 phon 字段的新对象
 */
function withPhon(card) {
  if (!card) return card;
  let phon = '';
  try {
    phon = ipaMod.forWord(card.prompt, phonemes);
  } catch (e) {
    // 音标是增强信息，取不到绝不能连带整张卡不可用
    console.warn('[pronounce] 取音标失败，本张卡不显示音标', e);
    phon = '';
  }
  return Object.assign({}, card, { phon: phon });
}

/**
 * 朗读记录统一走 store（不再自己管 storage key）。
 *
 * 为什么要改：原先本页写 'pron_records'，而设置页的"清空朗读记录"删的是
 * 'memcards_pron_records' —— 两个键，按钮点了等于没点。
 * 同一份数据只能有一个 owner，这个 owner 是 store。
 */
function saveRecord(wordId, entry) {
  return store.addPronRecord(wordId, entry);
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    ready: false,
    cfg: {},              // 必须在 data 里——WXML 要读它
    card: null,
    idx: 0,
    total: 0,

    // 录音状态
    recording: false,
    recordingMs: 0,
    recSec: '0.0',
    _stopRequested: false,

    // 评测状态
    judging: false,
    judgeSec: '0.0',       // 判定已等待秒数 —— 云端 4 秒的等待没有任何进度感时，
                           // 学生第一反应是"卡死了"，然后反复按按钮
    result: null,          // {band, score, heard, verdict, suggestion}

    // 服务状态
    // 三态：checking / ok / fail —— 避免"初值 false 先闪一条黄条再消失"
    service: 'checking',
    serviceMsg: '',

    // 端上模板包的准备态（首用需下载约 0.75 MB，见 prepareAcoustic）
    preparing: false,
    preparingPct: 0,
    prepareFailed: false,
    prepareHint: '',      // 失败的人话原因（可行动）；空 = 没有失败

    // 播放状态
    playing: false,

    // 本轮统计
    stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 },
    finished: false,

    // 「为什么不能用？」自检面板（四通道账本）。diagOpen/diag 都是 WXML 引用
    // 字段，必须在 data 初始化（项目门禁）；面板只在 service fail / 模板准备
    // 失败时可通过入口打开，展开时由 buildDiagnosis() 现算 —— 账本数据是
    // 探测结果的函数，不该在 data 里存第二份。
    diagOpen: false,
    diag: [],

    // 是否已展示答案（先读后看）
    revealed: false
  },

  onLoad(query) {
    this.today = todayStr();
    const cfg = settings.load();
    this.cfg = cfg;                      // 逻辑用 this.cfg
    this.setData({ cfg: cfg });          // 模板用 data.cfg（两者都要）
    this.recorder = wx.getRecorderManager();
    this.audio = wx.createInnerAudioContext();
    this.setupRecorder();
    this.setupAudio();

    this.checkVoice();

    /**
     * 端上声学判定的资源预热 —— **异步，不挡进页**。
     *
     * 为什么要预热：判定本身只要 20~60ms，但第一次要读 750 KB 模板。
     * 若把它放在按住录音那一刻（touchstart）做，会给第一次朗读加进可感知
     * 的延迟。这里提前读进内存，之后每次判定都是零 IO。
     *
     * 模板不在本机时（真机首用）不再静默放弃：后台发起下载并给进度态。
     * 原来这里的失败是**无声的** —— acousticReady 永远 false，学生只看到
     * "现在不能听你读"，既不知道原因也不知道在等什么（正是"永久卡死"观感
     * 的来源）。现在 prepareAcoustic 会说清"在准备什么、要等多久、失败了
     * 能不能重试"。
     */
    this.acousticReady = false;
    this._tplWords = null;
    const self = this;
    setTimeout(function () {
      try {
        if (acoustic.available()) { self.armAcoustic(); return; }
        self.prepareAcoustic();
      } catch (e) {
        console.warn('[pronounce] 端上模板预热失败，走云端通道', e);
      }
    }, 0);

    this.buildQueue(query && query.id);
  },

  /**
   * 模板就绪后的武装：读进内存 + 建词表索引 + 重算服务状态。
   * 单独成方法：onLoad 预热与 prepareAcoustic 的成功出口共用这一步。
   */
  armAcoustic() {
    try {
      const tpl = acoustic.load();
      if (!tpl) return;
      // 用 Set 查词：判定时每张卡都要问一次「这个词有模板吗」
      const set = {};
      for (let i = 0; i < tpl.words.length; i++) set[tpl.words[i]] = true;
      this._tplWords = set;
      this.acousticReady = true;
      // 模板就绪可能把"四条识别通道全断"的离线态救活 —— 状态必须重算，
      // 否则页顶会一直挂着"现在不能听你读"的旧结论（撒谎）。
      this.applyVoiceState();
      this.setData({ preparing: false, prepareFailed: false, prepareHint: '' });
    } catch (e) {
      console.warn('[pronounce] 端上模板预热失败，走云端通道', e);
    }
  },

  /**
   * 首次使用：后台下载端上模板（约 0.75 MB，仅一次），页面给进度态。
   *
   * 为什么不等用户按住录音才下载：下载要几秒，按住的手势等不起；
   * 进页就拉，学生读完第一张卡之前大概率已经就绪。
   * 为什么失败仍可点重试：NOT_UPLOADED（资源没上线）重试也不会好，
   * 但文案会如实说"等下次更新"；NETWORK（断网）联网后点一下就好 ——
   * 两种情况给同一个重试入口，由文案区分预期。
   */
  prepareAcoustic() {
    if (this.data.preparing) return;
    if (this.acousticReady) return;
    const self = this;
    this.setData({
      preparing: true,
      preparingPct: 0,
      prepareFailed: false,
      prepareHint: ''
    });
    asrPack.download({
      onProgress: function (p) {
        self.setData({ preparingPct: (p && p.percent) || 0 });
      },
      onDone: function (err) {
        if (!err) { self.armAcoustic(); return; }
        // 'downloading'（别处已在下，如设置页/启动预热）不是失败：如实转告
        const code = err.code || (err.message === 'downloading' ? 'DOWNLOADING' : 'NETWORK');
        console.warn('[pronounce] 模板下载失败 code=' + code, err.message || '');
        self.setData({
          preparing: false,
          prepareFailed: true,
          prepareHint: voice.hintFor(code)
        });
      }
    });
  },
  onUnload() {
    this.cleanup();
    if (this.audio) {
      try { this.audio.destroy(); } catch (e) { /* 忽略 */ }
    }
  },

  /** 页面隐藏时也要停：否则录音继续跑满 10 秒、定时器在已卸载页面上刷数据 */
  onHide() {
    // 兜底解除静音：插件通道的 stopRecognition 不保证回调一定会回来，
    // 只靠 startPluginRecord 的 then 解除的话，切走后可能一直是静音状态。
    this._muteForRecord(false);
    // 切走时停录音/停音频：后台持续录音既耗电又吓人。
    // recording 显式复位：recorder.stop() 的 onStop 事件不保证同步到达，
    // 不复位的话隐藏页面的录音态会挂着（计时器虽停，状态灯还亮着）。
    if (this.data.recording) { try { this.stopRecord(); } catch (e) { /* 忽略 */ } }
    if (this.data.recording) this.setData({ recording: false, _stopRequested: true });
    if (this.audio) { try { this.audio.stop(); } catch (e) { /* 忽略 */ } }
    this.setData({ playing: false });
  },

  cleanup() {
    // 页面卸载/隐藏时**必须**解除音效静音 —— 不解除的话，学生离开朗读页后
    // 复习页的音效就全哑了，而且没有任何报错，只会觉得"音效坏了"。
    this._muteForRecord(false);
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.stopJudgeTimer();
    if (this._pluginStarted) {
      try { voice.stopRecognition(); } catch (e) { /* 忽略 */ }
      this._pluginStarted = false;
    }
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (this.data.recording) {
      try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
    }
    if (this.data.playing) {
      try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    }
    if (this.data.recording || this.data.playing) {
      this.setData({ recording: false, recordingMs: 0, playing: false });
    }
  },

  /**
   * 检测**识别**能力，决定用哪条通道。
   *
   * 优先级：微信插件 > 云函数 > 本地服务 > 离线
   *
   * 为什么云函数排在本地服务前面：本地服务要求"电脑开机 + 同一 WiFi"，
   * 换台手机就废——这正是要消灭的依赖。云函数 Key 不进代码、任何网络都能调。
   *
   * ⚠️ 注意：识别与**播放**的优先级不同（播放首选随包音频，见 playAudio）。
   *    两者共用一个 this.voiceBackend 是为了少一处状态，但语义以识别为准。
   *
   * 探测顺序是**惰性**的：插件不可用时才去探云函数，云函数不通才去探本地服务。
   * 避免每次进页面都打三次网络请求。
   *
   * 2026-09-25 诚实化：每条探测过的通道都记进 this._channels（成功/失败 +
   * 失败码），最终状态统一由 voice.selectBackend 折算 —— 它返回的不只是
   * "选中了谁"，还有**每条失败通道的人话原因**。原来的写法只设一个
   * service 布尔量，为什么降级到离线完全无据可查（设置页和排查都瞎）。
   */
  checkVoice() {
    const cap = voice.capability();
    this._channels = {};
    const ch = this._channels;
    const self = this;

    // ① 插件（免费、端上，但需主体有权限）
    if (cap.plugin) {
      ch.plugin = { ok: true };
      this.applyVoiceState();
      this.primeRecordAuth();
      return;
    }
    ch.plugin = { ok: false, code: 'PLUGIN_MISSING' };

    // ② 云函数（任何手机可用）
    if (asr.cloudReady()) {
      asr.cloudStatus().then(r => {
        ch.cloud = (r && r.ok) ? { ok: true } : { ok: false, code: (r && r.code) || 'CLOUD_FAIL' };
        self.applyVoiceState();
        if (r && r.ok) { self.primeRecordAuth(); return; }
        // 云函数存在但没配服务 / 没部署 → 继续往下探
        self.tryLocalService();
      });
      return;
    }
    ch.cloud = { ok: false, code: 'NO_CLOUD' };

    // ③ 本地服务（开发期）
    this.tryLocalService();
  },

  /** 探测本地服务（最后的识别通道），失败则进入离线态 */
  tryLocalService() {
    const self = this;
    asr.health().then(r => {
      const ch = self._channels || (self._channels = {});
      ch.local = (r && r.ok) ? { ok: true } : { ok: false, code: (r && r.code) || 'OFFLINE' };
      self.applyVoiceState();
      // 只有真的能录音时才去要麦克风权限 —— 离线态申请它毫无意义（白弹一次框）
      if (r && r.ok) self.primeRecordAuth();
    });
  },

  /**
   * 把通道探测结果折算成页面状态（service / serviceMsg / voiceMode）。
   *
   * 每次任何通道结果变化（含模板包就绪）都要重跑一遍：旧结论必须被新事实
   * 覆盖 —— 否则"四条通道全断"时渲染的 fail 条，会在模板下载完成、端上
   * 判定已经能用了之后还挂在页顶（撒谎）。
   */
  applyVoiceState() {
    const ch = this._channels || {};
    const sel = voice.selectBackend({
      pref: settings.get('voiceBackend'),
      pluginReady: !!(ch.plugin && ch.plugin.ok),
      cloudReady: !!(ch.cloud && (ch.cloud.ok || ch.cloud.code !== 'NO_CLOUD')),
      cloudCode: ch.cloud ? (ch.cloud.ok ? 'OK' : ch.cloud.code) : 'NO_CLOUD',
      localReady: !!(ch.local && ch.local.ok),
      localCode: ch.local ? (ch.local.ok ? 'OK' : ch.local.code) : 'OFFLINE',
      acousticReady: this.acousticReady
    });
    this.voiceBackend = sel.backend;
    const anyOk = sel.backend !== 'offline' || sel.acousticRescued;
    // 模板正在准备中也算"有服务"：学生马上就有可用的判定，页顶不该吓人
    const preparingRescued = !anyOk && this.data.preparing;
    this.setData({
      service: (anyOk || preparingRescued) ? 'ok' : 'fail',
      serviceMsg: (anyOk || preparingRescued) ? '' : '现在不能听你读。先自己读一遍，再看答案。',
      voiceMode: sel.backend
    });
    if (!anyOk && !preparingRescued) {
      // 失败账本留档：每条失败通道的 code + 人话，排查时不用再猜
      const reasons = sel.tried.filter(t => !t.ok).map(t => t.channel + '(' + t.code + ')');
      console.log('[pron] 识别通道均不可用：' + reasons.join('、'));
    }
  },

  /*------------------------- 「为什么不能用？」自检面板 -------------------------*/

  /**
   * 展开/收起自检面板。展开时**现算**账本：四条通道的探测结果随时间变化
   * （模板可能在后台下完、云函数探测可能刚回来），面板数据必须是打开那一刻
   * 的真相快照，而不是 onLoad 时的旧账。
   */
  toggleDiag() {
    if (this.data.diagOpen) { this.setData({ diagOpen: false }); return; }
    this.setData({ diagOpen: true, diag: this.buildDiagnosis() });
  },

  /**
   * cloud 通道失败码 → 可行动的**操作步骤**。
   *
   * 为什么不直接用 voice.channelWhy：那句"还没部署（需要作者上传）"说清了
   * 是谁的问题，但没说**怎么修** —— 用户反馈"朗读依然是用不了"时，能照着
   * 一步步做出来的指引才是终局。文案必须精确到开发者工具里的具体右键项。
   */
  cloudGuide(code) {
    if (code === 'NOT_DEPLOYED') {
      return '修复步骤（需要作者操作）：在微信开发者工具左侧目录找到 cloudfunctions/asrProxy，'
        + '右键 →「上传并部署：云端安装依赖（不上传 node_modules）」，等部署完成后再回来读一次。';
    }
    if (code === 'NO_CLOUD') {
      return '先开通云开发：开发者工具顶部点「云开发」按引导开通，然后按"未部署"那条的步骤部署 asrProxy。';
    }
    if (code === 'NOT_CONFIGURED' || code === 'AUTH') {
      return '修复步骤：云开发控制台 → 云函数 → asrProxy → 配置，填环境变量'
        + '（TENCENT_SECRET_ID / TENCENT_SECRET_KEY，或 GLM_API_KEY），保存后等实例刷新。';
    }
    if (code === 'QUOTA') return '本月识别额度用完了，等额度恢复，或在腾讯云控制台升级语音识别配额。';
    return '网络不好或云函数临时异常，稍后再试；反复出现就按"未部署"那条重新部署一次。';
  },

  /** acoustic 通道失败码 → 可行动指引（资源未上线是作者侧的事，如实说） */
  acousticGuide(code) {
    if (code === 'NOT_UPLOADED') {
      return '发音判定资源还没上传到云存储（需要作者操作）。资源上线后进本页会自动下载。';
    }
    if (code === 'DOWNLOADING') return '正在后台下载（约 700KB，仅一次），几秒后会自动就绪。';
    return '联网后退出本页重进会自动重试；也可以点上方黄条里的「点此重试」。';
  },

  /**
   * 构建四通道账本 —— 自检面板的数据源。
   *
   * ## 为什么独立成方法而不是散在 toggleDiag 里
   * verify-boot.js 要在 Node 里直接构造页面实例调用它做**功能级**断言
   * （四通道齐全、cloud 指引含具体部署步骤、复制摘要可生成）。独立方法 +
   * 只依赖 this._channels / this.acousticReady / this.data 才可测。
   *
   * ## 行的形状
   * { channel, label, ok, code, why, guide }：why 是"为什么不可用"（人话），
   * guide 是"现在能做什么"（可执行步骤）。可用的通道 why='可用'、guide 空。
   */
  buildDiagnosis() {
    const cap = voice.capability();
    const ch = this._channels || {};
    const rows = [];

    // ① 微信语音插件（个人主体加不了，是资质问题，学生端无解）
    rows.push({
      channel: 'plugin',
      label: '微信语音插件',
      ok: !!cap.plugin,
      code: cap.plugin ? 'OK' : 'PLUGIN_MISSING',
      why: voice.channelWhy('plugin', cap.plugin ? 'OK' : 'PLUGIN_MISSING'),
      guide: cap.plugin ? ''
        : '个人主体小程序无法接入「微信同声传译」插件，属于主体资质限制。不影响端上判定与云端识别两条主路。'
    });

    // ② 云函数 asrProxy（真机上的主识别通道）
    const c = ch.cloud || { ok: false, code: 'NO_CLOUD' };
    const cCode = c.ok ? 'OK' : (c.code || 'CLOUD_FAIL');
    rows.push({
      channel: 'cloud',
      label: '云端识别（asrProxy）',
      ok: !!c.ok,
      code: cCode,
      why: voice.channelWhy('cloud', cCode),
      guide: c.ok ? '' : this.cloudGuide(cCode)
    });

    // ③ 本地识别服务（127.0.0.1 只属于开发电脑，手机上永远不可用）
    const l = ch.local || { ok: false, code: 'OFFLINE' };
    rows.push({
      channel: 'local',
      label: '本地识别服务',
      ok: !!l.ok,
      code: l.ok ? 'OK' : (l.code || 'OFFLINE'),
      why: voice.channelWhy('local', l.ok ? 'OK' : (l.code || 'OFFLINE')),
      guide: l.ok ? ''
        : '这条通道只给开发电脑用（手机连不上 127.0.0.1），学生端无需处理。'
    });

    // ④ 端上声学判定（离线主路：模板在本地就可用，与上面三条互不依赖）
    const st = asrPack.status();
    let aOk = !!this.acousticReady;
    let aCode = 'OK';
    if (!aOk) {
      if (this.data.preparing) aCode = 'DOWNLOADING';
      else if (!st.configured) aCode = 'NOT_UPLOADED';
      else aCode = 'NETWORK';
    }
    rows.push({
      channel: 'acoustic',
      label: '端上发音判定',
      ok: aOk,
      code: aCode,
      why: aOk ? '可用'
        : (this.data.prepareFailed && this.data.prepareHint
          ? this.data.prepareHint
          : voice.channelWhy('acoustic', aCode)),
      guide: aOk ? '' : this.acousticGuide(aCode)
    });

    return rows;
  },

  /**
   * 一键复制诊断摘要（反馈用）。
   *
   * 为什么是文本摘要而不是截图：家长反馈问题最方便的方式是把一段文字粘进
   * 对话框；摘要里带通道名+失败码+人话，作者拿到就能定位，不用来回追问。
   */
  copyDiag() {
    const rows = this.data.diag && this.data.diag.length ? this.data.diag : this.buildDiagnosis();
    const lines = ['【小鲸朗读自检】'];
    lines.push('当前后端: ' + (this.voiceBackend || this.data.voiceMode || 'unknown'));
    rows.forEach(function (r) {
      lines.push(r.label + ': ' + (r.ok ? '可用' : r.code + ' — ' + r.why));
      if (r.guide) lines.push('  ↳ ' + r.guide);
    });
    try {
      wx.setClipboardData({
        data: lines.join('\n'),
        success: function () { wx.showToast({ title: '已复制诊断信息', icon: 'none' }); },
        fail: function () { wx.showToast({ title: '复制失败，请截图反馈', icon: 'none' }); }
      });
    } catch (e) {
      wx.showToast({ title: '复制失败，请截图反馈', icon: 'none' });
    }
  },

  /*------------------------- 队列 -------------------------*/

  buildQueue(onlyId) {
    const cards = activeCards();

    if (onlyId) {
      const one = cards.filter(c => c.id === onlyId);
      if (one.length) {
        this.setData({
          ready: true, card: withPhon(one[0]), idx: 0, total: 1,
          stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 }
        });
        return;
      }
    }

    // 默认：取今日到期的卡，最多 sessionSize 张
    const states = store.loadStates();
    const due = schedule.dueCards(cards, states, this.today);
    const n = Math.max(1, this.cfg.sessionSize || 10);
    const queue = due.slice(0, n);

    if (queue.length === 0) {
      this.setData({ ready: true, finished: true, card: null, total: 0 });
      return;
    }

    this.queue = queue;
    this.setData({
      ready: true, finished: false,
      card: withPhon(queue[0]), idx: 0, total: queue.length,
      stats: { pass: 0, borderline: 0, fail: 0, unknown: 0 },
      revealed: false, result: null
    });
  },

  /*------------------------- 录音 -------------------------*/

  /**
   * 初始化本地录音管理器 —— 只在"本地服务"这条降级路径上用到。
   * 插件路径不需要它（插件内部自己录音并上传识别）。
   */
  setupRecorder() {
    this.recorder.onStart(() => {
      if (this.data._stopRequested) {
        this.setData({ _stopRequested: false });
        // 2026-09-19 修"第一次按没用，提示按住按钮读"：首次授权的系统弹框会打断
        // 这次手势（手指还按着，弹框一出来松手事件就到了）—— 录音启动后立刻停，
        // duration≈0，onStop 的"读完整个单词"提示在这种场景是**误导**
        //（用户明明按了很久，只是被授权框打断了）。静默结束；若本次刚好授权成功，
        // 补一句"再按一次开始读"的引导，第二次就能正常用。
        if (this._justGranted) {
          this._justGranted = false;
          wx.showToast({ title: '麦克风已允许，再按一次开始读', icon: 'none', duration: 2200 });
        }
        try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
        return;
      }
      this.setData({ recording: true, result: null, recordingMs: 0, recSec: '0.0' });
      this._timer = setInterval(() => {
        const ms = this.data.recordingMs + 100;
        this.setData({ recordingMs: ms, recSec: (ms / 1000).toFixed(1) });
        // 10s 硬上限（2026-09-19 加）：recorder.start 的 duration 参数在开发者工具
        // 的 mp3 格式下**不生效**（实测录到 16s+ 仍不停）—— 作者看到的就是
        // "录音无法自动结束，会无限开始"。客户端自己掐表，到点强制停。
        if (ms >= 10000) { this.stopRecord(); }
      }, 100);
    });

    this.recorder.onStop(res => {
      // 录音窗口结束：立刻恢复音效。放在最前面 ——
      // 后面几个 early return（被授权框打断 / 录得太短）都不能让静音漏下去。
      this._muteForRecord(false);
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this.setData({ recording: false });
      if (this._justGranted) {
        // 被授权框打断的那次：不判"录得太短"，给引导
        this._justGranted = false;
        wx.showToast({ title: '麦克风已允许，再按一次开始读', icon: 'none', duration: 2200 });
        return;
      }
      const ms = res.duration || this.data.recordingMs;
      if (ms < 400 || !res.tempFilePath) {
        wx.showToast({ title: '按住按钮读完整个单词', icon: 'none' });
        return;
      }
      // 按通道分流。端上声学判定排最前：它零额度、零网络、最快，
      // 且录音格式是 wav（mp3 走不了这条路）—— 所以必须与另两条互斥。
      if (this._useAcoustic) {
        this.judgeViaAcoustic(res.tempFilePath);
      } else if (this.voiceBackend === 'cloud') {
        this.judgeViaCloud(res.tempFilePath);
      } else {
        this.judgeViaLocal(res.tempFilePath);
      }
    });

    /**
     * 录音失败。
     *
     * ⚠️ 原来这个回调**不接参数**（`onError(() => ...)`），errno / errMsg 全被丢掉，
     * 只剩一句泛泛的"录音失败，检查麦克风权限" —— 学生不知道下一步做什么，
     * 开发者也拿不到任何线索（这正是"麦克风用不了"排查不下去的直接原因）。
     * 现在：原始 err 一律 console.error 留档，界面按**能区分的情形**给精确出路。
     */
    this.recorder.onError(err => {
      this._muteForRecord(false);         // 录音失败也要解除，否则全站静音
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this.setData({ recording: false });
      console.error('[pronounce] 录音失败（原始错误）', err);

      const m = String((err && (err.errMsg || err.errno)) || err || '');
      if (/auth|permission|denied|deny|授权|拒绝/i.test(m)) {
        // 权限类：给"去设置"这个动作，而不是一句无法执行的提示
        this.askRecordSetting();
        return;
      }
      if (/occup|busy|占用|in use|inuse/i.test(m)) {
        wx.showToast({ title: '麦克风正被别的应用占着，关掉再试', icon: 'none', duration: 2600 });
        return;
      }
      if (/not support|unsupport|不支持|no ?mic|nomicro/i.test(m)) {
        wx.showToast({ title: '这台手机现在录不了音，可以先听发音跟读', icon: 'none', duration: 2600 });
        return;
      }
      wx.showToast({ title: '这次没录上，再按一次试试', icon: 'none', duration: 2400 });
    });
  },

  /*------------------------- 录音权限 -------------------------*/

  /**
   * 录音前的权限闸门：① 隐私协议 ② 录音授权。resolve(true) 才允许录音。
   *
   * 为什么必须显式做（2026-09-19 修，作者实测"麦克风用不了"）：
   *   本页原来**直接 recorder.start()**，权限全靠系统弹窗兜底 —— 而全项目零权限 API
   *   （无 getSetting / authorize / openSetting / requirePrivacyAuthorize），
   *   于是用户一旦点过一次"拒绝"，之后 start() 只会静默失败：
   *   既没有申请入口，也没有补救入口。
   *
   * 三条分支各有出路（文案面向初一学生，不出现错误码）：
   *   · 从未申请过（undefined）→ wx.authorize 弹系统框
   *   · 拒绝过（false）→ 先用 showModal 说清"为什么要麦克风"，确认后去 wx.openSetting
   *   · 已允许（true）→ 直接放行
   *
   * @param {boolean} quiet 预申请用：只"问"，失败不弹解释框/提示
   *        （进页面就弹一个解释框太打扰；解释留给学生真的按住按钮的时候）
   */
  ensureRecordAuth(quiet, noTimeout) {
    const self = this;

    // ① 隐私协议（微信 2023 年起要求）。
    //    基础库过低时这个 API 不存在 → **跳过而不是报错**。
    const privacy = new Promise(function (resolve) {
      if (typeof wx.requirePrivacyAuthorize !== 'function') { resolve(true); return; }
      wx.requirePrivacyAuthorize({
        success: function () { resolve(true); },
        fail: function (err) {
          const m = String((err && err.errMsg) || '');
          if (/not declared|not configured|未声明|未配置|privacy agreement/i.test(m)) {
            // 小程序后台没配「用户隐私保护指引」（或没声明麦克风）—— 代码侧无解，
            // 只能把线索留给作者；对学生**继续走**，不能因为后台配置把功能整个挡死
            console.warn('[pronounce] 隐私授权不可用：需在小程序管理后台配置「用户隐私保护指引」'
              + '并声明"麦克风"，否则真机上录音会被系统直接拒绝。原始错误：', err);
            resolve(true);
            return;
          }
          if (/deny|denied|refuse|拒绝|不同意/i.test(m)) {
            console.warn('[pronounce] 学生未同意隐私说明', err);
            resolve(false);
            return;
          }
          // 认不出的失败：按"后台问题"处理并继续。
          // 取舍依据：把"后台没配"误判成"学生拒绝"，学生会**永远录不了音**，
          // 而且看到的提示是误导的；反过来最多多走一步系统弹窗，
          // 真失败也由 onError 给出可执行出路。
          console.warn('[pronounce] 隐私授权失败（原因未知，按可继续处理）：', err);
          resolve(true);
        }
      });
    });

    // ①b 超时兜底（2026-09-19 加，修"按住录音键有概率没反应"）：
    // requirePrivacyAuthorize 在开发者工具里**有概率既不回调 success 也不回调 fail**
    //（后台未配隐私指引时的已知怪癖）—— 不兜底的话闸门永远挂起，录音永远不启动，
    // 学生再点一下旁边"就好了一下"，正是这个竞态。超时放行的依据：隐私真正的
    // 硬闸在系统层（真机上 recorder.start 会报权限错，onError 会给出路），
    // 这里只是前置预检，挂起时放行比卡死好。
    // noTimeout=true（页面加载预申请）时等待真实结果 —— 授权框弹多久都等；
    // 按住按钮的路径（noTimeout=false）才用超时兜底（手势不能干等）。
    const privacyGuarded = noTimeout ? privacy : Promise.race([
      privacy,
      new Promise(function (resolve) {
        setTimeout(function () {
          console.warn('[pronounce] 隐私授权接口超时未回调，按可继续处理放行');
          resolve(true);
        }, 1200);
      })
    ]);

    // ② 录音权限（getSetting/authorize 同样加超时兜底：同源的挂起风险）
    return privacyGuarded.then(function (ok) {
      if (!ok) {
        if (!quiet) wx.showToast({ title: '先同意隐私说明，再按一次按钮试试', icon: 'none', duration: 2400 });
        return false;
      }
      // getSetting/authorize 同样可能挂起（与隐私接口同源的问题）→ 按住路径加超时兜底
      const core = new Promise(function (resolve) {
        // getSetting 不存在（旧基础库）→ 无法预检，交给 start() 自己的系统弹窗，
        // 与改动前行为一致（不更差）
        if (typeof wx.getSetting !== 'function') { resolve(true); return; }
        wx.getSetting({
          success: function (res) {
            const cur = res && res.authSetting && res.authSetting['scope.record'];
            if (cur === true) { resolve(true); return; }
            if (cur === false) {
              // 拒绝过：系统授权框不会再弹，只能解释 + 引导去设置
              if (quiet) { resolve(false); return; }
              self.askRecordSetting(resolve);
              return;
            }
            // undefined：从未申请过 → 主动申请（系统框）
            wx.authorize({
              scope: 'scope.record',
              success: function () {
                // 首次授权成功：标记之，让紧随其来的"被打断的第一次录音"
                // 走引导文案而不是误导性的"读完整个单词"
                self._justGranted = true;
                resolve(true);
              },
              fail: function (err) {
                console.warn('[pronounce] 申请录音权限未通过', err);
                if (quiet) { resolve(false); return; }
                self.askRecordSetting(resolve);
              }
            });
          },
          fail: function (err) {
            // 读不到授权状态 ≠ 没有权限：不阻断（start 时系统还会再判一次）
            console.warn('[pronounce] 读取授权状态失败', err);
            resolve(true);
          }
        });
      });
      if (noTimeout) return core;   // 页面加载预申请：等真实授权结果（弹框多久都等）
      return Promise.race([
        core,
        new Promise(function (resolve) {
          setTimeout(function () {
            console.warn('[pronounce] 录音权限检查超时未回调，按可继续处理放行');
            resolve(true);
          }, 1500);
        })
      ]);
    });
  },

  /**
   * 权限被拒后的唯一出路：解释为什么需要麦克风 → 去设置里打开。
   * 文案只说人话（"要听你读单词，才能告诉你读得对不对"），不出现错误码。
   */
  askRecordSetting(done) {
    if (typeof done !== 'function') done = function () {};
    wx.showModal({
      title: '要用一下麦克风',
      content: '要听你读单词，才能告诉你读得对不对。允许之后就能开始读了。',
      confirmText: '去允许',
      cancelText: '先不读',
      success: function (r) {
        if (!r || !r.confirm) { done(false); return; }
        if (typeof wx.openSetting !== 'function') {
          wx.showToast({ title: '没能打开设置，可以到手机设置里允许麦克风', icon: 'none', duration: 2600 });
          done(false);
          return;
        }
        wx.openSetting({
          success: function (s) {
            const ok = !!(s && s.authSetting && s.authSetting['scope.record'] === true);
            if (!ok) {
              wx.showToast({ title: '还没打开麦克风，可以到手机设置里允许', icon: 'none', duration: 2600 });
            }
            done(ok);
          },
          fail: function (err) {
            console.warn('[pronounce] 打开设置失败', err);
            wx.showToast({ title: '没能打开设置，可以到手机设置里允许麦克风', icon: 'none', duration: 2600 });
            done(false);
          }
        });
      },
      fail: function () { done(false); }
    });
  },

  /**
   * 进页面就把权限准备好 —— 让"按住"变成纯粹的录音动作。
   *
   * 【时序取舍】预申请（本方法） vs 按住时才申请：
   *   startRecord 是 **bindtouchstart** 触发的。权限框必须在用户**手指还按着**的时候弹出来，
   *   弹框会立刻打断这次触摸（touchend/touchcancel 到达）→ 学生体感是"按了半天没录上"。
   *   所以选**预申请**：弹框挪到"还没按住"的时刻，按住就只剩录音一件事。
   * 代价与缓解：
   *   · 一进页面可能弹一次系统框 —— 只在**从未申请过**时弹，且这个页面整个就是
   *     "读单词"，进页面即表明意图，语境上是合理的；
   *   · 拒绝过的用户**不会**在这里被反复打扰（quiet=true，不弹解释框），
   *     解释留到学生真的按住按钮时（askRecordSetting）；
   *   · 离线态不申请（调用点已保证）—— 没有识别能力时要麦克风毫无意义。
   * startRecord 里仍保留一次兜底复查，两条通道都过这道闸门。
   */
  primeRecordAuth() {
    if (this._authPrimed) return;
    this._authPrimed = true;
    // 2026-09-19 修"读第一个单词时按钮异常"：预申请**不设超时**（waitReal=true）。
    // 之前预申请也走 1.2s 超时兜底 —— 授权框还没确认就被兜底放行，
    // 权限仍是 undefined，于是第一个词按下去才弹授权框、手势被打断，
    // 学生看到的就是"按钮异常"。页面加载时多等一下（弹授权框是预期行为），
    // 换第一个词的按住即录。按住时的兜底复查仍保留超时（响应优先）。
    this.ensureRecordAuth(true, true);
  },

  /**
   * 录音入口：插件优先。
   *
   * 两条路径的实现细节差别很大：
   *   · 插件（WechatSI）：start 后**自动**在云端识别，stop 时直接给文本
   *   · 本地服务：先用 RecorderManager 录成文件，再上传给服务识别
   * 所以这里按后端分流，而不是硬套一条路。
   */
  startRecord() {
    if (!this.data.card || this.data.judging) return;
    if (this.data.recording) return;   // 已在录音：RecorderManager 是单例，重入 start 会互相打断
    if (this.data.playing) this.stopAudio();

    /**
     * 本轮手势开始，清掉上一轮留下的"已松手"标记。
     *
     * ⚠️ 位置很关键：原来它在 startLocalRecord 里（紧贴 recorder.start()）。
     * 现在权限闸门是**异步**的，若还留在那里，就会出现
     * "按住 → 立刻松手 → 权限检查回来 → 清掉标记 → 补 stop 失效 → 白录满 10 秒"。
     * 标记必须在手势开始时就清，之后谁都不能再动它。
     */
    this.setData({ _stopRequested: false });

    /**
     * 本轮是否走「端上声学判定」——决定录音格式，所以必须在录音前定好。
     *
     * 三个条件缺一不可：
     *   ① 模板包已下好（acousticReady，进页时预热）
     *   ② 当前这个词在模板词表里（用户自录入的词没有预置发音，也就没有模板）
     *   ③ 有卡片
     *
     * 为什么优先于插件/云端：它零额度、零网络、约 20~60ms 出结果，
     * 而且**离线也能用** —— 这正是"减负"要的效果。
     * 代价是它只说得出"像不像"，说不出"你读成了哪个词"（见 dtw.js 末尾说明）。
     */
    const card = this.data.card;
    this._useAcoustic = !!(this.acousticReady && card && this._tplWords
      && this._tplWords[card.prompt]);

    // 端上判定正在准备中：如实告知进度，而不是装作没看见这次按住。
    // （不置 revealed —— 马上就能读，没必要提前翻答案）
    if (this.data.preparing) {
      wx.showToast({
        title: '正在准备发音判定（' + this.data.preparingPct + '%），几秒后再试',
        icon: 'none', duration: 2400
      });
      return;
    }

    // 离线：没有识别能力。但**不静默**——告诉学生"可以先自己读，再对答案"
    // 这是"任何手机可用"的底线：功能降级，但流程不中断。
    //
    // ⚠️ 2026-09-24：端上声学判定不需要任何网络，所以**离线不等于不能评**。
    //    有模板时必须放行，否则等于白白浪费了这个能力。
    // ⚠️ 2026-09-25：离线提示要说**为什么**。模板下载失败（prepareFailed）
    //    时给具体原因（资源没上线 / 断网），笼统一句"不能听你读"只会让学生
    //    以为是自己的错 —— 区分"等一等会好"和"需要别人处理"是诚实的一部分。
    if (this.voiceBackend === 'offline' && !this._useAcoustic) {
      const why = this.data.prepareFailed
        ? this.data.prepareHint + '，先自己读一遍再看答案'
        : '现在不能听你读，先自己读一遍再看答案';
      wx.showToast({ title: why, icon: 'none', duration: 2600 });
      this.setData({ revealed: true });
      return;
    }

    /**
     * 预热云函数 —— 把冷启动（实测约 3.2s）藏进接下来的 1~3 秒录音里。
     *
     * 为什么时机是这里（本方法就是 bindtouchstart 的处理函数）：
     *   这是"学生马上要读"的确切时刻 —— 按下之后他会录 1~3 秒，这段时间
     *   足够云函数完成冷启动，等他松手发 transcribe 时实例已经是热的。
     *
     * 为什么放在**权限闸门之前**：闸门是异步的（可能弹系统框、可能要等学生
     * 去设置里点允许），等它回来再预热就白少了一段重叠时间；而预热与麦克风
     * 权限无关 —— asrProxy 的 status 分支只读环境变量，不碰音频。
     *
     * 为什么不会变成"每次按住都发一个请求"：节流在 asr.cloudPrewarm 内部
     *   （距上次碰云函数不足 45s 就直接返回）。见那里的取值依据。
     *
     * 为什么只在 cloud 通道：插件通道不经过 asrProxy（它自己在端上/插件侧识别），
     *   离线通道根本没有识别能力 —— 给这两条通道预热是纯浪费。
     *
     * ⚠️ 这是**体感与真实耗时都受益、但不牺牲任何准确率**的那张牌：
     *   不动 ASR 超时、不动采样率/格式（那些是拿"慢"换"不准"）。
     *   未经真机验证（自动化通道不可用），见交付报告。
     */
    if (this.voiceBackend === 'cloud') asr.cloudPrewarm();

    // 权限闸门：没通过就不启动录音，也不静默（ensureRecordAuth 内部已给出路）。
    // 预申请已在进页面时做过（primeRecordAuth），这里是一次**兜底复查** ——
    // 每次按住都重新读一次授权状态，学生刚在系统设置里打开权限、回到页面就能立刻用。
    const self = this;
    this.ensureRecordAuth().then(function (ok) {
      if (!ok) return;
      // 端上声学判定要 PCM，必须走自己的录音（插件内部自己录音，拿不到采样）
      if (self._useAcoustic) { self.startLocalRecord(); return; }
      if (self.voiceBackend === 'plugin') { self.startPluginRecord(); return; }
      self.startLocalRecord();
    });
  },

  /**
   * 插件通道的录音（插件自己录音并在云端识别，stop 时给文本）。
   * 从 startRecord 里拆出来，是为了让"权限闸门"成为两条通道唯一的共同前置。
   */
  startPluginRecord() {
    this._muteForRecord(true);            // 插件内部也在录音，同样要静音
    this._pluginStarted = true;
    this.startPluginTimer();
    voice.recognizeOnce({ duration: 10000 }).then(r => {
      this._muteForRecord(false);         // 结果回来 = 录音已结束
      this.stopPluginTimer();
      if (!r.ok) {
        // "麦克风不可用"要给出**可执行的动作**（去设置），而不是一句提示就结束
        if (voice.isAuthError(r.code)) { this.askRecordSetting(); return; }
        wx.showToast({ title: voice.hintFor(r.code), icon: 'none', duration: 2000 });
        return;
      }
      // 插件的 duration 是真实录音时长
      if (r.duration && r.duration < 400) {
        wx.showToast({ title: '按住按钮读完整个单词', icon: 'none' });
        return;
      }
      this.judgeText(r.text, r.duration);
    });
  },

  stopRecord() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.voiceBackend === 'plugin') {
      // 插件：stop 会触发 onStop，识别结果在那里回来
      if (this._pluginStarted) {
        voice.stopRecognition();
        this._pluginStarted = false;
      }
      return;
    }
    if (this.data.recording) {
      this.recorder.stop();
    } else {
      this.setData({ _stopRequested: true });
    }
  },

  /** 插件的录音计时（插件不提供 onStart 事件，用本地计时器显示秒数） */
  startPluginTimer() {
    this.setData({ recording: true, recordingMs: 0, recSec: '0.0', result: null });
    this._timer = setInterval(() => {
      const ms = this.data.recordingMs + 100;
      this.setData({ recordingMs: ms, recSec: (ms / 1000).toFixed(1) });
    }, 100);
  },

  stopPluginTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.setData({ recording: false });
  },

  /**
   * 本地服务 / 云端路径的录音（两条通道都要先录成文件）。
   *
   * 参数核对（2026-09-19，对照官方 RecorderManager.start 文档）：
   *   · format: 'wav' 是**合法值**（合法值只有 mp3/aac/wav/PCM；文档里那句
   *     "暂仅支持 mp3、pcm" 说的是 frameSize 帧回调，不是 format）
   *   · sampleRate 16000 配 encodeBitRate 48000 落在合法区间内（16k 对应 24000~96000）
   * 也就是说"录音失败"不是参数问题 —— 参数不合法时 start() 会直接失败，
   * 而作者实测的现象是权限相关的（见 ensureRecordAuth）。
   * ⚠️ 不要在这里顺手把 format 改成 aac：见交接说明（腾讯支持 aac，但云函数
   *    首选的智谱端点走 OpenAI 兼容白名单，aac 不在其中 → 可能整条通道坏掉）。
   */
  /**
   * 录音期间静音 —— **本项目特有的硬约束，不是体验偏好**。
   *
   * 学生按下录音后，若界面还在播音效（上一题的反馈音、"开始"提示等），
   * 那段音会被麦克风录进录音里。对云端 ASR 是"多了点杂音"，
   * 但对我们自己的**端上声学判定**是**数据污染**：
   * 纯音混进 MFCC 特征 → 与模板的距离被整体拉偏 → 判定会安静地判错，
   * 而且因为不抛异常，排查时根本想不到是音效干的。
   *
   * 所以录音窗口内一律短路 sfx（见 utils/sfx.js 的 setMuted）。
   * 覆盖范围：本地/云端录音的 start → onStop/onError，插件录音的 start → 结果回来。
   * 卸载与 onHide 也会解除，避免"离开朗读页后全站静音"。
   */
  _muteForRecord(on) {
    try { sfx.setMuted(!!on); } catch (e) { /* 音效失败不影响录音 */ }
  },

  startLocalRecord() {
    // format 用 mp3（2026-09-19 换）：实测（真机探测 2026-09-19）开发者工具录出的
    // **wav 腾讯 ASR 解不开**（InvalidParameterValue.ErrorInvalidVoicedata / Audio
    // decoding failed）—— 学生在工具里每次松手都得到"没听清"，正是"录音有大 BUG"的
    // 直接原因。mp3 三方全兼容：RecorderManager 合法值 ✓ 腾讯 VoiceFormat ✓
    // GLM 的 OpenAI 白名单 ✓（当时不敢改是顾虑 aac，mp3 没有这个问题）。
    // recognizeCloud 从临时文件扩展名自动带对 format，无需再改。
    //
    // ⚠️ 2026-09-24：端上声学判定这条路**反过来必须用 wav**。
    //    原因：端上要的是原始 PCM 采样，而小程序没有 mp3 解码 API
    //    （createInnerAudioContext 只能播、WebAudio 的 decodeAudioData 不可用）。
    //    wav 是唯一「容器结构简单、无需解码器、官方明确支持」的格式
    //    （format 合法值：mp3 / aac / wav / PCM）。
    //    这条路**不经过腾讯 ASR**，所以上面那个 wav 的坑与它无关。
    //    两条路互斥、由 _useAcoustic 在录音前决定，不存在格式打架。
    this._muteForRecord(true);          // 录音窗口开始：音效短路，避免被录进去
    const fmt = this._useAcoustic ? 'wav' : 'mp3';
    this.recorder.start({
      duration: 10000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: fmt
    });
  },

  /*------------------------- 评测 -------------------------*/

  /**
   * 评测态的计时器：判定中显示"已等待 N.Ns"。
   *
   * 为什么要有（2026-09-19 修"延迟高"的体感）：
   *   云端判定要 3~5 秒（含云函数冷启动约 3.2s），而判定中的界面原来只有
   *   "正在听你读的…" + 扫光动画 —— **没有任何进度感**。学生的第一反应是"卡死了"，
   *   然后反复按按钮（每次按住又会打断上一次）。一个在涨的秒数至少证明"还在跑"。
   *
   * ⚠️ 只改体感，不动超时与录音质量：缩短 ASR 超时或降低录音质量会把"慢"
   *    换成"识别不准"，是更糟的交换（明确不做，见交付报告）。
   *
   * 用 Date.now() 差值而不是累加：即使定时器被系统节流，显示的秒数也仍然是
   * 真实等待时长（累加式会偏小，等于撒谎）。
   */
  stopJudgeTimer() {
    if (this._judgeTimer) { clearInterval(this._judgeTimer); this._judgeTimer = null; }
  },

  beginJudging() {
    this.stopJudgeTimer();
    this._judgeStart = Date.now();
    this.setData({ judging: true, result: null, judgeSec: '0.0' });
    this._judgeTimer = setInterval(() => {
      this.setData({ judgeSec: ((Date.now() - this._judgeStart) / 1000).toFixed(1) });
    }, 100);
  },

  /**
   * 退出评测态。**凡是把 judging 置回 false 的地方都走这里** ——
   * 判定有 5 个出口（成功 / 识别失败 / 没听到声音 / 判定异常 / 切页），
   * 分散地起停计时器必然漏一个，漏掉的表现是"秒数一直在涨"。
   */
  endJudging() {
    this.stopJudgeTimer();
    this.setData({ judging: false });
  },

  /**
   * 用识别文本做判定 —— **完全在端上跑**（pron-judge.js，纯 JS 音素比对）。
   *
   * 这是"任何手机可用"的核心：判定不需要任何服务器。
   * 插件只负责"把声音转成文字"，剩下的判断题小程序自己算。
   */
  judgeText(heard, durationMs) {
    const card = this.data.card;
    if (!card) return;
    // 注意：这里**不重开**计时器。判定本身 <5ms，而这一步通常紧跟在
    // judgeViaCloud 的等待之后 —— 重开会把已经走了几秒的秒数打回 0.0，
    // 看起来像"又从零开始等"，比不显示还糟。
    this.setData({ judging: true, result: null });

    // 判定（同步、极快，实测 <5ms）
    let res;
    try {
      res = judgeCore.judge(card.prompt, heard, judgeCore.vocabList(), {
        passScore: this.cfg.passScore,
        borderlineScore: this.cfg.borderlineScore
      });
    } catch (e) {
      console.error('[pron] 判定异常', e);
      this.endJudging();
      wx.showToast({ title: '这次没评上，再读一次', icon: 'none' });
      return;
    }

    this.applyResult(res, durationMs);
  },

  /** 把判定结果落到界面与记录（插件/本地两条路径共用） */
  applyResult(res, durationMs) {
    const card = this.data.card;
    const band = res.band;

    const stats = Object.assign({}, this.data.stats);
    if (band === 'pass') stats.pass += 1;
    else if (band === 'borderline') stats.borderline += 1;
    else if (band === 'fail') stats.fail += 1;

    this.stopJudgeTimer();          // 成功出口：和 judging:false 一起收尾
    // 2026-09-19 加：每次判定完成立刻续命云实例 —— 学生做一个词约 8~15s，
    // 45s 节流窗口内必然再触发，实例全程保持热态；第 4~5 个词不再撞冷启动
    //（实测冷启动 3.2s + 腾讯识别 = 15s 等待的来源）。
    if (this.voiceBackend === 'cloud') asr.cloudPrewarm();
    this.setData({
      judging: false,
      result: {
        band: band,
        score: res.score,
        scorePct: res.scorePct,
        heard: res.heard,
        verdict: res.verdict,
        suggestion: res.suggestion
      },
      revealed: true,
      stats: stats
    });

    saveRecord(card.id, {
      date: this.today,
      band: band,
      score: res.score,
      heard: res.heard,
      ms: durationMs || this.data.recordingMs
    });

    if (band !== 'pass' && this.cfg.autoPlayAudio) {
      if (this._autoTimer) clearTimeout(this._autoTimer);
      this._autoTimer = setTimeout(() => {
        this._autoTimer = null;
        this.playAudio();
      }, 320);
    }
  },

  /**
   * 读录音文件并解析成 PCM。抽出来是为了让失败路径也能被单独测。
   * @returns {{ok:boolean, error?:string, samples?:Float64Array, sampleRate?:number}}
   */
  readWav(filePath) {
    let buf = null;
    try {
      buf = wx.getFileSystemManager().readFileSync(filePath);
    } catch (e) {
      return { ok: false, error: 'read-failed' };
    }
    try {
      return wav.parse(buf);
    } catch (e) {
      return { ok: false, error: 'parse-threw' };
    }
  },

  /**
   * 端上声学判定通道：录音 → 解析 wav → MFCC → VTLN-DTW → 判定。
   *
   * **全程在手机上，零网络、零额度，约 20~60ms。**
   * 这是"不再消耗 ASR 额度"的核心：闭集 294 词的模板匹配，压根不需要识别成文字。
   *
   * ⚠️ 失败时**绝不能**拿脏数据往下算 —— 半个 wav 头解析出来的采样值，
   *    MFCC 照样能算、DTW 照样给距离，只是判定全错且毫无提示。
   *    所以解析失败就走灰条 + 让下一次自动改回 mp3/云端通道（自愈）。
   */
  judgeViaAcoustic(filePath) {
    const card = this.data.card;
    if (!card) return;
    this.beginJudging();

    const parsed = this.readWav(filePath);
    if (!parsed.ok) {
      // 自愈：这一次已经录成 wav 了救不回来，但下一次必须改回 mp3 + 云端。
      // 不这么做的话，设备一旦不产出可解析的 wav，学生就永远卡在"这次没能评测"。
      this._useAcoustic = false;
      console.warn('[pronounce] wav 解析失败 code=' + parsed.error + '，下次改走云端通道');
      this.endJudging();
      this.setData({ result: {
        band: 'gray', score: 0, scorePct: 0, heard: '',
        verdict: '这次没能评测',
        suggestion: '再读一次（这次会走联网评测）'
      }});
      return;
    }

    let res;
    try {
      res = acoustic.judge(card.prompt, parsed.samples, parsed.sampleRate, {
        passScore: this.cfg.passScore,
        borderlineScore: this.cfg.borderlineScore
      });
    } catch (e) {
      console.error('[pronounce] 端上判定异常', e);
      this.endJudging();
      wx.showToast({ title: '这次没评上，再读一次', icon: 'none' });
      return;
    }

    // 与云端/本地两条通道共用同一套结果渲染与落库逻辑
    this.applyResult(res, this.data.recordingMs);
  },

  /** 走本地服务评测（降级路径） */
  /**
   * 云端通道：录音 → 云函数识别成文字 → **端上判定**。
   *
   * 为什么判定仍在端上：识别只负责"把声音变成文字"，
   * 而"这段文字像不像期望的那个词"是纯计算，端上音素判定 <5ms 就能算完。
   * 好处有三：① 省一次往返 ② 判定逻辑不依赖服务商（换 ASR 服务商不影响评分口径）
   * ③ 云端只存"文字"不存"分数"，评分标准改了不需要重新部署服务。
   */
  judgeViaCloud(filePath) {
    const card = this.data.card;
    if (!card) return;
    this.beginJudging();

    asr.recognizeCloud(filePath).then(r => {
      /**
       * 2026-09-19 修：失败原来只弹一个 2.2 秒的 toast —— 结果区一片空白，
       * 学生看到的就是"按了没反应"（作者反馈"麦克风根本录不上"的体感来源）。
       * 现在所有失败都渲染成**结果卡**（灰条 + 人话 + 下一步），失败码 console 留档。
       */
      if (!r.ok) {
        this.endJudging();
        // detail 带服务商原始错误（截断 300 字），真机上排查"录不上"全靠它
        console.warn('[pronounce] 云端识别失败 code=' + r.code, r.detail || '');
        this.setData({ result: {
          band: 'gray', score: 0, scorePct: 0, heard: '',
          verdict: '这次没能评测',
          suggestion: asr.hintFor(r.code) + '（按住按钮再读一次）'
        }});
        return;
      }
      const heard = String(r.text || '').trim();
      if (!heard) {
        // 识别成功但没听到内容 —— 如实说"没听到声音"，而不是报"读错了"
        this.endJudging();
        console.warn('[pronounce] 识别为空：录音里没有可辨认的语音');
        this.setData({ result: {
          band: 'gray', score: 0, scorePct: 0, heard: '',
          verdict: '没听到声音',
          suggestion: '离麦克风近一点，按住按钮读完整个单词再松手'
        }});
        return;
      }
      // 交给端上判定引擎（与插件通道共用同一套评分口径）
      this.judgeText(heard, this.data.recordingMs);
    });
  },

  judgeViaLocal(filePath) {
    const card = this.data.card;
    if (!card) return;
    this.beginJudging();

    asr.pronounce(card.prompt, filePath).then(r => {
      if (!r.ok) {
        this.endJudging();
        console.warn('[pronounce] 本地识别失败 code=' + r.code);
        this.setData({ result: {
          band: 'gray', score: 0, scorePct: 0, heard: '',
          verdict: '这次没能评测',
          suggestion: asr.hintFor(r.code) + '（按住按钮再读一次）'
        }});
        return;
      }
      this.applyResult({
        band: r.band, score: r.score, scorePct: Math.round((r.score || 0) * 100),
        heard: r.heard, verdict: r.verdict, suggestion: r.suggestion
      }, this.data.recordingMs);
    });
  },

  /**
   * "不会读"：直接听发音并记录为待加强。
   *
   * ## 防重入（2026-09-30 补）
   *
   * 原来没有任何幂等保护，于是同一个词反复点会：
   *   · stats.unknown 一路涨（界面上"不会读的词"计数虚高）
   *   · 往 pron_records 反复追加 unknown 记录，把该词 20 条的配额占满，
   *     于是**真正的朗读评测记录被挤出上限** —— 一个"标记不会读"的点击，
   *     悄悄毁掉了这个词的历史评测数据。
   *
   * 判据用 `_unknownMarked`（已标记的卡 id）：换一张卡就允许再标记，
   * 同一张卡重复点则忽略。只挡**同一次会话里对同一张卡的重复点击**，
   * 不影响学生练完一轮再回来标记同一个词。
   */
  markUnknown() {
    if (!this.data.card || this.data.judging) return;   // 评测中不许，避免两张卡叠显
    const cardId = this.data.card.id;
    if (this._unknownMarked === cardId) return;         // 同一张卡已标记，忽略重复点击
    this._unknownMarked = cardId;

    const stats = Object.assign({}, this.data.stats);
    stats.unknown += 1;
    this.setData({
      revealed: true,
      result: {
        band: 'unknown', score: 0, heard: '',
        verdict: '先听一遍', suggestion: '跟着读两遍，下次再考你'
      },
      stats: stats
    });
    // recordUnknown 开关（设置页"记录不会读的词"）此前是死开关：写盘前不检查，
    // 拨不拨都记。现在接线 —— 关掉时只给界面反馈，不写朗读记录。
    //
    // ⚠️ 落盘条 band:'unknown' 就是错题本的判据之一（store.weakIds 的 B 类来源，
    // 见那里注释为什么不能改成写 history）。所以这个开关关掉 = 该词不会因
    // "手动标记不会读"进错题本；但**机器判 fail 的记录照旧写**（见 applyResult），
    // 那条路径不受本开关影响 —— 开关语义是"要不要记我的手动标记"，
    // 不是"要不要评测发音"。
    if (this.cfg.recordUnknown) {
      saveRecord(cardId, {
        date: this.today, band: 'unknown', score: 0, heard: '', ms: 0
      });
    }
    if (this.cfg.autoPlayAudio) this.playAudio();
  },

  /*------------------------- 播放发音 -------------------------*/

  setupAudio() {
    this.audio.onEnded(() => this.setData({ playing: false }));
    this.audio.onError(() => {
      this.setData({ playing: false });
      wx.showToast({ title: '发音播放失败', icon: 'none' });
    });
  },

  /**
   * 播放单词发音。
   *
   * 顺序：**随包预置音频 → 插件合成 → 本地服务**。
   *
   * 为什么把随包音频放在最前：它是唯一"零延迟 + 离线可用 + 零成本"的方案
   * （294 词共 1MB，已打进包）。插件需要主体有权限、本地服务需要电脑开机，
   * 这两条都不能作为首选。只有用户**自己录入**的词（不在 295 词表内）
   * 才没有预置音频，那时才走插件。
   */
  playAudio() {
    const card = this.data.card;
    if (!card) return;
    if (this.data.playing) { this.stopAudio(); return; }

    audioPack.resolveForPlay(card.prompt).then(r => {
      if (r.ok && r.src) { this._playUrl(r.src); return; }
      // 预置和插件都不行 → 最后试本地服务（开发期可能开着）
      if (this.voiceBackend === 'local') { this.playLocalAudio(card.prompt); return; }
      wx.showToast({ title: '这个词还没有发音，可以查词典', icon: 'none' });
    });
  },

  /** 用本地服务的预生成音频（开发期兜底） */
  playLocalAudio(word) {
    this._playUrl(asr.audioUrl(word));
  },

  _playUrl(url) {
    try {
      this.audio.src = url;
      this.audio.play();
      this.setData({ playing: true });
    } catch (e) {
      console.warn('[pron] 播放失败', e);
      this.setData({ playing: false });
      wx.showToast({ title: '发音播放失败', icon: 'none' });
    }
  },

  stopAudio() {
    try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    this.setData({ playing: false });
  },

  /**
   * 重播：与 playAudio 不同，它**不 toggle**。
   * 点第二次应该重播，而不是停止 —— 否则学生按了没声音会以为坏了。
   */
  replay() {
    const card = this.data.card;
    if (!card) return;
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    try { this.audio.stop(); } catch (e) { /* 忽略 */ }
    this.setData({ playing: false });
    this.playAudio();
  },

  /*------------------------- 前进 -------------------------*/

  next() {
    if (this.data.judging) return;
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (!this.queue) {
      this.setData({ finished: true });
      return;
    }
    const nextIdx = this.data.idx + 1;
    if (nextIdx >= this.queue.length) {
      this.setData({ finished: true, card: null });
      return;
    }
    this.stopAudio();
    this.setData({
      idx: nextIdx,
      card: withPhon(this.queue[nextIdx]),
      result: null,
      revealed: false,
      recordingMs: 0
    });
  },

  revealAnswer() {
    this.setData({ revealed: true });
  },

  restart() {
    this.buildQueue();
  },

  /** 占位：录音时用 catchtouchmove 挂住，防止页面跟着手指滚动 */
  noop() {},

  /**
   * 去复习：落到「今日待复习」。
   *
   * ⚠️ 只 switchTab 不够（2026-09-19 修）：复习页是 tabBar 长生命周期实例，
   * wx.switchTab 到**已经创建过**的它不重跑 onLoad、只跑 onShow，于是它会保持
   * 上一次的范围/状态 —— 若学生刚点过错题重练（prefs.scope='weak'），或上一次
   * 恰好停在完成页，从朗读页点「去复习」看到的是错题本/完成页，而不是"今日待复习"。
   * 照 deck.goStudy 补 pending_study（由 study.consumePending() 读后即删）。
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
      console.warn('[pronounce] 写入今日任务请求失败', err);
    }
    wx.switchTab({ url: '/pages/study/study' });
  },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
}));
