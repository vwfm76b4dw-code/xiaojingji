/**
 * 可配置参数 —— "产品"与"demo"的区别就在这些开关。
 *
 * 设计原则：
 *   ① 每个参数都有**合理默认值**，用户不配置也能直接用；
 *   ② 参数改动立即生效（下次进入页面读取），不需要重启；
 *   ③ 所有参数集中在这里，避免散落各处导致"想改不知道去哪改"。
 */
const KEY = 'settings';

const DEFAULTS = {
  // ---- 学习量 ----
  dailyNewWords: 10,      // 每日新词数（首次学习的词）
  dailyReviewMax: 30,     // 每日复习上限（防止词库大了之后一打开就 200 张）

  /**
   * 自动学习量（2026-09-30 新增，默认关）。
   *
   * ## 它做什么
   * 打开后，utils/learn-advisor.js 会基于**本地**近 7 天的练习记录、当前连胜、
   * 词库剩余量与今日到期量，给出"今日建议新词数 / 复习上限"，覆盖上面的手动值。
   *
   * ## 为什么默认关
   * 手动值是用户（或家长）明确说出口的承诺；advisor 再聪明也是一个
   * "看数据下的判断"。用户原话「**基于本地模型做一个小体量的分析**，这些是要
   * 形成一个数据飞轮」—— 数据飞轮的前提是**学生同意它参与**，
   * 而不是默认替他做主张。家长控制已经接受这个口径（开关走 withParent）。
   *
   * ## 为什么必须是"本地、纯规则、零 LLM"
   * 字段语义本应在 utils/learn-advisor.js 的头注释里 ——
   * 这里只标记：与 localModel 的"云端语义检索"无关，advisor 完全离线、可解释。
   */
  autoDaily: false,

  // ---- 语音能力 ----
  // auto  = 优先用微信插件（任何手机可用），不可用时退回本地服务
  // local = 强制用本地服务（开发调试用）
  voiceBackend: 'auto',

  // ---- 朗读练习（ASR）----
  // ⚠️ 作用域只有朗读页（pronounce.js 取它当单次练习张数）——**复习页不读它**。
  // 曾经按"单轮复习张数"写在这里并放进设置页的「学习量」卡片，学生调了复习量
  // 却毫无变化：一个改不动的开关比没有这个开关更伤信任。文案与归属已同步纠正。
  sessionSize: 10,            // 朗读页单次练习词数
  passScore: 0.84,            // 判定通过阈值（音素相似度）
  borderlineScore: 0.68,      // "再读一次"阈值，低于此判错
  autoPlayAudio: true,        // 判定不通过时自动播放标准发音
  recordUnknown: true,        // 记录"不会读"的词（供后续重点练）

  // ---- 反馈与体验 ----
  showHook: true,
  sfx: true,                  // 反馈音效（对/错提示音）             // 翻卡时显示记忆钩子

  /**
   * 学后拼写（2026-09-25 显式收编进 settings）。
   *
   * 为什么现在才进 DEFAULTS：这个开关此前只活在 study_prefs 里
   * （study.js 自己兜 `prefs.spellCheck !== false`），settings.js 头部
   * 「每个参数都有合理默认值、所有参数集中在这里」的原则对它一直名存实亡 ——
   * 想知道"出厂默认是开还是关"得去翻页面代码。
   * 默认值定为 **true**：自评（我记住了吗）是不可靠信号，拼写是唯一的
   * 主动回忆验证层；把默认关掉等于默认只信自评。用户显式关过（study_prefs
   * 里存着 false）仍然尊重 —— settings 管默认值，用户操作管覆盖，两层不打架。
   */
  spellCheck: true,

  /**
   * 自动发音（2026-09-25 新增，默认开）。
   *
   * 来源是用户真机反馈「背这个单词需要同步朗读」：新词出现与翻到答案面时
   * 自动读一遍，形-音-义三路同时进记忆，而不是靠学生记得点 ▶。
   * 默认开而不是默认关：这是背单词的**学习机制**（听是记忆输入），
   * 不是装饰音效；嫌吵的人关一次即可，没发现的人永远受益。
   * 关闭后复习页的 ▶ 手动播放不受影响。
   */
  autoSpeak: true,

  /**
   * 主题（2026-09-25 新增，默认 'paper' 纸白 = 原视觉，行为零变化）。
   *
   * 为什么放在 settings 里而不是独立 storage key：主题与音效/钩子同属
   * "用户偏好"，走同一条 load/save/reset 路径 —— reset 恢复默认时主题
   * 一并回纸白，不存在"清了设置主题还留着"的两套真相。
   * 合法值与取色定义在 utils/theme.js（这里只存 id 字符串，不知道颜色），
   * 读到非法值时 theme.js 回退 paper —— 存储层不做白名单，避免两处维护。
   */
  theme: 'paper',

  /**
   * 端侧语义检索（2026-09-22 新增，**默认关闭**）。
   *
   * 为什么默认关：它要额外下载 47 MB 模型资源、每次问词多花 10~45ms。
   * 对「只想背单词」的用户这是纯负担；对想试语义检索的用户才有价值。
   * 所以做成显式开关 —— 资源在首次启动时后台下好（WiFi 下），
   * 但**不打开这个开关就不会被用到**。
   *
   * 打开后：问词页的召回会多一路「语义相似」，
   * 与既有的「字符串/音素」和「主题索引」两路融合（不是替换）。
   */
  localModel: false,

  /**
   * 参加排行榜（2026-09-24 新增，**默认关闭**）。
   *
   * 这是本项目里**唯一会把数据传出设备**的开关。打开后会上报 5 个数 + 一个昵称
   * （本周进步 / 本周练习量 / 当前连胜 / 已掌握词数 / 昵称）到云开发，
   * 用于"进步榜"。不打开则一切留在本机，与以前完全一样。
   *
   * 为什么默认关而不是默认开：
   *   ① 面向的是初中生（未成年人），未经同意就上传任何数据都不合适；
   *   ② 榜是"锦上添花"，不是背单词的必要条件 —— 没有它，核心功能一点不缺。
   * 正式上线前还需补隐私协议与监护人同意流程（见任务台账）。
   */
  rankOptIn: false
};

function load() {
  try {
    const v = wx.getStorageSync(KEY);
    return Object.assign({}, DEFAULTS, (v && typeof v === 'object') ? v : {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(patch) {
  try {
    const next = Object.assign(load(), patch || {});
    wx.setStorageSync(KEY, next);
    return next;
  } catch (e) {
    console.error('[settings] 保存失败', e);
    return load();
  }
}

function get(key) {
  const v = load();
  return key in v ? v[key] : DEFAULTS[key];
}

function reset() {
  try {
    wx.removeStorageSync(KEY);
    return Object.assign({}, DEFAULTS);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

module.exports = { KEY, DEFAULTS, load, save, get, reset };
