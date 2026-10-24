/**
 * 启动资源准备管线 —— 首启把"学习资源"一次备齐，之后每次启动只补缺、不重跑。
 *
 * ## 它解决什么问题（2026-09-25，用户点名）
 * 迁移上云后，发音 mp3 变成"用到才下"——第一次离线点开，每个词都要等一次
 * 网络往返；声学模板虽然启动会自动下，但**下完不加载**，朗读页第一次判定
 * 还要现场读 785KB。用户要的是"第一次启动先下好所有资源，每次启动先把
 * 模型加载进去"。本模块把三段收成一条管线：
 *
 *   阶段① 模板   asr/templates.bin（785KB，**不限 WiFi**，同 asr-pack 的既定策略）
 *                → 就绪后立刻 acoustic.load() 预热进内存（失败静默，朗读页账本兜底）
 *   阶段② 发音   294 个 audio/*.mp3（单文件 ~3KB，总量 ~1.7MB），并发 ≤3 后台下载
 *   阶段③ 模型   语义模型 47MB —— 只编排不重写：走 model-pack.download()，
 *                WiFi 门/断点判断都是它自己的（非 WiFi 时它返回 not-wifi，管线如实
 *                记 skipped，下次启动再试）
 *
 * ## 幂等与断点续传（门禁 verify-boot.js 的核心断言）
 * 进度持久化在 storage：`{ ver: 清单ver, done: {key: true} }`。
 *   · ver 一致 → book 里的 key 跳过下载；但每个 key 仍过一次 statSync 复核
 *     （book 是跳过提示不是事实，见 run() 内注释）——已缓存的文件因此零下载；
 *   · ver 变了 → book 整体作废，全部 key 按磁盘实况重新判断（清单换批意味着
 *     文件可能换内容，这正是 asr-pack.js 头注释里点名要防的"半新半旧"错位）。
 * 所以第二次启动：全部已缓存 → 零下载、只剩 acoustic.load() 一次内存预热。
 *
 * ## 退后台不中断
 * 刻意**不监听** onHide/appHide 去暂停：单文件 3KB、总量 1.7MB，暂停再恢复
 * 的状态机复杂度远超收益；微信对后台网络请求的生命周期由系统管理，我们能做
 * 的（也应该做的）只是不去主动 cancel——所以这里没有 cancel 这个概念。
 *
 * ## 失败语义
 *   · 单 key 失败：NETWORK 类记入失败表，本轮池子跑完后**整体重试一次**；
 *     NOT_UPLOADED（清单没有这条）不重试——重试多少次都是同一个答案；
 *   · 重试后仍失败的 key 留给下次启动（不在 done 集里，自然会被重跑）；
 *   · 模板失败不阻塞发音阶段（两段无依赖）；任何失败都不抛出本模块。
 *
 * ## 为什么在 resources.js 之外再包一层
 * resources.ensureResource 是"单 key"原语（含 in-flight 防重/截断校验），
 * 它不知道"294 个 key 该按什么顺序、几路并发、进度给谁看"。编排状态机放
 * 资源层会把两层职责搅在一起；放页面层则 deck/pronounce 都得各自实现一遍。
 * 启动是这条管线的唯一 owner。
 */

const resources = require('./resources.js');
const asrPack = require('./asr-pack.js');
const modelPack = require('./model-pack.js');
const acoustic = require('./acoustic.js');

/** 进度持久化键。带版本号 v1：将来改进度结构时换键，避免读到旧形状 */
const STORE_KEY = 'boot_prep_v1';

/** 下载并发上限。3 是保守值：单文件 3KB，瓶颈在 RTT 不在带宽，3 路已能把
 *  294 个串行往返压掉约 2/3，再多对云函数/CDN 是无意义的压力。 */
const MAX_CONCURRENCY = 3;

/** 每 N 个新完成落一次盘。294 次逐个 setStorageSync 是无谓放大（每次都序列化
 *  全量 done 表，O(n²)）；16 个一批既保断点粒度（最多丢 16 个的进度），又把
 *  写盘次数压到 ~20 次。阶段收尾与失败路径会强制落盘兜底。 */
const SAVE_EVERY = 16;

/** 阶段名 → 给用户看的阶段文案（deck 资源小条直接渲染） */
const STAGE_LABELS = {
  idle: '',
  template: '发音判定模板',
  audio: '单词发音',
  model: '语义模型',
  done: '完成'
};

/*------------------------- 模块态（全部会话内，持久化只有 done 表） -------------------------*/

let _running = false;
let _settled = false;        // 本会话管线已走到终态（含"无事可做"）
let _started = false;        // run() 被调用过（deck 小条据此决定出不出现）
let _stage = 'idle';
let _done = {};              // key -> true（本会话累计，含从持久化恢复的）
let _failed = {};            // key -> code（最近一次失败码；不持久化，下次启动自然重试）
let _ver = '';
let _total = 0;              // 模板(若有) + 音频数；语义模型不计入（它是 47MB 的大件，不拿它稀释 n/295 的进度感）
let _modelState = '';        // '' | 'downloading' | 'done' | 'skipped' | 'failed'
let _note = '';              // 跳过/等待原因（"语义模型等待 WiFi"等），给排查与 UI 副文案

/*------------------------- 清单（与 resources.js 同款懒加载 + 形状守卫） -------------------------*/

let _manifest = null;
let _manifestLoaded = false;
let _testManifest = undefined;   // 门禁注入缝（同 resources._injectManifestForTest 惯例）

function manifest() {
  if (_testManifest !== undefined) return _testManifest;
  if (!_manifestLoaded) {
    _manifestLoaded = true;
    try {
      const m = require('./resource-manifest.js');
      if (m && typeof m === 'object' && m.files && typeof m.files === 'object') _manifest = m;
    } catch (e) {
      _manifest = null;
    }
  }
  return _manifest;
}

/** 清单里"可下载"的条目（fid + size 齐全才算，与 resources.entryOf 同判据） */
function usable(m, key) {
  const e = m && m.files && m.files[key];
  return !!(e && e.fid && e.size > 0);
}

/*------------------------- 持久化 -------------------------*/

function loadPersisted() {
  try {
    const v = wx.getStorageSync(STORE_KEY);
    // ver 必须与当前清单一致才认：清单换批 = 旧进度作废（见文件头"幂等与断点续传"）
    if (v && typeof v === 'object' && v.ver === _ver && v.done && typeof v.done === 'object') {
      return v.done;
    }
  } catch (e) { /* 存储不可读按无进度处理，重下即可 */ }
  return null;
}

function persist() {
  try {
    wx.setStorageSync(STORE_KEY, { ver: _ver, done: _done });
  } catch (e) {
    // 进度存不下去只损失断点（下次重下），绝不能影响本次下载链路
  }
}

/*------------------------- 对外接口 -------------------------*/

/**
 * 当前状态快照。deck 资源小条与门禁都只消费这个形状，不碰内部字段。
 * settled 顶层单列：doneAll=false 且 settled=true 意味着"本轮跑完但没跑满"，
 * 小条要停轮询、改为展示"待补下"而不是无限等。
 */
function status() {
  const done = Object.keys(_done).length;
  const failed = Object.keys(_failed).length;
  return {
    started: _started,
    running: _running,
    settled: _settled,
    stage: _stage,
    stageLabel: STAGE_LABELS[_stage] || '',
    done: done,
    total: _total,
    percent: _total > 0 ? Math.round(done / _total * 100) : 0,
    failedCount: failed,
    doneAll: _settled && (_total === 0 || done >= _total),
    modelState: _modelState,
    note: _note
  };
}

/**
 * 启动管线。**fire-and-forget**：立即返回状态快照，实际工作在异步链上进行，
 * 绝不阻塞 onLaunch 首帧。重复调用幂等：进行中/已终态时直接回快照，不重跑
 * （同会话重跑的唯一合法入口是 _resetForTest）。
 *
 * @param {Object} [opts]
 *   @param {Function} [opts.onDone] (err|null) => void —— 管线终态回调（门禁与
 *          需要精确时机的调用方用；app.js 的启动路径不传，纯 fire-and-forget）
 */
function run(opts) {
  opts = opts || {};
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
  if (_running) { if (onDone) onDone(new Error('running')); return status(); }

  _started = true;
  _running = true;
  _settled = false;
  _failed = {};
  _modelState = '';
  _note = '';

  const m = manifest();
  _ver = (m && typeof m.ver !== 'undefined') ? String(m.ver) : '';

  // 待下载清单：294 个音频 key，排序保证进度顺序确定（门禁要确定性复现）
  const audioKeys = m
    ? Object.keys(m.files).filter(function (k) { return k.indexOf('audio/') === 0 && usable(m, k); }).sort()
    : [];
  const tplKey = asrPack.FILES[0].key;
  const hasTpl = usable(m, tplKey);
  _total = (hasTpl ? 1 : 0) + audioKeys.length;

  // 恢复断点 book。⚠️ book 是**跳过提示**，不是事实：缓存可能被 clearCache
  // 清掉而 book 无从得知（book 只记"下载完成过"，不记文件后来还在不在）。
  // 若盲信 book，缓存清空后音频会**静默丢失** —— 所以每个 book 声称已完成的
  // key 都要过一次 getResource（=一次 statSync）复核；295 次 statSync 是
  // 微秒级开销，换"book 与磁盘永不脱节"值得。ver 变化时 book 直接作废。
  const savedDone = loadPersisted();

  /** 终态：落盘 + 置态 + 回调。stage 统一落 'done'（部分失败由 doneAll/failedCount 表达） */
  function finish() {
    _running = false;
    _settled = true;
    _stage = 'done';
    persist();
    if (onDone) { try { onDone(null); } catch (e) { /* 回调不许炸管线 */ } }
  }

  /** 模板就绪即预热进内存（用户点名"每次启动先把模型加载进去"）。
   *  try 包住：load 失败只影响首次判定的预热时机，朗读页进页时还有自己的
   *  prepareAcoustic 兜底，绝不能让这里把管线带崩。 */
  function warmAcoustic() {
    try { acoustic.load(); } catch (e) { /* 静默：朗读页账本会兜底并给出可行动指引 */ }
  }

  /** book 复核：只保留"清单里仍有 + 磁盘上字节数仍达标"的 key 进 done 集 */
  function verifySaved() {
    _done = {};
    if (!savedDone) return Promise.resolve();
    const keys = Object.keys(savedDone).filter(function (k) { return m && m.files && m.files[k]; });
    return Promise.all(keys.map(function (k) {
      return resources.getResource(k).then(function (hit) {
        if (hit) _done[k] = true;
      });
    }));
  }

  /* ---- 阶段① 模板 ---- */
  function templateStage() {
    _stage = 'template';
    if (!hasTpl) {
      // 没这条清单项（降级空版）：仍然尝试预热 —— 模板可能来自
      // 开发者工具预置或旧版本安装，文件在本地就该用起来
      warmAcoustic();
      audioStage();
      return;
    }
    // 模板不查 book（asr-pack.download 对"文件已在且达标"是零下载早退），
    // 直接调它：本地有就秒回并顺手预热，没有才真下
    asrPack.download({
      onDone: function (err) {
        if (!err) {
          _done[tplKey] = true;
        } else {
          // asr-pack 的并发守卫（别处正在下）会回 'downloading'，如实记失败码；
          // 不重试模板（它自己下次启动会再试），不让模板失败拖住 294 个发音
          _failed[tplKey] = (err && err.code) || 'NETWORK';
        }
        warmAcoustic();
        persist();
        audioStage();
      }
    });
  }

  /* ---- 阶段② 发音（并发 ≤3 的两遍池子：第一遍 + 失败重试一遍） ---- */
  function audioStage() {
    _stage = 'audio';
    let pending = audioKeys.filter(function (k) { return !_done[k]; });

    let idx = 0;
    let inflight = 0;
    let pass = 1;
    let failedKeys = [];
    let sinceSave = 0;

    function settleIfDrained() {
      if (inflight > 0 || idx < pending.length) return;
      if (pass === 1 && failedKeys.length > 0) {
        // 第二遍只跑失败过的：NOT_UPLOADED 在第一遍就已剔除（重试无意义）
        pending = failedKeys.slice();
        failedKeys = [];
        idx = 0;
        pass = 2;
        pump();
        return;
      }
      persist();
      modelStage();
    }

    function pump() {
      while (inflight < MAX_CONCURRENCY && idx < pending.length) {
        const key = pending[idx++];
        inflight++;
        resources.ensureResource(key).then(function () {
          inflight--;
          _done[key] = true;
          delete _failed[key];
          sinceSave++;
          if (sinceSave % SAVE_EVERY === 0) persist();
          pump();
          settleIfDrained();
        }, function (err) {
          inflight--;
          const code = (err && err.code) || 'NETWORK';
          _failed[key] = code;
          if (code !== 'NOT_UPLOADED') failedKeys.push(key);
          pump();
          settleIfDrained();
        });
      }
    }

    if (pending.length === 0) { modelStage(); return; }
    pump();
  }

  /* ---- 阶段③ 语义模型（只编排，WiFi 门是 model-pack 自己的） ---- */
  function modelStage() {
    _stage = 'model';
    if (!modelPack.isConfigured()) {
      // 资源没上传 / fileID 没回填：如实记 skipped，不算失败也不挡终态。
      // note 用 || 追加：空清单场景已经先写了"清单未上线"，那句更接近根因
      _modelState = 'skipped';
      _note = _note || '语义模型资源未上传（等待发布）';
      finish();
      return;
    }
    if (modelPack.status().complete) { _modelState = 'done'; finish(); return; }
    _modelState = 'downloading';
    modelPack.download({
      onDone: function (err) {
        const msg = err && err.message;
        if (!err) { _modelState = 'done'; }
        else if (msg === 'not-wifi') { _modelState = 'skipped'; _note = _note || '语义模型等待 WiFi（可在设置页手动下载）'; }
        else if (msg === 'downloading') { _modelState = 'skipped'; _note = _note || '语义模型已在别处下载中'; }
        else { _modelState = 'failed'; _note = '语义模型下载失败：' + msg; }
        finish();
      }
    });
  }

  // 空清单（ver='0' 降级版 / 没有任何可下载条目）：不发起任何下载、不写垃圾
  // 进度，如实留因后照常走完管线（模板预热 → 模型 skipped → 终态），
  // 时序形状与非空清单完全一致（onDone 总在异步链之后触发，调用方可 await）
  if (!m || (audioKeys.length === 0 && !hasTpl)) {
    _note = '资源清单未上线（云存储还没有资源）';
  }

  // 整条管线异步化：onLaunch 调这里绝不许有同步 IO 卡首帧。
  // book 复核（每 key 一次 statSync）也进异步链。
  Promise.resolve()
    .then(function () { return verifySaved(); })
    .then(function () { templateStage(); });
  return status();
}

/*------------------------- 测试接缝（项目惯例：契约模块可注入依赖） -------------------------*/

/** 仅门禁使用：注入假清单，让管线在 Node 里确定性复现 */
function _injectManifestForTest(m) {
  _testManifest = m;
}

/** 仅门禁使用：清空全部会话态（场景间隔离；不清理 storage —— 那是门禁的活） */
function _resetForTest() {
  _running = false;
  _settled = false;
  _started = false;
  _stage = 'idle';
  _done = {};
  _failed = {};
  _ver = '';
  _total = 0;
  _modelState = '';
  _note = '';
  _testManifest = undefined;
  _manifest = null;
  _manifestLoaded = false;
}

module.exports = {
  STORE_KEY: STORE_KEY,
  MAX_CONCURRENCY: MAX_CONCURRENCY,
  status: status,
  run: run,
  _injectManifestForTest: _injectManifestForTest,
  _resetForTest: _resetForTest
};
