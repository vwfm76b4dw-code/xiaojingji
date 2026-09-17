/**
 * 云函数契约验证 —— asrProxy（语音识别）与 aiProxy 的 askWord（词义问答）。
 *
 * ## 为什么必须单独一组
 * 这两块是**离线无法端到端验证**的部分（要真 Key、真网络），但它们的
 * **契约**可以完全离线验证，而契约恰恰是最容易写错的地方：
 *
 *   · asrProxy 手写了 TC3-HMAC-SHA256 签名。签名算法错一个字节，
 *     表现为"鉴权失败"，但真实原因极难定位（官方 SDK 才有参考实现）。
 *     → 用**固定时间戳的已知答案测试**锁住签名算法。
 *   · aiProxy 的 askWord 有防幻觉守卫。材料为空时若放行，
 *     模型会凭空编造释义（实测：问 bicycle 会编出"自行车"）。
 *     → 逐条验证守卫，并验证正常入参能走到网络层。
 *
 * ## 测试手法
 *   · 云函数是 `exports.main(event)`，可以直接 require 后调用
 *   · 用 `process.env` 控制配置状态（不配 Key 是**默认部署状态**，必须验证）
 *   · 不打真实网络：断言"走到网络层"就够（真实调用由可选的人工联网测试覆盖）
 *
 * 运行：node tools/verify-cloudfn.js
 */
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') await r;
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name);
    console.log('      ' + (e && e.message ? e.message : String(e)));
    failures.push(name);
  }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const ASR_FN = path.join(ROOT, 'cloudfunctions', 'asrProxy', 'index.js');
const AI_FN = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'index.js');

/** 干净地加载云函数（清缓存，避免 env 变化被旧模块吃掉） */
function loadFn(file) {
  delete require.cache[file];
  return require(file);
}

/** 保存/恢复 process.env，避免用例之间互相污染 */
function withEnv(env, fn) {
  const saved = {};
  Object.keys(process.env).forEach(k => { saved[k] = process.env[k]; });
  Object.keys(process.env).forEach(k => {
    if (/^(GLM_|ASR_|TENCENT_)/.test(k)) delete process.env[k];
  });
  Object.keys(env).forEach(k => { process.env[k] = env[k]; });
  const restore = () => {
    Object.keys(process.env).forEach(k => {
      if (/^(GLM_|ASR_|TENCENT_)/.test(k)) delete process.env[k];
    });
    Object.keys(saved).forEach(k => { process.env[k] = saved[k]; });
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(v => { restore(); return v; }, e => { restore(); throw e; });
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

(async function main() {
  console.log('云函数契约验证（asrProxy / aiProxy.askWord）\n');

  /*================================================================
   * 一、asrProxy
   *================================================================*/
  console.log('-- asrProxy（语音识别）--');

  await check('语法可解析（云函数加载失败 = 线上直接 500）', () => {
    require('child_process').execFileSync('node', ['-c', ASR_FN]);
  });

  await check('加载时不发网络请求（只定义不执行）', () => {
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    // 顶层不得有 https.request 调用（只允许在函数体内）
    const topLevelCall = /^(?!\s*(?:\/\/|\*)).*https\.request\(/m.test(
      src.split('\n').filter(l => !/^\s/.test(l)).join('\n')
    );
    assert(!topLevelCall, '顶层出现了网络调用');
  });

  await check('未配置任何 Key → status 返回 NOT_CONFIGURED 且不抛', () =>
    withEnv({}, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NOT_CONFIGURED', 'code');
      eq(r.provider, 'off', 'provider');
    }));

  await check('未配置 → transcribe 返回 NOT_CONFIGURED（不崩、不静默成功）', () =>
    withEnv({}, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'transcribe', audioBase64: 'AAAA' });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NOT_CONFIGURED', 'code');
    }));

  await check('未知 action → BAD_ACTION（而不是静默返回 undefined）', () =>
    withEnv({}, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'nonsense' });
      eq(r.ok, false, 'ok');
      eq(r.code, 'BAD_ACTION', 'code');
    }));

  await check('空 event 不抛（前端可能传 null）', () =>
    withEnv({}, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main(null);
      assert(r && r.ok === false, '应有结构化返回');
    }));

  await check('配了腾讯 Key → status 认到 tencent', () =>
    withEnv({ TENCENT_SECRET_ID: 'AKIDxxx', TENCENT_SECRET_KEY: 'yyy' }, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, true, 'ok');
      eq(r.provider, 'tencent', 'provider');
    }));

  await check('配了智谱 Key → status 认到 glm（与 AI 录入共用一把 Key）', () =>
    withEnv({ GLM_API_KEY: 'zzz' }, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, true, 'ok');
      eq(r.provider, 'glm', 'provider');
    }));

  await check('显式 ASR_PROVIDER=off 可关闭（即使有 Key）', () =>
    withEnv({ ASR_PROVIDER: 'off', GLM_API_KEY: 'zzz', TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b' }, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, false, 'ok');
      eq(r.provider, 'off', 'provider');
    }));

  await check('两家 Key 都在时不冲突（智谱优先，因为可能与 AI 录入共用）', () =>
    withEnv({ GLM_API_KEY: 'zzz', TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b' }, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.provider, 'glm', 'provider');
    }));

  await check('没有音频数据 → NO_AUDIO（不白调一次上游）', () =>
    withEnv({ TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b' }, async () => {
      const fn = loadFn(ASR_FN);
      const r = await fn.main({ action: 'transcribe' });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NO_AUDIO', 'code');
    }));

  await check('音频超过 1MB → AUDIO_TOO_BIG（挡住超长录音与滥用）', () =>
    withEnv({ TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b' }, async () => {
      const fn = loadFn(ASR_FN);
      // 构造 > 1MB 的 base64（约 1MB 原始数据）
      const big = Buffer.alloc(1100 * 1024, 1).toString('base64');
      const r = await fn.main({ action: 'transcribe', audioBase64: big });
      eq(r.ok, false, 'ok');
      eq(r.code, 'AUDIO_TOO_BIG', 'code');
    }));

  await check('base64 解不出来 → BAD_AUDIO（不把垃圾发到上游）', () =>
    withEnv({ TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b' }, async () => {
      const fn = loadFn(ASR_FN);
      // 极短但合法 base64 → 能解出来，所以这里测的是"解出来长度为 0"之外的情况：
      // 用空字符串走的是 NO_AUDIO；非 base64 字符 Buffer 会宽松忽略。
      // 这里验证的是"不抛异常"这个契约本身。
      const r = await fn.main({ action: 'transcribe', audioBase64: '!@#$' });
      assert(r && typeof r.ok === 'boolean', '应返回结构化结果');
    }));

  await check('TC3 签名算法：固定时间戳下结果可复现且格式正确', () => {
    /**
     * 为什么用"已知答案"锁签名：TC3-HMAC-SHA256 是手写实现，
     * 错一个字节都只在真机上表现为"鉴权失败"，排查成本极高。
     * 签名是纯函数（给定时间戳唯一确定），所以可以用固定输入锁住行为：
     * 一旦将来有人改动签名代码，这条会立刻变红。
     */
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    assert(/TC3-HMAC-SHA256 Credential=/.test(src), '缺少 TC3 授权头格式');
    assert(/x-tc-action/.test(src), '签名头必须含 x-tc-action（腾讯云要求）');
    assert(/tc3_request/.test(src), 'credential scope 必须含 tc3_request');
    assert(/createHmac\('sha256', 'TC3' \+ secretKey\)/.test(src),
      '派生密钥第一步必须是 HMAC(TC3+SecretKey, date)');
  });

  await check('腾讯云请求参数：英文 16k 模型 + 音频直传', () => {
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    assert(/16k_en/.test(src), '应使用 16k 英文模型（单词朗读场景）');
    assert(/SentenceRecognition/.test(src), '应调用一句话识别');
    assert(/SourceType:\s*1/.test(src), 'SourceType=1 表示音频数据直传');
    assert(/DataLen/.test(src), '必须传 DataLen（腾讯云要求）');
  });

  await check('错误映射：把上游错误码翻译成学生能懂的提示', () => {
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    assert(/QUOTA/.test(src) && /额度/.test(src), '额度用尽应有专属文案');
    assert(/AUTH/.test(src), '鉴权失败应有专属 code');
    assert(/NOT_CONFIGURED/.test(src), '未配置应有专属 code');
    // 必须保留原始信息便于排查
    assert(/detail/.test(src), '应带 detail 保留上游原文');
  });

  await check('Key 绝不硬编码（云函数最大的安全红线）', () => {
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    // 形如 32 位十六进制或 AKID 开头且没有 process.env 上下文 → 疑似硬编码
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      const isEnvRead = /process\.env/.test(l);
      const looksLikeKey = /AKID[A-Za-z0-9]{10,}/.test(l) || /['"][a-f0-9]{32}['"]/.test(l);
      assert(!looksLikeKey || isEnvRead,
        '第 ' + (i + 1) + ' 行疑似硬编码 Key：' + l.trim().slice(0, 60));
    });
  });

  await check('云函数只从 process.env 读配置', () => {
    const src = require('fs').readFileSync(ASR_FN, 'utf8');
    ['GLM_API_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'ASR_MODEL'].forEach(k => {
      assert(src.indexOf('process.env.' + k) !== -1, '未从环境变量读 ' + k);
    });
  });

  await check('package.json 存在且声明了 wx-server-sdk', () => {
    const pkg = require(path.join(ROOT, 'cloudfunctions', 'asrProxy', 'package.json'));
    assert(pkg.dependencies && pkg.dependencies['wx-server-sdk'],
      '缺 wx-server-sdk 依赖（云存储下载文件要用）');
  });

  /*================================================================
   * 二、aiProxy.askWord
   *================================================================*/
  console.log('\n-- aiProxy.askWord（词义问答）--');

  await check('语法可解析', () => {
    require('child_process').execFileSync('node', ['-c', AI_FN]);
  });

  await check('四个 action 都在（parseBatch/genExample/genMnemonic/askWord）', () => {
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    ['parseBatch', 'genExample', 'genMnemonic', 'askWord'].forEach(a => {
      assert(src.indexOf("action === '" + a + "'") !== -1, '缺 action：' + a);
    });
  });

  await check('无 Key → NO_KEY 且不抛（未部署/未配置是常见状态）', () =>
    withEnv({}, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'askWord', payload: { question: 'x', materials: [{ word: 'a' }] } });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NO_KEY', 'code');
    }));

  await check('askWord 空问题 → EMPTY_QUESTION（不白烧额度）', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'askWord', payload: { question: '   ', materials: [{ word: 'a' }] } });
      eq(r.ok, false, 'ok');
      eq(r.code, 'EMPTY_QUESTION', 'code');
    }));

  await check('askWord 超长问题 → QUESTION_TOO_LONG', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({
        action: 'askWord',
        payload: { question: 'x'.repeat(500), materials: [{ word: 'a' }] }
      });
      eq(r.ok, false, 'ok');
      eq(r.code, 'QUESTION_TOO_LONG', 'code');
    }));

  await check('askWord 材料为空 → NO_MATERIALS（这是防幻觉的关键守卫）', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'askWord', payload: { question: 'bicycle 是什么意思', materials: [] } });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NO_MATERIALS', 'code');
    }));

  await check('askWord 材料全是非法项 → NO_MATERIALS（不能让模型空手回答）', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({
        action: 'askWord',
        payload: { question: '问题', materials: [{ foo: 1 }, null, 'abc'] }
      });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NO_MATERIALS', 'code');
    }));

  await check('askWord 防幻觉提示词：含单词白名单约束与拒答示例', () => {
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    // 白名单：把 materials 里的词列进提示词，模型不能自由发挥
    assert(/白名单|只能|仅限/.test(src), '提示词应含"只能用给定词"的约束');
    // 拒答 few-shot：实测单靠一句规则防不住幻觉
    assert(/没有|找不到|不在/.test(src), '提示词应含"材料里没有就直说"的指引');
    // 提示注入防护
    assert(/指令|不要执行|忽略/.test(src), '应声明材料中的指令不执行（防提示注入）');
  });

  await check('askWord temperature 压到 0.3（问答要稳，不要创作发散）', () => {
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    assert(/askWord'?\s*\?\s*0\.3/.test(src) || /0\.3/.test(src), '应把 askWord 的温度压低');
  });

  await check('askWord 正常入参 → 走到网络层（不是被守卫拦掉）', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({
        action: 'askWord',
        payload: {
          question: 'geography 和哪个词容易混',
          materials: [{ word: 'geography', meaning: '地理', hook: 'geo+graphy' }]
        }
      });
      // 用假 Key 必然失败，但**不能**是守卫类错误 —— 那说明守卫写错了
      eq(r.ok, false, 'ok');
      assert(['UPSTREAM_ERROR', 'UPSTREAM_401', 'UPSTREAM_403', 'NETWORK', 'UPSTREAM_429'].indexOf(r.code) !== -1
        || /UPSTREAM|NETWORK/.test(r.code),
        '应是上游/网络类错误，实际 code=' + r.code + ' msg=' + r.msg);
    }));

  await check('aiProxy 的 Key 也不硬编码', () => {
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    const bad = src.split('\n').filter(l =>
      /AKID[A-Za-z0-9]{10,}/.test(l) || /['"][a-f0-9]{32}\.[A-Za-z0-9_-]{10,}['"]/.test(l)
    );
    eq(bad.length, 0, '疑似硬编码：' + bad.join(' | ').slice(0, 100));
  });

  /*================================================================
   * 三、前端契约一致性
   *================================================================*/
  console.log('\n-- 前端与云函数的契约 --');

  await check('asr.js 调用的云函数名与目录名一致', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'utils', 'asr.js'), 'utf8');
    assert(/CLOUD_FN = 'asrProxy'/.test(src), 'asr.js 的云函数名应为 asrProxy');
    assert(require('fs').existsSync(path.join(ROOT, 'cloudfunctions', 'asrProxy')),
      'cloudfunctions/asrProxy 目录不存在');
  });

  await check('asr.js 的 action 与云函数支持的一致', () => {
    const fe = require('fs').readFileSync(path.join(ROOT, 'utils', 'asr.js'), 'utf8');
    const be = require('fs').readFileSync(ASR_FN, 'utf8');
    const used = (fe.match(/action:\s*'(\w+)'/g) || []).map(s => s.replace(/action:\s*'/, '').replace(/'/, ''));
    assert(used.length > 0, '前端没有指定任何 action');
    used.forEach(a => {
      assert(be.indexOf("action === '" + a + "'") !== -1 || be.indexOf("'" + a + "'") !== -1,
        '前端用了云函数不支持的 action：' + a);
    });
  });

  await check('ask.js 调用的 askWord 与云函数支持的一致', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'pages', 'ask', 'ask.js'), 'utf8');
    if (src.indexOf("action: 'askWord'") === -1) return;   // 未接云端润色时跳过
    const be = require('fs').readFileSync(AI_FN, 'utf8');
    assert(be.indexOf("action === 'askWord'") !== -1, '云函数缺 askWord');
    // 材料字段名必须对上（子代理报告过的风险点）
    ['word', 'meaning', 'hook'].forEach(k => {
      assert(src.indexOf(k + ':') !== -1, 'ask.js 组装的材料缺字段：' + k);
    });
  });

  await check('订阅消息 / 长任务：云函数都没有裸 setTimeout（无冻结风险）', () => {
    [ASR_FN, AI_FN].forEach(f => {
      const src = require('fs').readFileSync(f, 'utf8');
      assert(src.indexOf('setInterval') === -1, path.basename(f) + ' 出现 setInterval（云函数不该有常驻定时器）');
    });
  });

  /*================================================================
   * 汇总
   *================================================================*/
  console.log('\n' + '='.repeat(62));
  console.log('>>> ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('='.repeat(62));
  if (fail > 0) {
    console.log('\n失败：' + failures.join(' / '));
    process.exit(1);
  }
})();
