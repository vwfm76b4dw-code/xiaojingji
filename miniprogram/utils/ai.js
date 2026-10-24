/**
 * AiGateway —— 服务层前端适配器（对应《开发文档-完整版》§7）。
 *
 * 三条铁律：
 *  1. 前端代码里不含任何 Key；请求一律经 wx.cloud.callFunction 打到云函数。
 *  2. 本模块**永不 reject**：任何失败都折算成 { ok:false }，调用方无需写 try/catch。
 *  3. 失败即降级：例句/记忆法优先回退预置库内容，让界面始终有东西可显示。
 *
 * 云开发不可用时（未开通/未初始化/断网）自动返回 ok:false，核心功能不受影响。
 */
const aiCore = require('./ai-core.js');
const PRESET = require('../data/words.js');

const CLOUD_FN = 'aiProxy';

// 预置库索引（降级兜底用）：word(lower) → {example, mnemonic}
const PRESET_MAP = (function () {
  const m = Object.create(null);
  PRESET.forEach(function (w) {
    m[String(w.word).toLowerCase()] = {
      example: w.example || '',
      mnemonic: w.mnemonic || ''
    };
  });
  return m;
})();

/** 云开发是否就绪（阶段 1 环境未开通时返回 false，不影响其它功能） */
function isAvailable() {
  try {
    return !!(wx && wx.cloud && typeof wx.cloud.callFunction === 'function');
  } catch (e) {
    return false;
  }
}

/**
 * 把 wx.cloud 的 fail 回调翻译成一个稳定的 code。
 *
 * ## 为什么要分类而不是一律 CALL_FAILED
 * "云函数没部署"和"网络抖了一下"对用户是两件完全不同的事：
 * 前者重试一万次也不会好，必须告诉人去开发者工具里右键部署；
 * 后者过几秒就能好。一律报 CALL_FAILED 等于把"重试无解"说成"再等等"，
 * 那是撒谎。stats 页的 aiFailHintFor 正是靠这两个码分流出不同指引的。
 *
 * 未识别的 errMsg 一律归 CALL_FAILED（保守：不认识的形态不硬编故事）。
 */
function classifyFail(errMsg) {
  const m = String(errMsg == null ? '' : errMsg);
  if (/not\s*found|FUNCTION_NOT_FOUND|function not found/i.test(m)) return 'NOT_DEPLOYED';
  if (/timeout|timed\s*out/i.test(m)) return 'TIMEOUT';
  return 'CALL_FAILED';
}

/**
 * 统一出口：把云函数调用包成"绝不抛错"的一步。
 * 云函数本身约定返回 { ok, data } | { ok, code, msg }；网络层异常也在这里收口。
 *
 * 注意 wx.cloud.callFunction 抛的是同步异常（未初始化、参数错），
 * 它在 Promise 构造器里会直接把整个 promise 变成 rejected——
 * 若不在这一层拦住，异常就会穿透到页面，违反"界面不出现裸报错"的红线。
 */
function invoke(action, payload) {
  return new Promise(function (resolve) {
    if (!isAvailable()) {
      resolve({ ok: false, code: 'NO_CLOUD' });
      return;
    }

    try {
      wx.cloud.callFunction({
        name: CLOUD_FN,
        data: { action: action, payload: payload || {} },
        success: function (res) {
          const r = (res && res.result) || {};
          if (r.ok && r.data) resolve({ ok: true, data: r.data });
          else resolve({ ok: false, code: r.code || 'UNKNOWN', msg: r.msg || '' });
        },
        fail: function (err) {
          // errMsg 只在**本层**用于分流，不往界面传：界面要的是"能不能重试"
          resolve({ ok: false, code: classifyFail(err && err.errMsg) });
        }
      });
    } catch (e) {
      // 同步异常也必须折算成可降级的结果，绝不穿透
      console.warn('[ai] 云函数调用抛出异常，已降级', e);
      resolve({ ok: false, code: 'CALL_THREW' });
    }
  });
}

/**
 * 自然语言 → 词条列表。
 * 返回 { ok, items, dupCount, msg }；items 已清洗去重，dupCount 为与现有词库重复的条数。
 */
function parseBatch(text, existingWords) {
  const raw = String(text || '').trim();
  if (!raw) {
    return Promise.resolve({ ok: false, code: 'EMPTY_INPUT', items: [], dupCount: 0, msg: '先写点想录的单词吧' });
  }

  return invoke('parseBatch', { text: raw }).then(function (r) {
    if (!r.ok) {
      return { ok: false, code: r.code, items: [], dupCount: 0, msg: aiCore.degradeHint('parseBatch', r.code) };
    }
    try {
      const items = aiCore.normalizeItems(r.data.items);
      if (items.length === 0) {
        return { ok: false, code: 'NO_ITEMS', items: [], dupCount: 0, msg: aiCore.degradeHint('parseBatch', 'NO_ITEMS') };
      }
      const split = aiCore.partitionNew(items, existingWords);
      return { ok: true, code: 'OK', items: split.fresh, dupCount: split.dup.length, msg: '' };
    } catch (e) {
      // 归一化阶段出问题也走降级，不让异常冒到页面
      console.warn('[ai] 解析结果处理异常，已降级', e);
      return { ok: false, code: 'PARSE_ERROR', items: [], dupCount: 0, msg: aiCore.degradeHint('parseBatch', 'UNKNOWN') };
    }
  });
}

/**
 * 例句生成：AI 失败 → 回退预置库例句（若该词在预置库中）。
 * 返回 { ok, value, fromPreset, msg }
 */
function genExample(word, meaning) {
  return genField('genExample', 'example', word, meaning);
}

/** 词根记忆法生成：同上，失败回退预置库 */
function genMnemonic(word) {
  return genField('genMnemonic', 'mnemonic', word, '');
}

function genField(action, key, word, meaning) {
  const w = String(word || '').trim();
  if (!w) {
    return Promise.resolve({ ok: false, code: 'EMPTY_WORD', value: '', fromPreset: false, msg: '先填单词' });
  }

  const preset = PRESET_MAP[w.toLowerCase()] || {};

  return invoke(action, { word: w, meaning: meaning || '' }).then(function (r) {
    let v = '';
    try {
      v = r.ok ? aiCore.cleanText(r.data[key], 400) : '';
    } catch (e) {
      console.warn('[ai] 生成结果处理异常，已降级', e);
    }
    if (v) return { ok: true, code: 'OK', value: v, fromPreset: false, msg: '' };

    // 降级：预置库有这条就用它，并如实告诉界面这是预置内容
    if (preset[key]) {
      return { ok: true, code: 'PRESET', value: preset[key], fromPreset: true, msg: '已使用词库中的现成内容' };
    }
    // 走到这里有两种情况：① 调用失败（r.code 有值）；② 调用成功但内容为空
    // （此时 r 是 {ok:true,...}，**根本没有 code 字段**）。
    // ② 必须补一个码，否则返回结构违反本模块自定的 {ok:false, code, msg} 契约，
    // 调用方按 code 分支会拿到 undefined。
    const code = r.code || 'EMPTY';
    return { ok: false, code: code, value: '', fromPreset: false, msg: aiCore.degradeHint(action, code) };
  });
}

/**
 * 词义问答（问词页的云端增强）：把端上检索到的课本词条交给模型组织语言。
 *
 * ## 为什么单独一个出口而不是让页面直调 wx.cloud.callFunction
 * 直调有两个真实事故（本项目都发生过）：
 *   ① **aiBusy 复位靠 complete 回调**——一旦云开发未开通导致**同步抛异常**，
 *      complete 永远不会执行，扫描条永久停留、按钮永久 disabled；
 *   ② 异常直接穿透到页面 = 界面出现裸报错，违反项目红线。
 * 走本模块后：异常在 invoke() 里折算成 {ok:false}，页面只需 try/finally 复位。
 *
 * materials 传 null/空数组是**合法**的 —— 云端会走"超纲词"模式回答，
 * 不要在这里挡掉（那正是 2026-09-19 修掉的"问 bicycle 没反应"）。
 *
 * 返回 { ok, answer, code, msg }；answer 已截断到 400 字。
 */
function askWord(question, materials) {
  const q = String(question == null ? '' : question).trim();
  if (!q) {
    return Promise.resolve({ ok: false, code: 'EMPTY_QUESTION', answer: '', msg: '先写个问题吧' });
  }
  return invoke('askWord', {
    question: q,
    materials: Array.isArray(materials) ? materials : []
  }).then(function (r) {
    if (!r.ok) {
      return { ok: false, code: r.code, answer: '', msg: aiCore.degradeHint('askWord', r.code) };
    }
    let ans = '';
    try {
      ans = aiCore.cleanText(r.data && r.data.answer, 400);
    } catch (e) {
      // 清文本这一步理论上不会抛（纯函数），但网关不许异常穿透，兜住
      console.warn('[ai] 问答结果处理异常，已降级', e);
    }
    if (!ans) {
      return { ok: false, code: 'EMPTY', answer: '', msg: aiCore.degradeHint('askWord', 'EMPTY') };
    }
    return { ok: true, code: 'OK', answer: ans, msg: '' };
  });
}

/**
 * 学习分析（统计页）：把页面聚合好的指标交给模型，产出个性化建议。
 * 与 askWord 同构，单独开一个出口而不是让 stats 页自己拼 payload。
 * 返回 { ok, analysis, code, msg }（字段名与云函数 data.answer 对齐叫 analysis，
 * 避免调用方与"answer"混用后张冠李戴）。
 */
function analysis(stats) {
  if (!stats || typeof stats !== 'object') {
    return Promise.resolve({ ok: false, code: 'NO_STATS', analysis: '', msg: '还没有可分析的学习数据' });
  }
  return invoke('analysis', { stats: stats }).then(function (r) {
    if (!r.ok) {
      return { ok: false, code: r.code, analysis: '', msg: aiCore.degradeHint('analysis', r.code) };
    }
    let txt = '';
    try {
      txt = aiCore.cleanText(r.data && r.data.answer, 400);
    } catch (e) {
      console.warn('[ai] 分析结果处理异常，已降级', e);
    }
    if (!txt) {
      return { ok: false, code: 'EMPTY', analysis: '', msg: aiCore.degradeHint('analysis', 'EMPTY') };
    }
    return { ok: true, code: 'OK', analysis: txt, msg: '' };
  });
}

module.exports = { isAvailable, parseBatch, genExample, genMnemonic, askWord, analysis, PRESET_MAP };
