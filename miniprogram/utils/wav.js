/**
 * WAV（RIFF）解析 —— 把录音文件变成端上 MFCC 能吃的浮点采样。
 *
 * ## 为什么需要它
 * 端上 MFCC 要的是**原始 PCM 采样**，而小程序没有音频解码 API
 * （`wx.createInnerAudioContext` 只能播、`decodeAudioData` 在小程序里不可用）。
 * 于是朗读页在有模板时改用 `format: 'wav'` 录音 —— wav 是唯一
 * 「容器结构简单、无需解码器、RecorderManager 明确支持」的选择
 * （官方 format 合法值：mp3 / aac / wav / PCM）。
 *
 * ## 为什么不直接跳过 44 字节
 * "WAV 头就是 44 字节" 只对最朴素的文件成立。实际可能出现：
 *   · 中间夹着 LIST / fact / bext 等附加块；
 *   · 块长度为奇数时有一个填充字节；
 *   · `data` 块长度字段为 0 或明显错误（部分编码器不填）。
 * 硬跳 44 字节在这些情况下会**静默读出噪声** —— MFCC 照样算得出，
 * 判定全错且没有任何提示。所以这里老老实实按块遍历。
 *
 * ## 不猜的原则
 * 读不出可识别的 PCM 格式时**返回错误**，绝不"尽力而为"。
 * 上层（acoustic.js）会据此降级到云端通道 —— 那才是正确的失败姿势。
 */

/** 只接受 16 位整数 PCM。浮点/24 位/ADPCM 都要显式拒绝，别静默当 16 位读。 */
const FORMAT_PCM = 1;

function fourcc(view, off) {
  return String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1),
    view.getUint8(off + 2), view.getUint8(off + 3));
}

/**
 * 解析 WAV。
 *
 * @param {ArrayBuffer} buffer 文件内容
 * @returns {{ok:boolean, error?:string, samples?:Float64Array,
 *            sampleRate?:number, channels?:number, bits?:number, frames?:number}}
 *   ok=false 时带 error（机器可读的短标识，便于降级判断与日志）
 */
function parse(buffer) {
  if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength < 44) {
    return { ok: false, error: 'too-small' };
  }
  const view = new DataView(buffer);
  const len = buffer.byteLength;

  if (fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    // 不是 RIFF/WAVE —— 可能是别的容器或裸 PCM。裸 PCM 没有头可依，
    // 猜采样率/位深就是拿学生的分数开玩笑，直接拒绝。
    return { ok: false, error: 'not-riff-wave' };
  }

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;

  // 从 12 开始遍历块。每个块 8 字节头（id + size），size 不含头本身。
  let p = 12;
  while (p + 8 <= len) {
    const id = fourcc(view, p);
    let size = view.getUint32(p + 4, true);
    const body = p + 8;
    const avail = len - body;

    // 长度字段不可信时按「到文件末尾」处理。
    //   · data：有些编码器把长度填 0，或填得比实际大 —— 这是真实存在的情况，
    //     必须容错，否则整个文件解析不出采样（表现为"录了但说没听到声音"）；
    //   · 其它块：只在越界时收敛。**不能**对 size=0 也套用"剩余长度"——
    //     一个空的 LIST 块会让循环直接把后面所有块（含 data）吞掉。
    if (id === 'data') {
      if (size === 0 || size > avail) size = avail;
    } else if (size > avail) {
      size = avail;
    }

    if (id === 'fmt ' && body + 16 <= len) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      };
    } else if (id === 'data' && dataOff < 0) {
      dataOff = body;
      dataLen = size;
    }

    // 块长为奇数时有 1 字节填充，必须跟着跳，否则后续块 id 全错位
    p = body + size + (size % 2);
  }

  if (!fmt) return { ok: false, error: 'no-fmt-chunk' };
  if (dataOff < 0) return { ok: false, error: 'no-data-chunk' };
  if (fmt.format !== FORMAT_PCM) return { ok: false, error: 'not-pcm:' + fmt.format };
  if (fmt.bits !== 16) return { ok: false, error: 'bits:' + fmt.bits };
  if (!fmt.channels) return { ok: false, error: 'channels:0' };
  if (!fmt.sampleRate) return { ok: false, error: 'samplerate:0' };

  const bytesPerFrame = 2 * fmt.channels;
  const frames = Math.floor(dataLen / bytesPerFrame);
  if (frames < 1) return { ok: false, error: 'no-frames' };

  // 16 位小端 → [-1, 1)。除以 32768（而不是 32767）保证取值不越界。
  const out = new Float64Array(frames);
  if (fmt.channels === 1) {
    for (let i = 0; i < frames; i++) {
      out[i] = view.getInt16(dataOff + i * 2, true) / 32768;
    }
  } else {
    // 多声道取平均 —— 模板是单声道建的，不能只取第一路（会有相位/增益偏差）
    const inv = 1 / fmt.channels;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      const base = dataOff + i * bytesPerFrame;
      for (let c = 0; c < fmt.channels; c++) {
        s += view.getInt16(base + c * 2, true);
      }
      out[i] = s * inv / 32768;
    }
  }

  return {
    ok: true,
    samples: out,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    frames: frames
  };
}

module.exports = {
  parse: parse,
  FORMAT_PCM: FORMAT_PCM
};
