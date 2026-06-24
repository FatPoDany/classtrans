// Base real-time ASR session: protocol-agnostic transport + resilience.
//
// Holds everything that does NOT depend on the upstream wire protocol — the
// WebSocket lifecycle, heartbeat, stall watchdog, proactive rotation,
// auto-reconnect, and the AudioWorklet PCM pipeline. Concrete protocols
// (Paraformer/Gummy `run-task`, Qwen Omni-Realtime `session.update`) subclass
// this and implement a small set of hooks:
//
//   _sendConfig()                emit the per-task config message
//   _sendAudio(buf)              push a PCM ArrayBuffer (caller guarantees OPEN)
//   _sendFinish()                graceful task-finish message (self-guards ws)
//   _handleProtocolMessage(msg)  parse one server event
//   _resetBuffers()              clear transcript accumulation on renew/reconnect
//
// and call these base helpers from _handleProtocolMessage:
//
//   _signalReady()               resolve the start/await-ready promise
//   _handleFatalError(errMsg)    reject-if-starting else surface onError
//   _markResult()                reset the watchdog (a result-bearing event)
//
// onUpdate is called with { fullText, finalText, confidence, translatedText,
// translatedFinalText } whenever the running transcript changes; the caller
// drives its own silence timer / UI.

const FRAME_SIZE = 1600; // 100 ms at 16 kHz
const TARGET_SAMPLE_RATE = 16000;
const TASK_STARTED_TIMEOUT_MS = 5000;

// DashScope occasionally returns spurious "free tier exhausted" task-failed
// errors even when quota is available. Retry start a few times before
// surfacing the error to the user.
const TASK_START_MAX_RETRIES = 2;
const TASK_START_RETRY_DELAY_MS = 2000;

// Heartbeat: the Cloudflare Worker relay has a ~100 s idle timeout.
// We ping every 25 s to stay well within the limit.
const HEARTBEAT_INTERVAL_MS = 25_000;

// DashScope's own idle timeout: the server ends the task if it receives no
// valid audio for a while (~60 s). We send silence PCM frames every 15 s
// during quiet periods to prevent this.
const SILENCE_KEEPALIVE_INTERVAL_MS = 15_000;

// A silence PCM frame: FRAME_SIZE samples of 16-bit zeros = 100 ms of silence.
const SILENCE_FRAME = new ArrayBuffer(FRAME_SIZE * 2); // pre-zeroed

// Watchdog: if we receive no result events for this long while the session is
// supposed to be live, proactively renew the task.
const WATCHDOG_TIMEOUT_MS = 45_000;

// Proactive rotation: DashScope real-time tasks have an undocumented maximum
// duration. Rather than waiting for a silent stop, we proactively tear down and
// rebuild the full pipeline every 14 min.
const PROACTIVE_ROTATION_MS = 14 * 60 * 1000;

// Once rotation is due, wait for the App's canRotateNow() (= user in a natural
// pause) before swapping, with a hard ceiling so it can't defer forever.
const ROTATION_DEFER_CHECK_INTERVAL_MS = 5_000;
const ROTATION_HARD_CEILING_MS = 3 * 60 * 1000;

// Auto-reconnect: if the relay drops mid-session, transparently re-establish.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1500;

export const generateTaskId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
};

// Per-event id for protocols that tag every client event (Omni-Realtime).
export const generateEventId = () => `event_${generateTaskId().slice(0, 20)}`;

export const sanitizeText = (input) =>
  String(input || "")
    .replace(/<\/?s>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const averageWordConfidence = (words) => {
  if (!Array.isArray(words) || words.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const w of words) {
    const c = Number(w && w.confidence);
    if (Number.isFinite(c)) {
      sum += c;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
};

// Detect DashScope errors worth retrying (transient quota glitches, rate
// limits) vs. genuine fatal errors (bad model name, auth failure).
export const isRetriableTaskError = (msg) => {
  if (!msg) return false;
  const s = String(msg).toLowerCase();
  return (
    s.includes("free tier") ||
    s.includes("quota") ||
    s.includes("rate limit") ||
    s.includes("throttl") ||
    s.includes("too many requests") ||
    s.includes("temporarily unavailable")
  );
};

export { FRAME_SIZE, TARGET_SAMPLE_RATE, SILENCE_FRAME };

export class BaseAsrSession {
  constructor({ wsUrl, audioTrack, model, onUpdate, onError, onStatus, canRotateNow }) {
    if (!wsUrl) throw new Error("BaseAsrSession: wsUrl is required");
    if (!audioTrack) throw new Error("BaseAsrSession: audioTrack is required");

    this.wsUrl = wsUrl;
    this.audioTrack = audioTrack;
    this.model = (model && String(model).trim()) || "";
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};
    this.onError = typeof onError === "function" ? onError : () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    this.canRotateNow = typeof canRotateNow === "function" ? canRotateNow : () => true;

    this.ws = null;
    this.taskId = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.sentences = []; // protocol-defined accumulation (Paraformer/Gummy)
    this.paused = false;
    this.stopped = false;
    this.taskStartedPromise = null;
    this._heartbeatTimer = null;
    this._silenceTimer = null;
    this._watchdogTimer = null;
    this._rotationTimer = null;
    this._rotationCheckTimer = null;
    this._rotationDueAt = 0;
    this._lastAudioSentAt = 0;
    this._lastResultAt = 0;
    this._reconnectAttempt = 0;
    this._isReconnecting = false;
    this._isRenewing = false;
  }

  get _tag() {
    return this.constructor.name;
  }

  async start() {
    this.taskId = generateTaskId();

    await this._openWebSocket();
    await this._startAudioPipeline();
    await this._startTaskWithRetry();
    this.onStatus({ phase: "started" });
    this._lastResultAt = Date.now(); // arm watchdog from session start
    this._startRotationTimer();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  // Discard the accumulated transcript buffer so cumulative fullText starts
  // fresh. The WebSocket / task stays open (no recognition gap); the next
  // result rebuilds from an empty buffer.
  resetTranscript() {
    this._resetBuffers();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    this._clearHeartbeat();
    this._clearSilenceTimer();
    this._clearWatchdog();
    this._clearRotationTimer();

    try {
      this._sendFinish();
    } catch (e) {}

    this._teardownAudio();

    if (this.ws) {
      try { this.ws.close(1000, "client stop"); } catch (e) {}
      this.ws = null;
    }
  }

  // ---- protocol hooks (override in subclasses) ---------------------------

  // Emit the per-task config message (run-task / session.update).
  _sendConfig() {}

  // Send one PCM frame. Caller guarantees this.ws is OPEN. Default: raw binary
  // (Paraformer). Override to wrap in a protocol envelope (Omni base64 append).
  _sendAudio(buf) {
    this.ws.send(buf);
  }

  // Graceful task-finish message. Must self-guard ws state. Default: none.
  _sendFinish() {}

  // Parse one parsed server message object. Override; call _signalReady(),
  // _handleFatalError(), _markResult(), this.onUpdate(), this._renewTask().
  _handleProtocolMessage(_msg) {}

  // Clear transcript accumulation on task renewal / reconnect.
  _resetBuffers() {
    this.sentences = [];
  }

  // ---- ready/error/result helpers (called by protocol hook) --------------

  _signalReady() {
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
      this._readyReject = null;
    }
  }

  // During startup/renewal/reconnect the caller awaits _awaitReady and handles
  // the rejection (including retry logic for transient errors); don't also fire
  // onError in that window. Otherwise surface the error.
  _handleFatalError(errMsg) {
    if (this._readyReject) {
      this._readyReject(new Error(errMsg));
      this._readyResolve = null;
      this._readyReject = null;
      return;
    }
    this.onError(new Error(`ASR: ${errMsg}`));
  }

  _markResult() {
    this._lastResultAt = Date.now();
  }

  // ---- internals ---------------------------------------------------------

  _openWebSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        // Stale-handler guard: when we rotate / reconnect, the old WS's close
        // event can arrive after we've moved on to a new WS. Without this
        // check, the old close re-enters _handleClose with the current flags
        // and triggers a bogus reconnect cascade against the live session.
        ws.addEventListener("message", (ev) => {
          if (ws !== this.ws) return;
          this._handleMessage(ev);
        });
        ws.addEventListener("close", (ev) => {
          if (ws !== this.ws) return;
          this._handleClose(ev);
        });
        ws.addEventListener("error", () => {
          if (ws !== this.ws) return;
          this._handleSocketError();
        });
        this._startHeartbeat();
        this._startWatchdog();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("ASR relay WebSocket connect failed"));
      };
      const onClose = (event) => {
        cleanup();
        reject(new Error(`ASR relay WS closed before open (code ${event.code})`));
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
  }

  async _startAudioPipeline() {
    const ctx = new AudioContext({
      sampleRate: TARGET_SAMPLE_RATE,
      latencyHint: "interactive",
    });
    this.audioContext = ctx;

    // Chrome suspends AudioContext when the tab goes to background. Auto-resume.
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "suspended" && !this.stopped && !this.paused) {
        console.warn(`${this._tag}: AudioContext suspended, resuming...`);
        ctx.resume().catch(() => {});
      }
    });
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    await ctx.audioWorklet.addModule("/pcm16-worklet.js");

    const source = ctx.createMediaStreamSource(new MediaStream([this.audioTrack]));
    const worklet = new AudioWorkletNode(ctx, "pcm16-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: {
        targetRate: TARGET_SAMPLE_RATE,
        frameSize: FRAME_SIZE,
      },
    });

    worklet.port.onmessage = (event) => {
      if (this.paused || this.stopped) return;
      const buf = event.data;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this._sendAudio(buf);
          this._lastAudioSentAt = Date.now();
        } catch (e) {}
      }
    };

    // Silence keepalive: if AudioWorklet stops delivering frames (tab audio goes
    // silent / shared tab navigated away), DashScope's VAD will time out the
    // task. Periodically inject a silence frame to prevent that.
    this._startSilenceTimer();

    source.connect(worklet);
    this.sourceNode = source;
    this.workletNode = worklet;
  }

  _teardownAudio() {
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; } catch (e) {}
      try { this.workletNode.disconnect(); } catch (e) {}
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) {}
      this.sourceNode = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }
  }

  _awaitReady() {
    if (this.taskStartedPromise) return this.taskStartedPromise;
    this.taskStartedPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
      setTimeout(() => {
        if (this._readyResolve) {
          const err = new Error("ASR session start timeout");
          this._readyReject?.(err);
          this._readyResolve = null;
          this._readyReject = null;
        }
      }, TASK_STARTED_TIMEOUT_MS);
    });
    return this.taskStartedPromise;
  }

  // Wrap _sendConfig + _awaitReady with retry logic for transient DashScope
  // errors (spurious "free tier exhausted", temporary rate limits). Each retry
  // tears down the old WebSocket and opens a fresh one, because DashScope
  // typically closes the upstream connection after a failure.
  //
  // IMPORTANT: we do NOT silently downgrade the model. The user chooses the ASR
  // model deliberately; a hidden downgrade produces worse results and masks the
  // real failure. If a hot-word vocabulary_id is set, we drop it and retry the
  // SAME model once (a stale/deleted vocabulary is a common failure cause). If
  // the requested model still cannot start, we surface the real error.
  async _startTaskWithRetry() {
    let lastErr;

    const rebuildSocket = async () => {
      this._clearHeartbeat();
      this._clearWatchdog();
      const oldWs = this.ws;
      this.ws = null;
      if (oldWs) { try { oldWs.close(1000, "retry"); } catch (_) {} }

      this.taskId = generateTaskId();
      await new Promise((r) => setTimeout(r, TASK_START_RETRY_DELAY_MS));
      if (this.stopped) throw lastErr || new Error("session stopped");
      await this._openWebSocket();
    };

    // --- Phase 1: retry the configured model --------------------------------
    for (let attempt = 0; attempt <= TASK_START_MAX_RETRIES; attempt++) {
      if (attempt > 0) await rebuildSocket();

      this.taskStartedPromise = null;
      this._sendConfig();
      try {
        await this._awaitReady();
        return; // success
      } catch (err) {
        lastErr = err;
        if (!isRetriableTaskError(err && err.message)) throw err;
        console.warn(
          `${this._tag}: ${this.model} attempt ${attempt + 1}/${TASK_START_MAX_RETRIES + 1} failed: ${err.message}`
        );
      }
    }

    // --- Phase 2: drop a possibly-stale vocabulary_id and retry SAME model ---
    if (this.vocabularyId) {
      console.warn(
        `${this._tag}: retrying ${this.model} without vocabulary_id after repeated failures`
      );
      this.vocabularyId = null;
      try {
        await rebuildSocket();
        this.taskStartedPromise = null;
        this._sendConfig();
        await this._awaitReady();
        this.onStatus({ phase: "vocabulary-dropped" });
        return; // success without the vocabulary
      } catch (err) {
        lastErr = err;
      }
    }

    // Exhausted retries on the requested model — surface the real error.
    throw lastErr;
  }

  _handleMessage(event) {
    if (typeof event.data !== "string") return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    // Filter heartbeat ping/pong frames from the relay Worker. (Real protocol
    // events use dotted type names, so exact "ping"/"pong" never collide.)
    if (msg && (msg.type === "ping" || msg.type === "pong")) return;

    this._handleProtocolMessage(msg);
  }

  _handleClose(event) {
    this._clearHeartbeat();
    this._clearWatchdog();

    if (this._readyReject) {
      this._readyReject(new Error(`Relay closed before ready (code ${event.code})`));
      this._readyResolve = null;
      this._readyReject = null;
    }

    if (!this.stopped && !this._isReconnecting && !this._isRenewing) {
      this._attemptReconnect("close", event.code);
      return;
    }

    if (!this.stopped) {
      this.onError(new Error(`ASR relay closed (code ${event.code})`));
    }
  }

  _handleSocketError() {
    this._clearHeartbeat();
    this._clearWatchdog();

    if (this._readyReject) {
      this._readyReject(new Error("ASR relay socket error"));
      this._readyResolve = null;
      this._readyReject = null;
    }

    if (!this.stopped && !this._isReconnecting && !this._isRenewing) {
      this._attemptReconnect("error", 0);
      return;
    }

    if (!this.stopped) {
      this.onError(new Error("ASR relay socket error"));
    }
  }

  // --- heartbeat keepalive --------------------------------------------------

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch (_) {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // --- watchdog (last-resort stall detection) --------------------------------

  _startWatchdog() {
    this._clearWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (this.stopped || this.paused || this._isRenewing || this._isReconnecting) return;

      this._ensureAudioContextRunning();

      if (this.audioTrack && this.audioTrack.readyState === "ended") {
        console.error(`${this._tag}: audioTrack ended`);
        this.onError(new Error("音频轨道已结束，请重新开始同传"));
        this._clearWatchdog();
        return;
      }

      const elapsed = Date.now() - this._lastResultAt;
      if (elapsed >= WATCHDOG_TIMEOUT_MS) {
        const audioAge = Date.now() - this._lastAudioSentAt;
        const ctxState = this.audioContext ? this.audioContext.state : "none";
        const wsState = this.ws ? this.ws.readyState : -1;
        console.warn(
          `${this._tag}: watchdog fired – no results for ${Math.round(elapsed / 1000)}s, ` +
          `audioCtx=${ctxState}, ws=${wsState}, lastAudio=${Math.round(audioAge / 1000)}s ago`
        );
        this._clearWatchdog();
        this._renewTask("watchdog");
      }
    }, 10_000);
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _ensureAudioContextRunning() {
    if (this.audioContext && this.audioContext.state !== "running" && !this.stopped) {
      console.warn(`${this._tag}: AudioContext state=${this.audioContext.state}, resuming`);
      this.audioContext.resume().catch(() => {});
    }
  }

  // --- silence keepalive (DashScope level) -----------------------------------

  _startSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setInterval(() => {
      if (this.stopped || this.paused || this._isRenewing) return;
      const elapsed = Date.now() - this._lastAudioSentAt;
      if (elapsed >= SILENCE_KEEPALIVE_INTERVAL_MS && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this._sendAudio(SILENCE_FRAME);
          this._lastAudioSentAt = Date.now();
        } catch (_) {}
      }
    }, SILENCE_KEEPALIVE_INTERVAL_MS);
  }

  _clearSilenceTimer() {
    if (this._silenceTimer) {
      clearInterval(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  // --- task renewal (full reconnect through relay) ---------------------------

  async _renewTask(reason = "rotation") {
    if (this.stopped || this._isRenewing) return;
    this._isRenewing = true;

    console.log(`${this._tag}: renewing task (reason=${reason})`);
    this.onStatus({ phase: "reconnecting", attempt: 0, reason });

    this._clearHeartbeat();
    this._clearWatchdog();
    this._clearRotationTimer();

    if (this.ws) {
      try { this._sendFinish(); } catch (_) {}
      try { this.ws.close(1000, "task renewal"); } catch (_) {}
      this.ws = null;
    }

    try {
      this.taskId = generateTaskId();
      this.taskStartedPromise = null;

      await this._openWebSocket();
      await this._startTaskWithRetry();

      // The new task numbers results from 0 again. Drop accumulation and tell
      // the consumer to realign cumulative-text bookkeeping (App.js listens for
      // empty fullText after non-empty and resets processedLength).
      this._resetBuffers();
      this.onUpdate({ fullText: "", finalText: "", confidence: 0, translatedText: "", translatedFinalText: "" });

      this._isRenewing = false;
      this._reconnectAttempt = 0;
      this._lastResultAt = Date.now();
      this._startRotationTimer();
      this.onStatus({ phase: "started" });
      console.log(`${this._tag}: task renewed successfully`);
    } catch (err) {
      console.warn(`${this._tag}: task renewal failed, trying full reconnect:`, err);
      this._isRenewing = false;
      this._attemptReconnect("task-renew-failed", 0);
    }
  }

  // --- proactive rotation timer ----------------------------------------------

  _startRotationTimer() {
    this._clearRotationTimer();
    this._rotationDueAt = 0;
    this._rotationTimer = setTimeout(() => {
      if (this.stopped || this._isRenewing || this._isReconnecting) return;
      this._rotationDueAt = Date.now();
      console.log(`${this._tag}: rotation due, waiting for safe window`);
      this._startRotationDeferLoop();
    }, PROACTIVE_ROTATION_MS);
  }

  _startRotationDeferLoop() {
    this._clearRotationCheckTimer();
    const tick = () => {
      if (this.stopped || this._isRenewing || this._isReconnecting) {
        this._clearRotationCheckTimer();
        return;
      }
      if (!this._rotationDueAt) {
        this._clearRotationCheckTimer();
        return;
      }
      const dueAge = Date.now() - this._rotationDueAt;
      let safe = true;
      try { safe = !!this.canRotateNow(); } catch (e) { safe = true; }

      if (safe || dueAge >= ROTATION_HARD_CEILING_MS) {
        console.log(
          `${this._tag}: rotating (safeWindow=${safe}, deferred=${Math.round(dueAge / 1000)}s)`
        );
        this._clearRotationCheckTimer();
        this._renewTask();
      }
    };
    tick();
    this._rotationCheckTimer = setInterval(tick, ROTATION_DEFER_CHECK_INTERVAL_MS);
  }

  _clearRotationCheckTimer() {
    if (this._rotationCheckTimer) {
      clearInterval(this._rotationCheckTimer);
      this._rotationCheckTimer = null;
    }
  }

  _clearRotationTimer() {
    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }
    this._clearRotationCheckTimer();
    this._rotationDueAt = 0;
  }

  // --- auto-reconnect -------------------------------------------------------

  async _attemptReconnect(trigger, code) {
    if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`${this._tag}: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      this.onError(
        new Error(`ASR relay disconnected (${trigger} code=${code}), max reconnects exceeded`)
      );
      return;
    }

    this._isReconnecting = true;
    this._reconnectAttempt++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this._reconnectAttempt - 1);
    console.log(
      `${this._tag}: reconnect attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms (${trigger} code=${code})`
    );

    this.onStatus({
      phase: "reconnecting",
      attempt: this._reconnectAttempt,
      reason: trigger === "task-renew-failed" ? "renew-failed" : "drop",
    });

    await new Promise((r) => setTimeout(r, delay));

    if (this.stopped) {
      this._isReconnecting = false;
      return;
    }

    try {
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }

      this.taskId = generateTaskId();
      this.taskStartedPromise = null;

      await this._openWebSocket();
      await this._startTaskWithRetry();

      this._resetBuffers();
      this.onUpdate({ fullText: "", finalText: "", confidence: 0, translatedText: "", translatedFinalText: "" });

      this._reconnectAttempt = 0;
      this._isReconnecting = false;
      this._lastResultAt = Date.now();
      this._startRotationTimer();
      this.onStatus({ phase: "started" });
      console.log(`${this._tag}: reconnected successfully`);
    } catch (err) {
      console.warn(`${this._tag}: reconnect failed:`, err);
      this._isReconnecting = false;
      this._attemptReconnect(trigger, code);
    }
  }
}
