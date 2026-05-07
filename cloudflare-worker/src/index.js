// Cloudflare Worker: pass-through WebSocket relay between the classtrans
// browser client and DashScope Paraformer real-time ASR.
//
// Why a relay: the Paraformer endpoint requires an Authorization header which
// browsers cannot set on a WebSocket connection, and we don't want the API key
// in client code.
//
// Required secret:  DASHSCOPE_API_KEY
// Optional vars:    ALLOWED_ORIGINS (comma-separated; if set, requests from
//                   other origins are rejected with 403)
//
// Heartbeat: Cloudflare enforces a ~100 s idle timeout on WebSocket
// connections. During quiet classroom periods no data flows on the upstream
// leg, causing Cloudflare to close it. We send a lightweight JSON ping every
// 30 s on *both* legs to keep the connection alive.

const PARAFORMER_WS_URL = "https://dashscope.aliyuncs.com/api-ws/v1/inference";

// Interval between heartbeat pings (ms). 30 s is well within the 100 s limit.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Sentinel JSON string the client can recognise and ignore.
const PING_MSG = JSON.stringify({ type: "ping" });
const PONG_MSG = JSON.stringify({ type: "pong" });

// Silence PCM frame sent upstream to keep DashScope's ASR task alive.
// 1600 samples × 2 bytes = 3200 bytes = 100 ms at 16 kHz mono 16-bit.
// All zeros = silence. DashScope needs valid-sized PCM frames; anything
// smaller is ignored and the task eventually times out.
const SILENCE_PCM_FRAME = new Uint8Array(1600 * 2);

// Normalise close code to a value the WebSocket spec allows for app use.
// Cloudflare Workers throw if you pass an invalid close code.
const normalizeCloseCode = (code) => {
  if (typeof code !== "number" || !Number.isFinite(code)) return 1000;
  // Valid application close codes: 1000, 1001, 1002..1015 (some reserved),
  // and 3000-4999. Default to 1000 for anything outside the safe range.
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1000 && code <= 1015) return code;
  return 1000;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/asr") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    if (allowed.length > 0 && !allowed.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (!env.DASHSCOPE_API_KEY) {
      return new Response("Server missing DASHSCOPE_API_KEY", { status: 500 });
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(PARAFORMER_WS_URL, {
        headers: {
          Upgrade: "websocket",
          Authorization: `bearer ${env.DASHSCOPE_API_KEY}`,
          "X-DashScope-DataInspection": "enable",
        },
      });
    } catch (err) {
      return new Response(`Upstream connect failed: ${err && err.message}`, {
        status: 502,
      });
    }

    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      return new Response(
        `Upstream did not return a WebSocket (status ${upstreamResponse.status})`,
        { status: 502 }
      );
    }
    upstream.accept();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // Track whether the relay is still alive so the heartbeat can self-cancel.
    let alive = true;

    const safeClose = (sock, code, reason) => {
      try {
        sock.close(normalizeCloseCode(code), (reason || "").slice(0, 123));
      } catch (e) {
        /* already closed */
      }
    };

    const teardown = (code, reason) => {
      if (!alive) return;
      alive = false;
      safeClose(server, code, reason);
      safeClose(upstream, code, reason);
    };

    // Helper: is a message our heartbeat sentinel?
    const isPingPong = (data) => {
      if (typeof data !== "string") return false;
      return data === PING_MSG || data === PONG_MSG;
    };

    // ---- client → upstream ---------------------------------------------------
    server.addEventListener("message", (event) => {
      try {
        // If the client sends a ping, reply with pong – don't forward upstream.
        if (isPingPong(event.data)) {
          try { server.send(PONG_MSG); } catch (_) {}
          return;
        }
        upstream.send(event.data);
      } catch (e) {
        teardown(1011, "upstream send failed");
      }
    });

    // ---- upstream → client ---------------------------------------------------
    upstream.addEventListener("message", (event) => {
      try {
        // DashScope shouldn't send pings, but guard anyway.
        if (isPingPong(event.data)) return;
        server.send(event.data);
      } catch (e) {
        teardown(1011, "client send failed");
      }
    });

    // ---- close / error -------------------------------------------------------
    server.addEventListener("close", (event) => {
      teardown(event.code, event.reason);
    });
    upstream.addEventListener("close", (event) => {
      teardown(event.code, event.reason);
    });

    server.addEventListener("error", () => teardown(1011, "client error"));
    upstream.addEventListener("error", () => teardown(1011, "upstream error"));

    // ---- heartbeat keepalive -------------------------------------------------
    // Send a ping to *both* legs periodically so neither idles past 100 s.
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        return;
      }
      try { server.send(PING_MSG); } catch (_) {}
      // For upstream we send a proper silence PCM frame (100 ms at 16 kHz).
      // DashScope needs valid-sized audio frames to consider the stream
      // active and keep the ASR task alive.
      try { upstream.send(SILENCE_PCM_FRAME); } catch (_) {}
    }, HEARTBEAT_INTERVAL_MS);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
