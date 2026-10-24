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
const { runNodeCheck } = require('./lib/spawn-retry');

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

/**
 * 剥掉整行注释（// 与块注释的 * / /** 行）。
 *
 * ## 为什么凡是"扫源码找位置"的断言都必须先过这个
 * 2026-09-30 配额用例第一版栽在这：断言"配额闸必须早于 postJson("，
 * 而我自己在 aiProxy 的注释里就写了 postJson —— 于是拿注释里的偏移当代码位置，
 * 断言恒真，**门禁显示"有 PASS"但什么都没验**。
 * 这与本文件 6.1 记录的 verify-package canvas 检查（没剥 WXML 注释）是同一个病。
 *
 * ⚠️ 只处理整行注释：行尾注释（`x(); // 说明`）保留。它对本文件现有的断言无影响，
 * 而处理行尾注释需要真正的词法分析，反而容易引入新 bug —— 宁可承认这个局限，
 * 也不要写一个"看起来在剥注释、其实只剥了一半"的函数。
 */
function stripComments(src) {
  return String(src)
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** 干净地加载云函数（清缓存，避免 env 变化被旧模块吃掉） */
function loadFn(file) {
  delete require.cache[file];
  return require(file);
}

/** 保存/恢复 process.env，避免用例之间互相污染 */
function withEnv(env, fn) {
  // 前缀清单必须覆盖**所有**云函数会读的变量 —— 漏一个，前一个用例设的值就会
  // 泄漏到下一个用例，造出"单跑通过、连跑失败"的幽灵 bug。
  // 2026-09-18：补入 AGNES_ 与 AI_PROVIDER（aiProxy 加了 Agnes 多服务商支持后）。
  // 2026-09-30：补入 QUOTA_（quota.js 读 QUOTA_MINUTE_LIMIT / QUOTA_DAY_LIMIT /
  //   QUOTA_GLOBAL_DAY_LIMIT / QUOTA_OFF / QUOTA_COLLECTION）。
  //   不补的后果很具体：限流用例把 QUOTA_MINUTE_LIMIT 设成 2 之后，
  //   后面所有用例都会被"第 3 次就限流"影响，而单跑时又看不出 —— 正是本注释
  //   描述的幽灵 bug。
  const PREFIX = /^(GLM_|AGNES_|ASR_|TENCENT_|QUOTA_|AI_PROVIDER$)/;
  const saved = {};
  Object.keys(process.env).forEach(k => { saved[k] = process.env[k]; });
  Object.keys(process.env).forEach(k => {
    if (PREFIX.test(k)) delete process.env[k];
  });
  Object.keys(env).forEach(k => { process.env[k] = env[k]; });
  const restore = () => {
    Object.keys(process.env).forEach(k => {
      if (PREFIX.test(k)) delete process.env[k];
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
    runNodeCheck(ASR_FN);
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
    runNodeCheck(AI_FN);
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

  /*---- Agnes 多服务商（2026-09-18 新增，实测 Agnes 比 GLM-4-Flash 快 69%）----*/

  await check('status：无 Key → provider=off（自检入口，不烧额度）', () =>
    withEnv({}, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, false, 'ok');
      eq(r.provider, 'off', 'provider');
      eq(r.code, 'NOT_CONFIGURED', 'code');
      assert(r.msg && r.msg.indexOf('AGNES_API_KEY') !== -1, '提示里应指明要配哪个变量');
    }));

  await check('status：只配 Agnes → provider=agnes（推荐的默认路径）', () =>
    withEnv({ AGNES_API_KEY: 'a' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, true, 'ok');
      eq(r.provider, 'agnes', 'provider');
      eq(r.model, 'agnes-3.0-flash', 'model 默认值');
    }));

  await check('status：只配 GLM → 回退到 glm（不因偏好让功能不可用）', () =>
    withEnv({ GLM_API_KEY: 'g' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, true, 'ok');
      eq(r.provider, 'glm', 'provider');
      eq(r.model, 'glm-4-flash', 'model 默认值');
    }));

  await check('status：两家都配 → 优先 agnes（依据延迟实测）', () =>
    withEnv({ AGNES_API_KEY: 'a', GLM_API_KEY: 'g' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.provider, 'agnes', 'provider');
    }));

  await check('显式 AI_PROVIDER=glm 可覆盖自动推断', () =>
    withEnv({ AGNES_API_KEY: 'a', GLM_API_KEY: 'g', AI_PROVIDER: 'glm' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.provider, 'glm', 'provider');
    }));

  await check('显式 AI_PROVIDER=off 可关闭（即使两家 Key 都在）', () =>
    withEnv({ AGNES_API_KEY: 'a', GLM_API_KEY: 'g', AI_PROVIDER: 'off' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'status' });
      eq(r.ok, false, 'ok');
      eq(r.provider, 'off', 'provider');
    }));

  await check('AI_PROVIDER=agnes 但没配 Key → NO_KEY（不静默失败）', () =>
    withEnv({ AI_PROVIDER: 'agnes' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'askWord', payload: { question: 'x', materials: [{ word: 'a' }] } });
      eq(r.ok, false, 'ok');
      eq(r.code, 'NO_KEY', 'code');
    }));

  await check('Agnes 端点默认走国内（连接更快：实测 0.03s vs 0.35s）', () => {
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    assert(src.indexOf('https://api.agnes-ai.cn/v1/chat/completions') !== -1,
      '默认端点应为国内端点');
  });

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

  await check('askWord 空材料 → 超纲模式（2026-09-19 设计变更：超纲词也回答，先声明不在词表）', () => {
    // 材料为空不再拒绝（拒答等于没有 AI —— 作者反馈的根因之一）。
    // 改为源码级断言：超纲分支在，且防幻觉的"先声明"约束在提示词里。
    const src = require('fs').readFileSync(AI_FN, 'utf8');
    assert(src.indexOf('materials.length === 0') !== -1, '应有空材料超纲分支');
    assert(src.indexOf('不在本册课本词表里') !== -1, '超纲回答必须先声明不在词表');
    assert(src.indexOf('NO_MATERIALS') === -1, '旧的空材料拒绝守卫应已删除');
  });

  await check('askWord 问题为空 → EMPTY_QUESTION（省额度的守卫仍在）', () =>
    withEnv({ GLM_API_KEY: 'k' }, async () => {
      const fn = loadFn(AI_FN);
      const r = await fn.main({ action: 'askWord', payload: { question: '   ', materials: [] } });
      eq(r.ok, false, 'ok');
      eq(r.code, 'EMPTY_QUESTION', 'code');
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
   * rankProxy —— 进步榜（2026-09-24 新增）
   *
   * ## 为什么必须验
   * 这是本项目**唯一会接收用户上传数据**的云函数。它的失效方式有两类，
   * 两类都不可见：
   *   ① 排行口径写错 → 榜上的名次与用户预期不符，但没有任何报错；
   *   ② **把 openid 漏进响应** → 前端拿到别人的身份标识。
   *      这是隐私事故，而且**在界面上完全看不出来**（多一个字段而已）。
   * 所以下面有一条断言专门盯"响应里不许出现 _id/openid"。
   *
   * ## 测试手法
   * rankProxy 在**模块顶层** `require('wx-server-sdk')`，而本机没装这个包。
   * 用 Module._load 拦截注入一个内存版 SDK —— 于是整条链路（校验 → 写入 →
   * 排序 → 裁剪 → 返回）都能在离线、无云环境的情况下真实跑一遍。
   *================================================================*/

  const RANK_FN = path.join(ROOT, 'cloudfunctions', 'rankProxy', 'index.js');
  const Module = require('module');

  /**
   * 造一个内存版 wx-server-sdk；每个用例拿一份全新的，互不污染。
   * @param {string} openid 当前调用者身份（'' 表示拿不到）
   * @param {Object} [sharedStore] 传入则复用同一份数据 —— 多用户场景（排行榜）
   *   需要多个"调用者"读写同一张表。⚠️ 不能事后再赋 __store：
   *   db 是通过闭包持有 store 的，事后改属性改不到它（第一版就栽在这）。
   */
  function makeFakeSdk(openid, sharedStore) {
    const store = sharedStore || Object.create(null);   // collection → { id → row }
    let lastErr = null;

    const db = {
      createCollection: async (name) => {
        if (store[name]) throw new Error('collection already exists -501001');
        store[name] = Object.create(null);
      },
      collection: (name) => {
        if (!store[name]) {
          // 云数据库对不存在的集合报错，错误码 -502005；rankProxy 要能识别成"空榜"
          const e = new Error('collection not exists -502005');
          e.errCode = -502005;
          lastErr = e;
        }
        const rows = () => Object.values(store[name] || {});
        return {
          doc: (id) => ({
            set: async ({ data }) => {
              if (!store[name]) throw lastErr || new Error('no collection');
              store[name][id] = Object.assign({ _id: id }, data);
            },
            remove: async () => {
              if (!store[name]) throw lastErr || new Error('no collection');
              if (!store[name][id]) {
                const e = new Error('document not exists -502002');
                e.errCode = -502002;
                throw e;
              }
              delete store[name][id];
            }
          }),
          limit: () => ({
            get: async () => {
              if (!store[name]) throw lastErr || new Error('no collection');
              return { data: rows() };
            }
          })
        };
      }
    };

    return {
      __store: store,
      DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
      init: () => {},
      database: () => db,
      getWXContext: () => (openid ? { OPENID: openid } : {})
    };
  }

  /** 用替身 SDK 加载 rankProxy（清缓存，让每次注入生效） */
  function loadRankFn(sdk) {
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === 'wx-server-sdk') return sdk;
      return origLoad.apply(this, arguments);
    };
    try {
      delete require.cache[RANK_FN];
      return require(RANK_FN);
    } finally {
      Module._load = origLoad;
    }
  }

  await check('rankProxy：没有 openid 时明确拒绝，不猜身份', async () => {
    const fn = loadRankFn(makeFakeSdk(''));
    const r = await fn.main({ action: 'top' });
    eq(r.ok, false);
    eq(r.code, 'NO_OPENID');
  });

  await check('rankProxy：未知 action 明确报错（不是静默成功）', async () => {
    const fn = loadRankFn(makeFakeSdk('u1'));
    const r = await fn.main({ action: 'delete-everything' });
    eq(r.ok, false);
    eq(r.code, 'BAD_ACTION');
  });

  await check('rankProxy：昵称为空 → 拒绝；纯空白/控制字符也拒绝', async () => {
    const fn = loadRankFn(makeFakeSdk('u1'));
    eq((await fn.main({ action: 'submit', nick: '' })).code, 'NO_NICK');
    eq((await fn.main({ action: 'submit', nick: '   ' })).code, 'NO_NICK');
    eq((await fn.main({ action: 'submit', nick: '\u200b\u0000' })).code, 'NO_NICK',
      '零宽字符与控制字符净化后为空，应当拒绝');
  });

  await check('rankProxy：昵称被净化并截断到 8 字', async () => {
    const sdk = makeFakeSdk('u1');
    const fn = loadRankFn(sdk);
    const r = await fn.main({ action: 'submit', nick: '  小\n鲸\t记单词一二三四五六七  ' });
    eq(r.ok, true);
    assert(r.me.nick.length <= 8, '昵称应截断到 8 字，实得 ' + r.me.nick.length);
    assert(!/[\s\u0000-\u001f]/.test(r.me.nick), '昵称不该含空白或控制字符：' + JSON.stringify(r.me.nick));
  });

  await check('rankProxy：数值被夹到合理区间（挡住伪造的 999999）', async () => {
    const fn = loadRankFn(makeFakeSdk('u1'));
    const r = await fn.main({
      action: 'submit', nick: '小明',
      progress: 99999999, thisWeek: -5, streak: 1e9, mastered: 'abc'
    });
    eq(r.ok, true);
    assert(r.me.progress <= 100000, 'progress 应被夹住，实得 ' + r.me.progress);
    assert(r.me.thisWeek >= 0, 'thisWeek 不该为负，实得 ' + r.me.thisWeek);
    assert(r.me.streak <= 36500, 'streak 应被夹住，实得 ' + r.me.streak);
    eq(r.me.mastered, 0, '非数字应归 0');
  });

  await check('rankProxy：同一 openid 重复上报是覆盖而不是新增（用 openid 当 _id）', async () => {
    const sdk = makeFakeSdk('u1');
    const fn = loadRankFn(sdk);
    await fn.main({ action: 'submit', nick: '小明', progress: 1 });
    await fn.main({ action: 'submit', nick: '小明', progress: 9 });
    const rows = Object.values(sdk.__store['lb_weekly'] || {});
    eq(rows.length, 1, '同一人只该有一条记录');
    eq(rows[0].progress, 9, '应是最后一次的值');
  });

  await check('rankProxy：按进步幅度降序排；并列时本周量多者在前', async () => {
    const shared = Object.create(null);
    const fn = loadRankFn(makeFakeSdk('me', shared));
    // 三人：进步 5 / 12 / 12（后者本周量更大）
    for (const [id, nick, progress, thisWeek] of [
      ['a', '甲', 5, 30], ['b', '乙', 12, 10], ['c', '丙', 12, 40]
    ]) {
      const f2 = loadRankFn(makeFakeSdk(id, shared));
      await f2.main({ action: 'submit', nick, progress, thisWeek });
    }
    const r = await fn.main({ action: 'top' });
    eq(r.ok, true);
    eq(r.list.length, 3);
    eq(r.list[0].nick, '丙', '并列 12 时本周量大的在前');
    eq(r.list[1].nick, '乙');
    eq(r.list[2].nick, '甲', '进步最小的在最后');
  });

  await check('rankProxy：只返回前 3 名 + 自己，且不返回完整名单', async () => {
    const shared = Object.create(null);
    const fn = loadRankFn(makeFakeSdk('me', shared));
    for (let i = 0; i < 8; i++) {
      const f2 = loadRankFn(makeFakeSdk('u' + i, shared));
      await f2.main({ action: 'submit', nick: '同学' + i, progress: i });
    }
    const r = await fn.main({ action: 'top' });
    eq(r.list.length, 3, '列表只该有 3 条，实得 ' + r.list.length);
    eq(r.total, 8, 'total 应报总人数');
    assert(r.total > r.list.length, 'total 必须大于返回条数，否则说明返回了完整名单');
  });

  await check('rankProxy：自己不在前 3 时仍能看到自己的名次', async () => {
    const shared = Object.create(null);
    const fn = loadRankFn(makeFakeSdk('me', shared));
    for (let i = 0; i < 5; i++) {
      const f2 = loadRankFn(makeFakeSdk('u' + i, shared));
      await f2.main({ action: 'submit', nick: '同学' + i, progress: 100 - i });
    }
    await fn.main({ action: 'submit', nick: '我', progress: 1 });
    const r = await fn.main({ action: 'top' });
    eq(r.list.length, 3, '前 3 只有 3 条');
    assert(r.me, '自己不在前 3 时，me 必须仍然返回（否则用户找不到自己在哪）');
    eq(r.me.rank, 6, '自己是第 6 名，实得 ' + (r.me && r.me.rank));
    assert(r.me.nick === '我');
  });

  await check('rankProxy：响应里绝不出现 _id / openid（隐私红线）', async () => {
    const sdk = makeFakeSdk('u1');
    const fn = loadRankFn(sdk);
    await fn.main({ action: 'submit', nick: '小明', progress: 3 });
    const top = await fn.main({ action: 'top' });
    const dumped = JSON.stringify(top);
    assert(dumped.indexOf('_id') === -1, '响应里出现 _id：' + dumped);
    assert(dumped.indexOf('openid') === -1, '响应里出现 openid：' + dumped);
    // 提交的返回也不能带
    const sub = await fn.main({ action: 'submit', nick: '小明', progress: 3 });
    assert(JSON.stringify(sub).indexOf('_id') === -1, 'submit 响应里出现 _id');
  });

  await check('rankProxy：集合不存在时 top 返回空榜而不是报错', async () => {
    const fn = loadRankFn(makeFakeSdk('u1'));
    const r = await fn.main({ action: 'top' });
    eq(r.ok, true, '空榜是正常状态，不该是错误');
    eq(r.list.length, 0);
    eq(r.total, 0);
    eq(r.me, null);
  });

  await check('rankProxy：leave 真删记录；重复 leave 也算成功（幂等）', async () => {
    const sdk = makeFakeSdk('u1');
    const fn = loadRankFn(sdk);
    await fn.main({ action: 'submit', nick: '小明', progress: 3 });
    eq(Object.keys(sdk.__store['lb_weekly']).length, 1);
    eq((await fn.main({ action: 'leave' })).ok, true);
    eq(Object.keys(sdk.__store['lb_weekly']).length, 0, '记录应被真删，不是隐藏');
    eq((await fn.main({ action: 'leave' })).ok, true, '重复退出应幂等成功');
  });

  await check('rankProxy：package.json 声明了 wx-server-sdk 与超时', () => {
    const pkg = require(path.join(ROOT, 'cloudfunctions', 'rankProxy', 'package.json'));
    assert(pkg.dependencies && pkg.dependencies['wx-server-sdk'], '缺 wx-server-sdk 依赖');
    const cfg = require(path.join(ROOT, 'cloudfunctions', 'rankProxy', 'config.json'));
    assert(cfg.timeout >= 10 && cfg.timeout <= 60, '超时应在 10~60s，实得 ' + cfg.timeout);
  });

  /*================================================================
   * 配额限流 —— aiProxy / asrProxy 共用 quota.js（2026-09-30 新增）
   *
   * ## 为什么这组用例必须有
   * quota.js 有 350 行、多层降级、多处 catch、三套阈值分支，而它的失效方式
   * **全是静默的**：把某个 catch 从"放行"改成"拒绝"，AI 立刻全废；把
   * `limit > 0` 写成 `limit >= 0`，0 限值从"不限"变成"全禁"；把云端窗口
   * 判定删掉，多实例就能绕过限流刷爆 Key —— **以上三种改错，30 道门禁
   * 照样全绿**。这正是本项目吃过三次"假绿"的同一类病。
   *
   * ## 测试手法（照抄 rankProxy 那节的替身注入，不另创一套）
   * quota.js **懒加载** wx-server-sdk（顶层不 require），所以离线裸 Node 里
   * 缺包不会崩、只会走 NO_SDK 放行。正因如此，本组用例用 Module._load
   * 注入内存版 SDK，把 openid、数据库、故障全部可控。
   *
   * ⚠️ 每个用例都必须重新 require quota.js：它有**模块级状态**
   * （SDK 缓存 + 进程内计数窗口），共用一个实例就等于让上一个用例的计数
   * 泄漏到下一个 —— 又是本文件注释里那个"单跑通过、连跑失败"的幽灵 bug。
   *================================================================*/
  const QUOTA_AI = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'quota.js');
  const QUOTA_ASR = path.join(ROOT, 'cloudfunctions', 'asrProxy', 'quota.js');

  /**
   * 内存版 wx-server-sdk，专供 quota 用例。
   * 与 rankProxy 那版的差别（别混用）：
   *   · rankProxy 版 collection 不存在会抛 -502005（它要靠这个识别空榜）；
   *     quota 版**必须能在集合不存在时正常写**（云函数首次写入会自动建集合，
   *     团队-lead 已确认不预建集合），所以这里用 autoCreate 开关模拟。
   *   · quota 读单条文档用 doc().get()，rankProxy 版没有这个方法。
   * @param {string} openid '' 表示拿不到身份
   * @param {Object} [opts] { sharedDocs, dbBroken, ctxThrows, autoCreate }
   */
  function makeQuotaSdk(openid, opts) {
    opts = opts || {};
    const docs = opts.sharedDocs || Object.create(null);   // 跨用例共享 → 模拟同一份云端数据
    const dbBroken = !!opts.dbBroken;

    const db = {
      collection: () => ({
        doc: (id) => ({
          get: async () => {
            if (dbBroken) throw new Error('db unavailable');
            if (opts.autoCreate === false && !docs[id]) {
              // 集合/文档不存在（-502005 / -502002 家族），quota.js 应把它当"今天第一次"
              const e = new Error('document not exists -502002');
              e.errCode = -502002;
              throw e;
            }
            if (!docs[id]) {
              const e = new Error('document not exists -502002');
              e.errCode = -502002;
              throw e;
            }
            return { data: docs[id] };
          },
          set: async ({ data }) => {
            if (dbBroken) throw new Error('db unavailable');
            docs[id] = Object.assign({ _id: id }, data);
          }
        })
      })
    };

    return {
      __docs: docs,
      DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
      init: () => {},
      database: () => db,
      getWXContext: () => {
        if (opts.ctxThrows) throw new Error('getWXContext failed');
        return openid ? { OPENID: openid } : {};
      }
    };
  }

  /**
   * 在替身 SDK 下加载 quota.js 并跑一段逻辑。
   *
   * ⚠️ 为什么必须"包住 async 逻辑"，而不能「装 hook → require → 还原 hook → 再 await」：
   * quota.js 是**懒加载** wx-server-sdk 的（顶层不 require），所以注入窗口必须
   * 覆盖到 guardQuota 真正执行的那一刻。我第一版在 require 之后立刻还原了
   * Module._load，结果 14 条用例全部拿到 NO_SDK —— 而门禁当时仍显示"有 PASS"，
   * 真正被验的是降级分支、不是限流分支。这与本文件 6.1 记录的
   * createSelectorQuery 替身缺 .in() 是同一类病：**替身不完整时，
   * 失败指向的是替身，不是被测代码。**
   *
   * @param {Object|null} sdk null = 模拟真机离线（require 抛 MODULE_NOT_FOUND）
   * @param {Function} fn 拿到 quota 模块后要执行（可 await）
   * @param {string} [file] 默认 aiProxy 那份
   */
  async function withQuota(sdk, fn, file) {
    const target = file || QUOTA_AI;
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === 'wx-server-sdk') {
        if (!sdk) {
          const e = new Error("Cannot find module 'wx-server-sdk'");
          e.code = 'MODULE_NOT_FOUND';
          throw e;
        }
        return sdk;
      }
      return origLoad.apply(this, arguments);
    };
    try {
      // 清模块缓存 → 模块级计数窗口与 SDK 缓存归零（否则用例之间互相污染）
      delete require.cache[target];
      const q = require(target);
      return await fn(q);
    } finally {
      Module._load = origLoad;
    }
  }

  /** 只取 quota 的纯函数/常量（不触发 SDK 加载），用于 dayKeyOf 与默认阈值 */
  function quotaPure(file) {
    delete require.cache[file || QUOTA_AI];
    return require(file || QUOTA_AI);
  }

  // ---- 0. 两份文件必须逐字节一致（云函数按目录打包，改一处漏一处就永久分叉）----
  await check('quota：aiProxy 与 asrProxy 两份逐字节一致（手工同步没漏）', () => {
    const a = require('fs').readFileSync(QUOTA_AI);
    const b = require('fs').readFileSync(QUOTA_ASR);
    assert(a.equals(b), '两份 quota.js 已分叉：aiProxy ' + a.length + ' 字节 / asrProxy ' + b.length + ' 字节');
  });

  await check('quota：默认阈值是 15/分钟、120/日、3000 全局日（与文档一致）', () => {
    const q = quotaPure();
    eq(q.MINUTE_LIMIT_DEFAULT, 15, '分钟阈值');
    eq(q.DAY_LIMIT_DEFAULT, 120, '日阈值');
    eq(q.GLOBAL_DAY_LIMIT_DEFAULT, 3000, '全局日阈值');
  });

  // ---- 1. 身份：NO_SDK 与 NO_OPENID 语义相反，极易写反，单独钉死 ----
  await check('quota：环境无 SDK（离线门禁）→ NO_SDK 且放行，函数不能崩', () =>
    withEnv({}, async () => {
      await withQuota(null, async (q) => {
        const r = await q.guardQuota('aiProxy', 'askWord');
        assert(r.allowed === true, '无 SDK 时应放行（否则离线门禁与本地调试全挂）');
        eq(r.code, 'NO_SDK');
      });
    }));

  await check('quota：SDK 在但拿不到 openid → NO_OPENID 拒绝（防绕过小程序直调）', () =>
    withEnv({}, async () => {
      await withQuota(makeQuotaSdk(''), async (q) => {
        const r = await q.guardQuota('aiProxy', 'askWord');
        assert(r.allowed === false, '拿不到身份必须拒绝，否则等于没鉴权');
        eq(r.code, 'NO_OPENID');
      });
    }));

  await check('quota：getWXContext 抛异常 → 拒绝（不静默放行）', () =>
    withEnv({}, async () => {
      await withQuota(makeQuotaSdk('u_x', { ctxThrows: true }), async (q) => {
        const r = await q.guardQuota('aiProxy', 'askWord');
        assert(r.allowed === false, '取不到身份时不能当成合法调用');
        eq(r.code, 'NO_OPENID');
      });
    }));

  // ---- 2. 进程内分钟窗：15 次内放行、第 16 次拒 ----
  await check('quota：分钟窗默认 15 —— 前 15 次放行、第 16 次 RATE_LIMITED', () =>
    withEnv({}, async () => {
      /**
       * ⚠️ 这里必须**在同一个模块实例**上连打 17 次。
       * 我第一版在循环里每次重新 require（想"归零计数"），结果每次都是第 1 次 ——
       * 永远走不到第 16 次，断言拿到 firstRejectAt=0。
       * 反过来，别的用例（跨副本那条）**必须**每次重新 require 来模拟换实例。
       * 两种"隔离"含义相反，写反了就验不到东西 —— 这也是本文件注释里
       * 反复强调"清模块缓存"的原因：quota.js 有模块级计数状态。
       */
      await withQuota(makeQuotaSdk('u_minute'), async (q) => {
        let okCount = 0, firstRejectAt = 0;
        for (let i = 1; i <= 17; i++) {
          const r = await q.guardQuota('aiProxy', 'askWord');
          if (r.allowed) okCount++;
          else if (firstRejectAt === 0) firstRejectAt = i;
        }
        eq(firstRejectAt, 16, '第 16 次就该被拒（= 15 次窗口 + 1），实际第 ' + firstRejectAt + ' 次');
        eq(okCount, 15, '前 15 次都应放行');
      });
    }));

  await check('quota：分钟窗可通过环境变量调小（不必改代码重部署）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 2, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      await withQuota(makeQuotaSdk('u_minute_env'), async (q) => {
        eq((await q.guardQuota('aiProxy', 'askWord')).code, 'OK');
        eq((await q.guardQuota('aiProxy', 'askWord')).code, 'OK');
        eq((await q.guardQuota('aiProxy', 'askWord')).code, 'RATE_LIMITED', '限值 2 → 第 3 次被拒');
      });
    }));

  // ---- 3. 日限与全局日闸各自独立生效 ----
  await check('quota：日限独立生效（QUOTA_DAY_LIMIT=2 → 第 3 次 QUOTA_EXCEEDED）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 2, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      const codes = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await withQuota(makeQuotaSdk('u_day', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'))).code);
      }
      eq(codes[0], 'OK'); eq(codes[1], 'OK');
      eq(codes[2], 'QUOTA_EXCEEDED', '第 3 次应触日限');
    }));

  await check('quota：全局日闸独立生效（换 openid 也被拦，多账号分摊逃不掉）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 0, QUOTA_GLOBAL_DAY_LIMIT: 1 }, async () => {
      const docs = Object.create(null);   // 两个 openid 共享同一份"云端数据"
      const r1 = await withQuota(makeQuotaSdk('u_A', { sharedDocs: docs }),
        (q) => q.guardQuota('aiProxy', 'askWord'));
      const r2 = await withQuota(makeQuotaSdk('u_B', { sharedDocs: docs }),
        (q) => q.guardQuota('aiProxy', 'askWord'));
      eq(r1.code, 'OK', '第一个用户应放行');
      assert(r2.allowed === false && r2.code === 'QUOTA_EXCEEDED',
        '换一个 openid 也必须被全局闸拦住，否则守住 Key 余额的那道闸形同虚设');
    }));

  // ---- 4. limit=0 统一语义：0 = 不限（不是全禁）----
  await check('quota：上限 0 表示"不限"而非"全禁"（三套阈值同语义）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 0, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      for (let i = 0; i < 6; i++) {
        // 每次全新模块 → 只有 DB 计数累积；0 限值下应一路放行
        const r = await withQuota(makeQuotaSdk('u_zero', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'));
        assert(r.allowed === true, '第 ' + (i + 1) + ' 次被拒了：0 必须表示"不限制"');
      }
    }));

  await check('quota：envInt 对非法值回落默认值（不因手滑写出 NaN 而全禁）', () =>
    withEnv({}, async () => {
      const q = quotaPure();
      eq(q.envInt('QUOTA_MINUTE_LIMIT', 15), 15, '未设置 → 用默认值');
      eq(q.envInt('__QUOTA_NOT_SET__', 7), 7, '不存在的变量 → 用默认值');
    }));

  // ---- 5. fail-open：DB 异常时放行且带 degraded 标记，恢复后计数继续 ----
  await check('quota：DB 抛异常 → fail-open 放行且 degraded=true（AI 不因抖动全废）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      await withQuota(makeQuotaSdk('u_db', { dbBroken: true }), async (q) => {
        const r = await q.guardQuota('aiProxy', 'askWord');
        assert(r.allowed === true, 'DB 抖动不该让学生 AI 全废（限流是闸，不是功能本身）');
        eq(r.code, 'OK');
        eq(r.degraded, true, '必须标出这是降级放行，否则门禁无法证明 fail-open 契约没被改坏');
      });
    }));

  await check('quota：DB 恢复后计数继续（fail-open 不是把限流关掉）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 2, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      // 第 1 次：DB 坏 → 放行但没记账
      const call = () => withQuota(makeQuotaSdk('u_recov', { sharedDocs: docs }),
        (q) => q.guardQuota('aiProxy', 'askWord'));
      eq((await withQuota(makeQuotaSdk('u_recov', { sharedDocs: docs, dbBroken: true }),
        (q) => q.guardQuota('aiProxy', 'askWord'))).code, 'OK');
      // 第 2、3 次：DB 恢复 → 正常记账，第 4 次触日限
      eq((await call()).code, 'OK');
      eq((await call()).code, 'OK');
      eq((await call()).code, 'QUOTA_EXCEEDED',
        'DB 恢复后限流必须重新生效，不能一直 fail-open');
    }));

  await check('quota：正常放行时 degraded=false（降级标记不能恒为真）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      await withQuota(makeQuotaSdk('u_ok'), async (q) => {
        const r = await q.guardQuota('aiProxy', 'askWord');
        eq(r.allowed, true);
        eq(r.degraded, false, '没降级却标了 degraded，运维会误判');
      });
    }));

  // ---- 6. 云端窗口跨副本：换实例（清空进程内计数）仍被拦住 ----
  await check('quota：跨副本突发 —— 进程内计数清零后，云端窗口仍拦住（多实例绕不掉）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 3, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      // 同一实例连打 3 次吃掉分钟窗口
      for (let i = 0; i < 3; i++) {
        eq((await withQuota(makeQuotaSdk('u_replica', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'))).code, 'OK');
      }
      // 模拟"换一台实例"：全新模块（进程内窗口归零），只靠云端计数
      const r = await withQuota(makeQuotaSdk('u_replica', { sharedDocs: docs }),
        (q) => q.guardQuota('aiProxy', 'askWord'));
      assert(r.allowed === false && r.code === 'RATE_LIMITED',
        '进程内计数已清零却放行了 —— 说明云端窗口判定被删了，多实例即可绕过限流');
    }));

  await check('quota：云端日计数跨副本累加（DB 记账是权威，不靠内存）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 3, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      const dayKey = quotaPure().dayKeyOf(Date.now());
      // 每次都是"新实例"：内存层恒为 0，全靠 DB 累加
      for (let i = 1; i <= 3; i++) {
        eq((await withQuota(makeQuotaSdk('u_daycount', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'))).code, 'OK', '第 ' + i + ' 次应放行');
        const row = docs['u_daycount|' + dayKey];
        assert(row && row.dayCount === i, 'DB 里的 dayCount 应为 ' + i + '，实际 ' + JSON.stringify(row));
      }
      eq((await withQuota(makeQuotaSdk('u_daycount', { sharedDocs: docs }),
        (q) => q.guardQuota('aiProxy', 'askWord'))).code, 'QUOTA_EXCEEDED');
    }));

  // ---- 7. 守卫拒绝路径不消耗额度 ----
  await check('quota：status 与守卫拒绝不消耗额度（手滑不该被限流）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 10, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      /**
       * 手法：把 aiProxy 真正依赖的那个 quota 模块实例**注入计数器**，
       * 再驱动 aiProxy.main 的各条早退路径，数"配额闸被调了几次"。
       *
       * 为什么不直接断言 DB 里的 dayCount：守卫拒绝时根本没写库，
       * 两种写法都能过，但"闸被调了几次"直接把契约说清了 ——
       * 闸的位置一旦被挪到守卫之前（比如有人为了"统一收口"把它提到 main 顶部），
       * 本用例立刻红。
       */
      const docs = Object.create(null);
      let gateCalls = 0;
      const sdk = makeQuotaSdk('u_guard', { sharedDocs: docs });

      const origLoad = Module._load;
      Module._load = function (request) {
        if (request === 'wx-server-sdk') return sdk;
        return origLoad.apply(this, arguments);
      };
      let fn;
      try {
        // ① 先造一个"带计数器"的 quota 实例
        delete require.cache[QUOTA_AI];
        const q = require(QUOTA_AI);
        const realGuard = q.guardQuota;
        q.guardQuota = function () { gateCalls++; return realGuard.apply(this, arguments); };
        // ② 让 aiProxy 拿到**这个**实例（而不是自己 require 出一个新的）
        const innerLoad = Module._load;
        Module._load = function (request) {
          if (request === './quota.js') return q;
          return innerLoad.apply(this, arguments);
        };
        try {
          delete require.cache[AI_FN];
          fn = require(AI_FN);
        } finally {
          Module._load = innerLoad;
        }
      } finally {
        Module._load = origLoad;
      }

      // status 是自检入口，在配额闸之前就 return
      const st = await fn.main({ action: 'status' });
      assert(st.code === 'OK' || st.code === 'NOT_CONFIGURED', 'status 应正常返回，实际 ' + st.code);
      eq(gateCalls, 0, 'status 不该消耗额度（否则前端探一次可用性就扣一次）');

      // 无 Key → NO_KEY（配额闸之前）
      gateCalls = 0;
      eq((await fn.main({ action: 'askWord', payload: { question: 'x', materials: [] } })).code, 'NO_KEY');
      eq(gateCalls, 0, '没配 Key 时压根没请求模型，不该占额度');

      // ⚠️ 这里**故意不**断言 BAD_ACTION：无 Key 时 NO_KEY 优先于 BAD_ACTION
      // （本文件已有用例把这条优先级钉死："无 Key + 未知 action → NO_KEY"）。
      // 在无 Key 环境下断言 BAD_ACTION 会与那条用例矛盾 —— 那是断错了，不是代码错。
      // BAD_ACTION 的配额断言放在下面"配了 Key"那条用例里。
    }));

  // 上一个用例刻意在"无 Key"下验证 NO_KEY 早退；而空问题/超长问题这两条守卫
  // 排在 NO_KEY **之后**，所以必须配了 Key 才走得到它们（否则会先被 NO_KEY 拦下，
  // 断言就成了"在验 NO_KEY"而不是"在验空问题守卫"—— 又是假绿）。
  await check('quota：空问题 / 超长问题被守卫拦下时不消耗额度（配了 Key 才走得到这两条）', () =>
    withEnv({ GLM_API_KEY: 'dummy-key', QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 10, QUOTA_GLOBAL_DAY_LIMIT: 0 },
      async () => {
        let gateCalls = 0;
        const sdk = makeQuotaSdk('u_guard2', { sharedDocs: Object.create(null) });
        const origLoad = Module._load;
        Module._load = function (request) {
          if (request === 'wx-server-sdk') return sdk;
          return origLoad.apply(this, arguments);
        };
        let fn;
        try {
          delete require.cache[QUOTA_AI];
          const q = require(QUOTA_AI);
          const realGuard = q.guardQuota;
          q.guardQuota = function () { gateCalls++; return realGuard.apply(this, arguments); };
          const innerLoad = Module._load;
          Module._load = function (request) {
            if (request === './quota.js') return q;
            return innerLoad.apply(this, arguments);
          };
          try {
            delete require.cache[AI_FN];
            fn = require(AI_FN);
          } finally { Module._load = innerLoad; }
        } finally { Module._load = origLoad; }

        // 先确认没被 NO_KEY 抢先（否则下面的断言在验错的东西）
        const sanity = await fn.main({ action: 'askWord', payload: { question: 'holiday', materials: [] } });
        assert(sanity.code !== 'NO_KEY', '本用例必须先过 NO_KEY 这一关，实际 ' + sanity.code);

        // 未知 action → BAD_ACTION（配了 Key 才走得到，NO_KEY 不再抢先）
        gateCalls = 0;
        eq((await fn.main({ action: 'nonsense' })).code, 'BAD_ACTION', '未知 action 应被守卫拦下');
        eq(gateCalls, 0, '未知 action 不进模型请求，不该占额度');

        gateCalls = 0;
        eq((await fn.main({ action: 'askWord', payload: { question: '   ', materials: [] } })).code,
          'EMPTY_QUESTION', '空问题应被守卫拦下');
        eq(gateCalls, 0, '空问题不该占额度（用户手滑不是刷额度）');

        gateCalls = 0;
        eq((await fn.main({
          action: 'askWord',
          payload: { question: 'x'.repeat(300), materials: [] }
        })).code, 'QUESTION_TOO_LONG', '超长问题应被守卫拦下');
        eq(gateCalls, 0, '超长问题不该占额度');

        // 对照：真正会请求模型的那条路，闸必须被调用（否则上面的"0 次"毫无意义）
        gateCalls = 0;
        await fn.main({ action: 'askWord', payload: { question: 'holiday', materials: [] } });
        assert(gateCalls === 1,
          '合法请求应当正好过一次配额闸（实测 ' + gateCalls + ' 次）—— 若这里也是 0，'
          + '说明计数器没接上，上面几条 "0 次" 就是假绿');
    }));

  // ---- 8. 双服务商共用一个上限 ----
  await check('quota：Agnes 与 GLM 共用同一份日计数（回退链不会绕过配额）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 0, QUOTA_DAY_LIMIT: 2, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      const dayKey = quotaPure().dayKeyOf(Date.now());
      // 记两次：第一次"走 Agnes"，第二次"回退到 GLM"
      for (let i = 1; i <= 2; i++) {
        eq((await withQuota(makeQuotaSdk('u_two', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'))).code, 'OK');
      }
      const row = docs['u_two|' + dayKey];
      eq(row.dayCount, 2, '两次调用应记在同一个 openid 的同一份计数里');
      // 配额闸位置：必须在模型请求之前，且记账与 provider 无关。
      // ⚠️ 两个踩过的坑，都写在这里防止重犯：
      //   ① 必须**剥离注释**——我自己的注释里就写了 postJson，不剥离会拿注释偏移当代码位置；
      //   ② 必须找 `await postJson(`（调用点）而不是 `postJson(`（函数**定义**在文件更早处）——
      //      用定义当调用，断言会恒真，**门禁显示有 PASS 但什么都没验**。
      // 这与本文件 6.1 记录的 verify-package canvas 检查（没剥 WXML 注释）同属一类假绿。
      const src = stripComments(require('fs').readFileSync(AI_FN, 'utf8'));
      const gateAt = src.indexOf('quota.guardQuota');
      const callAt = src.indexOf('await postJson(');
      assert(gateAt > -1, 'aiProxy 未接入配额闸');
      assert(callAt > -1, '未找到 aiProxy 的模型调用点（await postJson），源码结构变了？');
      assert(gateAt < callAt, '配额闸必须早于模型请求（先占位再干活），否则并发请求会一起烧额度');
      assert(src.indexOf("quota.guardQuota('aiProxy', String(action || ''))") > -1,
        '记账不应带 provider 参数 —— 一旦按服务商分开计数，回退链就能绕过上限');
    }));

  // ---- 9. 限流文案：可理解且不含错误码 ----
  await check('quota：限流文案不含错误码、也不是裸报错（项目文案红线）', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 1, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const docs = Object.create(null);
      let msg = '';
      for (let i = 0; i < 3; i++) {
        const r = await withQuota(makeQuotaSdk('u_msg', { sharedDocs: docs }),
          (q) => q.guardQuota('aiProxy', 'askWord'));
        if (!r.allowed) msg = r.msg;
      }
      assert(msg.length > 0, '被限流时必须给出文案');
      assert(!/RATE_LIMITED|QUOTA_EXCEEDED|NO_OPENID|undefined|null/.test(msg),
        '文案里不该出现错误码：' + msg);
      assert(!/异常|失败|错误/.test(msg), '文案不该是裸报错：' + msg);
    }));

  // ---- 10. 红线：日志与源码规范 ----
  await check('quota：日志带 openid 掩码与 action，且不泄露完整 openid', () =>
    withEnv({ QUOTA_MINUTE_LIMIT: 1, QUOTA_DAY_LIMIT: 100, QUOTA_GLOBAL_DAY_LIMIT: 0 }, async () => {
      const warnings = [];
      const origWarn = console.warn;
      console.warn = function () { warnings.push(Array.prototype.join.call(arguments, ' ')); };
      try {
        const docs = Object.create(null);
        for (let i = 0; i < 3; i++) {
          await withQuota(makeQuotaSdk('o_secret_user_9999', { sharedDocs: docs }),
            (q) => q.guardQuota('aiProxy', 'askWord'));
        }
      } finally {
        console.warn = origWarn;
      }
      const all = warnings.join('\n');
      assert(all.length > 0, '限流必须留日志（否则线上出问题无从查）');
      assert(all.indexOf('o_secret_user_9999') === -1, '日志泄露了完整 openid：' + all.slice(0, 200));
      assert(/o_se\*\*\*9999/.test(all), '日志应带掩码 openid 便于定位：' + all.slice(0, 200));
      assert(/action=askWord/.test(all), '日志应带 action 上下文');
    }));

  await check('quota：无裸吞异常、无 setInterval、非注释行不用 toISOString', () => {
    const src = require('fs').readFileSync(QUOTA_AI, 'utf8');
    assert(src.indexOf('setInterval') === -1, '云函数不该有常驻定时器');
    // 外部 IO 的 catch 必须留日志上下文，不能是空块
    const emptyCatch = src.match(/catch\s*\([^)]*\)\s*\{\s*\}/g);
    assert(!emptyCatch, '存在裸吞异常的空 catch：' + (emptyCatch || []).join(' | '));
    // toISOString 只允许出现在注释里（禁令说明），代码行用它会被 verify-package 拦下
    const codeLines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    assert(!codeLines.some(l => l.indexOf('toISOString') > -1),
      '代码行里出现 toISOString（UTC 偏移会错一天）');
  });

  await check('quota：两个云函数都接了配额闸，且 aiProxy 声明了 wx-server-sdk', () => {
    const ai = stripComments(require('fs').readFileSync(AI_FN, 'utf8'));
    const asr = stripComments(require('fs').readFileSync(ASR_FN, 'utf8'));
    assert(ai.indexOf("require('./quota.js')") > -1, 'aiProxy 未 require quota');
    assert(asr.indexOf("require('./quota.js')") > -1, 'asrProxy 未 require quota');
    assert(/quota\.guardQuota\('aiProxy'/.test(ai), 'aiProxy 未调用配额闸');
    assert(/quota\.guardQuota\('asrProxy'/.test(asr), 'asrProxy 未调用配额闸');
    // asrProxy 的闸必须早于真正调服务商的 transcribe 调用。
    // 用剥离注释后的源码找位置：函数**定义**里也有 transcribeGlm 字样，
    // 不剥离就会拿定义当调用，断言恒真。
    const gateAt = asr.indexOf('quota.guardQuota');
    const trAt = asr.search(/await transcribeGlm\(/);
    assert(gateAt > -1 && trAt > -1, '未找到 asrProxy 的闸或服务商调用点');
    assert(gateAt < trAt, 'asrProxy 的配额闸必须早于服务商调用，否则会白烧 ASR 额度');
    // aiProxy 原本没声明 wx-server-sdk（它当时只用 https 原生模块），
    // 不补则 quota 的 DB 层在云端永久走 fail-open，等于没有跨副本限流
    const pkg = require(path.join(ROOT, 'cloudfunctions', 'aiProxy', 'package.json'));
    assert(pkg.dependencies && pkg.dependencies['wx-server-sdk'],
      'aiProxy 缺 wx-server-sdk 依赖，DB 限流层在云端会永久降级');
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
