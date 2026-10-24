/**
 * 排行榜云函数（进步榜）。
 *
 * ## 为什么是"进步榜"而不是"积分榜"
 * 本项目面向的是**几十到几百个学生**（老师/家长推广），这个规模下按绝对积分排名
 * 是**负向机制**：头部（每天 30 分钟）和底部（每天 5 分钟）的差距是 5~10 倍且基本固定，
 * 后进者从第一天就知道追不上，榜只会强化"我不行"。
 *
 * 所以这里排的是**本周相对上周的进步幅度**（多练了多少张卡）：
 *   · 后进者的提升空间最大，最容易第一 —— 比的是努力，不是天赋；
 *   · 新用户的 lastWeek 天然是 0，任何学习都是正进步，刚来的人也有机会站到前面。
 *
 * ## 只返回前 3 名 + 自己
 * 不返回完整名单。小规模熟人场景下，完整名单等于把后进者"公开处刑"，
 * 伤害远大于激励。前端拿到的就是这几条，拿不到别人的明细。
 *
 * ## 不设降级/淘汰
 * Duolingo 的降级是百万级产品维持 DAU 的手段；在几十人规模下，
 * 降级对初中生是纯打击，没有任何正向作用。所以本函数**没有降级逻辑**，
 * 这是刻意的，不是没做。
 *
 * ## 隐私（当前为测试版的最小实现）
 * 只存 6 个字段，全部由用户主动提交，且**默认关闭**（前端 opt-in 才会上报）：
 *   _id(openid) / nick / progress / thisWeek / streak / mastered / updatedAt
 * 不存姓名、手机号、设备信息、学习内容明细。openid 仅作去重键，
 * **不返回给任何客户端**（返回的列表里剔除了 _id）。
 * `leave` 动作会彻底删除自己的记录。
 * ⚠️ 正式上线前的隐私合规（隐私协议、未成年人监护人同意）尚未处理 —— 见任务台账。
 *
 * ## 环境变量
 *   LB_COLLECTION   集合名，默认 lb_weekly
 *
 * 部署：开发者工具右键本目录 → 上传并部署（云端安装依赖）
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = process.env.LB_COLLECTION || 'lb_weekly';

/** 昵称长度上限（中文 8 字 ≈ 屏幕一行放得下） */
const NICK_MAX = 8;
/** 榜单展示人数（前 3 + 自己） */
const TOP_N = 3;

/** 数值护栏：客户端可以伪造，但至少要挡住"999999 分"这种明显异常 */
const LIMITS = {
  progress: [-100000, 100000],
  thisWeek: [0, 100000],
  streak: [0, 36500],
  mastered: [0, 100000]
};

function clampNum(v, range) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(range[0], Math.min(range[1], Math.floor(n)));
}

/**
 * 昵称净化。
 * 只做"能安全展示"级别的处理：去控制字符、去零宽字符、压空白、截断。
 * **不做**敏感词过滤（那需要词库与合规流程，属于正式上线前的事）。
 */
function cleanNick(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 按码点截断，避免把一个 emoji/汉字劈成半个
  const arr = Array.from(s);
  return arr.slice(0, NICK_MAX).join('');
}

/** 集合不存在时自动建。并发下会重复建，报"已存在"要忽略而不是抛。 */
async function ensureCollection() {
  try {
    await db.createCollection(COLLECTION);
  } catch (e) {
    // -501001 / ResourceUnavailable / 已存在 —— 都属于"已经好了"，继续走
    const msg = String((e && (e.errMsg || e.message)) || '');
    if (!/exist|Exist|已存在|-501001/.test(msg)) {
      // 其它错误也不阻断：读操作在集合存在时会正常工作
      console.warn('[rankProxy] createCollection:', msg);
    }
  }
}

/** 去掉不该出现在响应里的字段（openid 绝不外传） */
function publicRow(doc) {
  return {
    nick: doc.nick || '同学',
    progress: Number(doc.progress) || 0,
    thisWeek: Number(doc.thisWeek) || 0,
    streak: Number(doc.streak) || 0,
    mastered: Number(doc.mastered) || 0
  };
}

/** 排序口径：先看进步，再看本周量，最后看谁更早更新（先到先得，鼓励早点练） */
function sortRows(rows) {
  return rows.slice().sort(function (a, b) {
    if (b.progress !== a.progress) return b.progress - a.progress;
    if (b.thisWeek !== a.thisWeek) return b.thisWeek - a.thisWeek;
    return (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

exports.main = async function (event) {
  const wx = cloud.getWXContext();
  const openid = wx && wx.OPENID;
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', msg: '拿不到用户标识，请重进小程序' };
  }

  const action = String((event && event.action) || '');

  try {
    if (action === 'submit') return await doSubmit(openid, event || {});
    if (action === 'top') return await doTop(openid);
    if (action === 'leave') return await doLeave(openid);
    return { ok: false, code: 'BAD_ACTION', msg: '未知操作：' + action };
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    console.error('[rankProxy] action=' + action, msg);
    return { ok: false, code: 'FAILED', msg: '排行榜暂时用不了', detail: msg.slice(0, 300) };
  }
};

/** 上报本周数据（upsert） */
async function doSubmit(openid, event) {
  const nick = cleanNick(event.nick);
  if (!nick) {
    return { ok: false, code: 'NO_NICK', msg: '请先起个名字（1~8 个字）' };
  }

  const row = {
    nick: nick,
    progress: clampNum(event.progress, LIMITS.progress),
    thisWeek: clampNum(event.thisWeek, LIMITS.thisWeek),
    streak: clampNum(event.streak, LIMITS.streak),
    mastered: clampNum(event.mastered, LIMITS.mastered),
    updatedAt: Date.now()
  };

  await ensureCollection();

  // 用 openid 当 _id：天然去重，且客户端无法指定别人的 id
  try {
    await db.collection(COLLECTION).doc(openid).set({ data: row });
  } catch (e) {
    return { ok: false, code: 'WRITE_FAILED', msg: '上报失败，稍后再试' };
  }

  // 顺手把自己现在的名次算出来，省一次往返
  const rank = await rankOf(openid);
  return { ok: true, me: Object.assign({}, publicRow(row), { rank: rank.rank, total: rank.total }) };
}

/** 前 3 + 自己 */
async function doTop(openid) {
  await ensureCollection();

  let rows = [];
  try {
    const res = await db.collection(COLLECTION).limit(500).get();
    rows = (res && res.data) || [];
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || '');
    // 集合还不存在 = 还没有人上榜，是空榜而不是错误
    if (/not exist|不存在|-502005/.test(msg)) rows = [];
    else throw e;
  }

  const sorted = sortRows(rows);
  const list = sorted.slice(0, TOP_N).map(function (r, i) {
    return Object.assign({ rank: i + 1 }, publicRow(r));
  });

  const mineIdx = sorted.findIndex(function (r) { return r._id === openid; });
  const me = mineIdx >= 0
    ? Object.assign({ rank: mineIdx + 1 }, publicRow(sorted[mineIdx]))
    : null;

  return {
    ok: true,
    list: list,
    me: me,
    total: sorted.length,
    topN: TOP_N
  };
}

/** 只算自己的名次（submit 后用） */
async function rankOf(openid) {
  try {
    const res = await db.collection(COLLECTION).limit(500).get();
    const sorted = sortRows((res && res.data) || []);
    const idx = sorted.findIndex(function (r) { return r._id === openid; });
    return { rank: idx >= 0 ? idx + 1 : 0, total: sorted.length };
  } catch (e) {
    return { rank: 0, total: 0 };
  }
}

/** 退出排行榜：彻底删除自己的记录（隐私承诺要能兑现，不能只是"隐藏"） */
async function doLeave(openid) {
  await ensureCollection();
  try {
    await db.collection(COLLECTION).doc(openid).remove();
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || '');
    // 本来就没有记录 → 目的已达成
    if (!/not exist|不存在|-502002|document.*not exist/i.test(msg)) {
      return { ok: false, code: 'DELETE_FAILED', msg: '退出失败，稍后再试' };
    }
  }
  return { ok: true };
}
