// Paraformer / Gummy real-time ASR session adapter.
//
// DashScope "run-task" protocol over the WebSocket relay (Cloudflare Worker →
// DashScope `/api-ws/v1/inference`). Wraps that protocol behind the
// BaseAsrSession transport/resilience machinery.
//
// Lifecycle:
//   const session = new ParaformerSession({ wsUrl, audioTrack, onUpdate, onError });
//   await session.start();
//   ...
//   session.pause(); session.resume();
//   await session.stop();
//
// Gummy (e.g. gummy-realtime-v1) is a one-pass speech-translation model that
// streams the source transcription AND the target translation together over the
// SAME run-task protocol; detecting it switches the run-task parameters and the
// result parsing while reusing everything else.

import {
  BaseAsrSession,
  sanitizeText,
  averageWordConfidence,
  TARGET_SAMPLE_RATE,
} from "./baseAsrSession";

const DEFAULT_PARAFORMER_MODEL = "paraformer-realtime-v2";

const isGummyModel = (name) => /^gummy/i.test(String(name || "").trim());

export class ParaformerSession extends BaseAsrSession {
  constructor(options) {
    super(options);
    const { languageHints, vocabularyId, translationTargets } = options || {};
    this.languageHints =
      Array.isArray(languageHints) && languageHints.length > 0 ? languageHints : ["en"];
    this.vocabularyId = (vocabularyId && String(vocabularyId).trim()) || null;
    if (!this.model) this.model = DEFAULT_PARAFORMER_MODEL;
    // Target language(s) for one-pass speech-translation models (Gummy).
    this.translationTargets =
      Array.isArray(translationTargets) && translationTargets.length > 0
        ? translationTargets
        : ["zh"];
  }

  // ---- protocol hooks ----------------------------------------------------

  _sendConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let parameters;
    if (isGummyModel(this.model)) {
      // Gummy: one-pass speech translation. Source language from the first
      // language hint (default en); translation enabled to the target list.
      parameters = {
        format: "pcm",
        sample_rate: TARGET_SAMPLE_RATE,
        source_language: (this.languageHints && this.languageHints[0]) || "en",
        transcription_enabled: true,
        translation_enabled: true,
        translation_target_languages: this.translationTargets,
      };
      if (this.vocabularyId) parameters.vocabulary_id = this.vocabularyId;
    } else {
      parameters = {
        format: "pcm",
        sample_rate: TARGET_SAMPLE_RATE,
        language_hints: this.languageHints,
      };
      if (this.vocabularyId) parameters.vocabulary_id = this.vocabularyId;
    }

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

  // Default _sendAudio (raw binary frame) from BaseAsrSession is correct here.

  _sendFinish() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
          payload: { input: {} },
        })
      );
    } catch (e) {}
  }

  _handleProtocolMessage(msg) {
    const evt = msg && msg.header && msg.header.event;
    if (!evt) return;

    if (evt === "task-started") {
      this._signalReady();
      return;
    }

    if (evt === "result-generated") {
      this._markResult();
      const output = msg.payload && msg.payload.output;
      if (output) {
        if (isGummyModel(this.model)) {
          this._applyGummyOutput(output);
        } else if (output.sentence) {
          this._applySentence(output.sentence);
        }
      }
      return;
    }

    if (evt === "task-failed") {
      const errMsg =
        (msg.header && (msg.header.error_message || msg.header.error_code)) || "task failed";
      this._handleFatalError(errMsg);
      return;
    }

    // DashScope ended the task (idle timeout / max duration). The WebSocket is
    // still open and reusable — start a new task.
    if (evt === "task-finished") {
      if (this._isRenewing || this._isReconnecting) return; // already handling
      console.log(`${this._tag}: task-finished received, renewing task`);
      this._renewTask("task-finished");
    }
  }

  // ---- result parsing ----------------------------------------------------

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

  // Parse a Gummy result, which carries both the source transcription and the
  // target translation. Field names vary across API revisions, so we read them
  // defensively. English always works; if the translation can't be located,
  // translatedText stays empty and the App falls back to its LLM path.
  _applyGummyOutput(output) {
    const tr = output.transcription || output.sentence || null;
    const enText = sanitizeText(tr && tr.text);
    const isFinal = !!(tr && (tr.sentence_end || tr.end_time));

    let zhText = "";
    const translations =
      output.translations || output.translation || (tr && tr.translation);
    if (Array.isArray(translations)) {
      const target = this.translationTargets[0] || "zh";
      const match =
        translations.find((t) =>
          new RegExp(target, "i").test(
            String(t.lang || t.language || t.target_language || "")
          )
        ) || translations[0];
      zhText = sanitizeText(match && match.text);
    } else if (translations && typeof translations === "object") {
      zhText = sanitizeText(translations.text);
    }

    const id =
      tr && tr.sentence_id != null
        ? String(tr.sentence_id)
        : tr && tr.begin_time != null
        ? `bt-${tr.begin_time}`
        : `auto-${this.sentences.length}`;

    if (!enText && !zhText && !isFinal) return;

    const entry = { id, text: enText, zh: zhText, isFinal };
    const idx = this.sentences.findIndex((s) => s.id === id);
    if (idx >= 0) this.sentences[idx] = entry;
    else this.sentences.push(entry);

    const join = (pred, key) =>
      this.sentences
        .filter(pred)
        .map((s) => s[key])
        .filter(Boolean)
        .join(" ")
        .trim();

    this.onUpdate({
      fullText: join(() => true, "text"),
      finalText: join((s) => s.isFinal, "text"),
      confidence: 0,
      translatedText: join(() => true, "zh"),
      translatedFinalText: join((s) => s.isFinal, "zh"),
    });
  }
}
