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
      // 原始 err 必须留档（errno/retcode/errMsg 全在里头）——
      // 只有一句折算后的 code，真机上出问题就没法查是权限、被占用还是网络
      console.error('[voice] 识别失败（原始错误）', err);
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

// ---------------------------------------------------------------- 后端选择（诚实状态机）

/**
 * 单条通道失败的人话原因。
 *
 * 为什么集中在这里而不是散在页面里：历史教训（被学生/作者骂过）是"状态只看
 * provider 就报就绪"——撒谎的根源是**通道失败原因没有结构化**，页面只能瞎猜
 * 一句通用文案。这里把 每条通道 × 每种失败码 折算成一句可行动的人话，
 * selectBackend 负责把它们串成完整的"为什么现在是这样"，页面只管渲染。
 * 文案纪律：对初一学生说人话，但"要作者处理"的原因要如实说"需要作者"，
 * 不能让学生以为是自己操作的问题。
 */
function channelWhy(channel, code) {
  if (code === 'OK') return '可用';
  if (channel === 'plugin') {
    // 个人主体小程序加不了 WechatSI 插件，这是主体资格问题，学生/家长无解
    if (code === 'PLUGIN_MISSING') return '微信语音插件未接入（需要小程序主体权限）';
    return '语音插件不可用';
  }
  if (channel === 'cloud') {
    if (code === 'NO_CLOUD') return '云开发未开通，云端识别用不了';
    if (code === 'NOT_DEPLOYED') return '云端识别函数还没部署（需要作者上传）';
    if (code === 'NOT_CONFIGURED') return '云端识别密钥还没配好（需要作者配置）';
    if (code === 'AUTH') return '云端识别鉴权失败（需要作者检查密钥）';
    if (code === 'QUOTA') return '云端识别额度用完了';
    return '云端识别暂时连不上';
  }
  if (channel === 'local') {
    // 127.0.0.1 在手机上指向手机自己 —— 这条通道天生只属于开发机
    if (code === 'OFFLINE' || code === 'CALL_THREW') return '本地识别服务没启动（仅开发电脑可用）';
    return '本地识别服务不可用';
  }
  if (channel === 'acoustic') {
    if (code === 'NOT_UPLOADED') return '发音判定资源还没上线（等资源发布）';
    if (code === 'NETWORK') return '联网后才能下载发音判定资源';
    if (code === 'DOWNLOADING') return '发音判定资源正在下载';
    return '端上判定不可用';
  }
  return '通道不可用';
}

/**
 * 后端选择 —— **纯函数**，把各通道的探测结果折算成最终后端 + 完整的失败账本。
 *
 * 选择顺序（与 pronounce 页 checkVoice 的探测顺序一致）：
 *   settings 指定 local（开发期显式选择，压过自动选择）
 *   → plugin → cloud → local → offline
 * offline 时若端上声学模板就绪，acousticRescued=true —— 它不需要识别后端
 * （直接比对波形），所以"四条识别通道全断"不再等于"不能评测"。
 *
 * 为什么做成纯函数：选择矩阵是回归最密集的地方（每种通道组合一种行为），
 * 纯函数才能在 Node 门禁里穷举（verify-voice.js 第一节），挂页面上就只能
 * 靠真机手点。
 *
 * @param {Object} input 各通道探测结果（字段缺失 = 该通道尚未探测/不可用）
 *   pref          settings.voiceBackend（'local' 为开发期显式选择）
 *   pluginReady   WechatSI 插件已加载
 *   cloudReady    wx.cloud 可调用
 *   cloudCode     云函数 status 的 code（'OK' | NOT_DEPLOYED | NOT_CONFIGURED | ...）
 *   localReady    本地服务 /api/health 通过
 *   localCode     本地服务失败码
 *   acousticReady 端上模板包就绪
 * @returns {{backend, acousticRescued, rescuedBy, tried}}
 *   tried: 每条被考虑过的通道 {channel, ok, code, why} —— 失败的也必须出现，
 *          这是"诚实"的载体：界面能说清"为什么降级到了这一步"。
 */
function selectBackend(input) {
  input = input || {};
  const tried = [];
  const note = function (name, ok, code) {
    tried.push({
      channel: name,
      ok: !!ok,
      code: ok ? 'OK' : (code || 'FAILED'),
      why: channelWhy(name, ok ? 'OK' : (code || 'FAILED'))
    });
  };

  let backend;
  if (input.pref === 'local') {
    backend = 'local';
    note('local', true);
  } else if (input.pluginReady) {
    backend = 'plugin';
    note('plugin', true);
  } else {
    note('plugin', false, 'PLUGIN_MISSING');
    if (input.cloudReady && input.cloudCode === 'OK') {
      backend = 'cloud';
      note('cloud', true);
    } else {
      note('cloud', false, input.cloudReady ? (input.cloudCode || 'CLOUD_FAIL') : 'NO_CLOUD');
      if (input.localReady) {
        backend = 'local';
        note('local', true);
      } else {
        note('local', false, input.localCode || 'OFFLINE');
        backend = 'offline';
      }
    }
  }

  const acousticRescued = backend === 'offline' && !!input.acousticReady;
  return {
    backend: backend,
    acousticRescued: acousticRescued,
    rescuedBy: acousticRescued ? 'acoustic' : '',
    tried: tried
  };
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
      // 不说"检查权限"就完了 —— 要给出可执行的动作（页面据 isAuthError 弹"去设置"）
      return '没能用上麦克风，你可以在设置里允许';
    case 'NETWORK':
      return '网络不太好，稍后再试';
    case 'RATE_LIMIT':
      return '读得太快了，等几秒再试';
    case 'OFFLINE':
      return '语音功能暂时用不了，先看单词也行';
    case 'NOT_UPLOADED':
      // 资源没上传是作者侧的事，"稍后再试"是撒谎 —— 等多久都不会自己好
      return '发音判定资源还没上线，等下次更新后再来';
    case 'DOWNLOADING':
      return '发音判定资源正在下载，稍等一下';
    case 'PREPARING':
      return '正在准备发音判定，马上就好';
    default:
      return '这次没评上，再读一次试试';
  }
}

/**
 * 这个失败是不是"没有麦克风权限"。
 *
 * 页面据此给**动作**（弹"为什么需要麦克风 → 去允许"），而不是只弹一句提示 ——
 * 权限类失败是唯一"学生自己一步就能解决"的失败，其它失败只能重试或降级。
 * 把错误码的词表留在本文件，页面不硬编码插件错误码。
 */
function isAuthError(code) {
  return code === 'MIC_ERROR';
}

module.exports = {
  backend, plugin, capability,
  selectBackend, channelWhy,
  recognizeOnce, stopRecognition,
  wordAudio, hintFor, isAuthError,
};
