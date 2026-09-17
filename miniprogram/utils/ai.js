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
          else resolve({ ok: false, code: r.code || 'UNKNOWN' });
        },
        fail: function () {
          // 不把 errMsg 往上传：界面只需知道"这次没成"，不需要网络细节
          resolve({ ok: false, code: 'CALL_FAILED' });
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

module.exports = { isAvailable, parseBatch, genExample, genMnemonic, PRESET_MAP };
