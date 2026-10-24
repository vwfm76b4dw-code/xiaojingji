/**
 * 好友域客户端封装 —— callFunction + 本地资料缓存 + 积分同步。
 *
 * ## 设计立场（与 utils/rank.js 同一套降级契约）
 * **永不抛错**。云开发没开通、没网、函数没部署、超时 —— 任何一种都折算成
 * {ok:false, code} 的结果对象返回，调用方据此显示"云服务暂不可用"横幅，
 * 绝不让页面白屏或挂起未捕获的 Promise。
 *
 * ## 身份边界（隐私硬要求）
 * openid 从云函数 context 取，前端**永远拿不到**；friendId 是唯一对外标识。
 * 本模块只收集：昵称（input type=nickname 官方组件）、头像（用户主动选择）、
 * 好友关系、积分。不碰手机号/位置/通讯录 —— 给家长的说明见好友页静态文案。
 *
 * ## 积分同步的"一天一个槽位"协议（与服务端 doSyncPoints 对齐）
 * 服务端对同一 dayKey 只接受一次写入（重复明确拒绝，防刷分/防回滚）。
 * 客户端策略：
 *   - 每天首次进社交页同步一次：delta = 本地累计 − 已同步累计（>0 才发）；
 *   - 当天晚些的增量**不发**（发了会被拒），顺延到下一次同步一起算，总分不丢；
 *   - 本地累计回退（删卡等）时 delta ≤ 0，不发负数。
 * 为什么不追求"实时一致"：社交积分的用途是周 PK 与宠物养成，
 * T+1 的滞后对这两件事都没有感知，却换来了服务端账本不可刷的确定性。
 *
 * ## 花钱的镜像
 * 宠物扣费在服务端，但本地积分余额（growth 的 total − spent）也要同步少掉，
 * 否则同一笔积分在本地还能买护身符、在云端又能喂鲸鱼 —— 双花。
 * 所以 feedPet 成功后由 utils/pet.js 把花销镜像进 growth.SPENT_KEY。
 */
const settings = require('./settings.js');
const store = require('./store.js');
const schedule = require('./schedule.js');
const growth = require('./growth.js');
const quiz = require('./quiz.js');
const { todayStr } = require('./date.js');

const FN = 'socialProxy';

/** 与服务端 FRIEND_ID_RE 一致：XJ + 6 位去混淆 base32（无 0/1/I/O）。 */
const FRIEND_ID_RE = /^XJ[2-9A-HJ-NP-Z]{6}$/;

const PROFILE_KEY = 'social_profile';   // {friendId, nickname, avatarFileID, updatedAt}
const SYNC_KEY = 'social_sync';         // {cum, day} —— cum=服务端已确认的本地累计

/*------------------------- 云调用（永不抛错） -------------------------*/

/** 调用云函数。超时兜底 —— 云函数冷启动约 3s，超过 8s 就别让用户等了。 */
function call(action, payload, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };

    const timer = setTimeout(function () {
      done({ ok: false, code: 'TIMEOUT', msg: '网络有点慢，稍后再试' });
    }, timeoutMs || 8000);

    try {
      if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
        clearTimeout(timer);
        done({ ok: false, code: 'NO_CLOUD', msg: '云服务暂不可用' });
        return;
      }
      wx.cloud.callFunction({
        name: FN,
        data: Object.assign({ action: action }, payload || {}),
        success: function (res) {
          clearTimeout(timer);
          const r = res && res.result;
          done(r && typeof r === 'object' ? r : { ok: false, code: 'BAD_RESULT' });
        },
        fail: function (err) {
          clearTimeout(timer);
          done({ ok: false, code: 'CALL_FAILED', msg: '云服务暂时联系不上', detail: (err && err.errMsg) || '' });
        }
      });
    } catch (e) {
      // callFunction 在云开发未初始化时会抛同步异常，必须折算成结果对象
      clearTimeout(timer);
      done({ ok: false, code: 'THREW', msg: '云服务暂不可用' });
    }
  });
}

/** 云能力是否可用。不可用时页面显示横幅、按钮降级，而不是报错。 */
function available() {
  try {
    return typeof wx !== 'undefined' && !!wx.cloud && typeof wx.cloud.callFunction === 'function';
  } catch (e) { return false; }
}

/*------------------------- 本地数据口径 -------------------------*/

/**
 * 本地累计积分 —— 与成长看板完全同口径（同一个 growth 模块）。
 * 为什么不另算：口径一旦分叉，"看板说我有 320 分、好友页说 300"会让人
 * 怀疑数据是假的。这也正是 rank.buildPayload 的做法。
 */
function localTotal() {
  try {
    const states = store.loadStates();
    const pron = store.loadPronRecords();
    const spell = store.loadSpellRecords();
    const dates = growth.activeDates(states, pron, spell);
    let repairs = [];
    try {
      const v = wx.getStorageSync(growth.REPAIR_KEY);
      if (Array.isArray(v)) repairs = v;
    } catch (e) { /* 读不到按无补签处理 */ }
    const st = growth.streakOf(dates, todayStr(), { repairs: repairs });
    const mastered = schedule.masteredCount(store.loadCards(), states);
    const quizRecs = quiz.recordsOf(readJSON(quiz.QUIZ_KEY, {}));
    return growth.pointsBreakdown({
      states: states, pron: pron, spell: spell,
      mastered: mastered, bestStreak: st.best, quizBonus: quiz.bonusOf(quizRecs)
    }).total;
  } catch (e) {
    return 0;
  }
}

/** 累计背单词数（分享战报用）：按"掌握"口径 —— 连续记住 21 天才算"背了"，
 *  过一遍就吹"背了 N 个"对初中生是虚假激励。 */
function totalWordsLocal() {
  try {
    return schedule.masteredCount(store.loadCards(), store.loadStates());
  } catch (e) { return 0; }
}

function readJSON(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? fallback : v;
  } catch (e) { return fallback; }
}
function writeJSON(key, val) {
  try { wx.setStorageSync(key, val); return true; } catch (e) { return false; }
}

/*------------------------- 资料缓存 -------------------------*/

function profile() {
  const p = readJSON(PROFILE_KEY, null);
  if (p && p.friendId && FRIEND_ID_RE.test(p.friendId)) return p;
  return null;
}

function saveProfileCache(p) {
  if (!p || !p.friendId) return;
  writeJSON(PROFILE_KEY, {
    friendId: p.friendId,
    nickname: p.nickname || '',
    avatarFileID: p.avatarFileID || '',
    updatedAt: Date.now()
  });
}

/**
 * 注册/更新资料。avatarFileID 必须已是 cloud:// 文件 ID
 * （上传由页面负责：button chooseAvatar 拿到临时路径 → wx.cloud.uploadFile）。
 */
function register(nickname, avatarFileID) {
  return call('registerProfile', {
    nickname: nickname,
    avatarFileID: avatarFileID || '',
    totalWords: totalWordsLocal()
  }).then(function (r) {
    if (r && r.ok && r.profile) saveProfileCache(r.profile);
    return r;
  });
}

/** 拉最新资料（顺带校验缓存没过期；云不可用时返回缓存，可能为 null）。 */
function refreshProfile() {
  return call('myProfile', { dayKey: todayStr() }).then(function (r) {
    if (r && r.ok && r.profile) {
      saveProfileCache(Object.assign({}, r.profile, { points: r.points, pointsWeek: r.pointsWeek }));
      return r;
    }
    return r && r.code === 'NO_PROFILE' ? r : r;
  });
}

/*------------------------- 积分同步 -------------------------*/

function readSync() {
  const s = readJSON(SYNC_KEY, null);
  if (s && typeof s.cum === 'number' && typeof s.day === 'string') return s;
  return { cum: 0, day: '' };
}

/**
 * 静默同步。返回 {ok, skipped?, pointsWeek?}。
 * 今天已同步过 → skipped（当天增量顺延，见模块顶部协议说明）。
 */
function syncNow() {
  if (!available()) return Promise.resolve({ ok: false, code: 'NO_CLOUD' });
  const today = todayStr();
  const st = readSync();
  if (st.day === today) return Promise.resolve({ ok: true, skipped: true });

  const delta = localTotal() - st.cum;
  if (delta <= 0) {
    // 没有增量也把"今天"标记掉：否则之后每天空转一次同步请求
    writeJSON(SYNC_KEY, { cum: st.cum, day: today });
    return Promise.resolve({ ok: true, skipped: true });
  }

  return call('syncPoints', { delta: delta, dayKey: today, totalWords: totalWordsLocal() })
    .then(function (r) {
      if (r && r.ok) writeJSON(SYNC_KEY, { cum: st.cum + delta, day: today });
      return r;
    });
}

/*------------------------- 好友操作 -------------------------*/

function addFriend(friendId) {
  return call('addFriend', { friendId: friendId });
}

function fetchFriends() {
  return call('listFriends', { dayKey: todayStr() });
}

function fetchLeaderboard() {
  return call('leaderboard', { scope: 'friends', dayKey: todayStr() });
}

function pkWith(friendId) {
  return call('pkWith', { friendId: friendId, dayKey: todayStr() });
}

function fetchQrCode(envVersion) {
  return call('qrCode', { envVersion: envVersion || 'release' });
}

/*------------------------- 工具 -------------------------*/

/**
 * 从分享 path 参数或二维码 scene 里提取 friendId。
 * scene 的来源有三种形状，都要兜住：
 *   'XJABC234'                    —— 我们自己生成的码（scene=friendId）
 *   'f%3DXJABC234' / 'f=XJABC234' —— 未来若改成键值对也不破
 *   'https://...XJABC234...'      —— 用户扫了别的东西，正则全文兜底
 * 返回 '' 表示没提取到（调用方给"识别失败"提示）。
 */
function extractFriendId(raw) {
  let s = String(raw == null ? '' : raw);
  try { s = decodeURIComponent(s); } catch (e) { /* 已是明文就用原样 */ }
  const m = s.match(/XJ[2-9A-HJ-NP-Z]{6}/);
  return m ? m[0] : '';
}

module.exports = {
  FN, FRIEND_ID_RE,
  available, call,
  profile, register, refreshProfile,
  localTotal, totalWordsLocal,
  syncNow,
  addFriend, fetchFriends, fetchLeaderboard, pkWith, fetchQrCode,
  extractFriendId,
  PROFILE_KEY, SYNC_KEY
};
