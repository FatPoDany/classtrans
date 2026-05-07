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

const PARAFORMER_MODEL = "paraformer-realtime-v2";
const FRAME_SIZE = 1600; // 100 ms at 16 kHz
const TARGET_SAMPLE_RATE = 16000;
const TASK_STARTED_TIMEOUT_MS = 5000;

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
const WATCHDOG_TIMEOUT_MS = 90_000;

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

export class ParaformerSession {
  constructor({
    wsUrl,
    audioTrack,
    languageHints,
    vocabularyId,
    onUpdate,
    onError,
    onStatus,
  }) {
    if (!wsUrl) throw new Error("ParaformerSession: wsUrl is required");
    if (!audioTrack) throw new Error("ParaformerSession: audioTrack is required");

    this.wsUrl = wsUrl;
    this.audioTrack = audioTrack;
    this.languageHints = Array.isArray(languageHints) && languageHints.length > 0
      ? languageHints
      : ["en"];
    this.vocabularyId = (vocabularyId && String(vocabularyId).trim()) || null;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};
    this.onError = typeof onError === "function" ? onError : () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};

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
    this._sendRunTask();
    await this._awaitTaskStarted();
    this.onStatus({ phase: "started" });
    this._lastResultAt = Date.now(); // arm watchdog from session start
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    this._clearHeartbeat();
    this._clearSilenceTimer();
    this._clearWatchdog();

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
        ws.addEventListener("message", (ev) => this._handleMessage(ev));
        ws.addEventListener("close", (ev) => this._handleClose(ev));
        ws.addEventListener("error", () => this._handleSocketError());
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
        model: PARAFORMER_MODEL,
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
        this._taskStartedReject(new Error(errMsg));
        this._taskStartedResolve = null;
        this._taskStartedReject = null;
      }
      this.onError(new Error(`Paraformer: ${errMsg}`));
      return;
    }

    // DashScope ended the ASR task (idle timeout / max duration reached).
    // The WebSocket connection is still open and reusable — start a new task.
    if (evt === "task-finished") {
      console.log("ParaformerSession: task-finished received, renewing task");
      this._renewTask();
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

    // If not intentionally stopped and not already reconnecting, try to recover.
    if (!this.stopped && !this._isReconnecting) {
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
    if (!this.stopped && !this._isReconnecting) {
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
      const elapsed = Date.now() - this._lastResultAt;
      if (elapsed >= WATCHDOG_TIMEOUT_MS) {
        console.warn(
          `ParaformerSession: watchdog fired – no results for ${Math.round(elapsed / 1000)}s, renewing task`
        );
        this._clearWatchdog();
        this._renewTask();
      }
    }, 10_000); // check every 10 s
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
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

  // --- task renewal (same WS, new DashScope task) ----------------------------
  // When DashScope sends task-finished (idle timeout / max duration), we
  // simply start a fresh task on the *same* WebSocket. This is seamless for
  // the user because the audio pipeline and CF relay connection remain intact.

  async _renewTask() {
    if (this.stopped || this._isRenewing) return;
    this._isRenewing = true;

    console.log("ParaformerSession: renewing DashScope task on existing WS");
    this.onStatus({ phase: "reconnecting", attempt: 0 });

    try {
      this.taskId = generateTaskId();
      this.taskStartedPromise = null;
      this._sendRunTask();
      await this._awaitTaskStarted();

      this._isRenewing = false;
      this.onStatus({ phase: "started" });
      this._lastResultAt = Date.now(); // reset watchdog for new task
      this._startWatchdog();
      console.log("ParaformerSession: task renewed successfully");
    } catch (err) {
      console.warn("ParaformerSession: task renewal failed, trying full reconnect:", err);
      this._isRenewing = false;
      // If in-place renewal fails, fall back to full reconnect.
      this._attemptReconnect("task-renew-failed", 0);
    }
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

    this.onStatus({ phase: "reconnecting", attempt: this._reconnectAttempt });

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
      this._sendRunTask();
      await this._awaitTaskStarted();

      // Success – reset counter.
      this._reconnectAttempt = 0;
      this._isReconnecting = false;
      this._lastResultAt = Date.now();
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
