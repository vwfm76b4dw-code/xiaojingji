/**
 * 云资源按需下载 + 本地缓存 —— 主包瘦身（音频上云）的地基。
 *
 * ## 它管什么
 * 两类资源，缓存在 `wx.env.USER_DATA_PATH/resources/<key>` 下：
 *   audio/<word-slug>.mp3   294 个预置真人发音（原来随包 901 KB，2026-09-25 迁出主包）
 *   asr/templates.bin       端上声学判定模板（767 KB，朗读页消费方见 asr-pack.js）
 * key 与云存储路径一一对应（`resources/<key>`），清单来自 resource-manifest.js。
 *
 * ## 契约（docs/契约-并行开发-2026-09-25.md §2.1，E 是消费方）
 *   getResource(key)             => Promise<{path, size}|null>  已缓存立即返回；未缓存 null（不抛错）
 *   ensureResource(key, onProgress) => Promise<{path}>          失败 reject({code:'NETWORK'|'NOT_UPLOADED', msg})
 *   cacheInfo()                  => {count, bytes}
 *   clearCache()                 => 清缓存（设置页未来用）
 *
 * ## 为什么校验只用 size、不用 md5
 * 微信运行时没有现成的文件摘要 API，自己 vendor 一份 JS md5（约 200 行）只为防
 * 「下了一半」这一个故障 —— 而字节数对比就能抓住截断（下载中断的真实故障模式，
 * asr-pack.js 已用同样的办法守了两年）。文件来自我们自己的云环境（私有读），
 * 不存在"被替换成恶意文件"的攻击面。清单里仍保留 md5 字段（上传脚本算的本地值），
 * 供未来人工核对/接 COS 侧校验使用，运行时不读它。
 *
 * ## 降级契约
 * 清单为空 / 无网 / 未上传 / wx.cloud 缺失 —— 任何情况都**不抛异常**：
 * getResource 返回 null（调用方显示「资源准备中」），ensureResource 才用 reject
 * 表达失败（它有明确等待语气的调用方，需要可重试）。audio.js 收下所有降级，
 * 不让任何一个散到页面层。
 *
 * ## 并发防重
 * 同 key 的并发 ensure 只发起**一次**下载：in-flight 表存的是 Promise 本身而不是
 * 布尔量 —— 后来者拿到的必须是同一个结局（成功同享、失败同败），存布尔量会让
 * 第二个调用方要么报"正在下载"要么轮询，两种都要调用方写额外状态机。
 */

const DIR = 'resources';

/** 清单（resource-manifest.js 是生成物）。懒加载 + try/catch：文件缺失时按空清单降级 */
let _manifest = null;
let _manifestLoaded = false;
/** 测试注入用的清单覆盖（verify-resources.js 用；项目惯例：契约模块可注入依赖） */
let _testManifest = undefined;
/** in-flight 下载表：key -> Promise */
const _inflight = Object.create(null);

function manifest() {
  if (_testManifest !== undefined) return _testManifest;
  if (!_manifestLoaded) {
    _manifestLoaded = true;
    try {
      const m = require('./resource-manifest.js');
      // 只接受形状合法的清单 —— 生成物被手改坏时按空清单降级，而不是把坏数据当真
      if (m && typeof m === 'object' && m.files && typeof m.files === 'object') _manifest = m;
    } catch (e) {
      _manifest = null;
    }
  }
  return _manifest;
}

/** 单条资源记录；清单没有 / 缺 fid / 缺 size 都算「未上传」 */
function entryOf(key) {
  const m = manifest();
  if (!m || !m.files) return null;
  const e = m.files[key];
  if (!e || !e.fid || !(e.size > 0)) return null;
  return e;
}

/*------------------------- 本地文件系统 -------------------------*/

/**
 * 懒取 fs / root。与 asr-pack.js 同款：status 类查询可能发生在任何下载之前，
 * 模块加载期就取 fs 会让 Node 侧门禁（无 wx 环境）无法直接 require 本模块。
 */
function env() {
  if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') return null;
  try {
    return { fs: wx.getFileSystemManager(), root: wx.env.USER_DATA_PATH };
  } catch (e) {
    return null;
  }
}

/** 缓存绝对路径。key 里的 '/' 直接成为目录层级，与云存储路径同构 */
function absPath(root, key) {
  return root + '/' + DIR + '/' + key;
}

/** 文件实际字节数；不存在/不可读返回 0 */
function sizeOf(fs, p) {
  try {
    const st = fs.statSync(p);
    return st && st.size ? st.size : 0;
  } catch (e) {
    return 0;
  }
}

/** 逐级建目录（'resources'、'resources/audio'）。已存在会抛，忽略 —— asr-pack.js 同款 */
function mkdirs(fs, root, key) {
  const segs = key.split('/');
  segs.pop();                            // 最后一段是文件名
  let cur = root + '/' + DIR;
  try { fs.mkdirSync(cur); } catch (e1) { /* 已存在 */ }
  for (let i = 0; i < segs.length; i++) {
    cur += '/' + segs[i];
    try { fs.mkdirSync(cur); } catch (e2) { /* 已存在 */ }
  }
}

/*------------------------- 对外接口 -------------------------*/

/**
 * 查询一个资源是否已在本地缓存。
 * 已缓存（字节数达标）=> {path, size}；否则 null。**任何输入都不抛错**：
 * 调用方（audio.js）在每次播放前都会问一次，异常会污染主播放链路。
 */
function getResource(key) {
  return new Promise(function (resolve) {
    const entry = entryOf(key);
    if (!entry) { resolve(null); return; }
    const envr = env();
    if (!envr) { resolve(null); return; }
    const p = absPath(envr.root, key);
    const sz = sizeOf(envr.fs, p);
    // 只认「字节数达标」，不认「文件存在」—— 截断的半个文件必须当成没缓存，
    // 让 ensureResource 重下（与 asr-pack.js 的同一判断，理由同源）
    resolve(sz >= entry.size ? { path: p, size: sz } : null);
  });
}

/**
 * 确保一个资源就绪：已缓存立即返回；未缓存发起下载（同 key 并发只发一次）。
 *
 * 失败 reject({code, msg})：
 *   NOT_UPLOADED  清单里没有这条（资源没传过 / 清单为空的降级态）——重试无意义，
 *                 提示语应引导"等资源上线"而不是"检查网络"
 *   NETWORK       无网 / wx.cloud 缺失 / HTTP 错 / 下载截断 —— 可重试
 */
function ensureResource(key, onProgress) {
  if (_inflight[key]) return _inflight[key];
  const p = new Promise(function (resolve, reject) {
    const entry = entryOf(key);
    if (!entry) {
      reject({ code: 'NOT_UPLOADED', msg: '清单中没有 ' + key + '（资源未上传或清单为降级空版）' });
      return;
    }
    const envr = env();
    if (!envr) { reject({ code: 'NETWORK', msg: '本地文件系统不可用' }); return; }
    if (typeof wx.cloud === 'undefined' || typeof wx.cloud.downloadFile !== 'function') {
      reject({ code: 'NETWORK', msg: 'wx.cloud 不可用（云开发未开通或基础库过旧）' });
      return;
    }
    const dest = absPath(envr.root, key);
    if (sizeOf(envr.fs, dest) >= entry.size) { resolve({ path: dest }); return; }

    mkdirs(envr.fs, envr.root, key);
    if (typeof onProgress === 'function') {
      try { onProgress({ loaded: 0, total: entry.size }); } catch (e0) { /* 进度回调不许影响下载 */ }
    }

    wx.cloud.downloadFile({
      fileID: entry.fid,
      success: function (res) {
        if (!res || res.statusCode !== 200 || !res.tempFilePath) {
          reject({ code: 'NETWORK', msg: 'HTTP ' + (res && res.statusCode) });
          return;
        }
        try {
          // 先删旧文件：copyFileSync 对已存在文件的行为在部分基础库上会失败
          try { envr.fs.unlinkSync(dest); } catch (e1) { /* 不存在，正常 */ }
          envr.fs.copyFileSync(res.tempFilePath, dest);
        } catch (e2) {
          reject({ code: 'NETWORK', msg: 'copy-failed' });
          return;
        }
        const got = sizeOf(envr.fs, dest);
        if (got < entry.size) {
          // 截断必须当成失败并清掉半个文件：留在缓存里会被 getResource 当成"已缓存"
          try { envr.fs.unlinkSync(dest); } catch (e3) { /* 尽力而为 */ }
          reject({ code: 'NETWORK', msg: 'truncated:' + got + '/' + entry.size });
          return;
        }
        if (typeof onProgress === 'function') {
          try { onProgress({ loaded: got, total: entry.size }); } catch (e4) { /* 同上 */ }
        }
        resolve({ path: dest });
      },
      fail: function (err) {
        reject({ code: 'NETWORK', msg: (err && err.errMsg) || 'download-failed' });
      }
    });
  });
  // 收尾清 in-flight：成功失败都要清，否则一次失败会永久挡住重试
  const clear = function () { try { delete _inflight[key]; } catch (e) { /* 键是自有属性，不会抛 */ } };
  p.then(clear, clear);
  _inflight[key] = p;
  return p;
}

/** 已缓存资源统计（设置页未来展示「离线资源：N 个 / X KB」用） */
function cacheInfo() {
  const m = manifest();
  const envr = env();
  if (!m || !m.files || !envr) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  Object.keys(m.files).forEach(function (key) {
    const need = m.files[key] && m.files[key].size;
    if (!(need > 0)) return;
    const sz = sizeOf(envr.fs, absPath(envr.root, key));
    if (sz >= need) { count++; bytes += sz; }
  });
  return { count: count, bytes: bytes };
}

/**
 * 清空缓存（设置页「清除离线资源」用）。
 * 逐文件 unlink 而不是 rmdir：rmdirSync 的递归参数是较新基础库才有的，
 * 逐个删在所有版本上都成立；留下的空目录字节开销为 0，不值得为它写两套代码。
 */
function clearCache() {
  const m = manifest();
  const envr = env();
  if (!envr) return false;
  const keys = (m && m.files) ? Object.keys(m.files) : [];
  let ok = true;
  keys.forEach(function (key) {
    try { envr.fs.unlinkSync(absPath(envr.root, key)); } catch (e) { ok = false; }
  });
  return ok;
}

/*------------------------- 测试接缝（项目惯例：契约模块可注入依赖） -------------------------*/

/** 仅门禁使用：注入假清单，让下载链路可以在 Node 里确定性复现 */
function _injectManifestForTest(m) {
  _testManifest = m;
}

/** 仅门禁使用：恢复真实清单 + 清空 in-flight（场景间隔离） */
function _resetForTest() {
  _testManifest = undefined;
  _manifest = null;
  _manifestLoaded = false;
  Object.keys(_inflight).forEach(function (k) { delete _inflight[k]; });
}

module.exports = {
  getResource: getResource,
  ensureResource: ensureResource,
  cacheInfo: cacheInfo,
  clearCache: clearCache,
  DIR: DIR,
  _injectManifestForTest: _injectManifestForTest,
  _resetForTest: _resetForTest
};
