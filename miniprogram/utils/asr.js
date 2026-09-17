/**
 * 发音服务客户端 —— 三条通道，按可用性自动选择，全部"永不抛错"。
 *
 * ## 三条通道与优先级
 *   ① 云函数 asrProxy   —— 任何手机可用（Tencent/智谱，Key 只在云函数环境变量）
 *   ② 本地服务 8766     —— 仅开发期用（电脑必须开机 + 同一 WiFi）
 *   ③ 离线              —— 不做识别，只判"没读/微判"，主流程不受影响
 *
 * 插件通道（微信同声传译）在 utils/voice.js 里判断，优先级高于以上三条，
 * 因为它是免费的端上能力；但需要小程序主体有插件权限，个人主体通常没有。
 *
 * ## 为什么云端优先于本地服务
 * 本地服务要求"电脑开机 + 同一 WiFi"，换台手机就废——这正是要消灭的依赖。
 * 云函数是官方唯一合规的中间层：Key 不进代码（反编译拿不到），任何网络都能调。
 *
 * ## 纪律
 * · 所有函数 resolve 结构化结果，**永不 reject**（页面无需 try/catch）
 * · 失败一定带 code，便于页面给正确的下一步
 * · 面向初一学生的文案里不出现错误码与技术术语（技术细节给 techHint，只在设置页用）
 */
const DEFAULT_BASE = 'http://127.0.0.1:8766';
const BASE_KEY = 'asr_base';
const CLOUD_FN = 'asrProxy';

/** 云函数单次调用的音频上限（base64 后）。超过就走云存储中转 */
const CLOUD_INLINE_LIMIT = 700 * 1024;

/*========================= 本地服务地址（开发期）=========================*/

function base() {
  try {
    const v = wx.getStorageSync(BASE_KEY);
    if (v && typeof v === 'string') return v.replace(/\/+$/, '');
  } catch (e) { /* 用默认值 */ }
  return DEFAULT_BASE;
}

function setBase(url) {
  try {
    wx.setStorageSync(BASE_KEY, String(url || '').trim());
    return true;
  } catch (e) {
    return false;
  }
}

/*========================= 云函数通道 =========================*/

/** 云开发是否可用（未开通 / 基础库过低时为 false） */
function cloudReady() {
  return !!(wx.cloud && typeof wx.cloud.callFunction === 'function');
}

/**
 * 调用云函数。**统一包一层**：wx.cloud.callFunction 会抛同步异常，
 * 直接调会让调用方被迫写 try/catch —— 那正是要避免的（页面代码会被污染）。
 */
function callCloud(data) {
  return new Promise(function (resolve) {
    if (!cloudReady()) {
      resolve({ ok: false, code: 'NO_CLOUD' });
      return;
    }
    try {
      wx.cloud.callFunction({
        name: CLOUD_FN,
        data: data,
        success: function (res) {
          const r = res && res.result;
          resolve(r && typeof r === 'object' ? r : { ok: false, code: 'BAD_RESPONSE' });
        },
        fail: function (err) {
          const m = (err && err.errMsg) || '';
          // 云函数不存在 → 还没部署；网络问题 → 换网络/稍后
          const code = /not found|FUNCTION_NOT_FOUND/i.test(m) ? 'NOT_DEPLOYED'
            : /timeout/i.test(m) ? 'TIMEOUT' : 'CLOUD_FAIL';
          resolve({ ok: false, code: code, msg: m.slice(0, 120) });
        }
      });
    } catch (e) {
      resolve({ ok: false, code: 'CLOUD_THREW' });
    }
  });
}

/** 云端语音识别是否就绪（设置页用它显示状态） */
function cloudStatus() {
  return callCloud({ action: 'status' });
}

/**
 * 用云函数识别一段录音。
 *
 * 音频传递方式：
 *   · 短录音（单词朗读通常 1-3 秒）→ base64 直接塞进 callFunction，一次调用搞定
 *   · 超过内联上限 → 先传云存储拿 fileID，由云函数下载（避免请求体过大）
 * 为什么不一律走云存储：那是两次网络往返 + 需要清理文件，
 * 为 99% 的场景（一个单词）付这个代价不值得。
 */
function recognizeCloud(filePath) {
  return new Promise(function (resolve) {
    if (!cloudReady()) { resolve({ ok: false, code: 'NO_CLOUD' }); return; }

    let fs = null;
    try {
      fs = wx.getFileSystemManager();
    } catch (e) {
      resolve({ ok: false, code: 'NO_FS' });
      return;
    }

    fs.readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (res) {
        const b64 = res && res.data;
        if (!b64) { resolve({ ok: false, code: 'EMPTY_AUDIO' }); return; }

        const fmt = /\.([a-z0-9]+)$/i.exec(String(filePath));
        const format = fmt ? fmt[1].toLowerCase() : 'wav';

        if (b64.length <= CLOUD_INLINE_LIMIT) {
          callCloud({ action: 'transcribe', audioBase64: b64, format: format })
            .then(resolve);
          return;
        }
        // 大文件走云存储
        uploadThenRecognize(filePath, format).then(resolve);
      },
      fail: function () {
        resolve({ ok: false, code: 'READ_FAILED' });
      }
    });
  });
}

/** 大录音的中转路径：先上传云存储，再把 fileID 给云函数 */
function uploadThenRecognize(filePath, format) {
  return new Promise(function (resolve) {
    const cloudPath = 'asr/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + format;
    try {
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: function (up) {
          const fileID = up && up.fileID;
          if (!fileID) { resolve({ ok: false, code: 'UPLOAD_FAILED' }); return; }
          callCloud({ action: 'transcribe', fileID: fileID }).then(function (r) {
            // 用完即删：识别结果是我们要的，录音没必要留在云上（隐私 + 存储成本）
            try { wx.cloud.deleteFile({ fileList: [fileID] }); } catch (e) { /* 删失败不影响结果 */ }
            resolve(r);
          });
        },
        fail: function () { resolve({ ok: false, code: 'UPLOAD_FAILED' }); }
      });
    } catch (e) {
      resolve({ ok: false, code: 'UPLOAD_THREW' });
    }
  });
}

/*========================= 本地服务通道（开发期）=========================*/

/** 服务健康检查（本地服务） */
function health() {
  return new Promise(function (resolve) {
    try {
      wx.request({
        url: base() + '/api/health',
        method: 'GET',
        timeout: 6000,
        success: function (res) {
          const d = res && res.data;
          if (d && d.ok) resolve({ ok: true, vocab: d.vocab_size, asr: d.asr_loaded });
          else resolve({ ok: false, code: 'BAD_RESPONSE' });
        },
        fail: function () { resolve({ ok: false, code: 'OFFLINE' }); }
      });
    } catch (e) {
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

/**
 * 用本地服务评测一次朗读（含服务端判定）。
 * 保留这条路径是因为它有独立价值：服务端能跑更重的判定（Metaphone 回退、更细的音素对齐）。
 */
function pronounce(word, filePath) {
  return new Promise(function (resolve) {
    try {
      wx.uploadFile({
        url: base() + '/api/pronounce',
        filePath: filePath,
        name: 'audio',
        formData: { word: word },
        timeout: 30000,
        success: function (res) {
          let d = null;
          try {
            d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          } catch (e) {
            resolve({ ok: false, code: 'BAD_JSON' });
            return;
          }
          if (d && d.ok) resolve(d);
          else resolve({ ok: false, code: (d && d.code) || 'UNKNOWN', msg: d && d.msg });
        },
        fail: function () { resolve({ ok: false, code: 'OFFLINE' }); }
      });
    } catch (e) {
      console.warn('[asr] 上传异常', e);
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

/** 单词发音音频 URL（仅本地服务通道有；云端通道用 TTS 插件或离线提示） */
function audioUrl(word) {
  return base() + '/api/audio/' + encodeURIComponent(word);
}

/*========================= 词义问答（已改为端上优先）=========================*/

/**
 * 单词知识问答 —— **端上优先**。
 *
 * 为什么改：检索的原料（词形、音素、标签、记忆钩子）本来就在词卡里，
 * 端上算完就能回答。云端只在"要生成更自然的解释"时才需要。
 * 所以这里是"端上检索 + 可选云端润色"，而不是"什么都问服务器"。
 *
 * 页面（ask）直接调 utils/rag.js 即可；本函数保留给"想走服务端"的调用方。
 */
function askWord(question, topK) {
  return new Promise(function (resolve) {
    try {
      wx.request({
        url: base() + '/api/word/ask',
        method: 'POST',
        data: { question: question, top_k: topK || 5 },
        timeout: 40000,
        header: { 'Content-Type': 'application/json' },
        success: function (res) {
          const d = res && res.data;
          if (d && d.ok) resolve(d);
          else resolve({ ok: false, code: (d && d.code) || 'UNKNOWN', msg: d && d.msg });
        },
        fail: function () { resolve({ ok: false, code: 'OFFLINE' }); }
      });
    } catch (e) {
      console.warn('[asr] 提问异常', e);
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

/*========================= 文案 =========================*/

/**
 * 失败时给用户的提示。
 *
 * 措辞纪律：这是给初一学生看的，**不能出现命令行、错误码、技术术语**。
 * 技术细节只放在 techHint 里给设置页/控制台排查用。
 */
function hintFor(code) {
  if (code === 'NO_CLOUD' || code === 'NOT_DEPLOYED') {
    return '朗读功能还没开通，先看单词也行';
  }
  if (code === 'OFFLINE' || code === 'CALL_THREW' || code === 'CLOUD_FAIL' || code === 'CLOUD_THREW') {
    return '网络不太好，稍后再试或先看单词';
  }
  if (code === 'TIMEOUT') return '网络有点慢，再读一次试试';
  if (code === 'QUOTA') return '今天的朗读次数用完了，明天再来';
  if (code === 'AUTH' || code === 'NOT_CONFIGURED') return '朗读功能还在准备中';
  if (code === 'AUDIO_TOO_SHORT') return '录得太短了，把整个单词读完';
  if (code === 'ASR_FAILED') return '没听清，再读一次';
  if (code === 'AUDIO_TOO_BIG') return '录太长了，读完单词就松手';
  if (code === 'EMPTY_AUDIO' || code === 'READ_FAILED') return '录音没存下来，再读一次';
  return '这次没评上，再读一次试试';
}

/** 技术性提示：只给设置页 / 控制台用（学生看不到） */
function techHint(code) {
  if (code === 'NO_CLOUD') return '未开通云开发，无法使用云端语音识别';
  if (code === 'NOT_DEPLOYED') return '云函数 asrProxy 未部署（开发者工具右键上传并部署）';
  if (code === 'NOT_CONFIGURED') return '云函数未配置语音识别服务（需配 TENCENT_SECRET_ID/KEY 或 GLM_API_KEY）';
  if (code === 'QUOTA') return '语音识别额度用尽（腾讯云每月免费 5000 次）';
  if (code === 'AUTH') return '语音识别鉴权失败（检查 SecretId/SecretKey 是否正确）';
  if (code === 'OFFLINE' || code === 'CALL_THREW') {
    return '本地朗读服务没启动（开发期用，运行 python -m server.asr_service）';
  }
  return '错误码 ' + code;
}

module.exports = {
  base, setBase, health,
  cloudReady, cloudStatus, recognizeCloud,
  pronounce, audioUrl, askWord,
  hintFor, techHint,
  BASE_KEY, CLOUD_FN
};
