// Qwen LiveTranslate real-time speech-translation session adapter.
//
// DashScope "Omni-Realtime" protocol over the WebSocket relay (Cloudflare
// Worker → DashScope `/api-ws/v1/realtime?model=...`). This is a different wire
// protocol from Paraformer/Gummy: a `session.update` configures source/target
// languages, audio is sent as base64 `input_audio_buffer.append` events, and
// the server streams source transcription + translated text (+ optional speech)
// back as `conversation.item.input_audio_transcription.*` and `response.*`
// events. All the transport/resilience machinery comes from BaseAsrSession.
//
// One-pass: this session emits both the source English (`fullText`) and the
// translated Chinese (`translatedText`) on `onUpdate`, so the App drives ZH
// directly and skips its interim-LLM translate loop (see App.js
// applyTranscriptUpdate / asrProvidesTranslationRef).
//
// NOTE: event/field names are best-effort against the Jan-2026 Omni-Realtime
// docs and may need a tweak after a live test — unhandled event types are
// console.debug-logged once to make that easy (same approach as Gummy).

import { BaseAsrSession, sanitizeText, generateEventId } from "./baseAsrSession";
import { AsrAudioPlayer } from "./asrAudioPlayer";

const DEFAULT_SOURCE_LANG = "en";
const DEFAULT_TARGET_LANG = "zh";
// Internal ASR sub-model the realtime model uses to transcribe the source.
const SOURCE_ASR_MODEL = "qwen3-asr-flash-realtime";

const toUint8 = (buf) =>
  buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const arrayBufferToBase64 = (buf) => {
  const bytes = toUint8(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

export class LiveTranslateSession extends BaseAsrSession {
  constructor(options) {
    super(options);
    const { sourceLang, target, audioOutput } = options || {};
    this.sourceLang = (sourceLang && String(sourceLang).trim()) || DEFAULT_SOURCE_LANG;
    this.target = (target && String(target).trim()) || DEFAULT_TARGET_LANG;
    this.audioOutput = !!audioOutput;

    // Ordered accumulation across turns. EN keyed by input-transcription item,
    // ZH keyed by response — independent cumulative strings (the App tracks each
    // with its own processedLength).
    // Cumulative transcript accumulation, id-free: completed utterances/responses
    // are appended permanently; the in-progress partial shows transiently. This
    // avoids depending on item_id/response_id (DashScope may omit them) and uses
    // only the event type (.completed/.done vs streaming) to decide.
    this._enFinalParts = []; // completed source (EN) transcripts
    this._enPartial = "";    // in-progress source partial
    this._zhFinalParts = []; // completed translated (ZH) texts
    this._zhPartial = "";    // in-progress translation (accumulated deltas)
    this._loggedUnknown = new Set(); // log each unrecognized event type once (debug)
    this._configSent = false; // one-shot session.update per connection

    this._player = null; // lazy AsrAudioPlayer when audioOutput is on
  }

  // ---- protocol hooks ----------------------------------------------------

  // Base calls this on every (re)connect. The realtime handshake requires
  // waiting for `session.created` before configuring, and DashScope allows the
  // session to be configured only ONCE ("session already started" otherwise) —
  // so we just arm the one-shot here and send the real session.update when
  // session.created arrives.
  _sendConfig() {
    this._configSent = false;
  }

  _sendSessionUpdate() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const session = {
      modalities: this.audioOutput ? ["text", "audio"] : ["text"],
      input_audio_format: "pcm",
      input_audio_transcription: { model: SOURCE_ASR_MODEL, language: this.sourceLang },
      translation: { language: this.target },
      turn_detection: { type: "server_vad" },
    };
    if (this.audioOutput) session.output_audio_format = "pcm";
    try {
      this.ws.send(
        JSON.stringify({ event_id: generateEventId(), type: "session.update", session })
      );
    } catch (e) {}
  }

  _sendAudio(buf) {
    // Omni-Realtime: base64 PCM in an input_audio_buffer.append event.
    this.ws.send(
      JSON.stringify({
        event_id: generateEventId(),
        type: "input_audio_buffer.append",
        audio: arrayBufferToBase64(buf),
      })
    );
  }

  // No explicit finish event — closing the socket ends the session, so the base
  // no-op _sendFinish() is correct.

  _resetBuffers() {
    this._enFinalParts = [];
    this._enPartial = "";
    this._zhFinalParts = [];
    this._zhPartial = "";
    if (this._player) this._player.reset();
  }

  _handleProtocolMessage(msg) {
    const type = msg && msg.type;
    if (!type || typeof type !== "string") return;

    if (type === "session.created") {
      // Configure exactly once, now that the session exists. Sending more than
      // one session.update per session is rejected ("session already started").
      // Readiness is signalled by session.updated.
      if (!this._configSent) {
        this._configSent = true;
        this._sendSessionUpdate();
      }
      return;
    }
    if (type === "session.updated") {
      this._signalReady();
      return;
    }

    if (type === "error") {
      const err = msg.error || {};
      const errMsg = err.message || err.code || msg.message || "realtime error";
      // "model repeat output happened" is DashScope's repeat-guard — a transient
      // hiccup; the server closes the socket and we auto-reconnect, so don't pop
      // an error toast for it (only surface genuinely fatal errors). During
      // startup (_readyReject set) always reject so the retry logic can react.
      if (!this._readyReject && /repeat output|repeat detected|repetition/i.test(errMsg)) {
        console.warn(`${this._tag}: transient model error, recovering on reconnect: ${errMsg}`);
        return;
      }
      this._handleFatalError(errMsg);
      return;
    }

    // --- source (input) transcription -> English ---
    // Streaming `.text` events carry the confirmed prefix in `text` and the
    // tentative tail in `stash`; the live hypothesis is text + stash. `.completed`
    // carries the authoritative full `transcript`.
    if (type.indexOf("input_audio_transcription") !== -1) {
      this._markResult();
      if (/\.completed$/.test(type)) {
        const t = sanitizeText(msg.transcript ?? msg.text);
        if (t) this._enFinalParts.push(t);
        this._enPartial = "";
        // end of a source turn (server VAD) — a real boundary for the App's
        // bubble grouping. Marked on both EN .completed and ZH .done because
        // their order varies.
        this._emit({ turnFinal: true });
      } else {
        this._enPartial = sanitizeText(
          [msg.text, msg.stash ?? msg.delta].filter(Boolean).join(" ")
        );
        this._emit();
      }
      return;
    }

    // --- translated output -> Chinese ---
    // Same shape as the source: partial `response.{audio_transcript|text}.text`
    // carries confirmed `text` + tentative `stash`; `.done` carries the full
    // `transcript` (audio) / `text` (text-only) AND marks the end of the model's
    // turn (server VAD), so we flag turnFinal for the App to finalize the bubble.
    if (/^response\.(text|audio_transcript)\.(text|delta|done)$/.test(type)) {
      this._markResult();
      if (/\.done$/.test(type)) {
        const t = sanitizeText(msg.transcript ?? msg.text);
        if (t) this._zhFinalParts.push(t);
        this._zhPartial = "";
        this._emit({ turnFinal: true });
      } else {
        // confirmed `text` + tentative `stash`, concatenated (no space for zh)
        this._zhPartial = sanitizeText(`${msg.text || ""}${msg.stash ?? msg.delta ?? ""}`);
        this._emit();
      }
      return;
    }

    // --- streamed translated speech ---
    if (type === "response.audio.delta") {
      this._markResult();
      if (this.audioOutput && msg.delta) this._ensurePlayer().feed(msg.delta);
      return;
    }

    // Benign lifecycle / no-op events.
    if (
      type === "response.created" ||
      type === "response.done" ||
      type === "response.audio.done" ||
      type === "response.output_item.added" ||
      type === "response.output_item.done" ||
      type === "response.content_part.added" ||
      type === "response.content_part.done" ||
      type === "input_audio_buffer.speech_started" ||
      type === "input_audio_buffer.speech_stopped" ||
      type === "input_audio_buffer.committed" ||
      type === "conversation.item.created" ||
      type === "rate_limits.updated"
    ) {
      return;
    }

    // Unrecognized event — no action needed, but log once (debug-level, hidden
    // by default) so a future DashScope protocol change is discoverable.
    if (!this._loggedUnknown.has(type)) {
      this._loggedUnknown.add(type);
      console.debug(`${this._tag}: unhandled event "${type}"`);
    }
  }

  // ---- accumulation ------------------------------------------------------

  _join(parts, tail) {
    return [...parts, tail]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _emit(opts) {
    this.onUpdate({
      fullText: this._join(this._enFinalParts, this._enPartial),
      finalText: this._join(this._enFinalParts, ""),
      confidence: 0,
      translatedText: this._join(this._zhFinalParts, this._zhPartial),
      translatedFinalText: this._join(this._zhFinalParts, ""),
      // model signalled end-of-turn → App should finalize this bubble now
      turnFinal: !!(opts && opts.turnFinal),
    });
  }

  // ---- audio output ------------------------------------------------------

  _ensurePlayer() {
    if (!this._player) this._player = new AsrAudioPlayer();
    return this._player;
  }

  // Toggle spoken-translation output mid-session. The session's modality is
  // fixed at creation (a live session.update is rejected), so switch by renewing
  // the task — a brief reconnect that reconfigures with the new modalities.
  // Called by the App's UI toggle.
  setAudioOutput(enabled) {
    const next = !!enabled;
    if (next === this.audioOutput) return;
    this.audioOutput = next;
    if (next) {
      this._ensurePlayer().enable();
    } else if (this._player) {
      this._player.disable();
    }
    if (this.ws && !this.stopped && !this._isRenewing && !this._isReconnecting) {
      this._renewTask("audio-toggle");
    }
  }

  async stop() {
    if (this._player) {
      try { this._player.dispose(); } catch (_) {}
      this._player = null;
    }
    await super.stop();
  }
}
