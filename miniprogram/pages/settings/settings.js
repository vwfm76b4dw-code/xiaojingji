const settings = require('../../utils/settings.js');
const theme = require('../../utils/theme.js');
const semantic = require('../../utils/semantic.js');

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',

    // 主题（utils/theme.js 的 id）：色卡选中态渲染用；
    // themeClass 由 withTheme 维护（根 view 挂 class）
    themeId: 'paper',
    themeDesc: '',
    // 色卡数据（onLoad 从 theme.THEMES 拍平 —— wxml 不直接引 utils 模块）
    themes: [],

    cfg: {},
    // 「本地模型」卡片状态（体积/进度/是否配置过）
    mp: { configured: false, complete: false, downloading: false, percent: 0, doneText: '0 MB', totalText: '47.0 MB', error: '' },
    // 「端上发音判定」卡片状态。ap 前缀避免与上面的 mp 混。
    ap: { configured: false, complete: false, downloading: false, percent: 0, doneText: '0 MB', totalText: '0.8 MB', error: '' },
    // 服务状态
    asrOk: false,
    asrMsg: '正在检查…',
    editingBase: false,
    draftBase: '',
    // 「开发者选项」折叠态开关，默认收起 —— 学生不该看到本机识别服务的地址
    // 统计
    vocabSize: 0,
    audioCached: 0
  },

  onLoad() {
    // 色卡元数据拍平进 data：THEMES 的键顺序即展示顺序（JS 对象序稳定）
    const themes = theme.IDS.map(function (id) {
      return { id: id, label: theme.THEMES[id].label, swatch: theme.THEMES[id].swatch };
    });
    this.setData({
      cfg: settings.load(),
      themes: themes
    });
  },














  onShow() {
    this.setData({
      cfg: settings.load(),
      // 色卡选中态与副文案每次进入都校准（onLoad 只跑一次，防以后有别的改主题入口）
      themeId: theme.current(),
      themeDesc: theme.THEMES[theme.current()].desc
    });
    this.refreshModelPack();
    this.refreshAsrPack();
  },








  /*------------------------- 参数调节 -------------------------*/

  /** 数值型参数：+/- 步进（比滑块更精确，也更好点） */
  step(e) {
    

  const key = e.currentTarget.dataset.k;
  const delta = Number(e.currentTarget.dataset.d);
  const min = Number(e.currentTarget.dataset.min);
  const max = Number(e.currentTarget.dataset.max);
  const cur = Number(this.data.cfg[key]) || 0;
  let next = cur + delta;
  if (next < min) next = min;
  if (next > max) next = max;
  if (next === cur) return;
  const cfg = settings.save({ [key]: next });
  this.setData({ cfg: cfg });
 
  
  },

  /** 开关型参数 */
  toggle(e) {
    const key = e.currentTarget.dataset.k;
    // 本地模型是实验功能开关，不是危险修改：不过家长锁。真机反馈（2026-09-25）：
    // 点它弹「设置家长密码」两连弹，体感是「本地模型和家长控制串了、两个按钮都没用」。
    // 家长锁继续拦真正的危险项：清空记录 / 重置学习进度 / 恢复默认 / 每日量步进。
    const apply = () => {
      const cfg = settings.save({ [key]: !this.data.cfg[key] });
      this.setData({ cfg: cfg });

      // 开关语义通道：开 → 后台初始化；关 → 释放（不删资源，只停用）
      if (key === 'localModel') {
        if (cfg.localModel) {
          semantic.init(function (err) {
            if (err && err.message && err.message.indexOf('资源缺失') >= 0) {
              // 资源还没下：引导去下载，而不是让人对着一个不工作的开关发呆
              wx.showToast({ title: '请先下载模型资源', icon: 'none' });
            }
          });
        } else {
          semantic.release();
        }
      }
    };
    if (key === 'localModel') { apply(); return; }
    apply();
  },

  /** 阈值这类连续参数：用几个预设档位（比滑块好操作） */
  pickThreshold(e) {
    

  const level = e.currentTarget.dataset.level;
  // 三档：宽松 / 标准 / 严格
  const PRESET = {
    loose: { passScore: 0.78, borderlineScore: 0.60 },
    normal: { passScore: 0.84, borderlineScore: 0.68 },
    strict: { passScore: 0.90, borderlineScore: 0.75 }
  };
  const cfg = settings.save(PRESET[level] || PRESET.normal);
  this.setData({ cfg: cfg });
  wx.showToast({ title: '判定尺度：' + ({ loose: '宽松', normal: '标准', strict: '严格' }[level] || '标准'), icon: 'none' });
 
  
  },

  resetAll(e) {
    

  wx.showModal({
    title: '恢复默认设置？',
    content: '只重置学习量、朗读、反馈等参数，学习进度不受影响。',
    success: res => {
      if (!res.confirm) return;
      const cfg = settings.reset();
      this.setData({ cfg: cfg });
      wx.showToast({ title: '已恢复默认', icon: 'none' });
    }
  });
 
  
  },

  /*------------------------- 服务地址 -------------------------*/

  /**
   * 展开/收起「开发者选项」。
   *
   * 为什么不直接删掉这一块：本机识别服务（127.0.0.1:8766）是开发期的调试通道，
   * voiceBackend='auto' 时线上优先走微信插件，学生永远用不到它 —— 但作者调试 ASR 时
   * 必须能改地址、跑连通性测试。折叠是同时满足两边的唯一做法。
   *
   * 为什么用"明摆着的入口"而不是长按/双击隐藏：后者不可发现，作者过两个月
   * 自己也找不到；折叠区的存在本身就是文档。
   */









  /**
   * 去朗读页。
   *
   * ⚠️ 必须用 switchTab —— pronounce 是 tabBar 页，
   * navigateTo 跳 tabBar 页会静默失败（只有控制台报错，界面完全没反应）。
   */
  goPronounce() {
    wx.switchTab({
      url: '/pages/pronounce/pronounce',
      fail: () => wx.showToast({ title: '打开失败，请点底部「朗读」', icon: 'none' })
    });
  },

  /*------------------------- 主题 -------------------------*/

  /**
   * 换主题（设置页色卡）。点选即时生效：settings 持久化 + 本页 themeClass
   * 立即刷新；其他页在返回时由 withTheme 的 onShow 前置刷新接管。
   */
  pickTheme(e) {
    const id = e.currentTarget.dataset.theme;
    const cfg = theme.setColor(id);
    this.setData({
      themeId: theme.current(),
      // 本页根 view 的 class 也要立即跟上 —— withTheme 只在 onShow 刷新，
      // 而此刻页面就在前台，等下一次 onShow 才变会让人以为点了没反应
      themeClass: theme.themeClassOf(theme.current())
    });
    wx.showToast({ title: '主题：' + theme.THEMES[theme.current()].label, icon: 'none' });
  }
}));
