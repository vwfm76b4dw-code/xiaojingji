/**
 * 好友页逻辑。数据获取全部走 utils/friend.js（永不抛错封装），
 * 页面只负责把 {ok, code, msg} 翻译成 UI 状态：横幅、toast、空态。
 *
 * ## 为什么页面里没有一处裸 wx.cloud 调用
 * 云调用的超时/异常折算都在 friend.js 一处做完（与 rank.js 同一套契约）。
 * 页面如果自己 wx.cloud.callFunction，降级逻辑就会散落 —— 这是项目
 * 明令禁止的模式（见 utils/audio.js 顶部注释）。
 */
const friend = require('../../../utils/friend.js');
const rank = require('../../../utils/rank.js');
// 主题接线走桥（pack-social/theme-bridge.js）：theme.js 由并行 Agent 开发中，
// 缺失/形态不符时桥返回空串 = 默认主题，绝不让装饰带崩功能页。
const themeBridge = require('../../theme-bridge.js');

/** 隐私说明是否已看过。不设过期：家长确认过一次就不再自动弹。 */
const PRIVACY_KEY = 'social_privacy_seen';

/**
 * 本地持久头像的 storage 标记：{path, updatedAt, pending}。
 * pending=true 表示「本地这张比云端新」（刚选还没上传 / 上传失败待重传），
 * 展示与重试都认它；上传落库成功后翻成 false，云端重新成为唯一事实——
 * 好友看的是云端的，本地不能反过来谎报。
 */
const AVATAR_LOCAL_KEY = 'social_avatar_local';

/** 固定文件名（USER_DATA_PATH 下）。为什么不用 saveFile / 时间戳新文件：
 *  saveFile 每次生成新落盘文件，10MB 配额迟早撑爆还得做清理；固定名覆盖写，
 *  本地只保「最近一张」，零增长零维护。 */
function localAvatarPath() {
  try {
    const base = (wx.env && wx.env.USER_DATA_PATH) || '';
    return base ? base + '/avatar_local.png' : '';
  } catch (e) { return ''; }
}

/** 读本地头像标记（带文件存在性校验）。为什么每次都 accessSync 而不是只信
 *  storage：清缓存/升级清理后 USER_DATA_PATH 可能被清空而标记还在——不校验
 *  就会给 image 一个必挂的 src，比没有头像更糟（空占位变破图）。 */
function localAvatarFlag() {
  try {
    const f = wx.getStorageSync(AVATAR_LOCAL_KEY);
    if (!f || !f.path) return null;
    wx.getFileSystemManager().accessSync(f.path);
    return f;
  } catch (e) { return null; }
}

/** 这些 code 都意味着"云暂时够不着"，统一翻成顶部横幅。
 *  业务 code（NOT_FOUND / CANT_ADD_SELF …）不是云的问题，走 toast。 */
const CLOUD_DOWN_CODES = ['NO_CLOUD', 'CALL_FAILED', 'TIMEOUT', 'THREW', 'FAILED'];

function isCloudDownCode(r) {
  return !!r && CLOUD_DOWN_CODES.indexOf(r.code) >= 0;
}

Page({
  data: {
    themeClass: '',       // 主题类名（theme-bridge 解析；空串 = 默认主题）
    cloudDown: false,
    showPrivacy: false,
    saving: false,
    nickname: '',
    avatarSrc: '',
    friendId: '',
    points: 0,
    pointsWeek: 0,
    totalWords: 0,
    inputId: '',
    qrFileID: '',
    qrNote: '',
    qrSaving: false,
    board: []
  },

  onLoad: function (options) {
    let seen = false;
    try { seen = !!wx.getStorageSync(PRIVACY_KEY); } catch (e) { /* 读不到当没看过 */ }
    // 主题类一次解析完：读 settings 是同步操作，不值得为它多发一次 setData
    this.setData({ showPrivacy: !seen, themeClass: themeBridge.resolveThemeClass() });

    // 分享卡片（path 带 f=friendId）或好友码（scene=friendId）落地：
    // 提取出来先存着，等 onShow 把云状态确认完再弹确认框 ——
    // 不在 onLoad 直接加：云没就绪时 addFriend 会静默失败，用户还以为加上了。
    const raw = (options && (options.f || options.scene)) || '';
    const fid = friend.extractFriendId(raw);
    if (fid) this.pendingAdd = fid;

    // 昵称预填：优先云端资料，其次借进步榜的匿名昵称（少一次空白输入）。
    // 为什么不默认真名/微信号：未成年人产品，展示名必须由本人主动给。
    const p = friend.profile();
    // 头像展示链（onLoad 版）：pending 本地头像 → 云端 fileID → 本地旧副本 → 空。
    // pending 在场说明上次会话的头像没传上云（没点保存/上传失败就退出了），
    // 本地那张才是用户最新意图，必须压过云端旧值；顺带恢复 _avatarTemp——
    // 「下次保存会再试」的承诺要跨重启成立，只靠内存变量活不过一次杀进程。
    const flag = localAvatarFlag();
    if (flag && flag.pending) this._avatarTemp = flag.path;
    this.setData({
      nickname: (p && p.nickname) || rank.nick() || '',
      friendId: (p && p.friendId) || '',
      avatarSrc: (this._avatarTemp && flag && flag.path)
        || (p && p.avatarFileID)
        || (flag && flag.path)
        || '',
      totalWords: friend.totalWordsLocal()
    });
  },

  onShow: function () {
    // 战报数字可能在本轮学习后变了，每次显示都重算（本地计算，零成本）。
    this.setData({ totalWords: friend.totalWordsLocal() });
    this.refreshAll();
  },

  /*------------------------- 数据加载 -------------------------*/

  refreshAll: function () {
    const that = this;
    if (!friend.available()) {
      // 云开发没初始化/低版本基础库：整页降级，但仍能看本地名片
      this.setData({ cloudDown: true });
      return;
    }
    // 静默同步积分 → 拉资料 → 拉周榜。syncNow 失败不挡后续读取
    // （积分晚一点到没关系，好友列表必须能看）。
    friend.syncNow()
      .then(function () { return friend.refreshProfile(); })
      .then(function (r) {
        if (r && r.ok && r.profile) {
          // 头像三级兜底链：云端 fileID（好友看到的就是它，本地优先级必须低于它）
          // → 服务端换好的临时直链 avatarUrl（存储「仅创建者可读写」挡住 fileID
          //   时的第二落点，见 socialProxy.attachAvatarUrls）→ 本地持久头像。
          // 刚选还没保存的头像（_avatarTemp 在场）除外：晚到的云端旧值不许
          // 顶掉屏幕上的新头像，用户会以为「选了个寂寞」。
          const keepPicked = !!that._avatarTemp;
          const flag = localAvatarFlag();
          that.setData({
            cloudDown: false,
            friendId: r.profile.friendId || that.data.friendId,
            nickname: r.profile.nickname || that.data.nickname,
            avatarSrc: keepPicked ? that.data.avatarSrc
              : (r.profile.avatarFileID || r.profile.avatarUrl || (flag && flag.path) || ''),
            points: r.points || 0,
            pointsWeek: r.pointsWeek || 0
          });
        }
        return that.loadBoard();
      })
      .then(function () { that.consumePendingAdd(); })
      .catch(function () {
        // call 永不 reject；这里兜的是链条里意外抛出的非网络错误
        that.setData({ cloudDown: true });
      });
  },

  loadBoard: function () {
    const that = this;
    return friend.fetchLeaderboard().then(function (r) {
      if (r && r.ok && Array.isArray(r.list)) {
        // 周榜自己那行允许本地兜底：头像没传上云（上传失败/没保存）时，
        // 「我」的行不该是空圆圈——本地那张就是我的头像。好友行绝不落本地
        // 路径：本地文件对别人的设备无意义，缺了就老实走服务端临时直链/空占位。
        const flag = localAvatarFlag();
        const list = (flag && flag.path)
          ? r.list.map(function (row) {
              return (row.isMe && !row.avatarFileID)
                ? Object.assign({}, row, { avatarLocal: flag.path })
                : row;
            })
          : r.list;
        that.setData({ cloudDown: false, board: list });
      } else if (r && r.code === 'NO_PROFILE') {
        that.setData({ board: [] });   // 没注册资料：榜为空，但云没挂
      } else if (isCloudDownCode(r)) {
        that.setData({ cloudDown: true });
      }
    });
  },

  /**
   * 周榜头像 fileID 加载失败的交换（binderror）。为什么 fileID 还排第一：
   * 它是永久稳定链路（自家文件直接可读；将来存储权限放宽也零成本受益），
   * 临时直链会过期；失败的代价只是一次快速的 403/404，兜底是自动的。
   * 清掉坏源而不是直接改 src：模板里的 || 表达式自然落到下一级，wx:if 与
   * src 永远同源，不会出现「占位和图打架」。
   */
  onBoardAvatarErr: function (e) {
    const i = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index;
    const row = (this.data.board || [])[i];
    if (!row) return;
    const failed = row.avatarFileID ? 'avatarFileID' : (row.avatarUrl ? 'avatarUrl' : 'avatarLocal');
    if (!row[failed]) return;
    const patch = {};
    patch['board[' + i + '].' + failed] = '';
    this.setData(patch);
  },

  /*------------------------- 落地自动加好友 -------------------------*/

  consumePendingAdd: function () {
    const fid = this.pendingAdd;
    if (!fid) return;
    this.pendingAdd = '';
    if (fid === this.data.friendId) {
      wx.showToast({ title: '这是你自己的好友 ID', icon: 'none' });
      return;
    }
    const that = this;
    // 弹确认而不是直接加：分享链接可以被转发到任何地方，
    // "点开就自动建立关系"对未成年人产品是越权行为。
    wx.showModal({
      title: '添加好友',
      content: '把「' + fid + '」的主人加为好友？加好友后你们能互相看到积分。',
      confirmText: '加好友',
      cancelText: '先不了',
      success: function (res) {
        if (!res.confirm) return;
        friend.addFriend(fid).then(function (r) {
          if (r && r.ok) {
            wx.showToast({ title: '已添加', icon: 'success' });
            that.loadBoard();
          } else if (r) {
            if (isCloudDownCode(r)) that.setData({ cloudDown: true });
            wx.showToast({ title: r.msg || '添加失败', icon: 'none' });
          }
        });
      }
    });
  },

  /*------------------------- 名片 -------------------------*/

  onNickInput: function (e) {
    this.setData({ nickname: (e.detail && e.detail.value) || '' });
  },

  onChooseAvatar: function (e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    // chooseAvatar 给的是临时路径：当次会话有效，用户没点保存/进程被杀/
    // 上传失败，头像就没了——这正是「重进头像消失」反馈的来源。所以先复制
    // 一份到 USER_DATA_PATH 固定名并写标记（pending=true：本地比云端新）。
    // 复制失败（极端机型/源不是本地文件）退回临时路径，至少本轮内能显示。
    const dest = localAvatarPath();
    let persistent = '';
    if (dest) {
      try {
        const fsm = wx.getFileSystemManager();
        try { fsm.unlinkSync(dest); } catch (e2) { /* 不存在就是我们要的目标态 */ }
        fsm.copyFileSync(url, dest);
        persistent = dest;
        try {
          wx.setStorageSync(AVATAR_LOCAL_KEY, { path: dest, updatedAt: Date.now(), pending: true });
        } catch (e3) { /* 标记存不上只损失跨会话兜底，本轮显示不受影响 */ }
      } catch (err) { /* 降级到临时路径，统一在下面处理 */ }
    }
    // 上传源一律用持久路径（复制成功时）：临时路径可能在用户点保存前被系统回收；
    // 新选择作废旧的「已上传缓存」，否则会拿旧 fileID 冒充新头像
    const shown = persistent || url;
    this._avatarTemp = shown;
    this._avatarUploadedFor = '';
    this._avatarUploadedFileID = '';
    this.setData({ avatarSrc: shown });
  },

  saveProfile: function () {
    if (this.data.saving) return;
    const nick = String(this.data.nickname || '').trim();
    if (!nick) {
      wx.showToast({ title: '先给自己起个名字', icon: 'none' });
      return;
    }
    const that = this;
    this.setData({ saving: true });
    this.uploadAvatarIfNeeded()
      .then(function (up) {
        return friend.register(nick, up.fileID).then(function (r) { return { up: up, r: r }; });
      })
      .then(function (out) {
        const r = out.r;
        const up = out.up;
        that.setData({ saving: false });
        if (r && r.ok && r.profile) {
          if (up.fileID) {
            // 上传+落库双成功才撤重传标记；只成功一半（云存储成了、register
            // 挂了）时保留 _avatarTemp，下次保存凭 _avatarUploadedFor 缓存复用
            // fileID，不会在云存储里再造一张废图。
            that._avatarTemp = '';
            that.markAvatarSynced();
          }
          // 展示源：只有「这次真的传上去了」才采信服务端头像值。上传失败时
          // 服务端返回的是旧 avatarFileID（register 对空头像不覆盖），直接
          // 采纳会把刚选的新头像顶掉——那等于替用户撤销了他刚做的选择。
          that.setData({
            friendId: r.profile.friendId,
            avatarSrc: up.uploaded
              ? (r.profile.avatarFileID || r.profile.avatarUrl || that.data.avatarSrc)
              : that.data.avatarSrc
          });
          // 不静默：静默 = 用户以为好友能看到，实际周榜是空圆圈。
          // 为什么不拆两条 toast：showToast 会互相顶掉，说清一件事比说完两件事强。
          wx.showToast({
            title: up.uploaded ? '已保存' : '头像已存本机，云端暂没传上，下次保存会再试',
            icon: up.uploaded ? 'success' : 'none'
          });
          that.loadBoard();   // 有了资料，周榜里才会在场
        } else if (r) {
          if (isCloudDownCode(r)) that.setData({ cloudDown: true });
          wx.showToast({ title: r.msg || '保存失败', icon: 'none' });
        }
      });
  },

  /**
   * 头像上传。resolve { fileID, uploaded }：
   *   uploaded=false ⟺ 本机有头像没传上云（含云能力缺席）——名片照存
   *   （昵称是主键级需求，头像是装饰），但 toast 必须说清「只在本机」，
   *   且 _avatarTemp 保留到下一次 saveProfile 自动重传。
   * 为什么不在 chooseAvatar 回调里就传：用户可能选完又换，每次都传会在
   * 云存储里留一堆废图。为什么有 _avatarUploadedFor 缓存：register 失败后
   * 再点保存，图没变就不该重传第二次——同上的废图问题，换个入口出现。
   */
  uploadAvatarIfNeeded: function () {
    const that = this;
    const tmp = this._avatarTemp;
    if (!tmp) return Promise.resolve({ fileID: '', uploaded: true });   // 没换头像 ≠ 失败，不提示
    if (this._avatarUploadedFor === tmp && this._avatarUploadedFileID) {
      return Promise.resolve({ fileID: this._avatarUploadedFileID, uploaded: true });
    }
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) {
      return Promise.resolve({ fileID: '', uploaded: false });
    }
    return new Promise(function (resolve) {
      // cloudPath 用时间戳+随机数而不是用户输入：路径可控、无注入面
      const path = 'avatars/' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.png';
      wx.cloud.uploadFile({
        cloudPath: path,
        filePath: tmp,
        success: function (res) {
          const fileID = (res && res.fileID) || '';
          if (fileID) {
            that._avatarUploadedFor = tmp;
            that._avatarUploadedFileID = fileID;
          }
          resolve({ fileID: fileID, uploaded: !!fileID });
        },
        fail: function () { resolve({ fileID: '', uploaded: false }); }
      });
    });
  },

  /** 本地头像已成功上云：翻 pending=false。此后展示走云端（好友看到的就是
   *  它），本地文件降级为纯兜底（云端 fileID 缺失时才出场）。 */
  markAvatarSynced: function () {
    try {
      const f = wx.getStorageSync(AVATAR_LOCAL_KEY);
      if (f && f.path) {
        wx.setStorageSync(AVATAR_LOCAL_KEY, { path: f.path, updatedAt: f.updatedAt || Date.now(), pending: false });
      }
    } catch (e) { /* 标记维护失败不影响主流程：展示链与重传按旧标记工作 */ }
  },

  copyId: function () {
    if (!this.data.friendId) return;
    wx.setClipboardData({
      data: this.data.friendId,
      success: function () { wx.showToast({ title: '已复制', icon: 'success' }); }
    });
  },

  togglePrivacy: function () {
    this.setData({ showPrivacy: !this.data.showPrivacy });
  },

  dismissPrivacy: function () {
    try { wx.setStorageSync(PRIVACY_KEY, 1); } catch (e) { /* 存不上就每次都显示，可接受 */ }
    this.setData({ showPrivacy: false });
  },

  /*------------------------- 加好友三入口 -------------------------*/

  onIdInput: function (e) {
    this.setData({ inputId: (e.detail && e.detail.value) || '' });
  },

  addById: function () {
    const fid = friend.extractFriendId(this.data.inputId);
    if (!fid) {
      wx.showToast({ title: '好友 ID 是 XJ 开头的 8 位字符', icon: 'none' });
      return;
    }
    if (fid === this.data.friendId) {
      wx.showToast({ title: '这是你自己的好友 ID', icon: 'none' });
      return;
    }
    const that = this;
    friend.addFriend(fid).then(function (r) {
      if (r && r.ok) {
        wx.showToast({ title: '已添加 ' + ((r.profile && r.profile.nickname) || fid), icon: 'none' });
        that.setData({ inputId: '' });
        that.loadBoard();
      } else if (r) {
        if (isCloudDownCode(r)) that.setData({ cloudDown: true });
        wx.showToast({ title: r.msg || '添加失败', icon: 'none' });
      }
    });
  },

  makeQr: function () {
    if (!this.data.friendId) {
      wx.showToast({ title: '先保存名片', icon: 'none' });
      return;
    }
    const that = this;
    this.setData({ qrFileID: '', qrNote: '生成中…' });
    // 不指定 envVersion → 服务端 release 失败自动降级 trial（见 doQrCode 注释）
    friend.fetchQrCode().then(function (r) {
      if (r && r.ok && r.fileID) {
        that.setData({
          qrFileID: r.fileID,
          qrNote: r.trialOnly
            ? '体验版好友码：目前只有本项目「体验成员」能扫；正式发布后所有人都能扫。'
            : ''
        });
      } else if (r && r.code === 'QR_UNAVAILABLE') {
        that.setData({ qrFileID: '', qrNote: r.msg || '好友码暂时生成不了，先用「转发邀请卡」' });
      } else if (isCloudDownCode(r)) {
        that.setData({ qrFileID: '', qrNote: '', cloudDown: true });
      } else {
        that.setData({ qrFileID: '', qrNote: (r && r.msg) || '生成失败，稍后再试' });
      }
    });
  },

  /*------------------------- 好友码保存 -------------------------*/

  /**
   * 保存好友码到相册。云函数返回的是云存储 fileID（不是 base64 也不是裸
   * buffer，见 doQrCode 注释），所以落盘方式是 downloadFile 出临时 png，
   * saveImageToPhotosAlbum 直接吃这个临时路径 —— 不需要再经
   * FileSystemManager.writeFile 手写一次（那是拿到 base64 数据才需要的步骤）。
   */
  saveQr: function () {
    const fileID = this.data.qrFileID;
    // 守卫放在最前：没有二维码时按钮本就不该出现，这里再挡一层防误触
    if (!fileID || this.data.qrSaving) return;
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.downloadFile) {
      // 云存储够不着时二维码本身也出不来，这里只是同一条降级防线的收尾
      wx.showToast({ title: '云服务暂不可用，稍后再试', icon: 'none' });
      return;
    }
    const that = this;
    this.setData({ qrSaving: true });
    wx.cloud.downloadFile({
      fileID: fileID,
      success: function (res) {
        const tmp = res && res.tempFilePath;
        if (!tmp) {
          that.setData({ qrSaving: false });
          wx.showToast({ title: '图片下载失败，稍后再试', icon: 'none' });
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: tmp,
          success: function () {
            that.setData({ qrSaving: false });
            // 把"下一步动作"写进成功反馈：孩子存完图最自然的疑问是"然后呢"
            wx.showToast({ title: '已存相册，转发给朋友扫码即可加你', icon: 'none' });
          },
          fail: function (err) {
            that.setData({ qrSaving: false });
            that.handleAlbumFail(err);
          }
        });
      },
      fail: function () {
        that.setData({ qrSaving: false });
        wx.showToast({ title: '图片下载失败，稍后再试', icon: 'none' });
      }
    });
  },

  /**
   * 保存失败分流。授权拒绝（scope.writePhotosAlbum）是唯一值得弹窗的分支：
   * 它有一个明确的补救动作（去设置开权限）；其他失败（磁盘/下载）重试
   * 意义不大，toast 即可。为什么不在授权恢复后自动重试：openSetting 回来
   * 用户意图可能已变，让他再点一次「保存到相册」比替他决定重下一次图更省流量。
   */
  handleAlbumFail: function (err) {
    const msg = String((err && err.errMsg) || '');
    // 授权拒绝的 errMsg 形状：saveImageToPhotosAlbum:fail auth deny / authorize
    if (/auth|deny/i.test(msg)) {
      wx.showModal({
        title: '需要相册权限',
        content: '在设置里允许「添加到相册」后，就能把好友码发给同学。不保存也没关系，可以直接用「转发邀请卡」。',
        confirmText: '去设置',
        cancelText: '先不存',
        success: function (r) {
          if (!r.confirm) return;
          wx.openSetting({
            success: function (s) {
              // 授权已开才提示重试：开了别的开关不代表相册权限变了
              if (s && s.authSetting && s.authSetting['scope.writePhotosAlbum']) {
                wx.showToast({ title: '已允许，再点一次「保存到相册」', icon: 'none' });
              }
            }
          });
        }
      });
      return;
    }
    wx.showToast({ title: '保存失败，稍后再试', icon: 'none' });
  },

  /*------------------------- 分享 -------------------------*/

  /** open-type="share" 的两个按钮都在触发前先标记意图（bindtap 先于分享回调）。 */
  shareInvite: function () { this._shareMode = 'invite'; },
  shareReport: function () { this._shareMode = 'report'; },

  onShareAppMessage: function () {
    if (this._shareMode === 'report') {
      const n = friend.totalWordsLocal();
      return {
        title: '我在小鲸记单词已经背下 ' + n + ' 个单词，来比比谁坚持得久',
        path: '/pages/deck/deck'
      };
    }
    const fid = this.data.friendId;
    return {
      /**
       * 邀请卡文案（2026-09-30 宠物下线时同步改）。
       *
       * 原文是「送你一只小鲸鱼，一起背单词、喂宠物、上好友榜」——
       * 宠物下线后「喂宠物」成了**悬空引用**：这张卡会真的发到同学微信里，
       * 对方点进来找不到宠物入口，只会觉得被骗。而它不像页面文案那样
       * 只在本机可见，是唯一会**流出到外部**的宠物描述，所以必须一起改。
       *
       * 「小鲸鱼」保留：它是产品名/吉祥物，不是那个已下线的养成功能。
       */
      title: '送你一只小鲸鱼，一起背单词、上好友榜',
      path: fid ? '/pack-social/pages/friends/friends?f=' + fid : '/pack-social/pages/friends/friends'
    };
  }
});
