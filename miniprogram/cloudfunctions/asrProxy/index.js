/**
 * ASR 云函数 —— 把录音转成文字，供朗读评测使用。
 *
 * ## 为什么必须有这一层
 * 端上的发音判定引擎（utils/pron-judge.js）只负责"比对文字"，
 * 它需要**文字输入**。而"把声音变成文字"这一步必须有声学模型，
 * 端上跑不动，所以只能走服务端。
 *
 * 原来的做法是本机 Python 服务（127.0.0.1），手机上根本连不上 ——
 * 这就是"换个手机就废掉"的根因。云函数是官方唯一合规的中间层：
 *   · Key 只存在云函数的**环境变量**里，不进代码、不进前端（反编译也拿不到）
 *   · 任何手机、任何网络都能调用（不依赖你电脑开机、不依赖同一 WiFi）
 *
 * ## 为什么支持多个服务商
 * 单一服务商都可能不可用：额度用尽、区域限制、临时故障。
 * 所以做成**按环境变量选择**，谁可用就用谁；都没配就明确返回未配置，
 * 让前端走降级（提示"先自己读一遍"），而不是报一个看不懂的错误。
 *
 * 支持的服务商：
 *   asrProvider = 'glm'      → 智谱 GLM-ASR（与 AI 录入共用一把 Key，最省事）
 *              = 'tencent'   → 腾讯云一句话识别（每月 5000 次免费额度）
 *              = 'off'       → 显式关闭
 *
 * ## 环境变量
 *   ASR_PROVIDER       glm | tencent | off（默认按已配置的 Key 自动推断）
 *   GLM_API_KEY        智谱 Key（ASR_PROVIDER=glm 时用）
 *   ASR_MODEL          默认 glm-asr-2512
 *   TENCENT_SECRET_ID  / TENCENT_SECRET_KEY  （tencent 时用）
 *   TENCENT_REGION     默认 ap-guangzhou
 *
 * ## 配额限流（2026-09-30 加，见同目录 quota.js）
 * 与 aiProxy 同一套实现（云函数按目录独立打包，代码无法跨目录共享，故各存一份）。
 * ASR 比文本 AI 贵（腾讯按条计费、智谱按音频时长），所以**突发上限收得更紧**。
 * `status` 不消耗额度 —— 它是前端探可用性的自检入口，扣它配额会让降级判断失真。
 *
 * 部署：开发者工具右键本目录 → 上传并部署（云端安装依赖）
 *
 * ## 部署提醒（2026-09-30 加配额后）
 * quota.js 是**新增文件**，云函数按目录打包 —— 不重新部署就没有限流。
 * ⚠️ 必须选「上传并部署：云端安装依赖」：本目录已依赖 wx-server-sdk，
 * 让云端装依赖才能跑起跨副本的 DB 限流层（否则永久降级为单机限流）。
 * ⚠️ aiProxy 也要**一起**重新部署（它同样新增了 quota.js），
 *    且它的 package.json 这次新增了 wx-server-sdk 依赖。
 * 部署后验证：真机朗读一次 → 云开发日志应出现 `[quota] asrProxy transcribe`。
 * 阈值可用环境变量调（QUOTA_MINUTE_LIMIT / QUOTA_DAY_LIMIT /
 * QUOTA_GLOBAL_DAY_LIMIT，0 = 不限制），改完同样要重新部署。
 */
const https = require('https');
const crypto = require('crypto');
const quota = require('./quota.js');

const DEFAULT_GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const DEFAULT_GLM_MODEL = 'glm-asr-2512';

/** 单次请求上限：超时留给前端降级，不要让用户干等 */
const TIMEOUT_MS = 25000;

/*-------------------------- 通用 HTTP --------------------------*/

function request(opts, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request(opts, function (res) {
      let buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        resolve({ status: res.statusCode, text: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('ASR_TIMEOUT')); });
    req.setTimeout(TIMEOUT_MS);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** 从各家的返回结构里把识别文本取出来 */
function pickText(json) {
  if (!json) return '';
  // 智谱：{ text: '...' } 或 { choices: [...] }
  if (typeof json.text === 'string') return json.text;
  if (Array.isArray(json.choices) && json.choices[0]) {
    const m = json.choices[0].message;
    if (m && typeof m.content === 'string') return m.content;
  }
  // 腾讯：{ Response: { Result: '...' } }
  if (json.Response && typeof json.Response.Result === 'string') return json.Response.Result;
  return '';
}

/*-------------------------- 智谱 GLM-ASR --------------------------*/

function transcribeGlm(audio, format) {
  const key = process.env.GLM_API_KEY;
  if (!key) return Promise.reject(new Error('NO_GLM_KEY'));

  const endpoint = process.env.GLM_ENDPOINT_ASR || DEFAULT_GLM_ENDPOINT;
  const model = process.env.ASR_MODEL || DEFAULT_GLM_MODEL;
  const url = new URL(endpoint);

  // 手搓 multipart：云函数环境不保证有 form-data 包，手搓最稳且零依赖
  const boundary = '----zc' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  const pushField = function (name, value) {
    chunks.push(Buffer.from('--' + boundary + '\r\n'));
    chunks.push(Buffer.from('Content-Disposition: form-data; name="' + name + '"\r\n\r\n'));
    chunks.push(Buffer.from(String(value) + '\r\n'));
  };
  pushField('model', model);
  // 明确指定语言能显著降低短音频的误识别率（学生读的是单个英文词）
  pushField('language', process.env.ASR_LANGUAGE || 'en');
  // 提示词：告诉模型这次是单词朗读，不是自由说话
  pushField('prompt', 'English word pronunciation');

  chunks.push(Buffer.from('--' + boundary + '\r\n'));
  chunks.push(Buffer.from(
    'Content-Disposition: form-data; name="file"; filename="a.' + (format || 'wav') + '"\r\n'));
  chunks.push(Buffer.from('Content-Type: audio/' + (format || 'wav') + '\r\n\r\n'));
  chunks.push(audio);
  chunks.push(Buffer.from('\r\n--' + boundary + '--\r\n'));

  const body = Buffer.concat(chunks);

  return request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    }
  }, body).then(function (res) {
    const json = parseJson(res.text);
    if (res.status !== 200) {
      // 把服务商的原话带出去，便于排查（额度不足 vs Key 错 vs 参数错）
      const msg = (json && json.error && (json.error.message || json.error.code)) || res.text.slice(0, 200);
      const err = new Error('GLM_' + res.status + ':' + msg);
      err.upstream = res.status;
      throw err;
    }
    return pickText(json);
  });
}

/*-------------------------- 腾讯云一句话识别 --------------------------*/

/** 腾讯云签名（TC3-HMAC-SHA256）。这一步必须服务端做 —— 密钥绝不能进前端 */
function tcSign(secretId, secretKey, service, host, action, payload, region) {
  const now = Math.floor(Date.now() / 1000);
  /**
   * 签名里的日期必须是 **UTC** 日期（TC3 规范如此，本地时区会签出错误签名）。
   * 但本项目全仓禁用 toISOString()（见 docs/开发指引.md §5 日期铁律，
   * 那道门禁会扫出任何一处调用）。所以这里用 getUTC* 逐字段拼 ——
   * 输出与 `toISOString().slice(0, 10)` 逐字节相同，既守住红线又不改签名语义。
   */
  const utc = new Date(now * 1000);
  const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  const date = utc.getUTCFullYear() + '-' + p2(utc.getUTCMonth() + 1) + '-' + p2(utc.getUTCDate());

  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' +
    'host:' + host + '\n' +
    'x-tc-action:' + action.toLowerCase() + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST', '/', '',
    canonicalHeaders, signedHeaders, hashedPayload
  ].join('\n');

  const credentialScope = date + '/' + service + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256', String(now), credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const kDate = crypto.createHmac('sha256', 'TC3' + secretKey).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    authorization: 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    timestamp: now,
    region: region
  };
}

function transcribeTencent(audio, format) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) return Promise.reject(new Error('NO_TENCENT_KEY'));

  const host = 'asr.tencentcloudapi.com';
  const region = process.env.TENCENT_REGION || 'ap-guangzhou';
  const action = 'SentenceRecognition';

  const payload = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: '16k_en',        // 16k 英文模型
    SourceType: 1,                   // 1 = 音频数据直传
    VoiceFormat: (format || 'wav'),
    Data: audio.toString('base64'),
    DataLen: audio.length
  });

  const sig = tcSign(secretId, secretKey, 'asr', host, action, payload, region);

  return request({
    hostname: host,
    path: '/',
    method: 'POST',
    headers: {
      'Authorization': sig.authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(sig.timestamp),
      'X-TC-Version': '2019-06-14',
      'X-TC-Region': region,
      'Content-Length': Buffer.byteLength(payload)
    }
  }, Buffer.from(payload)).then(function (res) {
    const json = parseJson(res.text);
    if (res.status !== 200 || (json && json.Response && json.Response.Error)) {
      const e = json && json.Response && json.Response.Error;
      throw new Error('TENCENT_' + res.status + ':' + (e ? e.Code + '/' + e.Message : res.text.slice(0, 200)));
    }
    return pickText(json);
  });
}

/*-------------------------- 入口 --------------------------*/

/** 按环境变量与已配置的 Key 决定用哪个服务商 */
function resolveProvider() {
  const explicit = String(process.env.ASR_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'off') return 'off';
  if (explicit === 'glm' || explicit === 'tencent') return explicit;
  // 未显式指定：谁配了 Key 用谁（智谱优先，因为它可能与 AI 录入共用同一把 Key）
  if (process.env.GLM_API_KEY) return 'glm';
  if (process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) return 'tencent';
  return 'off';
}

exports.main = async function (event) {
  const action = (event && event.action) || 'transcribe';

  // 前端先探一下服务可用性，决定走哪条降级路径
  if (action === 'status') {
    const p = resolveProvider();
    // 2026-09-19 修：status 之前只看 provider 就报"就绪"，但显式 ASR_PROVIDER=tencent
    // 可以在**钥匙缺失**时照样返回 'tencent'（resolveProvider 对显式值不做钥匙检查）——
    // 于是 status 报 OK、真转写炸 NO_TENCENT_KEY，学生看到的是"还在准备中"这种假话。
    // 这里把与 transcribe 相同的钥匙检查补上：status 与真实可用性必须是同一份事实。
    let ready = false;
    if (p === 'glm') ready = !!process.env.GLM_API_KEY;
    else if (p === 'tencent') ready = !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
    return {
      ok: ready,
      provider: p,
      code: ready ? 'OK' : 'NOT_CONFIGURED',
      msg: ready
        ? '云端语音识别就绪（' + p + '）'
        : (p === 'off'
          ? '云函数未配置语音识别服务（需在云开发控制台配置环境变量）'
          : '已选 ' + p + ' 但密钥未配齐（云开发控制台 → 云函数 → 配置 → 环境变量）')
    };
  }

  if (action !== 'transcribe') {
    return { ok: false, code: 'BAD_ACTION', msg: '未知操作：' + action };
  }

  const provider = resolveProvider();
  if (provider === 'off') {
    return {
      ok: false, code: 'NOT_CONFIGURED',
      msg: '云端语音识别未配置。朗读评测的判定仍可用，但需要语音输入。'
    };
  }

  // 音频来源：前端上传到云存储拿 fileID，或直接传 base64
  let audio = null;
  let format = (event.format || 'wav').replace(/[^a-z0-9]/gi, '') || 'wav';

  if (event.audioBase64) {
    try {
      audio = Buffer.from(String(event.audioBase64), 'base64');
    } catch (e) {
      return { ok: false, code: 'BAD_AUDIO', msg: '音频数据无法解析' };
    }
  } else if (event.fileID) {
    try {
      const r = await require('wx-server-sdk').cloud.downloadFile({ fileID: event.fileID });
      audio = r.fileContent;
      const m = /\.([a-z0-9]+)$/i.exec(String(event.fileID));
      if (m) format = m[1].toLowerCase();
    } catch (e) {
      return { ok: false, code: 'DOWNLOAD_FAILED', msg: '读取录音失败' };
    }
  }

  if (!audio || !audio.length) {
    return { ok: false, code: 'NO_AUDIO', msg: '没有收到录音数据' };
  }
  if (audio.length > 1024 * 1024) {
    return { ok: false, code: 'AUDIO_TOO_BIG', msg: '录音太长了，按住读完单词就松手' };
  }

  // ---- 配额闸：放在所有守卫之后、真正调服务商之前 ----
  // 空音频/超大音频这些请求压根不会到达服务商，不该占配额（学生手滑连点
  // "没听清"不该被限流）。先占位再干活，避免并发请求一起通过检查。
  const q = await quota.guardQuota('asrProxy', 'transcribe');
  if (!q.allowed) {
    return { ok: false, code: q.code, msg: q.msg, remain: q.remain };
  }

  try {
    const text = provider === 'glm'
      ? await transcribeGlm(audio, format)
      : await transcribeTencent(audio, format);

    return {
      ok: true,
      provider: provider,
      text: String(text || '').trim(),
      bytes: audio.length
    };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // 把常见失败翻译成学生能懂的话，同时保留原始信息便于排查
    let code = 'ASR_FAILED';
    let hint = '这次没听清，再读一遍试试';
    if (/NO_GLM_KEY|NO_TENCENT_KEY/.test(msg)) {
      code = 'NOT_CONFIGURED'; hint = '云端语音识别未配置';
    } else if (/429|余额|quota|Quota|limit|Limit/.test(msg)) {
      code = 'QUOTA'; hint = '语音识别额度用完了';
    } else if (/401|403|Auth|auth|Signature/.test(msg)) {
      code = 'AUTH'; hint = '语音识别服务鉴权失败（Key 配置有误）';
    } else if (/TIMEOUT|timeout/.test(msg)) {
      code = 'TIMEOUT'; hint = '网络慢，没来得及识别';
    }
    return { ok: false, code: code, msg: hint, detail: msg.slice(0, 300) };
  }
};

// 配额纯函数导出，供门禁在裸 Node（不联网、不装 wx-server-sdk）下直接验证
exports._quota = quota;
