/**
 * 发音音频 —— 三级取材：**本地（缓存或包内）→ 云端缓存 → 插件合成/本地服务**。
 *
 * ## 2026-09-25 音频上云（主包瘦身）
 * 294 个发音 mp3（901 KB）原本随包，主包 2048 KB 硬限被突破后迁到云存储
 * （`resources/audio/<slug>.mp3`，经 utils/resources.js 下载并缓存在
 * USER_DATA_PATH）。从此每个词首次播放需联网下载一次，之后**永久本地、零延迟**；
 * 下载与缓存的所有细节（并发防重、截断校验、断网降级）都收在 resources.js，
 * 本模块只负责编排取材顺序。
 *
 * ## 三级的取舍
 *   ① 本地缓存（resources 缓存目录）—— 迁移后的常态，命中即零开销；
 *   ② 包内复制 —— 兼容**旧包**（迁移前版本里 294 个 mp3 还在包里）：
 *      copyFile 成功即走老路，行为与历史版本逐字节一致；
 *   ③ 云端下载 —— ①②都落空时拉一次云端并落缓存，下一次播放就变成 ①；
 *   ④ 插件/本地服务 —— 只服务**没有预置音频**的词（用户自己录入的），
 *      以及 ①②③全失败的静默兜底。
 * 为什么不把 ① 做成"先查包内再查缓存"：迁移后包里没有文件，每次播放都白付一次
 * 失败的 copyFile；反过来旧包没有缓存目录，先查缓存也是白付一次 stat。
 * 两种包各取自己命中的第一级，代价最小。
 *
 * ## 为什么保留"复制到本地"这一步（旧包兼容）
 * `InnerAudioContext.src` 能否直接指向代码包内路径，官方文档没有明确承诺，
 * 社区资料互相矛盾（有人说包内路径播放不了，有人说可以）。
 * 所以这里做**双保险**：
 *   ① 先直接用包内路径播（若平台支持，零开销）
 *   ② 失败则把文件从包内复制到 `wx.env.USER_DATA_PATH`，再指向本地路径
 * 两种情况下功能都可用，且不需要我们替平台做假设。
 *
 * 复制是**每词一次**的（复制过就记在集合里），且复制结果落在本地文件系统，
 * 后续播放零开销。
 */
const settings = require('./settings.js');
const AUDIO_INDEX = require('../data/audio-index.js');
const resources = require('./resources.js');

/** 音频所在目录（相对小程序根）。迁移后包内不再有这些文件，保留目录常量只为旧包兼容 */
const AUDIO_DIR = '/data/audio';

let _copied = null;          // 已复制到本地的词（Set 延迟创建）
let _plugin = null;
let _pluginChecked = false;

/*------------------------- 路径工具 -------------------------*/

/**
 * 单词 → 音频文件名。
 *
 * ⚠️ 必须与 tools/build-audio-pack.js 的生成规则**逐字一致**：
 *   小写 → 去掉词性括号（race（v.）→ race）→ 非字母数字转连字符 → 去首尾连字符
 * 词表里有短语（junior high）和带词性的多义词（race（v.）），
 * 规则不一致就会出现"这个词听不到发音"，而且很难发现是命名问题。
 */
function audioKey(word) {
  return String(word == null ? '' : word)
    .toLowerCase()
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 音频在代码包内的路径；**没有预置音频时返回 ''**。
 *
 * ⚠️ 必须查清单，不能只拼路径。
 * 小程序运行时**无法列出代码包内的目录**（readdir 只能读 USER_DATA_PATH），
 * 所以"有没有这个文件"只能靠编译期生成的清单（data/audio-index.js）回答。
 *
 * 如果只拼路径会怎样：用户自己录入的词（如他把 water 加进词库）会拿到
 * `/data/audio/water.mp3` 这个**不存在的路径**，播放必然失败，
 * 而且失败信息是"播放错误"，与真正原因（没有预置音频）毫无关系 ——
 * 正确行为是识别出"没有预置"，直接走插件合成。
 */
function packPath(word) {
  const k = audioKey(word);
  if (!k) return '';
  return AUDIO_INDEX.has ? (AUDIO_INDEX.has(k) ? AUDIO_DIR + '/' + k + '.mp3' : '')
    : (_indexSet().has(k) ? AUDIO_DIR + '/' + k + '.mp3' : '');
}

/** 清单查询用的 Set（首次访问时构建；294 条约 3KB 内存，可忽略） */
let _set = null;
function _indexSet() {
  if (!_set) _set = new Set(AUDIO_INDEX);
  return _set;
}

/**
 * 词 → 云资源清单 key（resources.js 的命名空间）。
 * 与 packPath 一样吃 audioKey 的产物；命名规则是契约（§2.1），
 * 与 tools/upload-resources-cloud.py 的上传路径**逐字一致**，两边都改才会同步坏。
 */
function cloudKey(word) {
  const k = audioKey(word);
  if (!k) return '';
  return 'audio/' + k + '.mp3';
}

/** 已复制到本地的路径 */
function localPath(word) {
  const k = audioKey(word);
  if (!k) return '';
  try {
    return wx.env.USER_DATA_PATH + '/pron-' + k + '.mp3';
  } catch (e) {
    return '';
  }
}

/** 该词是否已在本地（复制过） */
function isCopied(word) {
  if (!_copied) return false;
  return _copied.has(audioKey(word));
}

/**
 * 把包内音频复制到本地文件系统。
 *
 * 为什么可能需要这一步：包内资源在部分平台/基础库版本下不能直接作为
 * audio src 播放（社区有明确反馈）。复制到 USER_DATA_PATH 后就是普通的本地文件，
 * 播放可靠性最高。代价是每个词首次多一次 IO（几毫秒），之后零开销。
 */
function ensureLocal(word) {
  return new Promise(function (resolve) {
    const k = audioKey(word);
    if (!k) { resolve({ ok: false, code: 'EMPTY' }); return; }
    if (isCopied(word)) { resolve({ ok: true, path: localPath(word), via: 'cache' }); return; }

    const src = packPath(word);
    const dst = localPath(word);
    if (!src || !dst) { resolve({ ok: false, code: 'NO_KEY' }); return; }

    let fs = null;
    try { fs = wx.getFileSystemManager(); } catch (e) {
      resolve({ ok: false, code: 'NO_FS' });
      return;
    }

    fs.copyFile({
      srcPath: src,
      destPath: dst,
      success: function () {
        if (!_copied) _copied = new Set();
        _copied.add(k);
        resolve({ ok: true, path: dst, via: 'copied' });
      },
      fail: function (err) {
        // 包内没有这个文件，或平台不允许复制
        resolve({ ok: false, code: 'COPY_FAILED', raw: err && err.errMsg });
      }
    });
  });
}

/*------------------------- 插件（备选）-------------------------*/

/**
 * 尝试加载 WechatSI 插件。
 * 用 try/catch 包住：插件需要在 app.json 声明，且**个人主体可能无法添加**（官方限制）。
 * 未配置时 requirePlugin 会抛异常，必须容错，否则整个模块加载失败会拖垮朗读页。
 */
function plugin() {
  if (_pluginChecked) return _plugin;
  _pluginChecked = true;
  try {
    _plugin = requirePlugin('WechatSI');
  } catch (e) {
    _plugin = null;
  }
  return _plugin;
}

/** 插件合成发音（包内没有对应词时的兜底） */
function ttsViaPlugin(word) {
  const p = plugin();
  if (!p) return Promise.resolve({ ok: false, code: 'NO_PLUGIN' });
  return new Promise(function (resolve) {
    try {
      p.textToSpeech({
        lang: 'en_US',
        tts: true,
        content: String(word || ''),
        success: function (res) {
          const url = res && res.filename;
          if (url) resolve({ ok: true, url: url, via: 'plugin' });
          else resolve({ ok: false, code: 'NO_AUDIO' });
        },
        fail: function (err) {
          resolve({ ok: false, code: 'TTS_FAILED', raw: err && err.retcode });
        }
      });
    } catch (e) {
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

/*------------------------- 对外接口 -------------------------*/

/**
 * 取一个词的发声音频。
 *
 * 返回 { ok, src, via } 或 { ok:false, code }
 *   via: 'pack'   包内路径（迁移前的包里真实存在；迁移后的包里这个路径是死的）
 *        'local'  已复制到本地
 *        'plugin' 插件合成
 *        'service' 本地服务 URL（开发期）
 *
 * ⚠️ 调用方拿到 ok:true 后仍需处理**播放失败**：
 *    包内路径在某些平台播不了，这时应该再调 `ensureLocal` 拿本地路径重试。
 *    本模块提供 `resolveForPlay` 把这两步合起来，页面直接用那个更省事。
 * ⚠️ 迁移后（2026-09-25）包内已没有 mp3，本函数对预置词返回的包内路径只在旧包上可播。
 *    **新代码一律用 resolveForPlay** —— 它接入云端缓存链，迁移后仍能给出真实可播的文件。
 *    本函数保留原实现不动：它是导出 API，语义（"给一个尽量能用的 src"）不能变。
 */
function wordAudio(word) {
  const src = packPath(word);
  if (src) return Promise.resolve({ ok: true, src: src, via: 'pack' });
  return ttsViaPlugin(word).then(function (r) {
    if (r.ok) return r;
    // 没有插件时给本地服务 URL（开发期可能可用）
    if (settings.get('voiceBackend') === 'local') {
      return { ok: true, src: require('./asr.js').audioUrl(word), via: 'service' };
    }
    return { ok: false, code: r.code || 'NO_AUDIO' };
  });
}

/**
 * 走云端取一个词的发音（缓存命中直接回，未命中下载并落缓存）。
 * 失败时 reject —— 只在内部使用，对外仍由 resolveForPlay 转成静默降级。
 */
function viaCloud(word) {
  const key = cloudKey(word);
  if (!key) return Promise.reject({ code: 'NOT_UPLOADED', msg: 'empty-key' });
  return resources.getResource(key).then(function (cached) {
    if (cached) return { ok: true, src: cached.path, via: 'cloud-cache' };
    return resources.ensureResource(key).then(function (r) {
      return { ok: true, src: r.path, via: 'cloud' };
    });
  });
}

/**
 * 为"播放"解析出一个**确定能播**的路径。
 *
 * 顺序：本地缓存 → 包内复制 → 云端下载 → 插件合成 → 包内路径兜底。
 * 前两级覆盖旧包（mp3 还在包里的历史版本）与已缓存词；
 * 第三级覆盖迁移后首次播放（下载一次，之后走第一级）；
 * 第四级覆盖用户自己录入的词（没有预置音频）。
 *
 * ⚠️ 契约（§2.2）：云端取不到时**静默失败** —— 这里只 console 上下文日志（含 word），
 * 不弹窗、不抛错。最后的包内路径兜底保留旧行为（旧包上它真实存在），
 * 调用方本就要处理"src 播不出来"的情况（见 wordAudio 的说明）。
 */
function resolveForPlay(word) {
  const src = packPath(word);
  if (!src) {
    // 不在预置范围内（用户自己加的词）：直接走插件
    return ttsViaPlugin(word);
  }
  return ensureLocal(word).then(function (r) {
    if (r.ok) return { ok: true, src: r.path, via: 'local' };
    // 复制失败：旧包可能是平台不允许，新包是文件已迁出。两种都交给云端链，
    // 由 resources.js 自己判定"缓存有没有/清单有没有/网通不通"
    return viaCloud(word).catch(function (err) {
      console.log('[audio] 云端发音不可用 word=' + word +
        ' code=' + ((err && err.code) || '?') +
        ' ' + ((err && err.msg) || ''));
      return { ok: true, src: src, via: 'pack' };
    });
  });
}

/**
 * 能力自检（设置页用来显示"发音可用性"）。
 * 只做**同步可判定**的部分：预置发音覆盖率由编译期清单（audio-index）决定，
 * 不需要网络 —— 词在清单里就代表"包内（旧包）或云端（迁移后）有它的发音"，
 * 不区分两种来源，因为设置页只关心覆盖率这一个数。
 */
function audioCapability(words) {
  let has = 0;
  const missing = [];
  (words || []).forEach(function (w) {
    if (packPath(w)) has++;
    else missing.push(w);
  });
  return {
    total: (words || []).length,
    packaged: has,
    missing: missing,
    coverage: (words || []).length > 0 ? Math.round((has / words.length) * 100) : 0,
    plugin: !!plugin()
  };
}

module.exports = {
  audioKey, cloudKey, packPath, localPath, ensureLocal,
  wordAudio, resolveForPlay, audioCapability,
  AUDIO_DIR
};
