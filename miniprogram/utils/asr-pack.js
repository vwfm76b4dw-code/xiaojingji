/**
 * 端上声学判定模板包管理 —— 下载走 utils/resources.js、存本地、可清理。
 *
 * ## 它管什么
 * 端上声学判定需要 **1 个文件**，放在 wx.env.USER_DATA_PATH/asr/ 下，
 * **不进代码包**：
 *   asr-templates.bin   294 词 × 5 档 VTLN 的 int8 量化 MFCC（0.75 MB）
 * 词表 / 索引 / 阈值（原 asr-templates.json）已改为**随包**（asr-templates-meta.js，
 * 52 KB）—— 为什么拆开：① 契约 §2.1 的云端 key 只登记了 asr/templates.bin，
 * meta 没有云端 key，随包是唯一不依赖"另一个 Agent 恰好也上传了它"的取法；
 * ② bin 与 meta 必须同批生成，分开下载就可能出现"半新半旧"的组合，
 * 索引错位会让判定全错且不报错 —— 同一个包里永远同批；③ 52 KB 换判定链
 * 离线完备，判定是朗读页主路径，值得。
 *
 * ## 下载通道：为什么是 resources.js 而不是自己直连 wx.cloud
 * 原实现直接调 wx.cloud.downloadFile，fileID 硬编码在本文件里、要人肉回填。
 * 2026-09-25 起项目有了统一的云资源层（resources.js：清单寻址 + 截断校验 +
 * 并发防重 + 缓存），再自己直连就是把同一套下载状态机维护两份。这里的职责
 * 只剩"编排"：调 ensureResource 拿到资源缓存路径 → 复制进本模块的约定目录。
 * 保留 USER_DATA_PATH/asr/ 这个目录约定的原因：开发者工具模拟器的文件系统
 * 已预置了模板（见 docs/端上能力-资源上传与验证.md §0），acoustic.js 的读取
 * 路径与设置页的"删除模板"都挂在这个目录上 —— 换目录等于把三处都改一遍，
 * 收益为零。
 *
 * ## 降级契约
 * 清单为空（资源未上传）、无网络、wx.cloud 缺失 —— **不抛错、不弹窗**：
 *   · 启动时的 autoDownloadOnLaunch 静默跳过；
 *   · 用户等着的 ensure/download 会收到 {code:'NOT_UPLOADED'|'NETWORK'} 的
 *     Error，调用方（朗读页）据此显示「资源准备中」等**可行动**的提示，
 *     而不是永远卡在"没有识别能力"。
 * 下载失败只是「端上判定用不了」，云端识别通道完全不受影响。
 */

const DIR = 'asr';
const resources = require('./resources.js');

/**
 * 资源清单：现在只有 bin 一个文件需要下载。
 *
 * 字节数是**校验依据**：这里写错会让「下了一半的文件」被当成完整文件，
 * 于是端上读到截断的模板、判定全错却不报错 —— 改这个数字必须与
 * out/asr-templates/manifest.json 对齐（verify-acoustic / verify-voice 都有断言）。
 * key 是 resources.js 云清单（resource-manifest.js）里的寻址名，契约 §2.1。
 */
const FILES = [
  { name: 'asr-templates.bin', bytes: 785720, key: 'asr/templates.bin' }
];

/** 随包 meta 的"理论体积"：needFrames × dim。load() 用它做严格相等校验，
 *  防"bin 换了批次、meta 还是旧的"这种版本漂移（见 acoustic.js）。 */
const META_BIN_BYTES = 785720;

const TOTAL_BYTES = FILES.reduce(function (a, f) { return a + f.bytes; }, 0);

let fs = null;
let root = '';
let downloading = false;
let lastError = '';
let lastProgress = { done: 0, total: TOTAL_BYTES, index: 0, name: '', percent: 0 };

function abs(name) { return root + '/' + DIR + '/' + name; }

/**
 * 懒取 fs / root。status() 可能在 download() 之前被调（冷启动 → 设置页先打开），
 * 不在这里初始化的话 sizeOf 全部读 0：明明下完了也显示 0%。
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

/**
 * 是否已配置（云清单里有这条、可以下载）。
 *
 * 为什么查清单而不是记一个"上传过没有"的标志：清单是 A 的上传脚本的产物，
 * 资源传没传、key 对不对，清单是唯一事实源。这里懒 require 并做形状校验，
 * 清单是降级空版（当前状态）时返回 false —— 通道如实显示"资源还没上线"，
 * 而不是让用户去点一个必然失败的下载。
 */
function isConfigured() {
  try {
    const m = require('./resource-manifest.js');
    if (!m || !m.files || typeof m.files !== 'object') return false;
    const e = m.files[FILES[0].key];
    return !!(e && e.fid && e.size > 0);
  } catch (e) { return false; }
}

/**
 * 当前状态。设置页用它渲染进度与体积。
 * @returns {{configured, complete, downloaded, totalBytes, percent, files, downloading, error, progress}}
 */
function status() {
  ensureFs();
  let downloaded = 0;
  const files = FILES.map(function (f) {
    const sz = (fs && root) ? sizeOf(f.name) : 0;
    // 只认「字节数达标」，不认「文件存在」—— 中断留下的半个文件必须重下
    const ok = sz >= f.bytes;
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

/**
 * 下载（可重复调用；进行中会直接返回）。
 *
 * 与 model-pack.js 不同：**不做 WiFi 判断**。理由：只有 0.75 MB，为它逼用户
 * 找 WiFi 不值得；而且声学判定是朗读页的主路径，下不到就是功能不可用。
 *
 * @param {Object} [opts]
 *   @param {Function} [opts.onProgress]  (p) => void，p 同 lastProgress
 *   @param {Function} [opts.onDone]      (err) => void，err 为 null 表示全部就绪；
 *                                        失败时 err.code = 'NOT_UPLOADED'|'NETWORK'
 */
function download(opts) {
  opts = opts || {};
  const done = opts.onDone || function () { };

  if (downloading) { done(new Error('downloading')); return; }
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) { lastError = 'no-fs'; done(new Error('no-fs')); return; }

  fs = wx.getFileSystemManager();
  root = wx.env.USER_DATA_PATH;

  const f = FILES[0];
  if (sizeOf(f.name) >= f.bytes) { lastError = ''; done(null); return; }   // 已完整，零开销

  // wx.cloud 缺失不再在这里拦：resources.ensureResource 会对同一种情况
  // 返回 {code:'NETWORK'}，人话提示在 voice.js 的文案映射里统一给，
  // 这里提前拦只会多出一种措辞不一致的错误。
  downloading = true;
  lastError = '';
  ensureDir();

  lastProgress = { done: 0, total: TOTAL_BYTES, index: 0, name: f.name, percent: 0 };
  if (opts.onProgress) opts.onProgress(lastProgress);

  resources.ensureResource(f.key, function (p) {
    // resources 的进度 {loaded,total} → 本模块的进度形状（设置页按这个渲染）
    lastProgress = {
      done: p && p.loaded || 0,
      total: (p && p.total) || TOTAL_BYTES,
      index: 0,
      name: f.name,
      percent: p && p.total ? Math.round(p.loaded / p.total * 100) : 0
    };
    if (opts.onProgress) opts.onProgress(lastProgress);
  }).then(function (res) {
    // 复制进本模块的约定目录（USER_DATA_PATH/asr/）：
    // 模拟器预置、acoustic 读取、设置页删除都认这个目录；resources 自己的
    // 缓存副本保留 —— clear() 只删本目录，下次 ensure 会从缓存秒回。
    try { fs.unlinkSync(abs(f.name)); } catch (e0) { /* 不存在，正常 */ }
    try {
      fs.copyFileSync(res.path, abs(f.name));
    } catch (e1) {
      downloading = false; lastError = 'copy-failed';
      done(fail('NETWORK', 'copy-failed')); return;
    }
    const got = sizeOf(f.name);
    if (got < f.bytes) {
      // 截断必须当成失败：半个模板会让判定全错且不报错
      try { fs.unlinkSync(abs(f.name)); } catch (e2) { /* 尽力而为 */ }
      downloading = false; lastError = 'truncated:' + f.name;
      done(fail('NETWORK', lastError)); return;
    }
    downloading = false;
    lastProgress = { done: TOTAL_BYTES, total: TOTAL_BYTES, index: 0, name: f.name, percent: 100 };
    if (opts.onProgress) opts.onProgress(lastProgress);
    done(null);
  }).catch(function (err) {
    downloading = false;
    const code = (err && err.code) || 'NETWORK';
    const msg = (err && err.msg) || (err && err.message) || 'download-failed';
    lastError = code + ':' + msg;
    done(fail(code, msg));
  });

  /** 统一造带 code 的 Error（调用方按 code 映射人话，message 给控制台） */
  function fail(code, msg) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }
}

/**
 * 首次启动时调用。**刻意做成「尽力而为」**：不阻塞、失败静默。
 * 清单未就绪（资源未上传）时直接跳过 —— 每次启动都打一条"NOT_UPLOADED"
 * 日志没有任何信息量，只会淹没真日志。
 */
function autoDownloadOnLaunch() {
  try {
    if (!isConfigured()) return;            // 还没上传资源，不折腾
    if (status().complete) return;          // 已下好，零开销
    download({
      onDone: function (err) {
        if (err && typeof console !== 'undefined') {
          console.log('[asr-pack] 自动下载跳过：' + (err.message || err));
        }
      }
    });
  } catch (e) {
    // onLaunch 里绝不能让这里把启动带崩
  }
}

/**
 * 按需确保资源就绪 —— 朗读页在「有模板但还没下好」时用它。
 *
 * 与 autoDownloadOnLaunch 的区别：这个是**用户等着的**（他刚按下录音），
 * 所以要回传结果让他能重试，而不是静默失败。
 *
 * @param {Function} cb (err|null) => void；err.code = 'NOT_UPLOADED'|'NETWORK'
 */
function ensure(cb) {
  cb = cb || function () { };
  try {
    if (status().complete) { cb(null); return; }
    download({ onDone: cb });
  } catch (e) {
    const err = new Error('ensure-failed');
    err.code = 'NETWORK';
    cb(err);
  }
}

/** 清空本地资源（设置页用）。声学通道会自动退回关闭状态。 */
function clear() {
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return false;
  try {
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;
    FILES.forEach(function (f) {
      try { fs.unlinkSync(abs(f.name)); } catch (e) { /* 不存在，正常 */ }
    });
    // 旧版本下载过的 asr-templates.json 已被随包 meta 取代，顺手清掉，
    // 不然它会在 USER_DATA_PATH 里永远躺着 52 KB 的死数据。
    try { fs.unlinkSync(abs('asr-templates.json')); } catch (e2) { /* 不存在，正常 */ }
    lastError = '';
    return true;
  } catch (e) { return false; }
}

module.exports = {
  FILES: FILES,
  DIR: DIR,
  TOTAL_BYTES: TOTAL_BYTES,
  META_BIN_BYTES: META_BIN_BYTES,
  status: status,
  download: download,
  ensure: ensure,
  autoDownloadOnLaunch: autoDownloadOnLaunch,
  clear: clear,
  isConfigured: isConfigured
};
