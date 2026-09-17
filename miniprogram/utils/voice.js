/**
 * 语音能力适配层 —— 让朗读功能在**任何手机**上都能用。
 *
 * 这是本项目最重要的一次架构调整。原来朗读依赖本地 Python 服务
 * （whisper + 自建 HTTP），导致：
 *   · 只能用同一 WiFi 下的手机
 *   · 电脑必须开机
 *   · 换个手机就用不了
 * 现在改为**三级降级**，从"零依赖"到"完整能力"逐层退让：
 *
 *   ① WechatSI 插件（首选）—— 微信官方插件，云端识别，任何手机可用
 *        录音 → 插件识别（en_US）→ 端上音素判定（纯 JS）
 *        发音播放 → 插件 textToSpeech（en_US）
 *   ② 本地服务（开发/演示用）—— 局域网内的 Python 服务
 *   ③ 纯离线（兜底）—— 没有识别能力，但**单词显示、释义、记忆钩子、
 *        以及 SM-2 复习排期全部照常可用**（阶段 1 的零依赖保证）
 *
 * 设计纪律（沿用本项目一贯做法）：
 *   · 永不抛错：所有失败折算成 { ok:false, code }
 *   · 失败必须给出路：告诉用户"现在还能做什么"，而不是只报错
 *   · 如实标注来源：用插件还是本地服务，界面上说清楚
 */
const settings = require('./settings.js');

// ---------------------------------------------------------------- 插件探测

let _plugin = null;
let _pluginChecked = false;

/**
 * 尝试加载 WechatSI 插件。
 *
 * 为什么用 try/catch 包住：插件需要在 app.json 里声明、
 * 且**个人主体小程序可能无法添加**（官方限制）。未配置时 requirePlugin 会抛异常，
 * 这里必须容错，否则整个模块加载失败会连带拖垮朗读页。
 */
function plugin() {
  if (_pluginChecked) return _plugin;
  _pluginChecked = true;
  try {
    _plugin = requirePlugin('WechatSI');
  } catch (e) {
    console.warn('[voice] WechatSI 插件不可用（未配置或主体不支持）：', e && e.message);
    _plugin = null;
  }
  return _plugin;
}

/** 当前可用的语音后端：plugin | local | offline */
function backend() {
  if (settings.get('voiceBackend') === 'local') return 'local';
  if (plugin()) return 'plugin';
  // 本地服务是否可用由调用方异步探测
  return 'offline';
}

// ---------------------------------------------------------------- ASR

let _manager = null;

/**
 * 拿语音识别管理器（插件）。
 * 插件要求**全局唯一**的 manager，所以缓存起来。
 */
function recognitionManager() {
  const p = plugin();
  if (!p) return null;
  if (_manager) return _manager;
  try {
    _manager = p.getRecordRecognitionManager();
  } catch (e) {
    console.warn('[voice] 获取识别管理器失败', e);
    _manager = null;
  }
  return _manager;
}

/**
 * 用插件做一次识别。
 * @returns Promise<{ ok, text, duration, code }>
 */
function recognizeOnce(opts) {
  opts = opts || {};
  const manager = recognitionManager();
  if (!manager) {
    return Promise.resolve({ ok: false, code: 'NO_PLUGIN' });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = r => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    manager.onStop = function (res) {
      const text = (res && res.result) ? String(res.result) : '';
      const dur = (res && res.duration) || 0;
      if (!text) {
        finish({ ok: false, code: 'NO_SPEECH', duration: dur });
        return;
      }
      finish({ ok: true, text: text, duration: dur });
    };

    manager.onError = function (err) {
      // 插件的错误码对用户没意义，折算成我们自己的 code
      const rc = err && err.retcode;
      let code = 'ASR_FAILED';
      if (rc === -30001) code = 'MIC_ERROR';
      else if (rc === -30003) code = 'NO_FRAME';
      else if (rc === -30004 || rc === -30006 || rc === -30008) code = 'NETWORK';
      else if (rc === -40001) code = 'RATE_LIMIT';
      console.warn('[voice] 识别失败', err);
      finish({ ok: false, code: code, raw: rc });
    };

    try {
      // lang=en_US：识别英文（插件的四个语种之一）
      manager.start({
        duration: opts.duration || 10000,
        lang: 'en_US'
      });
    } catch (e) {
      finish({ ok: false, code: 'START_FAILED' });
    }
  });
}

/** 停止当前识别（松手时调用） */
function stopRecognition() {
  const manager = recognitionManager();
  if (!manager) return false;
  try {
    manager.stop();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- TTS

const _ttsCache = {};      // word → 音频 URL（插件返回的临时链接）

/**
 * 取单词发音。
 *
 * 优先用插件合成（en_US，任何手机可用）；
 * 失败则退回本地服务的预生成音频（局域网内可用）。
 * 结果按单词缓存 —— 同一个词反复听不该反复请求。
 */
function wordAudio(word) {
  const key = String(word || '').toLowerCase().trim();
  if (!key) return Promise.resolve({ ok: false, code: 'EMPTY' });
  if (_ttsCache[key]) return Promise.resolve({ ok: true, url: _ttsCache[key], via: 'cache' });

  const p = plugin();
  if (!p || settings.get('voiceBackend') === 'local') {
    return Promise.resolve({ ok: false, code: 'NO_PLUGIN' });
  }

  return new Promise(resolve => {
    try {
      p.textToSpeech({
        lang: 'en_US',
        tts: true,
        content: key,
        success(res) {
          const url = res && res.filename;
          if (url) {
            _ttsCache[key] = url;
            resolve({ ok: true, url: url, via: 'plugin' });
          } else {
            resolve({ ok: false, code: 'NO_AUDIO' });
          }
        },
        fail(err) {
          console.warn('[voice] 语音合成失败', err);
          resolve({ ok: false, code: 'TTS_FAILED', raw: err && err.retcode });
        }
      });
    } catch (e) {
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

// ---------------------------------------------------------------- 状态

/** 语音能力自检（供设置页显示） */
function capability() {
  const p = plugin();
  return {
    plugin: !!p,
    pluginName: p ? 'WechatSI（微信同声传译）' : '未接入',
    manager: !!recognitionManager(),
    backend: backend(),
  };
}

/** 失败提示（对学生说人话，不给错误码） */
function hintFor(code) {
  switch (code) {
    case 'NO_PLUGIN':
      return '语音识别未接入，可以先听发音跟读';
    case 'NO_SPEECH':
      return '没听到声音，再读一次';
    case 'MIC_ERROR':
      return '麦克风不可用，检查一下手机权限';
    case 'NETWORK':
      return '网络不太好，稍后再试';
    case 'RATE_LIMIT':
      return '读得太快了，等几秒再试';
    case 'OFFLINE':
      return '语音功能暂时用不了，先看单词也行';
    default:
      return '这次没评上，再读一次试试';
  }
}

module.exports = {
  backend, plugin, capability,
  recognizeOnce, stopRecognition,
  wordAudio, hintFor,
};
