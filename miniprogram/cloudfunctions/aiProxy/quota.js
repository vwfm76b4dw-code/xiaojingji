/**
 * 配额限流（aiProxy / asrProxy 共用同一份实现，见各自的说明注释）
 *
 * ## 为什么不放在 utils/ 下共享
 * 微信云函数**按目录独立打包上传**，aiProxy 的部署包里不会有 asrProxy 的文件。
 * 所以"共享"只能靠把同一份代码各放一份（或发 npm 包）。这里选前者：
 * 两份都是纯函数 + 零依赖，改一处记得改另一处（下方常量按场景分档）。
 *
 * ## 为什么是两层
 * 云函数实例**多副本并行且会被回收**：
 *   · 只用进程内计数 → 每个副本各算各的，限流形同虚设（换台手机就绕开）；
 *   · 只用数据库     → 每次调用多一次网络往返，且数据库一抖功能就挂。
 * 故两层并用，缺一不可：
 *   ① 进程内滑动窗口：零 IO、零依赖，挡"单人狂刷"与短时突发；
 *   ② 数据库计数：跨副本权威，挡"多副本分摊额度"，并统计全局用量守住 Key 余额。
 *
 * ## 为什么数据库层"失败放行"（fail-open）
 * 限流是**保护共享资源**的闸门，不是功能本身。数据库偶发不可用时若改拒绝，
 * 学生看到的是"AI 坏了"，而端上检索其实完全可用（阶段 1 必须始终可完整演示）。
 * 故 DB 出错 → 放行 + 打上下文日志，退回第①层的"单副本级"限流。
 *
 * ## 局限（如实记录，不要误以为它是严格配额系统）
 *   · 进程内层在实例回收后清零，冷启动密集时第①层可能被绕过；
 *   · 计数是"先读后写"，同一 openid 的**并发**请求可能少计 1~2 次 ——
 *     对"防刷爆"这个量级够用，不追求严格原子配额；
 *   · 拿不到 openid 时按 fail-open 放行（见调用方 getOpenId 的处理）。
 */

/*------------------------------ 可配参数 ------------------------------*/
const PREFIX = '[quota]';

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = parseInt(String(raw).trim(), 10);
  return isFinite(n) && n >= 0 ? n : dflt;
}

function envFlag(name) {
  return /^(1|true|on|yes)$/i.test(String(process.env[name] || '').trim());
}

/**
 * 每人每分钟突发上限：防"狂刷"，取正常连问十几题的量级。
 * 每人每天上限：正常学生一天远用不到，够用且挡住脚本。
 * 全局每天上限：真正守住 Key 余额的那道闸（多 openid 分摊也逃不掉）。
 *
 * ⚠️ 三个上限都是 **0 = 不限制**（不是"全禁"）。两层判据统一为 `limit > 0 才生效`。
 * ⚠️ 改这些值要**重新部署云函数**（环境变量不是热更新的）。
 */
const MINUTE_LIMIT_DEFAULT = 15;
const DAY_LIMIT_DEFAULT = 120;
const GLOBAL_DAY_LIMIT_DEFAULT = 3000;
const COLLECTION_DEFAULT = 'ai_quota';

const WINDOW_MINUTE_MS = 60 * 1000;

/*--------------------------- 进程内第①层 ---------------------------*/
/**
 * openid → 最近命中的时间戳数组（滑动窗口）。
 * 用 Object.create(null) 避免原型键污染（openid 由微信下发、不会撞 "__proto__"，
 * 但 Object 字面量被外部键污染是真实事故模式，养成习惯）。
 */
const _memHits = Object.create(null);
let _memKeys = 0;
/** 最多保留多少个 openid 的窗口，防止长期运行内存无界增长 */
const MEM_MAX_KEYS = 2000;
/** 一天的窗口长度（内存层只需要知道"多旧的记录可以扔"） */
const DAY_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function memPrune(now) {
  const keys = Object.keys(_memHits);
  for (let i = 0; i < keys.length; i++) {
    const arr = _memHits[keys[i]];
    const keep = arr.filter(function (t) { return t > now - DAY_LIMIT_WINDOW_MS; });
    if (keep.length === 0) {
      delete _memHits[keys[i]];
      _memKeys--;
    } else {
      _memHits[keys[i]] = keep;
    }
  }
}

/** 记一次命中并返回"本窗口内已用次数"（含本次） */
function memHit(openid, now) {
  if (!_memHits[openid]) {
    if (_memKeys >= MEM_MAX_KEYS) memPrune(now);
    _memHits[openid] = [];
    _memKeys++;
  }
  const arr = _memHits[openid];
  const cutMinute = now - WINDOW_MINUTE_MS;
  while (arr.length && arr[0] <= cutMinute) arr.shift();
  arr.push(now);
  return { minute: arr.length, day: arr.filter(function (t) { return t > now - DAY_LIMIT_WINDOW_MS; }).length };
}

/** 只读不记：给 status / 诊断用 */
function memPeek(openid, now) {
  const arr = _memHits[openid] || [];
  return {
    minute: arr.filter(function (t) { return t > now - WINDOW_MINUTE_MS; }).length,
    day: arr.filter(function (t) { return t > now - DAY_LIMIT_WINDOW_MS; }).length
  };
}

/*--------------------------- 数据库第②层 ---------------------------*/
/**
 * 云函数 SDK 是**懒加载**的，两个原因：
 *   ① 本地/离线跑门禁时根本没装 wx-server-sdk，顶层 require 会直接崩
 *      （verify-cloudfn.js / verify-ai.js 就是在裸 Node 里 require 本文件的）；
 *   ② 让"SDK 缺失"成为一条可判定的降级路径，而不是加载期异常。
 */
let _sdk = null;
let _sdkTried = false;

function getCloudSdk(tag) {
  if (_sdkTried) return _sdk;
  _sdkTried = true;
  try {
    _sdk = require('wx-server-sdk');
    if (typeof _sdk.init === 'function') _sdk.init({ env: _sdk.DYNAMIC_CURRENT_ENV });
  } catch (e) {
    const m = (e && (e.message || e.code)) || String(e);
    console.warn(PREFIX + ' ' + tag + ' wx-server-sdk 不可用（非云端环境属正常），配额退化为进程内层：' + m);
    _sdk = null;
  }
  return _sdk;
}

/**
 * 取调用方 openid。三种结果，**语义完全不同**，调用方必须分开处理：
 *   { ok:true, openid }        —— 正常，取到身份
 *   { ok:true, openid:null, sdk:false } —— 环境里没有 SDK（离线/门禁）→ 放行
 *   { ok:false }               —— SDK 在却拿不到 openid → 拒绝（这才是可疑调用）
 */
function readOpenId(tag) {
  const sdk = getCloudSdk(tag);
  if (!sdk || typeof sdk.getWXContext !== 'function') {
    return { ok: true, openid: null, sdk: false };
  }
  try {
    const ctx = sdk.getWXContext();
    const openid = ctx && ctx.OPENID;
    if (!openid) {
      return { ok: false, openid: null, sdk: true };
    }
    return { ok: true, openid: String(openid), sdk: true };
  } catch (e) {
    const m = (e && (e.message || e.code)) || String(e);
    console.warn(PREFIX + ' ' + tag + ' getWXContext 异常，无法确认调用方身份，按可疑调用拒绝：' + m);
    return { ok: false, openid: null, sdk: true };
  }
}

/** 日志里的 openid 只留头尾，避免整串进日志（openid 是用户标识，不该被复制传播） */
function maskOpenid(openid) {
  const s = String(openid || '');
  if (s.length <= 8) return s ? '***' : '';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

/** 本地日期键 YYYY-MM-DD。禁 toISOString()（见 CLAUDE.md 日期铁律），按本地时间拼 */
function dayKeyOf(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 限流判定 + 记账。**在真正发起模型请求之前调用**（先占位后干活）：
 * 若放在调用之后，并发请求会全部通过检查再一起烧额度。
 *
 * 返回 { allowed, code, msg, remain, degraded }：
 *   code = OK | NO_SDK | NO_OPENID | RATE_LIMITED | QUOTA_EXCEEDED
 *   degraded = 仅第②层（数据库）因异常 fail-open 时为 true。
 *   为什么要单独一个字段而不是靠 code 区分：fail-open 放行时 code 就是 'OK'
 *   （"调用成功"与"降级后放行"必须同码，否则页面会误以为限流生效了）。
 *   没有这个标记，降级只存在于 console.log 里 —— **无法被门禁断言**，
 *   也就无法证明"DB 抖动时 AI 仍然可用"这条契约没被改坏。
 */
async function guardQuota(tag, action, opts) {
  const cfg = {
    collection: process.env.QUOTA_COLLECTION || COLLECTION_DEFAULT,
    minuteLimit: envInt('QUOTA_MINUTE_LIMIT', MINUTE_LIMIT_DEFAULT),
    dayLimit: envInt('QUOTA_DAY_LIMIT', DAY_LIMIT_DEFAULT),
    globalDayLimit: envInt('QUOTA_GLOBAL_DAY_LIMIT', GLOBAL_DAY_LIMIT_DEFAULT),
    off: envFlag('QUOTA_OFF')
  };
  if (cfg.off) {
    console.warn(PREFIX + ' ' + tag + ' QUOTA_OFF=1，配额已全局关闭（仅排查时使用）');
    return { allowed: true, code: 'OK', msg: '', remain: null, degraded: false };
  }

  const now = Date.now();
  const who = readOpenId(tag);

  // 环境里没有 SDK → 不在云端，无法识别调用方，也就无从限流。放行。
  if (!who.sdk) {
    return { allowed: true, code: 'NO_SDK', msg: '', remain: null, degraded: false };
  }
  // SDK 在却拿不到 openid：这是"有人绕过正常小程序入口直接打云函数"的形态，拒绝。
  if (!who.ok || !who.openid) {
    console.warn(PREFIX + ' ' + tag + ' action=' + action + ' 拿不到 openid，拒绝调用（防绕过客户端直调）');
    return { allowed: false, code: 'NO_OPENID', msg: '拿不到用户标识，请退出小程序重新进入', remain: null };
  }

  const openid = who.openid;
  const dayKey = dayKeyOf(now);
  const logId = maskOpenid(openid);

  // ---- 第①层：进程内滑动窗口（先判，快且无 IO）----
  // 上限为 0 统一表示"该维度不限制"（与下面数据库层的 `> 0` 判据一致）。
  // 若不这么对齐，就会出现"日限 0 = 不限、分钟限 0 = 全禁"这种反直觉行为。
  const hit = memHit(openid, now);
  if (cfg.minuteLimit > 0 && hit.minute > cfg.minuteLimit) {
    console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' action=' + action
      + ' 分钟内 ' + hit.minute + '/' + cfg.minuteLimit + ' 次，触发突发限流');
    return {
      allowed: false, code: 'RATE_LIMITED',
      msg: '等一会儿再试吧，刚问得有点密', remain: null
    };
  }
  if (cfg.dayLimit > 0 && hit.day > cfg.dayLimit) {
    console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' action=' + action
      + ' 今日 ' + hit.day + '/' + cfg.dayLimit + ' 次，触发每日上限');
    return {
      allowed: false, code: 'QUOTA_EXCEEDED',
      msg: '今天的 AI 次数用完了，明天再来吧', remain: null
    };
  }

  // ---- 第②层：数据库（跨副本权威 + 全局闸）----
  const sdk = getCloudSdk(tag);
  if (!sdk) {
    // 读到这里说明 SDK 在 readOpenId 时存在过；理论上不会发生，仍兜住
    return { allowed: true, code: 'OK', msg: '', remain: null, degraded: true };
  }

  let db = null;
  try {
    db = sdk.database();
  } catch (e) {
    console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' 取数据库句柄失败，本层降级放行：'
      + ((e && (e.message || e.code)) || String(e)));
    return { allowed: true, code: 'OK', msg: '', remain: null, degraded: true };
  }

  const userDocId = openid + '|' + dayKey;
  const globalDocId = '__global__|' + dayKey;

  try {
    const col = db.collection(cfg.collection);

    const readDoc = async function (id) {
      try {
        const res = await col.doc(id).get();
        return (res && res.data) || null;
      } catch (e) {
        // 文档不存在是正常状态（今天第一次调用），不是错误
        const m = (e && (e.message || e.errMsg)) || String(e);
        if (/not exist|-502002|does not exist/i.test(m)) return null;
        throw e;
      }
    };

    const [userRow, globalRow] = [await readDoc(userDocId), await readDoc(globalDocId)];

    const gDay = Number(globalRow && globalRow.dayCount) || 0;
    if (cfg.globalDayLimit > 0 && gDay >= cfg.globalDayLimit) {
      console.warn(PREFIX + ' ' + tag + ' 全局日用量 ' + gDay + '/' + cfg.globalDayLimit
        + ' 已达上限，openid=' + logId + ' action=' + action + ' 一并拒绝（守住 Key 余额）');
      return {
        allowed: false, code: 'QUOTA_EXCEEDED',
        msg: 'AI 服务今天已达使用上限，明天再来吧', remain: null
      };
    }

    const uDay = Number(userRow && userRow.dayCount) || 0;
    if (cfg.dayLimit > 0 && uDay >= cfg.dayLimit) {
      console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' 云端记录今日 ' + uDay + '/' + cfg.dayLimit
        + ' 次已达上限（跨副本计数）');
      return {
        allowed: false, code: 'QUOTA_EXCEEDED',
        msg: '今天的 AI 次数用完了，明天再来吧', remain: null
      };
    }

    // 突发窗口也要在**云端**判，不能只在内存里判。
    // 内存层是 per-instance 的：脚本只要把请求摊到多个实例（或等实例回收重启），
    // 就能把每台的分钟计数都压在阈值以下 —— 云端窗口是唯一跨副本的闸。
    const prevWinStart = Number(userRow && userRow.winStart) || 0;
    const winAlive = (now - prevWinStart) < WINDOW_MINUTE_MS;
    const uWin = winAlive ? (Number(userRow && userRow.winCount) || 0) : 0;
    if (cfg.minuteLimit > 0 && uWin >= cfg.minuteLimit) {
      console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' action=' + action
        + ' 云端窗口 ' + uWin + '/' + cfg.minuteLimit + ' 次已达上限（跨副本突发限流）');
      return {
        allowed: false, code: 'RATE_LIMITED',
        msg: '等一会儿再试吧，刚问得有点密', remain: null
      };
    }

    // 记账：先读后写（同一 openid 并发可能少计 1~2 次，见文件头"局限"）
    const winCount = winAlive ? uWin + 1 : 1;

    await col.doc(userDocId).set({
      data: {
        openid: openid,
        dayKey: dayKey,
        dayCount: uDay + 1,
        winStart: winAlive ? prevWinStart : now,
        winCount: winCount,
        updatedAt: now
      }
    });
    await col.doc(globalDocId).set({
      data: {
        dayKey: dayKey,
        dayCount: gDay + 1,
        updatedAt: now
      }
    });

    const remain = Math.max(0, cfg.dayLimit - (uDay + 1));
    console.log(PREFIX + ' ' + tag + ' openid=' + logId + ' action=' + action
      + ' 今日 ' + (uDay + 1) + '/' + cfg.dayLimit + '，全局 ' + (gDay + 1) + '/' + cfg.globalDayLimit);
    return { allowed: true, code: 'OK', msg: '', remain: remain, degraded: false };

  } catch (e) {
    // fail-open：数据库这一层只保护共享额度，不该因为它抖动就让学生的 AI 全废
    console.warn(PREFIX + ' ' + tag + ' openid=' + logId + ' action=' + action
      + ' 数据库层异常，本层放行（仅剩进程内限流）：'
      + ((e && (e.message || e.code)) || String(e)));
    return { allowed: true, code: 'OK', msg: '', remain: null, degraded: true };
  }
}

module.exports = {
  guardQuota,
  readOpenId,
  maskOpenid,
  dayKeyOf,
  memHit,
  memPeek,
  envInt,
  envFlag,
  MEM_MAX_KEYS,
  MINUTE_LIMIT_DEFAULT,
  DAY_LIMIT_DEFAULT,
  GLOBAL_DAY_LIMIT_DEFAULT
};
