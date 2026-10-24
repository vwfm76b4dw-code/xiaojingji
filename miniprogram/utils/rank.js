/**
 * 排行榜客户端 —— 进步榜（本周 vs 上周）。**永不抛错**，失败即静默降级。
 *
 * ## 设计立场（重要，决定了下面每一个取舍）
 * 排行榜是本项目里**唯一会把数据传出设备的功能**。在它之前，整个应用是
 * "零后端、数据只存本机"。所以这里刻意做得很保守：
 *
 *   ① **默认关闭**。用户主动打开才上报（settings.rankOptIn）。不打开时
 *      这个模块只做一件事：什么都不做。
 *   ② **只传 5 个数 + 一个昵称**。不传姓名、不传学了哪些词、不传设备信息。
 *      昵称默认是匿名的「同学1234」，用户可改。
 *   ③ **随时可退出**，退出是真删（云函数的 leave 会 remove 记录），不是隐藏。
 *   ④ **失败完全静默**。云开发没开通、没网、集合不存在 —— 任何一种都只是
 *      "榜看不见"，绝不影响背单词主流程（这是项目一贯的降级契约）。
 *
 * ⚠️ 正式上线前还需：隐私协议、未成年人监护人同意、在《小程序用户隐私保护指引》
 *    里声明「昵称」与「学习统计数据」的收集。见任务台账，本轮只做测试版。
 *
 * ## 为什么榜排"进步"而不是"积分"
 * 见 cloudfunctions/rankProxy/index.js 顶部注释。一句话：几十人规模下，
 * 按绝对积分排名会让后进者从第一天就知道追不上，那是劝退而不是激励。
 */
const settings = require('./settings.js');
const store = require('./store.js');
const schedule = require('./schedule.js');
const growth = require('./growth.js');
const { todayStr } = require('./date.js');

const FN = 'rankProxy';
const NICK_KEY = 'rank_nick';

/** 调用云函数。超时兜底 —— 云函数冷启动约 3s，超过 8s 就别让用户等了。 */
function call(action, payload, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };

    const timer = setTimeout(function () {
      done({ ok: false, code: 'TIMEOUT' });
    }, timeoutMs || 8000);

    try {
      if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
        clearTimeout(timer);
        done({ ok: false, code: 'NO_CLOUD' });
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
          done({ ok: false, code: 'CALL_FAILED', msg: (err && err.errMsg) || '' });
        }
      });
    } catch (e) {
      // callFunction 会抛同步异常（云开发未初始化等），必须折算成结果对象
      clearTimeout(timer);
      done({ ok: false, code: 'THREW' });
    }
  });
}

/*------------------------- 开关与昵称 -------------------------*/

function isOn() {
  try { return !!settings.get('rankOptIn'); } catch (e) { return false; }
}

function setOn(v) {
  try { settings.save({ rankOptIn: !!v }); return true; } catch (e) { return false; }
}

/** 默认匿名昵称：同学 + 4 位数字。不取真名、不取微信号。 */
function defaultNick() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return '同学' + n;
}

function nick() {
  try {
    const v = wx.getStorageSync(NICK_KEY);
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 8);
  } catch (e) { /* 读不到就用默认 */ }
  return '';
}

function setNick(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  try { wx.setStorageSync(NICK_KEY, Array.from(s).slice(0, 8).join('')); return true; }
  catch (e) { return false; }
}

/*------------------------- 上报与查询 -------------------------*/

/**
 * 组装上报数据。**只在这里读本地数据**，调用方不用关心口径。
 *
 * 口径与看板页完全一致（同一个 growth 模块），避免"榜上的数字和看板对不上"
 * —— 那种不一致会让人怀疑数据是假的。
 */
function buildPayload() {
  const today = todayStr();
  const states = store.loadStates();
  const pron = store.loadPronRecords();
  const spell = store.loadSpellRecords();
  const dates = growth.activeDates(states, pron, spell);
  const repairs = loadRepairs();
  const st = growth.streakOf(dates, today, { repairs: repairs });
  const wk = growth.weeklyProgressOf(states, today);
  const mastered = schedule.masteredCount(store.loadCards(), states);

  return {
    nick: nick() || defaultNick(),
    progress: wk.progress,
    thisWeek: wk.thisWeek,
    streak: st.current,
    mastered: mastered
  };
}

function loadRepairs() {
  try {
    const v = wx.getStorageSync(growth.REPAIR_KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

/** 上报。返回 {ok, me?, code?}。**未开启开关时直接返回，不发请求。** */
function submit() {
  if (!isOn()) return Promise.resolve({ ok: false, code: 'OFF' });
  return call('submit', buildPayload(), 8000);
}

/** 拉榜单。返回 {ok, list, me, total}。 */
function fetchTop() {
  if (!isOn()) return Promise.resolve({ ok: false, code: 'OFF' });
  return call('top', {}, 8000);
}

/** 退出排行榜（云函数会真删记录） */
function leave() {
  return call('leave', {}, 8000);
}

/** 关掉开关并退出（设置页用：一步做完，避免"关了开关但记录还在"） */
function turnOff() {
  const self = this;
  return leave().then(function (r) {
    setOn(false);
    return r;
  });
}

module.exports = {
  FN, NICK_KEY,
  isOn, setOn, nick, setNick, defaultNick,
  buildPayload, submit, fetchTop, leave, turnOff
};
