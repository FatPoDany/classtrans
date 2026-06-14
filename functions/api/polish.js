// functions/api/polish.js
// Cloudflare Pages Function – proxy for DashScope chat completions (polish).
// Supports both streaming (SSE) and non-streaming responses.

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

  const wantsStream = !!(body && body.stream);

  try {
    const upstream = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );

    if (!wantsStream) {
      const data = await upstream.json();
      return Response.json(data, { status: upstream.status });
    }

    // Streaming: pipe the upstream SSE response through to the client.
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return Response.json(
        { error: text || "Upstream stream error" },
        { status: upstream.status || 500 }
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Polish API Error:", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
