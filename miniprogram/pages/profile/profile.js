/**
 * 「我的」页 —— 资料卡 / 数据概览 / 次级功能入口收拢。
 *
 * ## 这个页面为什么存在（2026-09-25 底部栏整理）
 * tabBar 从 5 项收成 4 项（词库/复习/朗读/我的），问词与统计从底栏撤下。
 * 撤下的页面不能只是"还在"——它们必须有一个稳定、可预期的家，否则就是孤儿页。
 * 这一页就是那个家：低频但必需的入口全部收进菜单列表；高频的问词另在
 * 词库页给了直达卡（deck 工具区）——「遇到生词马上查」不该先绕道"我的"。
 *
 * ## 降级立场（与 pack-social/pages/friends 同一套契约）
 * 资料读取全部走 utils/friend.js（永不抛错封装），页面里没有一处裸 wx.cloud 调用
 * —— 降级逻辑散到调用方是项目明令禁止的模式（见 utils/audio.js 顶部注释）。
 * 云不可用时显示本机缓存的名片 + 提示横幅，没有缓存就显示注册引导：
 * 任何状态都有可看的 UI，绝不白屏、绝不挂未捕获的 Promise。
 */
const friend = require('../../utils/friend.js');
const store = require('../../utils/store.js');
const growth = require('../../utils/growth.js');
const { todayStr } = require('../../utils/date.js');
const theme = require('../../utils/theme.js');   // 主题接线：data.themeClass + onShow 刷新

/** 这些 code 都意味着"云暂时够不着"。口径与 friends.js 的 CLOUD_DOWN_CODES 一致
 *  （friend.js 的 call 只会返回这几个失败 code；两处清单必须同步改）。 */
const CLOUD_DOWN_CODES = ['NO_CLOUD', 'CALL_FAILED', 'TIMEOUT', 'THREW', 'FAILED'];

function readJSON(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? fallback : v;
  } catch (e) { return fallback; }
}

Page(theme.withTheme({
  data: {
    // 主题类（根 view 挂 class）：显式声明过「wxml 引用字段必须在 data 初始化」门禁
    themeClass: 'theme-paper',
    // 资料卡三态：hasProfile=云端已注册；cloudDown=云不可用（缓存名片 + 提示）
    hasProfile: false,
    cloudDown: false,
    nickname: '',
    avatarSrc: '',
    friendId: '',

    // 数据概览条（口径与成长看板/战报一致，见 refreshOverview）
    mastered: 0,
    streakDays: 0,
    points: 0
  },

  /**
   * onShow 而不是 onLoad 刷新：从好友页/宠物页回来时资料可能已改；
   * 本页只被 navigateTo 打开、每次都是新实例，onShow 全量刷新成本可忽略。
   */
  onShow() {
    this.refreshOverview();
    this.loadProfile();
  },

  /*------------------------- 数据概览 -------------------------*/

  /**
   * 三个数字全部复用既有口径，**不自算一套**：
   *   · 累计掌握 → friend.totalWordsLocal()（= schedule.masteredCount，战报同款）
   *   · 积分     → friend.localTotal()（= growth.pointsBreakdown，成长看板同款）
   * 口径一旦分叉，"看板说 320 分、我的页说 300"会让人怀疑数据是假的 ——
   * 这正是 friend.js 顶部注释立下的规矩。
   * 连胜没有现成封装，照 deck/growth 页的同一段推导（activeDates + repairs + streakOf）。
   */
  refreshOverview() {
    const today = todayStr();
    const states = store.loadStates();
    const pron = store.loadPronRecords();
    const spell = store.loadSpellRecords();
    let repairs = readJSON(growth.REPAIR_KEY, []);
    if (!Array.isArray(repairs)) repairs = [];
    const st = growth.streakOf(growth.activeDates(states, pron, spell), today, { repairs: repairs });
    this.setData({
      mastered: friend.totalWordsLocal(),
      points: friend.localTotal(),
      streakDays: st.current
    });
  },

  /*------------------------- 资料卡 -------------------------*/

  /**
   * 本地持久头像兜底（与 friends.js 的本地链同源：storage 标记 social_avatar_local
   * + 固定文件 avatar_local.png）。为什么页内再实现一份而不是抽 util：
   * friends.js 的助手长在页面文件里（并行开发产物），抽取是独立重构；
   * 两端 key/文件名的一致性由 verify-profile 的对账断言钉住。
   * accessSync 校验：清缓存后文件可能没了，给 image 一个必挂 src 比没头像更糟。
   */
  localAvatar() {
    try {
      const f = wx.getStorageSync('social_avatar_local');
      if (!f || !f.path) return '';
      wx.getFileSystemManager().accessSync(f.path);
      return f.path;
    } catch (e) { return ''; }
  },

  /**
   * 两段式渲染：先上本地缓存（首屏零等待），再拉云端校正。
   * 为什么不阻塞首屏等云：云函数冷启动约 3s、超时兜底 8s，等它就是白屏 3 秒起。
   */
  loadProfile() {
    const p = friend.profile();
    if (p) {
      this.setData({
        hasProfile: true,
        nickname: p.nickname || '',
        avatarSrc: p.avatarFileID || this.localAvatar() || '',
        friendId: p.friendId || ''
      });
    }
    const self = this;
    friend.refreshProfile().then(function (r) {
      if (r && r.ok && r.profile) {
        self.setData({
          hasProfile: true,
          cloudDown: false,
          nickname: r.profile.nickname || '',
          // 云端没带头像时保留缓存值，再退本地持久头像：不因一次成功响应把头像洗掉
          avatarSrc: r.profile.avatarFileID || self.data.avatarSrc || self.localAvatar() || '',
          friendId: r.profile.friendId || self.data.friendId
        });
      } else if (r && r.code === 'NO_PROFILE') {
        // 云没挂，只是这个人还没注册 → 给注册引导（注册入口在好友页，那里有给家长的说明）
        self.setData({ hasProfile: false, cloudDown: false });
      } else if (r && CLOUD_DOWN_CODES.indexOf(r.code) >= 0) {
        // 云不可用：沿用缓存名片（可能为空）。空缓存时引导按钮仍可点，
        // 点进好友页会看到同一套降级文案 —— 不在本页重复实现注册表单。
        self.setData({ cloudDown: true });
      }
    }).catch(function () {
      // call 契约上永不 reject；这里兜的是链条里意外抛出的非网络错误
      self.setData({ cloudDown: true });
    });
  },

  /** 头像加载失败（如 cloud:// 在云不可用时打不开）：退回占位，不留破图 */
  onAvatarError() {
    this.setData({ avatarSrc: '' });
  },

  /** 好友号一键复制。隐私指引已声明剪切板用途（交接文档「剩用户操作③」同批声明） */
  copyFriendId() {
    const fid = this.data.friendId;
    if (!fid) return;
    wx.setClipboardData({
      data: fid,
      success: function () {
        wx.showToast({ title: '好友号已复制', icon: 'none' });
      }
    });
  },

  /*------------------------- 菜单跳转 -------------------------*/

  // 统一 navigateTo：目标页全部已不是 tabBar 页（2026-09-25 底部栏整理）。
  // switchTab 只对 tabBar 页有效，对普通页会**静默失败**（只有控制台报错，界面没反应）。

  goFriends() { wx.navigateTo({ url: '/pack-social/pages/friends/friends' }); },
  goStats() { wx.navigateTo({ url: '/pages/stats/stats' }); },
  goAsk() { wx.navigateTo({ url: '/pages/ask/ask' }); },
  goGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  /**
   * 分享战报：口径照抄 pack-social/pages/friends 的 report 模式
   * （标题带累计掌握数、path 落到词库页）。两处文案分叉会像两个产品。
   */
  onShareAppMessage: function () {
    return {
      title: '我在小鲸记单词已经背下 ' + friend.totalWordsLocal() + ' 个单词，来比比谁坚持得久',
      path: '/pages/deck/deck'
    };
  }
}));
