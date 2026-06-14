// functions/api/asr-vocabulary.js
// Cloudflare Pages Function – pass-through proxy for DashScope's ASR
// vocabulary (hot-word) management. The frontend assembles the official
// body shape; we only inject the API key.

const VOCABULARY_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization/vocabulary";

export async function onRequestPost(context) {
  const apiKey = context.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Server missing DASHSCOPE_API_KEY" }, { status: 500 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const upstream = await fetch(VOCABULARY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    console.error("ASR vocabulary proxy error:", err);
    return Response.json(
      { error: String((err && err.message) || err) },
      { status: 500 }
    );
  }
}
