// functions/api/transcribe.js
// Cloudflare Pages Function – proxy for DashScope qwen3-asr-flash file
// transcription (音频文件上传转写). The client decodes the file locally,
// slices it into ≤~3 min 16 kHz mono WAV chunks and posts one chunk per
// request as base64; qwen3-asr-flash accepts up to 5 min / 10 MB per call.
import { verifyAuth, unauthorizedResponse } from './_auth.js';

const DEFAULT_FILE_ASR_MODEL = 'qwen3-asr-flash';
// DashScope rejects audio over 10MB after base64 encoding; fail fast with a
// clearer message instead of relaying the upstream error.
const MAX_AUDIO_BASE64_CHARS = 10 * 1024 * 1024;

export async function onRequestPost(context) {
  const user = await verifyAuth(context.request, context.env);
  if (!user) return unauthorizedResponse();

  const apiKey = context.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Server missing DASHSCOPE_API_KEY' }, { status: 500 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const audioBase64 = typeof body?.audio === 'string' ? body.audio.trim() : '';
  if (!audioBase64) {
    return Response.json({ error: 'Missing "audio" (base64 string)' }, { status: 400 });
  }
  if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
    return Response.json(
      { error: 'Audio chunk too large (base64 must stay under 10MB)' },
      { status: 413 }
    );
  }

  const format = /^[a-z0-9]{1,8}$/i.test(String(body?.format || ''))
    ? String(body.format).toLowerCase()
    : 'wav';
  const model = /^[\w.-]{1,64}$/.test(String(body?.model || ''))
    ? String(body.model)
    : DEFAULT_FILE_ASR_MODEL;
  // Optional biasing context (e.g. the user's glossary terms). qwen3-asr uses
  // the system text as recognition context / hotwords.
  const contextText = typeof body?.context === 'string' ? body.context.slice(0, 8000).trim() : '';
  const language = /^[a-z]{2,8}$/i.test(String(body?.language || ''))
    ? String(body.language).toLowerCase()
    : '';

  const messages = [];
  if (contextText) {
    messages.push({ role: 'system', content: [{ text: contextText }] });
  }
  messages.push({
    role: 'user',
    content: [{ audio: `data:audio/${format};base64,${audioBase64}` }],
  });

  const asrOptions = { enable_lid: true, enable_itn: false };
  if (language) asrOptions.language = language;

  try {
    const upstream = await fetch(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: { messages },
          parameters: { asr_options: asrOptions },
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const message =
        data?.message || data?.error?.message || `DashScope HTTP ${upstream.status}`;
      const code = data?.code || data?.error?.code || '';
      return Response.json(
        { error: code ? `${code}: ${message}` : message },
        { status: upstream.status }
      );
    }

    const content = data?.output?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('')
          .trim()
      : '';

    return Response.json({
      text,
      // annotations carry detected language / audio info; forwarded for debugging.
      annotations: data?.output?.choices?.[0]?.message?.annotations || null,
      usage: data?.usage || null,
      request_id: data?.request_id || '',
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error('Transcribe API Error:', error);
    return Response.json(
      { error: timedOut ? 'DashScope transcription timed out' : 'Internal Server Error' },
      { status: timedOut ? 504 : 500 }
    );
  }
}
