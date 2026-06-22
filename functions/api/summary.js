// functions/api/summary.js
// Cloudflare Pages Function – proxy for DashScope chat completions (summary).
import { verifyAuth, unauthorizedResponse } from './_auth.js';

export async function onRequestPost(context) {
  const user = await verifyAuth(context.request, context.env);
  if (!user) return unauthorizedResponse();

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

    const data = await upstream.json();
    return Response.json(data, { status: upstream.status });
  } catch (error) {
    console.error("Summary API Error:", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
