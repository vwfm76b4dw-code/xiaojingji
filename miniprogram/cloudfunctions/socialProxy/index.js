/**
 * 社交云函数 —— 好友 / PK / 积分同步 / 电子宠物 / 好友码。
 *
 * ## 为什么是独立函数而不是扩展 rankProxy
 * rankProxy 的集合（lb_weekly）与"进步榜"口径被三道门禁钉住，且它承诺
 * "只返回前 3 + 自己、openid 绝不外传"。好友关系是另一套数据形状
 * （双向边、按 friendId 寻址、扣费写操作），塞进去等于同时动两份已验证的契约。
 * 独立函数还能独立部署/回滚，互不拖累。
 *
 * ## 身份模型（隐私硬要求）
 * openid 只从 cloud.getWXContext() 取，**任何 action 的返回值都不含 openid**；
 * 对外唯一标识是 friendId（XJ + 6 位去混淆 base32）。客户端伪造不了别人的
 * friendId 对应的 openid —— 所有写操作都以 context 里的 openid 为准。
 *
 * ## 积分账本（防作弊的核心设计）
 * 本地积分（growth.pointsBreakdown）是**可推导值**，客户端只能上报"增量"：
 *   points_daily 文档 _id = openid + '|' + dayKey，**同一 dayKey 只允许写一次**。
 * 为什么这么严：如果把"重复写同一 dayKey"当幂等成功，攻击者可以反复上报
 * 同一天的 delta 刷分；如果允许负 delta 或覆盖写，就能把历史回滚。
 * 所以：delta 必须 > 0 且 ≤ 上限；重复 dayKey 明确拒绝（ALREADY_SYNCED）；
 * 服务端累计值只增不减（单调）。诚实的客户端一天最多同步一次，
 * 当天晚些的增量顺延到下一次同步，总分不丢（见 utils/friend.js 的注释）。
 *
 * ## 宠物扣费在服务端
 * 前端只展示，feedPet 里检查余额并 _.inc(-cost)。为什么不用前端扣：
 * 本地存储是可改的，扣费必须发生在攻击者改不到的地方。
 * 代价是"读-判-写"之间存在极小的并发窗口（同一账号两个设备同时喂），
 * 在"几十个学生、单设备"的真实规模下可接受，不值得为它引入事务复杂度。
 *
 * ## 好友码（wxacode.getUnlimited）
 * scene = friendId（8 字符，远小于 32 上限），page 指向 pack-social 好友页。
 * **未发布版该 API 必失败** —— 返回 QR_UNAVAILABLE，前端 fallback 到转发卡片。
 * 生成后把 buffer 传到云存储，返回 fileID：为什么不直接回 base64 ——
 * image 组件对 data URL 的支持在部分基础库上有体积与表现差异，fileID 是官方路。
 *
 * ## 集合
 *   users        _id=openid  {friendId, nickname, avatarFileID, totalWords, pointsTotal, ...}
 *   friend_edges _id=a|b（字典序）{a, b, createdAt} —— 双向边用一条文档表达
 *   points_daily _id=openid|dayKey {openid, dayKey, delta, createdAt}
 *   pets         _id=openid  {stage, xp, hatchedAt, fedAt, updatedAt}
 * 首次调用 ensureCollection 自动建集合，"已存在"错误码必须容忍。
 *
 * ## 环境变量（均可选）
 *   SOCIAL_USERS / SOCIAL_EDGES / SOCIAL_POINTS / SOCIAL_PETS   集合名
 *
 * 部署：开发者工具右键本目录 → 上传并部署（云端安装依赖）。
 * openapi 权限：config.json 声明 wxacode.getUnlimited，缺失时二维码动作报错。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COL_USERS = process.env.SOCIAL_USERS || 'users';
const COL_EDGES = process.env.SOCIAL_EDGES || 'friend_edges';
const COL_POINTS = process.env.SOCIAL_POINTS || 'points_daily';
const COL_PETS = process.env.SOCIAL_PETS || 'pets';

/*----------------------------- 常量 -----------------------------*/

/** friendId 字母表：base32 般的 32 字符，去掉易混淆的 0/1/I/O。
 *  32^6 ≈ 10.7 亿，几十人规模碰撞概率可忽略（仍带重试）。 */
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const FRIEND_ID_RE = /^XJ[2-9A-HJ-NP-Z]{6}$/;

const HATCH_COST = 0;      // 孵化免费——蛋是免费送的（新用户第一天使然拿不到 200 分，那等于永远用不了鲸鱼；改 0 才有「首页就有鲸鱼」的意义）
const FEED_COST = 50;     // 每次喂食价格（养成维度仍走服务端扣减）
/** 形态阈值（喂食次数）。四态：egg → hatchling → juvenile → adult。
 *  为什么是 5 / 10：孵化 200 + 喂满 500 = 700 积分的完整养成周期，
 *  按 growth.pointsBreakdown 的分值（复习 +4 / 拼写 +3 / 朗读 +5），
 *  一个每天练 10~15 个词的活跃学生日入 60~90 分，养满约 8~10 天 ——
 *  足够长到让形态有"养成感"，又不至于让孩子两三周看不到升级。
 *  中间加 juvenile 一档（Agent F 的三段素材本就是 hatchling/juvenile/adult）：
 *  只有两态的宠物"从蛋直接变大人"，中间没有盼头。 */
const JUVENILE_AT = 5;    // 喂满 5 次出少年形态（学会喷水）
const ADULT_AT = 10;      // 喂满 10 次成完全体（皇冠）
/** 单次 syncPoints 写入的 delta 上限。
 *  为什么不是"每日封顶"：账本槽位是 (openid, dayKey) 一天一条，客户端协议
 *  是"一天最多同步一次、断签后的存量顺延到下次一起发"（utils/friend.js），
 *  所以同一次写入合法地可能覆盖多天 —— 这里的上限必须是"多天存量"而不是单日。
 *  取值推导：单日理论极限 ≈ 500 分（复习 50 词 ×4 + 拼写 50 词 ×3 + 朗读 30 词 ×5，
 *  是每天 3 小时高强度才够到的量，见 growth.pointsBreakdown 的分值注释）；
 *  ×7 天（周榜窗口宽度，超出 7 天没同步的存量本就不该一次涌入）= 3500。
 *  周榜的公平性不靠这个数：一周最多 7 个槽位，天天同步和攒一周一次同步，
 *  周总分天然一样 —— 封顶防的是"一次伪造几十万分"这种明显异常，
 *  不是替孩子决定每天练多少（那是 rankProxy 进步榜的事，口径不同）。 */
const MAX_DAY_DELTA = 3500;
const NICK_MAX = 12;      // 比进步榜的 8 字宽：这是本人选的展示名，不是匿名昵称

/** 周窗口：滚动 7 天而不是自然周。
 *  为什么不做周一结算：自然周在周一零点清零，孩子周日攒的分周一"消失"，
 *  是纯负反馈；滚动窗口的分数每天才过期一天，感知上公平得多。 */
const WEEK_DAYS = 7;

/*----------------------------- 工具 -----------------------------*/

function fail(code, msg, extra) {
  return Object.assign({ ok: false, code: code, msg: msg || '' }, extra || {});
}
function ok(data) {
  return Object.assign({ ok: true }, data || {});
}

/** 日期串校验：格式 + 真实存在（挡 2026-02-30 这类静默进位）。 */
function isValidDayKey(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const p = String(s).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

/** dayKey - n 天。dayKey 是纯日期串，用 Date 算差即可（不做任何时区换算 —— 它是标签不是时刻）。 */
function dayKeyMinus(dayKey, n) {
  const p = dayKey.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() - n);
  const pad = function (x) { return x < 10 ? '0' + x : '' + x; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function cleanNick(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NICK_MAX).join('');
}

function genFriendId() {
  let s = 'XJ';
  for (let i = 0; i < 6; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}

/** 文档不存在判定。云开发的"不存在"错误码有多个形状，全部按不存在处理。 */
function isNotExistErr(e) {
  const msg = String((e && (e.errMsg || e.message)) || e);
  return /not exist|不存在|-50200[0-9]|DOCUMENT_NOT_FOUND|DOC_NOT_FOUND/i.test(msg);
}

/** 集合不存在时自动建。并发下会重复建，报"已存在"要忽略而不是抛。 */
async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || '');
    if (!/exist|Exist|已存在|-501001/.test(msg)) {
      console.warn('[socialProxy] createCollection ' + name + ':', msg);
    }
  }
}

async function ensureAll() {
  await ensureCollection(COL_USERS);
  await ensureCollection(COL_EDGES);
  await ensureCollection(COL_POINTS);
  await ensureCollection(COL_PETS);
}

/*----------------------------- 数据访问 -----------------------------*/

async function getUser(openid) {
  try {
    const res = await db.collection(COL_USERS).doc(openid).get();
    return (res && res.data) || null;
  } catch (e) {
    if (isNotExistErr(e)) return null;
    throw e;
  }
}

/** friendId 查用户（加好友的寻址入口）。返回 {openid, ...doc} 或 null。 */
async function findByFriendId(friendId) {
  const res = await db.collection(COL_USERS).where({ friendId: friendId }).limit(2).get();
  const doc = (res && res.data && res.data[0]) || null;
  if (!doc) return null;
  return Object.assign({ openid: doc._id }, doc);
}

/** 周（滚动 7 天）积分：按 openid 拉该用户的逐日记录再窗口求和。
 *  为什么不用聚合管道：几十人规模、每列 ≤7 条，拉回来 JS 求和比维护管道
 *  mock/调试成本低得多；优化留给规模真的上来那天。 */
async function weekPointsOf(openid, todayKey) {
  const start = dayKeyMinus(todayKey, WEEK_DAYS - 1);
  let rows = [];
  try {
    const res = await db.collection(COL_POINTS).where({ openid: openid }).limit(100).get();
    rows = (res && res.data) || [];
  } catch (e) {
    if (!isNotExistErr(e)) throw e;
  }
  let sum = 0;
  rows.forEach(function (r) {
    if (r && r.dayKey >= start && r.dayKey <= todayKey) sum += Number(r.delta) || 0;
  });
  return sum;
}

/** 朋友 openid 列表（双向边各查一半再合并 —— 避免 _.or 的 mock/调试成本）。 */
async function friendOpenids(openid) {
  const out = [];
  const seen = Object.create(null);
  async function half(field) {
    let rows = [];
    try {
      const res = await db.collection(COL_EDGES).where(field).limit(500).get();
      rows = (res && res.data) || [];
    } catch (e) {
      if (!isNotExistErr(e)) throw e;
    }
    rows.forEach(function (r) {
      const other = r.a === openid ? r.b : r.a;
      if (other && other !== openid && !seen[other]) { seen[other] = true; out.push(other); }
    });
  }
  await half({ a: openid });
  await half({ b: openid });
  return out;
}

/** 对外可见的用户行（绝不带 openid —— 见顶部身份模型）。 */
function publicUser(doc) {
  return {
    friendId: doc.friendId || '',
    nickname: doc.nickname || '同学',
    avatarFileID: doc.avatarFileID || '',
    totalWords: Number(doc.totalWords) || 0,
    pointsTotal: Number(doc.pointsTotal) || 0
  };
}

/**
 * 给行数据补 avatarUrl（云存储临时直链）。
 * ## 为什么必须云函数侧换链
 * 头像由客户端 wx.cloud.uploadFile 上传，云存储默认权限是「仅创建者可读写」：
 * 好友的客户端拿别人的 fileID 渲染 <image> 会加载失败——这就是「好友看不到
 * 我头像」的根因。云函数持管理员凭证调 getTempFileURL，不受该 ACL 约束。
 * 临时直链有有效期（约 2 小时），但列表每次进页都重拉，新鲜度天然够用。
 * ## 为什么不是另外两种做法
 * - 把存储权限改成「所有用户可读」：一次配置全局放宽，头像在儿童产品里
 *   不该对全量用户可读，且配置活在控制台、代码库外，易漂移难回滚；
 * - 客户端逐个 downloadFile/fileID：同样被该 ACL 挡着，读不到就是读不到。
 * 任何失败整体吞掉、原样返回：头像丢了列表不能跟着挂（装饰不劫持主数据）。
 */
async function attachAvatarUrls(rows) {
  const ids = [];
  const seen = Object.create(null);
  rows.forEach(function (r) {
    const f = r && r.avatarFileID;
    if (f && f.indexOf('cloud://') === 0 && !seen[f]) { seen[f] = true; ids.push(f); }
  });
  if (!ids.length || typeof cloud.getTempFileURL !== 'function') return rows;
  try {
    // 单次 getTempFileURL 上限 50 个 fileID；周榜是好友小圈子（几十人）量级，远够
    const res = await cloud.getTempFileURL({ fileList: ids.slice(0, 50) });
    const map = Object.create(null);
    ((res && res.fileList) || []).forEach(function (f) {
      if (f && f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
    });
    rows.forEach(function (r) {
      if (r && r.avatarFileID && map[r.avatarFileID]) r.avatarUrl = map[r.avatarFileID];
    });
  } catch (e) {
    console.warn('[socialProxy] getTempFileURL:', String((e && (e.errMsg || e.message)) || e).slice(0, 120));
  }
  return rows;
}

/*----------------------------- actions -----------------------------*/

/**
 * 注册/更新资料。已注册则原 friendId 不变（friendId 是稳定标识，变了等于换人）。
 * totalWords 由客户端顺带上报（累计背词数只有客户端算得出），只增不减 —— 防回滚。
 */
async function doRegisterProfile(openid, event) {
  const nick = cleanNick(event.nickname);
  if (!nick) return fail('NO_NICK', '先给自己起个名字（1~12 个字）');
  const avatar = typeof event.avatarFileID === 'string' && event.avatarFileID.indexOf('cloud://') === 0
    ? event.avatarFileID : '';

  await ensureAll();

  const existing = await getUser(openid);
  if (existing) {
    const patch = { nickname: nick, updatedAt: Date.now() };
    if (avatar) patch.avatarFileID = avatar;
    if (Number.isFinite(Number(event.totalWords))) {
      const tw = Math.max(0, Math.floor(Number(event.totalWords)));
      // 只增不减：删卡导致的本地回退不应抹掉云端的历史最好成绩
      if (tw > (Number(existing.totalWords) || 0)) patch.totalWords = tw;
    }
    try {
      await db.collection(COL_USERS).doc(openid).update({ data: patch });
    } catch (e) { return fail('WRITE_FAILED', '保存失败，稍后再试'); }
    const fresh = await getUser(openid);
    return ok({ friendId: fresh.friendId, profile: publicUser(fresh) });
  }

  // 新用户：生成不撞车的 friendId（先查后用；规模小，碰撞重试 5 次足够）
  let friendId = '';
  for (let i = 0; i < 5; i++) {
    const cand = genFriendId();
    const hit = await findByFriendId(cand);
    if (!hit) { friendId = cand; break; }
  }
  if (!friendId) return fail('ID_GEN_FAILED', '好友 ID 生成失败，请重试');

  const row = {
    friendId: friendId,
    nickname: nick,
    avatarFileID: avatar,
    totalWords: Math.max(0, Math.floor(Number(event.totalWords) || 0)),
    pointsTotal: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  try {
    await db.collection(COL_USERS).doc(openid).set({ data: row });
  } catch (e) { return fail('WRITE_FAILED', '注册失败，稍后再试'); }
  return ok({ friendId: friendId, profile: publicUser(row) });
}

/** 我的资料 + 当前余额 + 周积分。 */
async function doMyProfile(openid, event) {
  await ensureAll();
  const me = await getUser(openid);
  if (!me) return fail('NO_PROFILE', '还没注册资料');
  const dayKey = isValidDayKey(event.dayKey) ? event.dayKey : todayInUtc8();
  // 名片头像也换临时直链：自己的 fileID 本来就能读（创建者），avatarUrl 只是
  // 让前端「fileID 挂了自动下落」的兜底链在名片上同样成立，成本一次批量换链。
  const withUrl = await attachAvatarUrls([publicUser(me)]);
  return ok({
    profile: withUrl[0],
    points: Number(me.pointsTotal) || 0,
    pointsWeek: await weekPointsOf(openid, dayKey)
  });
}

/** 服务器侧"今天"（北京时间）。只用于客户端没传 dayKey 时的兜底。 */
function todayInUtc8() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = function (x) { return x < 10 ? '0' + x : '' + x; };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** 加好友：幂等；不可加自己；目标必须已注册。 */
async function doAddFriend(openid, event) {
  const fid = String(event.friendId || '').trim().toUpperCase();
  if (!FRIEND_ID_RE.test(fid)) return fail('BAD_FRIEND_ID', '好友 ID 是 XJ 开头的 8 位字符');
  await ensureAll();

  const target = await findByFriendId(fid);
  if (!target) return fail('NOT_FOUND', '没找到这个好友 ID，检查一下有没有抄错');
  if (target.openid === openid) return fail('CANT_ADD_SELF', '这是你自己的 ID');

  const a = openid < target.openid ? openid : target.openid;
  const b = openid < target.openid ? target.openid : openid;
  // _id = 有序对：同一条好友关系在库里只有一份，重复添加天然幂等
  try {
    await db.collection(COL_EDGES).doc(a + '|' + b).set({
      data: { a: a, b: b, createdAt: Date.now() }
    });
  } catch (e) { return fail('WRITE_FAILED', '添加失败，稍后再试'); }

  return ok({ profile: publicUser(target) });
}

/** 好友列表（含积分）。供调试与后续页面用；好友页主视图走 leaderboard。 */
async function doListFriends(openid, event) {
  await ensureAll();
  const dayKey = isValidDayKey(event.dayKey) ? event.dayKey : todayInUtc8();
  const ids = await friendOpenids(openid);

  const list = [];
  for (let i = 0; i < ids.length; i++) {
    const doc = await getUser(ids[i]);
    if (!doc) continue;                 // 用户可能已清库，边还挂着 —— 跳过而不是报错
    const row = publicUser(doc);
    row.avatar = row.avatarFileID;      // 契约字段名：avatar
    row.pointsWeek = await weekPointsOf(ids[i], dayKey);
    list.push(row);
  }
  await attachAvatarUrls(list);         // 原地补 avatarUrl，失败不改变 list
  return ok({ list: list, dayKey: dayKey });
}

/** 积分同步：见顶部"积分账本"。重复 dayKey 明确拒绝是特性不是缺陷。 */
async function doSyncPoints(openid, event) {
  const dayKey = String(event.dayKey || '');
  if (!isValidDayKey(dayKey)) return fail('BAD_DAYKEY', '日期格式应为 YYYY-MM-DD');
  const delta = Math.floor(Number(event.delta));
  if (!Number.isFinite(delta) || delta <= 0) return fail('BAD_DELTA', '增量必须是正数');
  if (delta > MAX_DAY_DELTA) return fail('DELTA_TOO_LARGE', '单日增量超出上限');
  await ensureAll();

  const docId = openid + '|' + dayKey;
  try {
    const existed = await db.collection(COL_POINTS).doc(docId).get();
    if (existed && existed.data) return fail('ALREADY_SYNCED', '今天已经同步过了，明天的练习会一起算上');
  } catch (e) {
    if (!isNotExistErr(e)) return fail('READ_FAILED', '同步失败，稍后再试');
  }

  try {
    await db.collection(COL_POINTS).doc(docId).set({
      data: { openid: openid, dayKey: dayKey, delta: delta, createdAt: Date.now() }
    });
  } catch (e) { return fail('WRITE_FAILED', '同步失败，稍后再试'); }

  // 累计余额原子自增；totalWords 只增不减（与 registerProfile 同一纪律）
  const patch = { pointsTotal: _.inc(delta), updatedAt: Date.now() };
  if (Number.isFinite(Number(event.totalWords))) {
    const me = await getUser(openid);
    const tw = Math.max(0, Math.floor(Number(event.totalWords)));
    if (me && tw > (Number(me.totalWords) || 0)) patch.totalWords = tw;
  }
  try {
    await db.collection(COL_USERS).doc(openid).update({ data: patch });
  } catch (e) {
    // 用户还没注册资料：增量先落 points_daily，资料注册后余额由后续同步补齐。
    // 不在这里自动建 users —— 资料必须由本人显式提交（昵称是收集行为，不能默默创建）。
  }

  const me = await getUser(openid);
  return ok({
    pointsWeek: await weekPointsOf(openid, dayKey),
    points: Number((me && me.pointsTotal) || 0)
  });
}

/** 好友排行榜：好友 + 我，按周积分排（周相同看累计）。 */
async function doLeaderboard(openid, event) {
  await ensureAll();
  const dayKey = isValidDayKey(event.dayKey) ? event.dayKey : todayInUtc8();
  const ids = await friendOpenids(openid);

  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const doc = await getUser(ids[i]);
    if (!doc) continue;
    const row = publicUser(doc);
    row.pointsWeek = await weekPointsOf(ids[i], dayKey);
    rows.push(row);
  }
  // 我也进榜 —— 排行榜没有"我"就没有比较的意义
  const me = await getUser(openid);
  if (me) {
    const mine = publicUser(me);
    mine.isMe = true;
    mine.pointsWeek = await weekPointsOf(openid, dayKey);
    rows.push(mine);
  }

  rows.sort(function (x, y) {
    if (y.pointsWeek !== x.pointsWeek) return y.pointsWeek - x.pointsWeek;
    if (y.pointsTotal !== x.pointsTotal) return y.pointsTotal - x.pointsTotal;
    return String(x.friendId).localeCompare(String(y.friendId));
  });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  await attachAvatarUrls(rows);         // 原地补 avatarUrl，失败不改变 rows
  return ok({ list: rows, dayKey: dayKey });
}

/** PK：本周积分对比。平局 win 为 null —— 硬说"你赢了"是撒谎。 */
async function doPkWith(openid, event) {
  const fid = String(event.friendId || '').trim().toUpperCase();
  if (!FRIEND_ID_RE.test(fid)) return fail('BAD_FRIEND_ID', '好友 ID 格式不对');
  await ensureAll();

  const target = await findByFriendId(fid);
  if (!target) return fail('NOT_FOUND', '没找到这个好友');
  if (target.openid === openid) return fail('CANT_ADD_SELF', '不能和自己 PK');

  const dayKey = isValidDayKey(event.dayKey) ? event.dayKey : todayInUtc8();
  const myWeek = await weekPointsOf(openid, dayKey);
  const peerWeek = await weekPointsOf(target.openid, dayKey);

  const me = await getUser(openid);
  return ok({
    me: { pointsWeek: myWeek, pointsTotal: Number((me && me.pointsTotal) || 0) },
    peer: { pointsWeek: peerWeek, pointsTotal: Number(target.pointsTotal) || 0, nickname: target.nickname || '同学' },
    win: myWeek > peerWeek ? true : (myWeek < peerWeek ? false : null)
  });
}

/** 宠物状态。没有记录 = 一枚蛋（"还没开始养"也是一种状态，不该报错）。 */
async function doGetPet(openid) {
  await ensureAll();
  let pet = null;
  try {
    const res = await db.collection(COL_PETS).doc(openid).get();
    pet = (res && res.data) || null;
  } catch (e) {
    if (!isNotExistErr(e)) return fail('READ_FAILED', '宠物状态读不到，稍后再试');
  }
  if (!pet) {
    pet = { stage: 'egg', xp: 0, hatchedAt: 0, fedAt: 0, updatedAt: Date.now() };
    try {
      await db.collection(COL_PETS).doc(openid).set({ data: pet });
    } catch (e) { /* 建档失败不挡读取 —— 下次再建 */ }
  }
  const me = await getUser(openid);
  return ok({
    pet: petState(pet),
    points: Number((me && me.pointsTotal) || 0),
    costs: { hatch: HATCH_COST, feed: FEED_COST },
    juvenileAt: JUVENILE_AT,
    adultAt: ADULT_AT
  });
}

/** 给前端的状态形状：toNext/percent 让页面不用重复算比例。
 *  百分比按"当前形态段"算：hatchling 0~5、juvenile 5~10，跨段不累计 ——
 *  否则少年期的进度条几乎不动（前一段占了 50%），升级感被稀释。 */
function petState(pet) {
  const xp = Math.max(0, Number(pet.xp) || 0);
  let stage = pet.stage;
  if (stage !== 'hatchling' && stage !== 'juvenile' && stage !== 'adult') stage = 'egg';
  let toNext = 0;
  let percent = 0;
  if (stage === 'hatchling') {
    toNext = Math.max(0, JUVENILE_AT - xp);
    percent = Math.min(100, Math.round(xp * 100 / JUVENILE_AT));
  } else if (stage === 'juvenile') {
    toNext = Math.max(0, ADULT_AT - xp);
    percent = Math.min(100, Math.round((xp - JUVENILE_AT) * 100 / (ADULT_AT - JUVENILE_AT)));
  } else if (stage === 'adult') {
    percent = 100;
  }
  return { stage: stage, xp: xp, toNext: toNext, percent: percent };
}

/**
 * 喂食 / 孵化。蛋阶段一次"喂食"就是孵化（花 HATCH_COST）；之后每次花 FEED_COST。
 * 为什么不给前端传 cost 的决定权：价格是经济系统的服务端事实，
 * 客户端传入的 cost 只用于展示，扣多少由阶段决定 —— 免得"前端说 50 就扣 50"。
 */
async function doFeedPet(openid, event) {
  await ensureAll();
  let pet;
  try {
    const res = await db.collection(COL_PETS).doc(openid).get();
    pet = (res && res.data) || null;
  } catch (e) {
    if (!isNotExistErr(e)) return fail('READ_FAILED', '宠物状态读不到，稍后再试');
  }
  if (!pet) pet = { stage: 'egg', xp: 0, hatchedAt: 0, fedAt: 0, updatedAt: 0 };

  const me = await getUser(openid);
  const balance = Number((me && me.pointsTotal) || 0);
  // 先归一化旧版三态数据（'baby' 是四态上线前的幼鲸态），再判孵化 ——
  // 否则旧数据会被当成蛋二次孵化、多扣一次 200 分。
  const legacyStage = pet.stage === 'baby' ? 'hatchling' : pet.stage;
  const hatching = legacyStage !== 'hatchling' && legacyStage !== 'juvenile' && legacyStage !== 'adult';
  const cost = hatching ? HATCH_COST : FEED_COST;
  if (balance < cost) {
    return fail('NOT_ENOUGH_POINTS', '积分还差 ' + (cost - balance) + ' 分', { need: cost - balance, cost: cost });
  }

  const now = Date.now();
  const newXp = hatching ? 0 : (Number(pet.xp) || 0) + 1;
  // 形态只向前演进，一次写到位、不留中间态。
  let stage = hatching ? 'hatchling' : (legacyStage === 'adult' ? 'adult'
    : (newXp >= ADULT_AT ? 'adult' : (newXp >= JUVENILE_AT ? 'juvenile'
      : (legacyStage === 'juvenile' ? 'juvenile' : 'hatchling'))));
  const patch = hatching
    ? { stage: stage, xp: 0, hatchedAt: now, fedAt: now, updatedAt: now }
    : { stage: stage, xp: newXp, fedAt: now, updatedAt: now };
  const evolved = !hatching && stage !== legacyStage;   // 每次跨档都值得庆祝，不只成体

  try {
    await db.collection(COL_PETS).doc(openid).set({
      data: Object.assign({}, pet, patch)
    });
    await db.collection(COL_USERS).doc(openid).update({ data: { pointsTotal: _.inc(-cost), updatedAt: now } });
  } catch (e) {
    return fail('WRITE_FAILED', '操作失败，积分没扣，稍后再试');
  }

  const fresh = await db.collection(COL_PETS).doc(openid).get();
  return ok({
    pet: petState((fresh && fresh.data) || Object.assign({}, pet, patch)),
    points: balance - cost,
    cost: cost,
    evolved: evolved
  });
}

/**
 * 好友码。scene = friendId（8 字符 ≤ 32 上限），page 不带前导 / 不带参数。
 * checkPath: false —— 官方参数，允许页面尚未发布也出码（F 考证结论）；
 * envVersion 自动降级：先试 release（正式版），失败（页面未发布/版本未上线）
 * 再试 trial（体验版，仅项目体验成员可扫）。响应带 trialOnly 让前端出提示，
 * 不静默：扫不开的二维码比没有二维码更伤信任。
 * 彻底失败返回 QR_UNAVAILABLE，前端 fallback 转发卡片。
 * 生成后把 buffer 传到云存储，返回 fileID：为什么不直接回 base64 ——
 * image 组件对 data URL 的支持在部分基础库上有体积与表现差异，fileID 是官方路。
 */
async function doQrCode(openid, event) {
  await ensureAll();
  const me = await getUser(openid);
  if (!me || !me.friendId) return fail('NO_PROFILE', '先保存资料，再生成好友码');

  const req = String(event.envVersion || '');
  // 指定 trial/develop 就只出一个（联调用）；没指定或指定 release 才走降级链
  const envs = (req === 'trial' || req === 'develop')
    ? [req]
    : ['release', 'trial'];
  const errors = [];

  for (let i = 0; i < envs.length; i++) {
    const env = envs[i];
    try {
      const res = await cloud.openapi.wxacode.getUnlimited({
        scene: me.friendId,
        page: 'pack-social/pages/friends/friends',
        checkPath: false,
        envVersion: env
      });
      const buffer = res && res.buffer;
      if (!buffer) {
        errors.push(env + ': empty buffer');
        continue;
      }
      const upload = await cloud.uploadFile({
        cloudPath: 'qrcodes/' + me.friendId + '-' + env + '.png',
        fileContent: buffer
      });
      return ok({ fileID: upload.fileID, envVersion: env, trialOnly: env === 'trial' });
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || e);
      errors.push(env + ': ' + msg.slice(0, 120));
    }
  }
  console.error('[socialProxy] qrCode all envs failed:', errors.join(' | '));
  return fail('QR_UNAVAILABLE',
    '小程序正式版发布后才能生成好友码，先用「转发邀请卡」',
    { detail: errors.join(' | ').slice(0, 300) });
}

/*----------------------------- 入口 -----------------------------*/

exports.main = async function (event) {
  const wx = cloud.getWXContext();
  const openid = wx && wx.OPENID;
  if (!openid) {
    return fail('NO_OPENID', '拿不到用户标识，请重进小程序');
  }

  const action = String((event && event.action) || '');
  const ev = event || {};
  try {
    if (action === 'registerProfile') return await doRegisterProfile(openid, ev);
    if (action === 'myProfile') return await doMyProfile(openid, ev);
    if (action === 'addFriend') return await doAddFriend(openid, ev);
    if (action === 'listFriends') return await doListFriends(openid, ev);
    if (action === 'syncPoints') return await doSyncPoints(openid, ev);
    if (action === 'leaderboard') return await doLeaderboard(openid, ev);
    if (action === 'pkWith') return await doPkWith(openid, ev);
    if (action === 'getPet') return await doGetPet(openid);
    if (action === 'feedPet') return await doFeedPet(openid, ev);
    if (action === 'qrCode') return await doQrCode(openid, ev);
    return fail('BAD_ACTION', '未知操作：' + action);
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    console.error('[socialProxy] action=' + action, msg);
    return fail('FAILED', '社交功能暂时用不了', { detail: msg.slice(0, 300) });
  }
};
