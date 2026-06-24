// Paraformer real-time ASR session adapter.
//
// Wraps the WebSocket relay (Cloudflare Worker → DashScope Paraformer) and the
// AudioWorklet PCM pipeline behind a small interface that mirrors what the
// existing webkitSpeechRecognition path already feeds into the App.
//
// Lifecycle:
//   const session = new ParaformerSession({ wsUrl, audioTrack, onUpdate, onError });
//   await session.start();
//   ...
//   session.pause(); session.resume();
//   await session.stop();
//
// onUpdate is called with { fullText, finalText, confidence } whenever the
// running transcript changes; the caller drives its own silence timer / UI.

const DEFAULT_PARAFORMER_MODEL = "paraformer-realtime-v2";
const FRAME_SIZE = 1600; // 100 ms at 16 kHz
const TARGET_SAMPLE_RATE = 16000;
const TASK_STARTED_TIMEOUT_MS = 5000;

// DashScope occasionally returns spurious "free tier exhausted" task-failed
// errors even when quota is available. Retry run-task a few times before
// surfacing the error to the user.
const TASK_START_MAX_RETRIES = 2;
const TASK_START_RETRY_DELAY_MS = 2000;

// Heartbeat: the Cloudflare Worker relay has a ~100 s idle timeout.
// We ping every 25 s to stay well within the limit.
const HEARTBEAT_INTERVAL_MS = 25_000;

// DashScope's own idle timeout: the server ends the ASR task if it receives
// no valid audio for a while (~60 s). We send silence PCM frames every 15 s
// during quiet periods to prevent this.
const SILENCE_KEEPALIVE_INTERVAL_MS = 15_000;

// A silence PCM frame: FRAME_SIZE samples of 16-bit zeros = 100 ms of silence.
// This is small enough to not affect transcription, but tells DashScope the
// stream is still alive.
const SILENCE_FRAME = new ArrayBuffer(FRAME_SIZE * 2); // pre-zeroed

// Watchdog: if we receive no result-generated events for this long while the
// session is supposed to be live, proactively renew the task. This catches
// the case where DashScope silently stops producing results without sending
// any close / task-finished / task-failed event.
const WATCHDOG_TIMEOUT_MS = 45_000;

// Proactive rotation: DashScope paraformer-realtime-v2 has an undocumented
// maximum task duration (~15-20 min). Rather than waiting for it to silently
// stop, we proactively tear down and rebuild the full pipeline every 14 min.
const PROACTIVE_ROTATION_MS = 14 * 60 * 1000;

// Once rotation is due, we wait for the App's canRotateNow() to return true
// (= user is in a natural pause / no active utterance) before swapping the
// pipeline. Check every 5 s. If the user keeps talking past this ceiling,
// rotate anyway — better a small mid-utterance hiccup than a silent task
// timeout.
const ROTATION_DEFER_CHECK_INTERVAL_MS = 5_000;
const ROTATION_HARD_CEILING_MS = 3 * 60 * 1000;

// Auto-reconnect: if the relay drops mid-session (e.g. CF runtime update),
// we transparently re-establish the connection so the user doesn't notice.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1500;

const generateTaskId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
};

const sanitizeText = (input) =>
  String(input || "")
    .replace(/<\/?s>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const averageWordConfidence = (words) => {
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

// Detect DashScope errors that are worth retrying (transient quota glitches,
// rate limits, etc.) vs. genuine fatal errors (bad model name, auth failure).
const isRetriableTaskError = (msg) => {
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

export class ParaformerSession {
  constructor({
    wsUrl,
    audioTrack,
    languageHints,
    vocabularyId,
    model,
    onUpdate,
    onError,
    onStatus,
    canRotateNow,
  }) {
    if (!wsUrl) throw new Error("ParaformerSession: wsUrl is required");
    if (!audioTrack) throw new Error("ParaformerSession: audioTrack is required");

    this.wsUrl = wsUrl;
    this.audioTrack = audioTrack;
    this.languageHints = Array.isArray(languageHints) && languageHints.length > 0
      ? languageHints
      : ["en"];
    this.vocabularyId = (vocabularyId && String(vocabularyId).trim()) || null;
    this.model = (model && String(model).trim()) || DEFAULT_PARAFORMER_MODEL;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};
    this.onError = typeof onError === "function" ? onError : () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    this.canRotateNow = typeof canRotateNow === "function" ? canRotateNow : () => true;

    this.ws = null;
    this.taskId = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.sentences = []; // { id, text, isFinal }
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

  // Discard the accumulated transcript buffer so the cumulative fullText starts
  // fresh. Used when the user clears the on-screen transcript mid-session: the
  // WebSocket / ASR task stays open (no recognition gap), but the next
  // result-generated event rebuilds from an empty buffer instead of replaying
  // everything spoken before the clear.
  resetTranscript() {
    this.sentences = [];
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    this._clearHeartbeat();
    this._clearSilenceTimer();
    this._clearWatchdog();
    this._clearRotationTimer();

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            header: {
              action: "finish-task",
              task_id: this.taskId,
              streaming: "duplex",
            },
            payload: { input: {} },
          })
        );
      }
    } catch (e) {}

    this._teardownAudio();

    if (this.ws) {
      try { this.ws.close(1000, "client stop"); } catch (e) {}
      this.ws = null;
    }
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
        // event can arrive after we've already moved on to a new WS. Without
        // this check, the old close event re-enters _handleClose with the
        // current flags (e.g. _isRenewing already cleared) and triggers a
        // bogus "relay closed" + reconnect cascade against the live session.
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
        reject(new Error("Paraformer relay WebSocket connect failed"));
      };
      const onClose = (event) => {
        cleanup();
        reject(new Error(`Paraformer relay WS closed before open (code ${event.code})`));
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

    // Chrome suspends AudioContext when the tab goes to background.
    // Auto-resume to keep audio flowing.
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "suspended" && !this.stopped && !this.paused) {
        console.warn("ParaformerSession: AudioContext suspended, resuming...");
        ctx.resume().catch(() => {});
      }
    });
    // Ensure it's running from the start.
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
          this.ws.send(buf);
          this._lastAudioSentAt = Date.now();
        } catch (e) {}
      }
    };

    // Silence keepalive: if AudioWorklet stops delivering frames (e.g. tab
    // audio goes silent), DashScope's VAD will eventually time out the task.
    // We periodically inject a silence frame to prevent that.
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

  _sendRunTask() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const parameters = {
      format: "pcm",
      sample_rate: TARGET_SAMPLE_RATE,
      language_hints: this.languageHints,
    };
    if (this.vocabularyId) parameters.vocabulary_id = this.vocabularyId;

    const runTask = {
      header: {
        action: "run-task",
        task_id: this.taskId,
        streaming: "duplex",
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: this.model,
        parameters,
        input: {},
      },
    };
    try { this.ws.send(JSON.stringify(runTask)); } catch (e) {}
  }

  _awaitTaskStarted() {
    if (this.taskStartedPromise) return this.taskStartedPromise;
    this.taskStartedPromise = new Promise((resolve, reject) => {
      this._taskStartedResolve = resolve;
      this._taskStartedReject = reject;
      setTimeout(() => {
        if (this._taskStartedResolve) {
          const err = new Error("Paraformer task-started timeout");
          this._taskStartedReject?.(err);
          this._taskStartedResolve = null;
          this._taskStartedReject = null;
        }
      }, TASK_STARTED_TIMEOUT_MS);
    });
    return this.taskStartedPromise;
  }

  // Wrap _sendRunTask + _awaitTaskStarted with retry logic for transient
  // DashScope errors (e.g. spurious "free tier exhausted" when quota is
  // actually available, or temporary rate limits).
  // Each retry tears down the old WebSocket and opens a fresh one, because
  // DashScope typically closes the upstream connection after task-failed.
  //
  // IMPORTANT: we do NOT silently downgrade the model (e.g. v2 → v1). The user
  // chooses the ASR model deliberately (and may have quota specifically for
  // paraformer-realtime-v2); a hidden downgrade produces worse results and
  // masks the real failure. Instead, if a hot-word vocabulary_id is set, we
  // drop it and retry the SAME model once (a stale/deleted vocabulary is a
  // common cause of run-task failure). If the requested model still cannot
  // start, we surface the real error.
  async _startTaskWithRetry() {
    let lastErr;

    // Tear down the current WS and open a fresh one for a retry. Null this.ws
    // FIRST so the stale-handler guard skips the old socket's close event.
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

    // --- Phase 1: retry the configured model ----------------------------------
    for (let attempt = 0; attempt <= TASK_START_MAX_RETRIES; attempt++) {
      if (attempt > 0) await rebuildSocket();

      this.taskStartedPromise = null;
      this._sendRunTask();
      try {
        await this._awaitTaskStarted();
        return; // success
      } catch (err) {
        lastErr = err;
        if (!isRetriableTaskError(err && err.message)) throw err;
        console.warn(
          `ParaformerSession: ${this.model} attempt ${attempt + 1}/${TASK_START_MAX_RETRIES + 1} failed: ${err.message}`
        );
      }
    }

    // --- Phase 2: drop a possibly-stale vocabulary_id and retry SAME model -----
    if (this.vocabularyId) {
      console.warn(
        `ParaformerSession: retrying ${this.model} without vocabulary_id after repeated failures`
      );
      this.vocabularyId = null;
      try {
        await rebuildSocket();
        this.taskStartedPromise = null;
        this._sendRunTask();
        await this._awaitTaskStarted();
        this.onStatus({ phase: "vocabulary-dropped" });
        return; // success without the vocabulary
      } catch (err) {
        lastErr = err;
      }
    }

    // Exhausted retries on the requested model — surface the real error rather
    // than silently switching to a different model.
    throw lastErr;
  }

  _handleMessage(event) {
    if (typeof event.data !== "string") return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    // Filter out heartbeat ping/pong frames from the relay Worker.
    if (msg && (msg.type === "ping" || msg.type === "pong")) return;

    const evt = msg && msg.header && msg.header.event;
    if (!evt) return;

    if (evt === "task-started") {
      if (this._taskStartedResolve) {
        this._taskStartedResolve();
        this._taskStartedResolve = null;
        this._taskStartedReject = null;
      }
      return;
    }

    if (evt === "result-generated") {
      this._lastResultAt = Date.now(); // reset watchdog
      const sentence = msg.payload && msg.payload.output && msg.payload.output.sentence;
      if (sentence) this._applySentence(sentence);
      return;
    }

    if (evt === "task-failed") {
      const errMsg = (msg.header && (msg.header.error_message || msg.header.error_code)) || "task failed";
      if (this._taskStartedReject) {
        // During startup / renewal / reconnect the caller awaits
        // _awaitTaskStarted and will handle the rejection (including retry
        // logic for transient errors). Don't also fire onError here —
        // that would cause a spurious error toast before the retry fires.
        this._taskStartedReject(new Error(errMsg));
        this._taskStartedResolve = null;
        this._taskStartedReject = null;
        return;
      }
      this.onError(new Error(`Paraformer: ${errMsg}`));
      return;
    }

    // DashScope ended the ASR task (idle timeout / max duration reached).
    // The WebSocket connection is still open and reusable — start a new task.
    if (evt === "task-finished") {
      if (this._isRenewing || this._isReconnecting) return; // already handling
      console.log("ParaformerSession: task-finished received, renewing task");
      this._renewTask("task-finished");
      return;
    }
  }

  _handleClose(event) {
    this._clearHeartbeat();
    this._clearWatchdog();

    if (this._taskStartedReject) {
      this._taskStartedReject(new Error(`Relay closed before task-started (code ${event.code})`));
      this._taskStartedResolve = null;
      this._taskStartedReject = null;
    }

    // If not intentionally stopped and not already reconnecting/renewing, try to recover.
    if (!this.stopped && !this._isReconnecting && !this._isRenewing) {
      this._attemptReconnect("close", event.code);
      return;
    }

    if (!this.stopped) {
      this.onError(new Error(`Paraformer relay closed (code ${event.code})`));
    }
  }

  _handleSocketError() {
    this._clearHeartbeat();
    this._clearWatchdog();

    if (this._taskStartedReject) {
      this._taskStartedReject(new Error("Paraformer relay socket error"));
      this._taskStartedResolve = null;
      this._taskStartedReject = null;
    }

    // Try to reconnect on unexpected errors too.
    if (!this.stopped && !this._isReconnecting && !this._isRenewing) {
      this._attemptReconnect("error", 0);
      return;
    }

    if (!this.stopped) {
      this.onError(new Error("Paraformer relay socket error"));
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
  // If DashScope silently stops sending results (no task-finished, no error),
  // the watchdog fires after WATCHDOG_TIMEOUT_MS of result silence and forces
  // a task renewal.

  _startWatchdog() {
    this._clearWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (this.stopped || this.paused || this._isRenewing || this._isReconnecting) return;

      // --- audio health check ---
      this._ensureAudioContextRunning();

      // Check if the audio track has ended (e.g. user stopped sharing tab).
      if (this.audioTrack && this.audioTrack.readyState === "ended") {
        console.error("ParaformerSession: audioTrack ended");
        this.onError(new Error("音频轨道已结束，请重新开始同传"));
        this._clearWatchdog();
        return;
      }

      // --- result staleness check ---
      const elapsed = Date.now() - this._lastResultAt;
      if (elapsed >= WATCHDOG_TIMEOUT_MS) {
        const audioAge = Date.now() - this._lastAudioSentAt;
        const ctxState = this.audioContext ? this.audioContext.state : "none";
        const wsState = this.ws ? this.ws.readyState : -1;
        console.warn(
          `ParaformerSession: watchdog fired – no results for ${Math.round(elapsed / 1000)}s, ` +
          `audioCtx=${ctxState}, ws=${wsState}, lastAudio=${Math.round(audioAge / 1000)}s ago`
        );
        this._clearWatchdog();
        this._renewTask("watchdog");
      }
    }, 10_000); // check every 10 s
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // Resume AudioContext if Chrome suspended it (background tab, etc.)
  _ensureAudioContextRunning() {
    if (this.audioContext && this.audioContext.state !== "running" && !this.stopped) {
      console.warn(`ParaformerSession: AudioContext state=${this.audioContext.state}, resuming`);
      this.audioContext.resume().catch(() => {});
    }
  }

  // --- silence keepalive (DashScope level) -----------------------------------
  // DashScope ends the ASR task if it receives no audio for its own idle
  // timeout (~60 s). During silent classroom periods the AudioWorklet may
  // deliver near-zero-energy frames, but if tab capture goes fully mute
  // (e.g. shared tab navigated away) no frames arrive at all. We inject a
  // silence PCM frame periodically to reset DashScope's idle timer.

  _startSilenceTimer() {
    this._clearSilenceTimer();
    this._silenceTimer = setInterval(() => {
      if (this.stopped || this.paused || this._isRenewing) return;
      const elapsed = Date.now() - this._lastAudioSentAt;
      if (elapsed >= SILENCE_KEEPALIVE_INTERVAL_MS && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(SILENCE_FRAME);
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
  // When DashScope ends a task (task-finished, watchdog, or proactive rotation)
  // we do a FULL reconnect: close old WS → open new WS → new run-task.
  // This is more reliable than trying to reuse the existing WS, because
  // DashScope may have silently abandoned the upstream connection.

  async _renewTask(reason = "rotation") {
    if (this.stopped || this._isRenewing) return;
    this._isRenewing = true;

    console.log(`ParaformerSession: renewing task (reason=${reason})`);
    // reason: "rotation" (planned) → App suppresses toast; "task-finished" /
    // "watchdog" → App still shows a soft notice. "drop" handled by
    // _attemptReconnect with its own trigger.
    this.onStatus({ phase: "reconnecting", attempt: 0, reason });

    this._clearHeartbeat();
    this._clearWatchdog();
    this._clearRotationTimer();

    // Close old WS cleanly.
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({
          header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
      } catch (_) {}
      try { this.ws.close(1000, "task renewal"); } catch (_) {}
      this.ws = null;
    }

    try {
      this.taskId = generateTaskId();
      this.taskStartedPromise = null;

      await this._openWebSocket();  // new WS → new upstream in Worker
      await this._startTaskWithRetry();

      // The new task numbers sentences from 0 again. If we kept the old
      // sentences[] entries with the same ids, _applySentence would replace
      // them mid-array and fullText would collapse, leaving the App's
      // processedLength stranded past the new (much shorter) fullText.
      this.sentences = [];
      // Tell the consumer to realign its cumulative-text bookkeeping. App.js
      // listens for empty fullText after non-empty and resets processedLength.
      this.onUpdate({ fullText: "", finalText: "", confidence: 0 });

      this._isRenewing = false;
      this._reconnectAttempt = 0;
      this._lastResultAt = Date.now();
      this._startRotationTimer();
      this.onStatus({ phase: "started" });
      console.log("ParaformerSession: task renewed successfully");
    } catch (err) {
      console.warn("ParaformerSession: task renewal failed, trying full reconnect:", err);
      this._isRenewing = false;
      this._attemptReconnect("task-renew-failed", 0);
    }
  }

  // --- proactive rotation timer ----------------------------------------------
  // Don't wait for DashScope to time out — preemptively rotate every 14 min.

  _startRotationTimer() {
    this._clearRotationTimer();
    this._rotationDueAt = 0;
    this._rotationTimer = setTimeout(() => {
      if (this.stopped || this._isRenewing || this._isReconnecting) return;
      // Mark rotation due; the deferred-rotation loop will swap the pipeline
      // on the next moment the App reports a natural pause (or the hard
      // ceiling, whichever comes first).
      this._rotationDueAt = Date.now();
      console.log("ParaformerSession: rotation due, waiting for safe window");
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
          `ParaformerSession: rotating (safeWindow=${safe}, deferred=${Math.round(dueAge / 1000)}s)`
        );
        this._clearRotationCheckTimer();
        this._renewTask();
      }
    };
    // First check immediately; subsequent every interval.
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
      console.warn(
        `ParaformerSession: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
      );
      this.onError(
        new Error(
          `Paraformer relay disconnected (${trigger} code=${code}), max reconnects exceeded`
        )
      );
      return;
    }

    this._isReconnecting = true;
    this._reconnectAttempt++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this._reconnectAttempt - 1);
    console.log(
      `ParaformerSession: reconnect attempt ${this._reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms (${trigger} code=${code})`
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
      // Close old socket if it somehow lingered.
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }

      // Generate a fresh task ID for the new DashScope session.
      this.taskId = generateTaskId();
      this.taskStartedPromise = null;

      await this._openWebSocket();
      await this._startTaskWithRetry();

      // New task → new sentence_id space. Drop accumulated sentences and
      // signal the App to reset processedLength (see _renewTask comment).
      this.sentences = [];
      this.onUpdate({ fullText: "", finalText: "", confidence: 0 });

      // Success – reset counter.
      this._reconnectAttempt = 0;
      this._isReconnecting = false;
      this._lastResultAt = Date.now();
      this._startRotationTimer();
      this.onStatus({ phase: "started" });
      console.log("ParaformerSession: reconnected successfully");
    } catch (err) {
      console.warn("ParaformerSession: reconnect failed:", err);
      this._isReconnecting = false;
      // Recurse to try the next attempt.
      this._attemptReconnect(trigger, code);
    }
  }

  _applySentence(sentence) {
    const id = sentence.sentence_id != null
      ? String(sentence.sentence_id)
      : sentence.begin_time != null
      ? `bt-${sentence.begin_time}`
      : `auto-${this.sentences.length}`;
    const text = sanitizeText(sentence.text);
    const isFinal = !!(sentence.sentence_end || sentence.end_time);

    if (!text && !isFinal) return;

    const idx = this.sentences.findIndex((s) => s.id === id);
    if (idx >= 0) {
      this.sentences[idx] = { id, text, isFinal };
    } else {
      this.sentences.push({ id, text, isFinal });
    }

    const fullText = this.sentences
      .map((s) => s.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    const finalText = this.sentences
      .filter((s) => s.isFinal)
      .map((s) => s.text)
      .filter(Boolean)
      .join(" ")
      .trim();

    const confidence = averageWordConfidence(sentence.words);

    this.onUpdate({ fullText, finalText, confidence });
  }
}
