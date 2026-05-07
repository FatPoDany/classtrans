// api/asr-vocabulary.js
// Pass-through proxy for DashScope's ASR vocabulary (hot-word) management.
// The frontend assembles the official body shape; we only inject the API key.

const VOCABULARY_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization/vocabulary";

export default async function handler(req, res) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing DASHSCOPE_API_KEY" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const upstream = await fetch(VOCABULARY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json"
    );
    return res.send(text);
  } catch (err) {
    console.error("ASR vocabulary proxy error:", err);
    return res
      .status(500)
      .json({ error: String((err && err.message) || err) });
  }
}
