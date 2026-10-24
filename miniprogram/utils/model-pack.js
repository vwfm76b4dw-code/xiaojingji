/**
 * 端侧模型资源包管理 —— 首次启动后台下载、存本地、可清理
 *
 * ## 它管什么
 * 端侧语义检索需要 4 个文件（合计 47 MB），全部放在
 * wx.env.USER_DATA_PATH/semantic/ 下，**不进代码包**。
 * 原因：主包只剩二十几 KB，光词表就要 107 KB。详见 README「包体积」一节。
 *
 * ## 下载策略（三条，都是为了让 47MB 不打扰用户）
 *   ① **非阻塞**：只在 onLaunch 后异步跑，绝不挡启动、不挡首屏
 *   ② **只在 WiFi 自动下**：流量下不自动下载，改为在设置页等用户手动点
 *   ③ **只认字节数精确匹配的文件**：中断留下的半个文件、以及**内容更新后
 *      字节数变了的旧文件**都会重下 —— 2026-10-17 起 vectors/index 换成
 *      295 词专属索引（体积 1.4MB→148KB），若用「>= 就算完整」的旧判据，
 *      旧用户会保留旧 vectors 配新 index（行数不一致），语义通道静默挂死；
 *      精确匹配让老用户在下次启动自动换上成对的新资源。
 *
 * ## 与 utils/semantic.js 的分工
 *   本模块：只负责「文件在不在、要不要下、下到哪」
 *   semantic.js：只负责「有了文件之后怎么用」
 * 两者通过 USER_DATA_PATH/semantic/ 这个目录解耦，互不知道对方存在。
 *
 * ## 降级契约
 * 云开发未开通、无网络、用户拒绝 —— 任何情况都不抛错、不弹窗。
 * 下载失败只是「语义检索用不了」，既有检索通道完全不受影响。
 */

const DIR = 'semantic';

/**
 * 资源清单。
 *
 * ⚠️ fileID 需要在上传后回填 —— 从云开发控制台「存储」里复制每个文件的
 * File ID（形如 cloud://<env>.<bucket>/semantic/vocab.txt）。
 * 未回填时本模块会判定为「未配置」，自动跳过下载（不报错）。
 */
const FILES = [
  { name: 'vocab.txt', bytes: 109539, fileID: 'cloud://ENV_ID/FILE_ID' },
  { name: 'vectors.bin', bytes: 151040, fileID: 'cloud://ENV_ID/FILE_ID' },
  { name: 'index.json', bytes: 32761, fileID: 'cloud://ENV_ID/FILE_ID' },
  { name: 'bge-small-zh.onnx', bytes: 47497427, fileID: 'cloud://ENV_ID/FILE_ID' }
];

const TOTAL_BYTES = FILES.reduce(function (a, f) { return a + f.bytes; }, 0);

let fs = null;
let root = '';
let downloading = false;
let lastError = '';
let lastProgress = { done: 0, total: TOTAL_BYTES, index: 0, name: '', percent: 0 };

function abs(name) { return root + '/' + DIR + '/' + name; }

/**
 * 懒取 fs / root。status() 可能在 download() 之前被调（冷启动 → 设置页先打开），
 * 不在这里初始化的话 sizeOf 全部读 0：明明下完了也显示 0% +「立即下载」常驻。
 */
function ensureFs() {
  if (fs && root) return true;
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return false;
  try {
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;
  } catch (e) { return false; }
  return true;
}

function ensureDir() {
  try { fs.mkdirSync(root + '/' + DIR); } catch (e) { /* 已存在会抛，忽略 */ }
}

/** 单个文件的实际字节数；不存在返回 0 */
function sizeOf(name) {
  try {
    const st = fs.statSync(abs(name));
    return st && st.size ? st.size : 0;
  } catch (e) { return 0; }
}

/** 是否已配置（fileID 都填了） */
function isConfigured() {
  return FILES.every(function (f) { return !!f.fileID; });
}

/**
 * 当前状态。设置页用它渲染进度与体积。
 * @returns {{configured, complete, downloaded, totalBytes, percent, files, downloading, error}}
 */
function status() {
  ensureFs();
  let downloaded = 0;
  const files = FILES.map(function (f) {
    const sz = (fs && root) ? sizeOf(f.name) : 0;
    // 只认「字节数精确匹配」，不认「文件存在」也不认「达标」——
    // 中断的半个文件、内容更新后体积变化的旧文件都必须重下（见头部 ③）
    const ok = sz === f.bytes;
    if (ok) downloaded += f.bytes;
    return { name: f.name, bytes: f.bytes, local: sz, ok: ok };
  });
  return {
    configured: isConfigured(),
    complete: downloaded >= TOTAL_BYTES,
    downloaded: downloaded,
    totalBytes: TOTAL_BYTES,
    percent: Math.round(downloaded / TOTAL_BYTES * 100),
    files: files,
    downloading: downloading,
    error: lastError,
    progress: lastProgress
  };
}

/** 当前是否 WiFi。取不到网络信息时按「非 WiFi」处理（保守，不偷跑流量） */
function onWifi(cb) {
  try {
    wx.getNetworkType({
      success: function (res) { cb(res && res.networkType === 'wifi'); },
      fail: function () { cb(false); }
    });
  } catch (e) { cb(false); }
}

/** 下一个待下载的文件索引；全下完返回 -1 */
function nextPending() {
  for (let i = 0; i < FILES.length; i++) {
    if (sizeOf(FILES[i].name) !== FILES[i].bytes) return i;
  }
  return -1;
}

/**
 * 下载（可重复调用；进行中会直接返回）。
 *
 * @param {Object} [opts]
 *   @param {Function} [opts.onProgress]  (p) => void，p 同 lastProgress
 *   @param {Function} [opts.onDone]      (err) => void，err 为 null 表示全部就绪
 *   @param {boolean}  [opts.force]       true 时忽略 WiFi 限制（设置页手动点用）
 */
function download(opts) {
  opts = opts || {};
  const done = opts.onDone || function () { };

  if (downloading) { done(new Error('downloading')); return; }
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) { lastError = 'no-fs'; done(new Error('no-fs')); return; }
  if (!isConfigured()) { lastError = 'not-configured'; done(new Error('not-configured')); return; }
  if (typeof wx.cloud === 'undefined' || typeof wx.cloud.downloadFile !== 'function') {
    lastError = 'no-cloud'; done(new Error('no-cloud')); return;
  }

  fs = wx.getFileSystemManager();
  root = wx.env.USER_DATA_PATH;

  const idx = nextPending();
  if (idx < 0) { lastError = ''; done(null); return; }

  function start() {
    downloading = true;
    lastError = '';
    ensureDir();
    step(idx);
  }

  function step(i) {
    if (i >= FILES.length) { downloading = false; done(null); return; }
    const f = FILES[i];
    if (sizeOf(f.name) === f.bytes) { step(i + 1); return; }   // 字节数精确匹配，已完整

    lastProgress = {
      done: FILES.slice(0, i).reduce(function (a, x) { return a + x.bytes; }, 0),
      total: TOTAL_BYTES, index: i, name: f.name, percent: 0
    };
    if (opts.onProgress) opts.onProgress(lastProgress);

    wx.cloud.downloadFile({
      fileID: f.fileID,
      success: function (res) {
        if (!res || res.statusCode !== 200 || !res.tempFilePath) {
          downloading = false; lastError = 'http-' + (res && res.statusCode);
          done(new Error(lastError)); return;
        }
        try {
          // 先删旧的半个文件，避免 copyFile 在已存在时失败
          try { fs.unlinkSync(abs(f.name)); } catch (e) { /* 不存在，正常 */ }
          fs.copyFileSync(res.tempFilePath, abs(f.name));
        } catch (e) {
          downloading = false; lastError = 'copy-failed'; done(new Error(lastError)); return;
        }
        const got = sizeOf(f.name);
        if (got !== f.bytes) {
          downloading = false; lastError = 'size-mismatch:' + f.name + ':' + got;
          done(new Error(lastError)); return;
        }
        lastProgress = {
          done: FILES.slice(0, i + 1).reduce(function (a, x) { return a + x.bytes; }, 0),
          total: TOTAL_BYTES, index: i, name: f.name, percent: 100
        };
        if (opts.onProgress) opts.onProgress(lastProgress);
        step(i + 1);
      },
      fail: function (err) {
        downloading = false;
        lastError = (err && err.errMsg) || 'download-failed';
        done(new Error(lastError));
      }
    });
  }

  if (opts.force) { start(); return; }
  onWifi(function (wifi) {
    if (!wifi) { lastError = 'not-wifi'; done(new Error('not-wifi')); return; }
    start();
  });
}

/**
 * 首次启动时调用。**刻意做成「尽力而为」**：
 * 不阻塞、失败静默、非 WiFi 直接跳过。
 * 用户想手动下，去设置页点。
 */
function autoDownloadOnLaunch() {
  try {
    if (!isConfigured()) return;            // 还没上传资源，不折腾
    if (status().complete) return;          // 已下好，零开销
    download({
      onDone: function (err) {
        if (err && typeof console !== 'undefined') {
          console.log('[model-pack] 自动下载跳过：' + (err.message || err));
        }
      }
    });
  } catch (e) {
    // onLaunch 里绝不能让这里把启动带崩
  }
}

/** 清空本地资源（设置页用）。语义通道会自动退回关闭状态。 */
function clear() {
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return false;
  try {
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;
    FILES.forEach(function (f) {
      try { fs.unlinkSync(abs(f.name)); } catch (e) { /* 不存在，正常 */ }
    });
    lastError = '';
    return true;
  } catch (e) { return false; }
}

module.exports = {
  FILES: FILES,
  DIR: DIR,
  TOTAL_BYTES: TOTAL_BYTES,
  status: status,
  download: download,
  autoDownloadOnLaunch: autoDownloadOnLaunch,
  clear: clear,
  isConfigured: isConfigured
};
