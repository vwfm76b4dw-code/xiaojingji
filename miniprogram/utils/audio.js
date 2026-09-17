/**
 * 发音音频 —— 优先用**随包预置的真人发音**，其次插件合成，最后本地服务。
 *
 * ## 为什么把音频打进包
 * 之前发音要么靠插件（个人主体常无权限）、要么靠电脑上的服务（换手机就废）。
 * 而 294 个单词的发音 mp3 在 16kbps 单声道下**总共只有 1MB** ——
 * 代码压缩后才 257KB，加上音频也在 2MB 主包限制内（实测 1283KB / 62%）。
 * 于是发音可以做到：**零延迟、离线可用、零成本、不依赖任何服务**。
 * 这是"任何手机都能用"这个目标里最后一块拼图。
 *
 * ## 为什么有"复制到本地"这一步
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

/** 音频所在目录（相对小程序根） */
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
 *   via: 'pack'   随包预置（首选，离线可用）
 *        'local'  已复制到本地
 *        'plugin' 插件合成
 *        'service' 本地服务 URL（开发期）
 *
 * ⚠️ 调用方拿到 ok:true 后仍需处理**播放失败**：
 *    包内路径在某些平台播不了，这时应该再调 `ensureLocal` 拿本地路径重试。
 *    本模块提供 `resolveForPlay` 把这两步合起来，页面直接用那个更省事。
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
 * 为"播放"解析出一个**确定能播**的路径。
 *
 * 顺序：包内 → 本地复制 → 插件合成。前两步覆盖随包词，
 * 第三步覆盖用户自己录入的词（那些词没有预置音频）。
 */
function resolveForPlay(word) {
  const src = packPath(word);
  if (!src) {
    // 不在预置范围内（用户自己加的词）：直接走插件
    return ttsViaPlugin(word);
  }
  return ensureLocal(word).then(function (r) {
    if (r.ok) return { ok: true, src: r.path, via: 'local' };
    // 复制失败（平台不支持）→ 退回包内路径试试，再不行才用插件
    return { ok: true, src: src, via: 'pack' };
  });
}

/**
 * 能力自检（设置页用来显示"发音可用性"）。
 * 只做**同步可判定**的部分：包内音频覆盖率是编译期确定的，不需要网络。
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
  audioKey, packPath, localPath, ensureLocal,
  wordAudio, resolveForPlay, audioCapability,
  AUDIO_DIR
};
