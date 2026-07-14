// ============================================================================
// 音频文件上传转写：纯前端音频/文本工具
// ----------------------------------------------------------------------------
// 浏览器本地把用户上传的音频文件（m4a / mp3 / wav / … 任何浏览器能解码的格式）
// 解码为 16 kHz 单声道 PCM，在"最安静处"规划切片边界（避免切在词中间），把每个
// 切片编码为 WAV 并转 base64，交给 /api/transcribe（qwen3-asr-flash，单次上限
// 5 分钟 / base64 10MB）。全程无需把原始文件上传到任何存储。
// ============================================================================

export const TARGET_SAMPLE_RATE = 16000;

export const AUDIO_UPLOAD_LIMITS = {
  // 300MB ≈ 5 小时 128kbps m4a；解码后 16k 单声道 float32 ≈ 230MB/小时，
  // 上限取 3 小时以免长文件解码把标签页内存打爆。
  maxFileBytes: 300 * 1024 * 1024,
  maxDurationSec: 3 * 60 * 60,
};

// 切片参数：从 targetSec 起在 [targetSec, maxSec] 窗口内找最安静的一帧下刀。
// maxSec=160s → WAV 5.12MB → base64 ≈ 6.8MB，稳低于 DashScope 的 10MB 上限。
export const CHUNK_PLAN_DEFAULTS = {
  targetSec: 120,
  maxSec: 160,
  frameMs: 200,
};

// 兼容老 Safari：decodeAudioData 可能只支持回调形式。
const decodeAudioDataCompat = (ctx, arrayBuffer) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const once = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    try {
      const maybePromise = ctx.decodeAudioData(arrayBuffer, once(resolve), once(reject));
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(once(resolve), once(reject));
      }
    } catch (err) {
      once(reject)(err);
    }
  });

const mixToMono = (audioBuffer) => {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  const scale = 1 / channels;
  for (let i = 0; i < length; i++) mono[i] *= scale;
  return mono;
};

/**
 * 把音频文件解码为 16 kHz 单声道 Float32 PCM。
 * 通过 16 kHz 的 OfflineAudioContext 解码：规范要求 decodeAudioData 重采样到
 * 上下文采样率，直接得到 16k（内存占用比先解到 44.1/48k 再重采样低 ~3 倍）。
 * 个别实现若未重采样，再用 OfflineAudioContext 渲染一遍兜底。
 */
export async function decodeAudioFileToMono16k(file) {
  if (!file) throw new Error('未选择文件');
  if (file.size > AUDIO_UPLOAD_LIMITS.maxFileBytes) {
    throw new Error(
      `文件过大（${Math.round(file.size / 1024 / 1024)}MB），当前上限 ${Math.round(
        AUDIO_UPLOAD_LIMITS.maxFileBytes / 1024 / 1024
      )}MB`
    );
  }

  const OfflineCtx =
    (typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext)) ||
    null;
  if (!OfflineCtx) throw new Error('当前浏览器不支持音频解码（OfflineAudioContext）');

  const arrayBuffer = await file.arrayBuffer();

  let decoded;
  try {
    decoded = await decodeAudioDataCompat(new OfflineCtx(1, 1, TARGET_SAMPLE_RATE), arrayBuffer);
  } catch (err) {
    throw new Error('无法解码该音频文件：浏览器不支持其编码格式，或文件已损坏');
  }

  const durationSec = decoded.length / decoded.sampleRate;
  if (durationSec > AUDIO_UPLOAD_LIMITS.maxDurationSec) {
    throw new Error(
      `音频过长（${Math.round(durationSec / 60)} 分钟），当前上限 ${Math.round(
        AUDIO_UPLOAD_LIMITS.maxDurationSec / 60
      )} 分钟`
    );
  }
  if (decoded.length === 0) throw new Error('音频内容为空');

  let samples;
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) {
    samples = mixToMono(decoded);
  } else {
    // 实现没按规范重采样（或不支持 16k 解码上下文）：渲染一遍完成重采样+下混。
    const length = Math.max(1, Math.ceil((decoded.length * TARGET_SAMPLE_RATE) / decoded.sampleRate));
    const renderCtx = new OfflineCtx(1, length, TARGET_SAMPLE_RATE);
    const source = renderCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(renderCtx.destination);
    source.start(0);
    const rendered = await renderCtx.startRendering();
    samples = rendered.getChannelData(0);
  }

  return {
    samples,
    sampleRate: TARGET_SAMPLE_RATE,
    durationSec: samples.length / TARGET_SAMPLE_RATE,
  };
}

/**
 * 规划切片边界：每片从上一片结束处开始，在 [targetSec, maxSec] 搜索窗口内
 * 找能量最低（最安静）的一帧，从帧中心下刀；尾片不足 maxSec 则整段收下。
 * 返回 [{ start, end }]（样本下标，左闭右开）。
 */
export function planChunkRanges(samples, sampleRate, options = {}) {
  const { targetSec, maxSec, frameMs } = { ...CHUNK_PLAN_DEFAULTS, ...options };
  const total = samples.length;
  const minSamples = Math.max(1, Math.floor(targetSec * sampleRate));
  const maxSamples = Math.max(minSamples + 1, Math.floor(maxSec * sampleRate));
  const frameLen = Math.max(1, Math.floor((frameMs / 1000) * sampleRate));

  const ranges = [];
  let start = 0;
  while (start < total) {
    if (total - start <= maxSamples) {
      ranges.push({ start, end: total });
      break;
    }
    const searchStart = start + minSamples;
    const searchEnd = start + maxSamples;
    let bestPos = searchEnd; // 兜底：窗口内没有可比帧就硬切在 maxSec
    let bestEnergy = Infinity;
    for (let f = searchStart; f + frameLen <= searchEnd; f += frameLen) {
      let energy = 0;
      for (let i = f; i < f + frameLen; i++) {
        const v = samples[i];
        energy += v * v;
      }
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestPos = f + (frameLen >> 1);
      }
    }
    ranges.push({ start, end: bestPos });
    start = bestPos;
  }
  return ranges;
}

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
};

/**
 * 把 samples[start, end) 编码为 16-bit PCM 单声道 WAV，返回 base64 字符串。
 */
export function encodeWavPcm16Base64(samples, sampleRate, start = 0, end = samples.length) {
  const from = Math.max(0, Math.min(start, samples.length));
  const to = Math.max(from, Math.min(end, samples.length));
  const numSamples = to - from;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度（PCM）
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // 位深
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = from; i < to; i++) {
    let s = samples[i];
    if (s < -1) s = -1;
    else if (s > 1) s = 1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return arrayBufferToBase64(buffer);
}

// ============================================================================
// 文本切分：把整段带标点的 ASR 文本切成句子，再按长度上限归组为“气泡”
// ============================================================================

/** 按中英文句末标点切句；无句末标点的尾巴保留为最后一句。 */
export function splitSentences(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const re = /[^.!?。！？…]+[.!?。！？…]+["'”’)\]]*\s*|[^.!?。！？…]+$/g;
  const out = [];
  let match;
  while ((match = re.exec(clean)) !== null) {
    const piece = match[0].trim();
    if (piece) out.push(piece);
  }
  return out;
}

/**
 * 把句子归组为不超过 maxChars 的气泡文本；单句超长时独占一个气泡
 * （宁可气泡偏长也不在句中硬切）。
 */
export function groupSentencesIntoBubbles(sentences, maxChars = 500) {
  const bubbles = [];
  let current = '';
  for (const sentence of sentences || []) {
    if (!sentence) continue;
    if (!current) {
      current = sentence;
      continue;
    }
    if (current.length + 1 + sentence.length <= maxChars) {
      current += ` ${sentence}`;
    } else {
      bubbles.push(current);
      current = sentence;
    }
  }
  if (current) bubbles.push(current);
  return bubbles;
}

/** 文本是否以句末标点收尾（用于跨切片的“半句”携带逻辑）。 */
export const endsWithTerminalPunctuation = (text) =>
  /[.!?。！？…]["'”’)\]]*$/.test(String(text || '').trim());
