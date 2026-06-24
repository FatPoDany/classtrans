import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  Square,
  Trash2,
  Globe,
  AlertCircle,
  Loader2,
  Sparkles,
  PictureInPicture,
  ChevronDown,
  Settings,
  Pause,
  Play,
  User,
  Headphones,
  Home,
  FolderOpen,
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  Activity,
  Pencil,
  Check,
  X,
  Sun,
  Moon,
  RefreshCw,
  LogOut,
  Folder,
  FolderPlus,
  Plus,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ParaformerSession } from "./paraformerSession";
import { LiveTranslateSession } from "./liveTranslateSession";
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import AuthPage from './pages/AuthPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { useCloudSettings } from './hooks/useCloudSettings';
import { useGlobalSettings } from './hooks/useGlobalSettings';
import { useCloudGlossary } from './hooks/useCloudGlossary';
import { useCloudSessions } from './hooks/useCloudSessions';
import { useCloudFolders } from './hooks/useCloudFolders';

const THEME_STORAGE_KEY = "classtrans.uiTheme.v1";

// Folder color palette. Stored as a key in the DB; the gradient drives the
// folder card visuals. "未归档" (Unfiled) uses the neutral slate entry.
const FOLDER_COLORS = {
  slate: { grad: "from-slate-500 to-slate-600", dot: "#64748b" },
  blue: { grad: "from-sky-400 to-blue-500", dot: "#3b82f6" },
  green: { grad: "from-emerald-400 to-green-500", dot: "#10b981" },
  purple: { grad: "from-purple-400 to-fuchsia-500", dot: "#a855f7" },
  indigo: { grad: "from-indigo-400 to-indigo-600", dot: "#6366f1" },
  amber: { grad: "from-amber-400 to-orange-500", dot: "#f59e0b" },
  rose: { grad: "from-rose-400 to-pink-500", dot: "#f43f5e" },
};
const FOLDER_COLOR_KEYS = Object.keys(FOLDER_COLORS);
const folderGrad = (color) => (FOLDER_COLORS[color] || FOLDER_COLORS.indigo).grad;
const PARAFORMER_WS_URL = process.env.REACT_APP_PARAFORMER_WS_URL || "";

let globalApiToken = "";
export const setGlobalApiToken = (token) => { globalApiToken = token; };


// ============================================================================
// 引擎 1a：免费谷歌翻译公共接口 (作为最后兜底使用)
// ============================================================================
const translateTextBasic = async (text) => {
  if (!text.trim()) return "";
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(
    text
  )}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    const data = await response.json();
    if (data && data[0]) {
      let translated = "";
      for (let i = 0; i < data[0].length; i++) {
        if (data[0][i][0]) translated += data[0][i][0];
      }
      return translated;
    }
    return "[解析翻译结果失败]";
  } catch (error) {
    console.error("Basic translation request failed:", error);
    return "[基础翻译异常]";
  }
};

// ============================================================================
// 引擎 1b：qwen-turbo 实时快译 (取代 Google 公共接口作为主路径，可控、可观测)
// ============================================================================
const REALTIME_TRANSLATE_SYSTEM_PROMPT =
  "你是专业的同传译者。把用户给出的英文翻译成简体中文，要求：忠实、准确、术语一致、口语自然。只输出译文本身，不要任何引号、不要解释、不要前后缀。";

const translateRealtimeWithQwen = async (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";

  const modelName = runtimeRealtimeModelName || DEFAULT_REALTIME_MODEL;
  const payload = {
    model: modelName,
    messages: [
      { role: "system", content: REALTIME_TRANSLATE_SYSTEM_PROMPT },
      { role: "user", content: trimmed },
    ],
    temperature: 0.1,
  };

  const response = await fetch("/api/polish", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": globalApiToken ? `Bearer ${globalApiToken}` : "" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`qwen-turbo translate failed: ${response.status}`);
  }

  const data = await response.json();
  if (data?.error) {
    const msg = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(msg || "qwen-turbo upstream error");
  }

  const result = String(data?.choices?.[0]?.message?.content || "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!result) throw new Error("qwen-turbo empty response");
  recordAiUsage({ type: "realtime", model: modelName, usage: data?.usage });
  return result;
};

const translateRealtimeFast = async (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  try {
    return await translateRealtimeWithQwen(trimmed);
  } catch (err) {
    console.warn("qwen-turbo realtime translate failed, falling back to Google:", err);
    return translateTextBasic(trimmed);
  }
};

// ============================================================================
// 引擎 2：AI 深度引擎 (阿里云 DashScope) - 用于文本润色 & 生成课堂总结
// ============================================================================
// API Key 现已交由 Vercel 后端 (/api 目录下的接口) 安全管理，前端不再直接引用以避免 process 环境变量报错
const MODEL_STORAGE_KEY = "classtrans.aiModelName.v1";
const REALTIME_MODEL_STORAGE_KEY = "classtrans.realtimeModelName.v1";
const SUMMARY_MODEL_STORAGE_KEY = "classtrans.summaryModelName.v1";
const ASR_MODEL_STORAGE_KEY = "classtrans.asrModelName.v1";
const TRANSLATION_AUDIO_STORAGE_KEY = "classtrans.playTranslationAudio.v1";

const DEFAULT_POLISH_MODEL = "qwen-plus";
const DEFAULT_REALTIME_MODEL = "qwen-turbo";
const DEFAULT_ASR_MODEL = "qwen3.5-livetranslate-flash-realtime";

const normalizeLegacyPolishModelName = (name) => {
  const cleanName = String(name || "").trim();
  return cleanName === "qwen3.5-122b-a10b" ? DEFAULT_POLISH_MODEL : cleanName;
};

let runtimeModelName = DEFAULT_POLISH_MODEL;
let runtimeRealtimeModelName = DEFAULT_REALTIME_MODEL;
let runtimeSummaryModelName = ""; // 空 → 回退到 polish 模型
let runtimeAsrModelName = DEFAULT_ASR_MODEL;

try {
  if (typeof window !== "undefined") {
    const ls = window.localStorage;
    const m = ls.getItem(MODEL_STORAGE_KEY);
    if (m) runtimeModelName = normalizeLegacyPolishModelName(m);
    const r = ls.getItem(REALTIME_MODEL_STORAGE_KEY);
    if (r) runtimeRealtimeModelName = r;
    runtimeSummaryModelName = normalizeLegacyPolishModelName(
      ls.getItem(SUMMARY_MODEL_STORAGE_KEY) || ""
    );
    const a = ls.getItem(ASR_MODEL_STORAGE_KEY);
    if (a) runtimeAsrModelName = a;
  }
} catch (err) {}

// 仅 Paraformer 系列支持 vocabulary_id 热词偏置；切到 Gummy 等其他系列时跳过
const isParaformerFamilyModel = (name) =>
  /^paraformer-/i.test(String(name || "").trim());

// 一体化语音翻译模型（Qwen LiveTranslate，Omni-Realtime 协议）：与 Paraformer/Gummy 的
// run-task 协议不同，需要走中继的 /realtime 路由并自带译文。
const isLiveTranslateModel = (name) => /livetranslate/i.test(String(name || "").trim());

// 由 Paraformer 中继地址推导 Realtime 中继地址：/asr → /realtime，附带 model 查询参数。
const REALTIME_WS_BASE = PARAFORMER_WS_URL
  ? /\/asr$/i.test(PARAFORMER_WS_URL)
    ? PARAFORMER_WS_URL.replace(/\/asr$/i, "/realtime")
    : PARAFORMER_WS_URL.replace(/\/+$/, "") + "/realtime"
  : "";
const buildRealtimeWsUrl = (model) =>
  REALTIME_WS_BASE ? `${REALTIME_WS_BASE}?model=${encodeURIComponent(model)}` : "";

export const setGlobalModelName = (name) => {
  const cleanName = normalizeLegacyPolishModelName(name);
  if (cleanName) {
    runtimeModelName = cleanName;
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, cleanName);
    } catch (e) {}
  }
};

const setGlobalRealtimeModelName = (name) => {
  const cleanName = String(name || "").trim();
  if (cleanName) {
    runtimeRealtimeModelName = cleanName;
    try {
      window.localStorage.setItem(REALTIME_MODEL_STORAGE_KEY, cleanName);
    } catch (e) {}
  }
};

const setGlobalSummaryModelName = (name) => {
  const cleanName = normalizeLegacyPolishModelName(name);
  runtimeSummaryModelName = cleanName;
  try {
    if (cleanName) {
      window.localStorage.setItem(SUMMARY_MODEL_STORAGE_KEY, cleanName);
    } else {
      window.localStorage.removeItem(SUMMARY_MODEL_STORAGE_KEY);
    }
  } catch (e) {}
};

const setGlobalAsrModelName = (name) => {
  const cleanName = String(name || "").trim() || DEFAULT_ASR_MODEL;
  runtimeAsrModelName = cleanName;
  try {
    window.localStorage.setItem(ASR_MODEL_STORAGE_KEY, cleanName);
  } catch (e) {}
};

const getEffectiveSummaryModel = () =>
  (runtimeSummaryModelName || runtimeModelName).trim();

// ============================================================================
// AI 用量日志：记录每次 LLM 调用的 prompt / completion / total tokens
// 仅本地 (localStorage)，订阅模式给 React 组件用
// ============================================================================
const USAGE_LOG_STORAGE_KEY = "classtrans.aiUsageLog.v1";
const USAGE_LOG_MAX_ENTRIES = 200;

const usageListeners = new Set();
let usageLogCache = null;

const readUsageLog = () => {
  if (usageLogCache) return usageLogCache;
  try {
    const raw = window.localStorage.getItem(USAGE_LOG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    usageLogCache = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    usageLogCache = [];
  }
  return usageLogCache;
};

const writeUsageLog = (entries) => {
  const trimmed = Array.isArray(entries)
    ? entries.slice(-USAGE_LOG_MAX_ENTRIES)
    : [];
  usageLogCache = trimmed;
  try {
    window.localStorage.setItem(USAGE_LOG_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {}
  for (const fn of usageListeners) {
    try { fn(trimmed); } catch (e) {}
  }
};

const recordAiUsage = ({ type, model, usage }) => {
  if (!usage) return;
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const totalTokens =
    Number(usage.total_tokens || 0) || promptTokens + completionTokens;
  if (!totalTokens) return;
  const entry = {
    timestamp: Date.now(),
    type: String(type || "unknown"),
    model: String(model || ""),
    promptTokens,
    completionTokens,
    totalTokens,
  };
  writeUsageLog(readUsageLog().concat(entry));
};

const subscribeUsageLog = (fn) => {
  usageListeners.add(fn);
  return () => usageListeners.delete(fn);
};

const clearUsageLog = () => writeUsageLog([]);

// ============================================================================
// 课堂术语纠错：用于提升浏览器识别后的英文可读性与专业词准确率
// ============================================================================
const CLASSROOM_TERM_RULES = [
  { pattern: /\bchat\s*g\s*p\s*t\b/gi, replacement: "ChatGPT" },
  { pattern: /\bopen\s*ai\b/gi, replacement: "OpenAI" },
  { pattern: /\bgithub\b/gi, replacement: "GitHub" },
  { pattern: /\bcopilot\b/gi, replacement: "Copilot" },
  { pattern: /\bjava\s*script\b/gi, replacement: "JavaScript" },
  { pattern: /\btype\s*script\b/gi, replacement: "TypeScript" },
  { pattern: /\bnode\s*js\b/gi, replacement: "Node.js" },
  { pattern: /\bweb\s*socket\b/gi, replacement: "WebSocket" },
  { pattern: /\bdash\s*scope\b/gi, replacement: "DashScope" },
  { pattern: /\bqwen\b/gi, replacement: "Qwen" },
  { pattern: /\bkubernetes\b/gi, replacement: "Kubernetes" },
  { pattern: /\bdocker\b/gi, replacement: "Docker" },
  { pattern: /\bapi\b/gi, replacement: "API" },
  { pattern: /\brag\b/gi, replacement: "RAG" },
  { pattern: /\bllm\b/gi, replacement: "LLM" },
  { pattern: /\bai\b/gi, replacement: "AI" },
];

const GLOSSARY_STORAGE_KEY = "classtrans.customGlossaryTerms.v1";
const VOCAB_ID_STORAGE_KEY = "classtrans.paraformerVocabularyId.v1";
const VOCAB_SIGNATURE_STORAGE_KEY = "classtrans.paraformerVocabularySignature.v1";
let customClassroomTermRules = [];

// ============================================================================
// Paraformer 热词词典：自定义术语保存时同步注册到 DashScope，得到 vocabulary_id
// 后续 ASR 会话在 run-task 的 parameters 里带上它，实现声学层的偏置纠错
// ============================================================================
const PARAFORMER_VOCAB_TARGET_MODEL = "paraformer-realtime-v2";
const PARAFORMER_VOCAB_PREFIX = "classtrans";
const PARAFORMER_VOCAB_DEFAULT_WEIGHT = 4;

const buildVocabularyFromPairs = (pairs) => {
  const dedup = new Map();
  for (const pair of pairs || []) {
    if (!pair) continue;
    const text = String(pair.to || "").trim();
    if (!text) continue;
    if (!dedup.has(text)) {
      dedup.set(text, {
        text,
        weight: PARAFORMER_VOCAB_DEFAULT_WEIGHT,
        lang: "en",
      });
    }
  }
  return Array.from(dedup.values());
};

const computeVocabularySignature = (vocabulary) =>
  vocabulary
    .map((v) => `${v.text}|${v.weight}|${v.lang}`)
    .sort()
    .join("\n");

const getStoredVocabularyId = () => {
  try {
    return window.localStorage.getItem(VOCAB_ID_STORAGE_KEY) || "";
  } catch (e) {
    return "";
  }
};

const setStoredVocabulary = (vocabularyId, signature) => {
  try {
    if (vocabularyId) {
      window.localStorage.setItem(VOCAB_ID_STORAGE_KEY, vocabularyId);
      window.localStorage.setItem(VOCAB_SIGNATURE_STORAGE_KEY, signature || "");
    } else {
      window.localStorage.removeItem(VOCAB_ID_STORAGE_KEY);
      window.localStorage.removeItem(VOCAB_SIGNATURE_STORAGE_KEY);
    }
  } catch (e) {}
};

const syncGlossaryToParaformerVocabulary = async (pairs) => {
  const vocabulary = buildVocabularyFromPairs(pairs);
  const signature = computeVocabularySignature(vocabulary);
  const storedSignature = (() => {
    try {
      return window.localStorage.getItem(VOCAB_SIGNATURE_STORAGE_KEY) || "";
    } catch (e) {
      return "";
    }
  })();
  const storedVocabId = getStoredVocabularyId();

  if (vocabulary.length === 0) {
    if (storedVocabId) {
      try {
        await fetch("/api/asr-vocabulary", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": globalApiToken ? `Bearer ${globalApiToken}` : "" },
          body: JSON.stringify({
            model: "speech-biasing",
            input: {
              action: "delete_vocabulary",
              vocabulary_id: storedVocabId,
            },
          }),
        });
      } catch (e) {
        console.warn("vocabulary delete failed (ignored):", e);
      }
    }
    setStoredVocabulary("", "");
    return { vocabularyId: "", changed: !!storedVocabId };
  }

  if (storedSignature === signature && storedVocabId) {
    return { vocabularyId: storedVocabId, changed: false };
  }

  const body = storedVocabId
    ? {
        model: "speech-biasing",
        input: {
          action: "update_vocabulary",
          vocabulary_id: storedVocabId,
          vocabulary,
        },
      }
    : {
        model: "speech-biasing",
        input: {
          action: "create_vocabulary",
          target_model: PARAFORMER_VOCAB_TARGET_MODEL,
          prefix: PARAFORMER_VOCAB_PREFIX,
          vocabulary,
        },
      };

  const response = await fetch("/api/asr-vocabulary", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": globalApiToken ? `Bearer ${globalApiToken}` : "" },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    const msg =
      (data && (data.message || data.error || (data.output && data.output.message))) ||
      `HTTP ${response.status}`;
    throw new Error(`vocabulary register failed: ${msg}`);
  }

  const newId =
    (data && data.output && data.output.vocabulary_id) || storedVocabId || "";
  if (!newId) {
    throw new Error("vocabulary register: no vocabulary_id in response");
  }

  setStoredVocabulary(newId, signature);
  return { vocabularyId: newId, changed: true };
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildCustomClassroomRules = (pairs = []) => {
  return pairs
    .filter((pair) => pair?.from && pair?.to)
    .map((pair) => {
      const from = String(pair.from).trim();
      const to = String(pair.to).trim();

      const escaped = escapeRegExp(from).replace(/\s+/g, "\\s+");
      const startsWithWord = /[A-Za-z0-9]/.test(from[0] || "");
      const endsWithWord = /[A-Za-z0-9]/.test(from[from.length - 1] || "");
      const patternSource = `${startsWithWord ? "\\b" : ""}${escaped}${endsWithWord ? "\\b" : ""}`;

      return {
        pattern: new RegExp(patternSource, "gi"),
        replacement: to,
      };
    });
};

const setRuntimeCustomGlossaryPairs = (pairs = []) => {
  customClassroomTermRules = buildCustomClassroomRules(pairs);
};

const parseGlossaryDraft = (draftText) => {
  const lines = String(draftText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { pairs: [] };
  }

  if (lines.length > 80) {
    return { error: "术语条目最多 80 行，请精简后再保存。" };
  }

  const dedupeMap = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split("=>");
    if (parts.length < 2) {
      return { error: `第 ${i + 1} 行格式错误，请使用“原词 => 纠正词”。` };
    }

    const from = parts[0].trim();
    const to = parts.slice(1).join("=>").trim();

    if (!from || !to) {
      return { error: `第 ${i + 1} 行为空，请检查“原词”和“纠正词”。` };
    }

    dedupeMap.set(from.toLowerCase(), { from, to });
  }

  return { pairs: Array.from(dedupeMap.values()) };
};

// 模型生成的纪要里经常夹带 &lt; / &gt; / &amp; 这种 HTML 实体（训练语料里
// 大量包含 escaped HTML），如果直接 escapeHtml 会把 & 二次转成 &amp; 让用户
// 看到字面 "&lt;html&gt;"。先做一次单层解码，再 escape，保持幂等。
const HTML_ENTITY_DECODE_MAP = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&amp;": "&",
};

const decodeHtmlEntitiesOnce = (value) =>
  String(value ?? "").replace(
    /&(?:lt|gt|quot|apos|amp|#39|#x27);/gi,
    (m) => HTML_ENTITY_DECODE_MAP[m.toLowerCase()] || m
  );

const escapeHtml = (value) =>
  decodeHtmlEntitiesOnce(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderInlineMarkdownToSafeHtml = (rawText) => {
  const source = String(rawText || "");
  if (!source) return "";

  const codeTokens = [];
  let html = escapeHtml(source).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@INLINECODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>'
    );

  return html.replace(/@@INLINECODE(\d+)@@/g, (_, index) => {
    return codeTokens[Number(index)] || "";
  });
};

const renderMarkdownToSafeHtml = (markdownText) => {
  const normalized = String(markdownText || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "<p>（该会话未保存纪要）</p>";

  const lines = normalized.split("\n");
  const htmlParts = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines = [];
  let currentListType = null; // ul | ol

  const closeList = () => {
    if (!currentListType) return;
    htmlParts.push(`</${currentListType}>`);
    currentListType = null;
  };

  const closeCodeBlock = () => {
    if (!inCodeBlock) return;
    const codeClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    htmlParts.push(`<pre><code${codeClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeLang = "";
    codeLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine || "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        closeList();
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      // 不在空行处直接 closeList：AI 生成的有序列表常常带空行分隔
      // （"1. xxx\n\n2. yyy"），强行关闭会让每个 <ol> 各自从 1 重新计数，
      // 渲染出 "1, 1, 1" / "1, 2, 1, 2" 的错乱编号。
      // 真正的段落结束由下一行的非列表内容触发 closeList。
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      htmlParts.push("<hr />");
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${renderInlineMarkdownToSafeHtml(headingMatch[2])}</h${level}>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      if (currentListType !== "ul") {
        closeList();
        currentListType = "ul";
        htmlParts.push("<ul>");
      }
      htmlParts.push(`<li>${renderInlineMarkdownToSafeHtml(unorderedMatch[1])}</li>`);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      if (currentListType !== "ol") {
        closeList();
        currentListType = "ol";
        htmlParts.push("<ol>");
      }
      htmlParts.push(`<li>${renderInlineMarkdownToSafeHtml(orderedMatch[1])}</li>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s+(.+)$/);
    if (quoteMatch) {
      closeList();
      htmlParts.push(`<blockquote>${renderInlineMarkdownToSafeHtml(quoteMatch[1])}</blockquote>`);
      continue;
    }

    closeList();
    htmlParts.push(`<p>${renderInlineMarkdownToSafeHtml(trimmed)}</p>`);
  }

  closeCodeBlock();
  closeList();

  return htmlParts.join("\n");
};

const safeFileName = (value, fallback = "classtrans_session") => {
  const normalized = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return normalized || fallback;
};

const applyClassroomGlossary = (input) => {
  if (!input) return "";
  const allRules = [...CLASSROOM_TERM_RULES, ...customClassroomTermRules];
  return allRules.reduce((acc, rule) => {
    return acc.replace(rule.pattern, rule.replacement);
  }, input);
};

const sanitizeRecognitionArtifacts = (input) => {
  return String(input || "")
    // 典型 ASR 垃圾标记，可能出现在句尾并导致 “</S>” 可见或吞词
    .replace(/<\/?s>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

// ============================================================================
// 轻量英文可读性增强：实时阶段先做基础标点与大小写修正（不改写语义）
// ============================================================================
const smartPunctuateEnglish = (input, forceTerminalPunctuation = false) => {
  if (!input) return "";

  let text = applyClassroomGlossary(sanitizeRecognitionArtifacts(input))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();

  // 常见口语中的 i -> I
  text = text.replace(/\bi\b/g, "I");

  // 句首/句后首字母大写
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, letter) => {
    return `${prefix}${letter.toUpperCase()}`;
  });

  // 实时阶段的轻量标点增强：在常见连词前补逗号，减少“无标点长串”的阅读负担
  text = text.replace(/([a-z0-9])\s+(and|but|so|because|which|when|while|however)\s+/gi, "$1, $2 ");
  text = text.replace(/\s+,/g, ",");

  // 当实时文本足够长且末尾无标点时，给出弱句号提示（不改语义，仅提升可读性）
  if (!forceTerminalPunctuation && text && !/[.!?…]$/.test(text)) {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 12) {
      text += ".";
    }
  }

  // 只有在“准备入库”时强制补全句末标点，避免实时闪烁太明显
  if (forceTerminalPunctuation && text && !/[.!?…]$/.test(text)) {
    text += ".";
  }

  return text;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Pause-before-finalize thresholds. Lowered (was base 2800, clamp 2200–5500)
// to cut the lag between speech and the settled translation for fast lectures.
// Trade-off: slightly more chance of splitting mid-sentence — the qwen polish
// pass re-joins/cleans those, so it's an acceptable exchange for responsiveness.
const getAdaptivePauseThreshold = (text) => {
  const cleanText = (text || "").trim();
  if (!cleanText) return 1800;

  const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
  let threshold = 1600;

  // 短句更容易是“思考停顿”，延迟一点再截断，降低漏字率
  if (wordCount <= 4) threshold += 900;
  else if (wordCount <= 8) threshold += 400;
  else if (wordCount >= 20) threshold -= 200;

  // 若明显已成句，适当提前截断，减少延迟
  if (/[.!?…]$/.test(cleanText)) threshold -= 400;
  else if (/[,;:]$/.test(cleanText)) threshold += 300;

  // 快速连续语流更容易被过早切段，适当延后截断，降低跨块吞字
  if (wordCount >= 12 && !/[.!?…]$/.test(cleanText)) {
    threshold += 400;
  }

  const tailToken = cleanText.split(/\s+/).pop() || "";
  // 末词太短通常仍在抖动更新阶段（例如 "a", "to"），延后收口
  if (!/[.!?…]$/.test(cleanText) && tailToken.length > 0 && tailToken.length <= 2) {
    threshold += 300;
  }

  // 超长 active 文本避免无限等待
  if (cleanText.length > 200) threshold -= 300;

  return clamp(threshold, 1100, 3200);
};

const normalizeComparableText = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();

const getCjkRatio = (text) => {
  const value = String(text || "");
  if (!value) return 0;
  const cjkCount = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjkCount / value.length;
};

const isTranslationTextSuspicious = (text) => {
  const value = String(text || "").trim();
  if (!value) return true;
  return (
    value === "..." ||
    /\[.*?(失败|异常|error|timeout).*?\]/i.test(value) ||
    /^\{[\s\S]*\}$/.test(value)
  );
};

// 历史会话气泡是否"未经 AI 精调"。优先看显式 isPolished 标志；
// 早期保存文件没有该字段，则回退到 speaker 启发式：质量门控 / 超时降级
// 路径会把 speaker 写成"⚠️ AI超时降级"或"🛡️ 质量守卫(机译保底)"。
const isSavedBubbleUnpolished = (item) => {
  if (!item) return false;
  if (item.isPolished === true) return false;
  if (item.isPolished === false) return true;
  const speaker = String(item.speaker || "");
  return /AI\s*超时降级|AI报错|AI保底|质量守卫|机译保底/.test(speaker);
};

const evaluateAiPolishQuality = ({ rawEn, aiSegments, basicZh }) => {
  if (!Array.isArray(aiSegments) || aiSegments.length === 0) {
    return { ok: false, reason: "empty_segments" };
  }

  const aiZhCombined = aiSegments.map((seg) => String(seg?.zh || "").trim()).join(" ").trim();
  const aiEnCombined = aiSegments.map((seg) => String(seg?.en || "").trim()).join(" ").trim();
  const normalizedAiZh = normalizeComparableText(aiZhCombined);
  const normalizedBasicZh = normalizeComparableText(basicZh);
  const normalizedAiEn = normalizeComparableText(aiEnCombined);
  const normalizedRawEn = normalizeComparableText(rawEn);

  if (isTranslationTextSuspicious(aiZhCombined)) {
    return { ok: false, reason: "suspicious_zh" };
  }

  // 英文回写严重偏短通常意味着内容遗漏
  if (
    normalizedRawEn.length >= 20 &&
    normalizedAiEn.length > 0 &&
    normalizedAiEn.length < normalizedRawEn.length * 0.55
  ) {
    return { ok: false, reason: "en_too_short" };
  }

  // 相对机译严重偏短，视为“信息损失风险”
  if (
    normalizedBasicZh.length >= 18 &&
    normalizedAiZh.length < Math.max(10, Math.floor(normalizedBasicZh.length * 0.62))
  ) {
    return { ok: false, reason: "zh_shorter_than_baseline" };
  }

  // 中文占比过低，往往是异常输出（例如英文/JSON 混入）
  const cjkRatio = getCjkRatio(aiZhCombined);
  if (aiZhCombined.length >= 18 && cjkRatio < 0.28) {
    return { ok: false, reason: "low_cjk_ratio" };
  }

  return { ok: true, reason: "ok" };
};

// ============================================================================
// 行式纯文本解析：增量友好，可在流式过程中反复 re-parse 当前累积的 raw 文本
// ----------------------------------------------------------------------------
// 期望的模型输出（无 JSON、无代码块、无前后缀）：
//   ## SEG
//   SPEAKER: 👩‍🏫 主讲人
//   EN: Corrected English on a single line
//   ZH: 中文译文写在同一行
//   ## SEG
//   ...
// 容忍：行首加粗 (**SPEAKER:**)、Chinese 全角冒号、缺失 ## SEG 头、缺失字段。
// ============================================================================
const FIELD_KEY_PATTERN = /^\**\s*(SPEAKER|EN|ZH)\s*\**\s*[:：]\s*(.*)$/i;
const SEGMENT_HEADER_PATTERN = /^#{1,3}\s*SEG\b/i;

const parseLineFormatSegments = (rawText) => {
  const text = String(rawText || "");
  if (!text.trim()) return [];

  const cleaned = text
    .replace(/^```[a-zA-Z]*\s*/m, "")
    .replace(/```\s*$/m, "");

  const lines = cleaned.split(/\r?\n/);
  const segments = [];
  let cur = null;
  let activeField = null;

  const ensureSegment = () => {
    if (!cur) {
      cur = { speaker: "", en: "", zh: "" };
      segments.push(cur);
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      activeField = null;
      continue;
    }

    if (SEGMENT_HEADER_PATTERN.test(trimmed)) {
      cur = { speaker: "", en: "", zh: "" };
      segments.push(cur);
      activeField = null;
      continue;
    }

    const match = trimmed.match(FIELD_KEY_PATTERN);
    if (match) {
      ensureSegment();
      activeField = match[1].toLowerCase();
      cur[activeField] = match[2] || "";
      continue;
    }

    if (activeField && cur) {
      cur[activeField] = (cur[activeField] ? cur[activeField] + " " : "") + trimmed;
    }
  }

  return segments.filter((seg) => seg.en || seg.zh);
};

const normalizePolishSegments = (segments, rawEn) =>
  segments.map((seg) => ({
    speaker: (seg.speaker || "").trim() || "👩‍🏫 主讲人",
    en: sanitizeRecognitionArtifacts(seg.en || rawEn),
    zh: String(seg.zh || "")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }));

// 等多久 polish 还没出第一个 ZH delta，再启动 qwen-turbo 基线（用于质量门控对比 + 兜底）
const POLISH_BASELINE_DELAY_MS = 2500;
const POLISH_PRIMARY_TIMEOUT_MS = 30_000;
const POLISH_FALLBACK_TIMEOUT_MS = 18_000;

const POLISH_SYSTEM_PROMPT = `You are a professional interpreter and context analyzer. Output ONLY plain text in the segment format below. Do NOT use JSON, do NOT wrap in code fences, do NOT add any preamble or trailing commentary.

OUTPUT FORMAT — repeat for each segment:
## SEG
SPEAKER: <role with emoji, e.g. 👩‍🏫 主讲人 / 🙋 提问者 / 🗣️ 互动者>
EN: <corrected English on ONE single line; no speaker prefix>
ZH: <polished Simplified Chinese on ONE single line; no speaker prefix>

HARD QUALITY BAR:
1. Chinese translation quality must be at least as good as literal machine translation; never omit, summarize, or weaken factual details.
2. Keep technical terms, numbers, names, versions, API names and code identifiers accurate.
3. If a phrase is uncertain, prefer conservative literal translation over free paraphrase.
4. Split into multiple segments ONLY when the speaker clearly changes. Keep continuous speech as ONE segment.
5. Each field on a single line. No blank lines inside a segment. No markdown decoration around the field keys.
6. Begin output immediately with "## SEG" — no preamble.
7. If "Earlier context" is provided, use it ONLY to keep terminology, named entities, and pronoun references consistent. Do NOT re-translate the earlier context. Do NOT mention it in the output.`;

const buildPolishUserMessage = (rawEn, contextHistory) => {
  const safeHistory = Array.isArray(contextHistory)
    ? contextHistory
        .filter((h) => h && (h.en || h.zh))
        .slice(-2)
    : [];

  if (safeHistory.length === 0) {
    return `Raw text: "${rawEn}"`;
  }

  const ctxLines = safeHistory
    .map(
      (h, i) =>
        `(${i + 1}) EN: ${String(h.en || "").trim()}\n    ZH: ${String(h.zh || "").trim()}`
    )
    .join("\n\n");

  return `Earlier context (in chronological order — for terminology consistency only; do NOT re-translate):\n${ctxLines}\n\nCurrent raw text to translate:\n"${rawEn}"`;
};

const polishWithAI = async (rawEn, { onUpdate, signal, contextHistory } = {}) => {
  const url = `/api/polish`;

  const runPolishStream = async (polishModel, timeoutMs) => {
    const payload = {
      model: polishModel,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: POLISH_SYSTEM_PROMPT },
        { role: "user", content: buildPolishUserMessage(rawEn, contextHistory) },
      ],
    };

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromParent = () => controller.abort();
    if (signal) {
      if (signal.aborted) abortFromParent();
      else signal.addEventListener("abort", abortFromParent, { once: true });
    }

    let reader = null;
    let sseBuffer = "";
    let assistantText = "";
    let lastEmittedSnapshot = "";
    let capturedUsage = null;
    let streamError = null;
    const decoder = new TextDecoder("utf-8");

    const emitProgress = () => {
      if (!onUpdate) return;
      if (assistantText === lastEmittedSnapshot) return;
      lastEmittedSnapshot = assistantText;
      try {
        onUpdate(parseLineFormatSegments(assistantText));
      } catch (e) {
        console.warn("polish onUpdate threw:", e);
      }
    };

    const ingestSseJson = (json) => {
      if (!json) return;
      if (json.error) {
        const errMsg =
          typeof json.error === "string"
            ? json.error
            : json.error?.message || "upstream error";
        throw new Error(errMsg);
      }
      const delta = json?.choices?.[0]?.delta?.content || "";
      if (delta) {
        assistantText += delta;
        emitProgress();
      }
      if (json.usage && Number(json.usage.total_tokens || 0) > 0) {
        capturedUsage = json.usage;
      }
    };

    const consumeBufferedLine = (rawLine) => {
      if (!rawLine.startsWith("data:")) return;
      const dataStr = rawLine.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") return;
      try {
        ingestSseJson(JSON.parse(dataStr));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": globalApiToken ? `Bearer ${globalApiToken}` : "",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let errMessage = `Polish stream failed: ${response.status}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) {
            errMessage =
              typeof errBody.error === "string"
                ? errBody.error
                : JSON.stringify(errBody.error);
          }
        } catch (e) {}
        const err = new Error(errMessage);
        err.status = response.status;
        throw err;
      }

      reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = sseBuffer.indexOf("\n")) !== -1) {
          const rawLine = sseBuffer.slice(0, newlineIdx).replace(/\r$/, "");
          sseBuffer = sseBuffer.slice(newlineIdx + 1);
          consumeBufferedLine(rawLine);
        }
      }
    } catch (error) {
      streamError =
        timedOut && !signal?.aborted
          ? new Error(`AI polish timeout after ${Math.round(timeoutMs / 1000)}s`)
          : error;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener?.("abort", abortFromParent);
      try { reader?.releaseLock(); } catch (e) {}
    }

    if (sseBuffer.startsWith("data:")) {
      const dataStr = sseBuffer.slice(5).trim();
      if (dataStr && dataStr !== "[DONE]") {
        try { ingestSseJson(JSON.parse(dataStr)); } catch (e) {}
      }
    }

    if (capturedUsage) {
      recordAiUsage({ type: "polish", model: polishModel, usage: capturedUsage });
    }

    const segments = parseLineFormatSegments(assistantText);
    if (segments.length > 0 && segments.some((seg) => String(seg.zh || "").trim())) {
      return normalizePolishSegments(segments, rawEn);
    }

    if (streamError) throw streamError;

    console.warn("AI 流式输出无法解析为有效片段。Raw output:", assistantText);
    throw new Error("AI 流式输出为空或缺失中文翻译");
  };

  const primaryModel = runtimeModelName || DEFAULT_POLISH_MODEL;
  const fallbackModel = (runtimeRealtimeModelName || DEFAULT_REALTIME_MODEL).trim();

  try {
    return await runPolishStream(primaryModel, POLISH_PRIMARY_TIMEOUT_MS);
  } catch (error) {
    const status = Number(error?.status || 0);
    const canRetryFastModel =
      fallbackModel &&
      fallbackModel !== primaryModel &&
      status !== 401 &&
      status !== 403 &&
      !signal?.aborted;

    if (!canRetryFastModel) throw error;

    console.warn(
      `AI polish primary model ${primaryModel} failed, retrying ${fallbackModel}:`,
      error
    );
    return runPolishStream(fallbackModel, POLISH_FALLBACK_TIMEOUT_MS);
  }
};

const generateSummaryWithAI = async (fullTextContent) => {
  const url = `/api/summary`;

  const modelName = getEffectiveSummaryModel();
  const payload = {
    model: modelName,
    messages: [
      {
        role: "system",
        content: `你是一个专业的学术助理。请阅读以下课堂/会议的完整对话记录，并生成一份高质量的中文课堂纪要。
        要求：
        1. 包含【核心主题】。
        2. 提取 3-5 个【关键知识点】。
        3. 简要的【整体总结】。`,
      },
      {
        role: "user",
        content: `以下是课堂记录内容：\n\n${fullTextContent}`,
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": globalApiToken ? `Bearer ${globalApiToken}` : "" },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    const upstreamMsg =
      (data && (data.error?.message || data.error?.code || data.message)) ||
      `HTTP ${response.status}`;
    throw new Error(`生成纪要失败：${upstreamMsg}`);
  }

  if (data && data.error) {
    const upstreamMsg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || data.error.code || "上游返回错误";
    throw new Error(`生成纪要失败：${upstreamMsg}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      "生成纪要失败：模型未返回内容（可能是配额耗尽 / 限流 / 模型名错误）"
    );
  }

  recordAiUsage({ type: "summary", model: modelName, usage: data?.usage });
  return content;
};

// ============================================================================
// 渲染画中画 (PiP) 悬浮窗内部气泡列表的独立组件
// ============================================================================
const PipContent = ({ transcripts, activeEn, activeZh }) => {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  // 监听画中画内的滚动事件，实现智能悬停
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // 距离底部不到 80px 时，自动恢复滚屏
    setIsAutoScroll(scrollHeight - scrollTop - clientHeight < 80);
  };

  useEffect(() => {
    if (isAutoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcripts, activeEn, activeZh, isAutoScroll]);

  const cardBase = {
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    borderRadius: "18px",
    padding: "14px 18px",
    marginBottom: "14px",
    flexShrink: 0,
    transition: "border-color 200ms ease, box-shadow 200ms ease",
  };
  const speakerPillStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    backgroundColor: "rgba(255,255,255,0.06)",
    color: "#cbd5e1",
    fontSize: "0.7rem",
    padding: "3px 9px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.10)",
    fontWeight: 600,
    letterSpacing: "0.2px",
  };
  const tagStyle = (variant) => {
    const palette = {
      polish: { bg: "rgba(168,85,247,0.10)", color: "#c4b5fd", border: "rgba(168,85,247,0.30)" },
      warn: { bg: "rgba(251,191,36,0.13)", color: "#fcd34d", border: "rgba(251,191,36,0.30)" },
    }[variant] || { bg: "rgba(255,255,255,0.06)", color: "#cbd5e1", border: "rgba(255,255,255,0.10)" };
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "2px 7px",
      borderRadius: "6px",
      fontSize: "0.65rem",
      fontWeight: 700,
      backgroundColor: palette.bg,
      color: palette.color,
      border: `1px solid ${palette.border}`,
    };
  };
  const enTextStyle = (item) => ({
    color: item.isPolished || item.fromTab ? "#cbd5e1" : "#94a3b8",
    fontSize: "0.95rem",
    lineHeight: 1.55,
    marginBottom: "6px",
    fontFamily: "sans-serif",
    flex: 1,
    minWidth: 0,
  });
  const zhTextStyle = {
    color: "#f1f5f9",
    fontSize: "1.55rem",
    fontWeight: 700,
    lineHeight: 1.5,
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    letterSpacing: "0.5px",
    textShadow: "0 0 18px rgba(165,180,252,0.18)",
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "18px 20px",
        boxSizing: "border-box",
        height: "100vh",
        overflowY: "auto",
        overflowX: "hidden",
        position: "relative",
      }}
    >
      <div style={{ flex: 1, minHeight: "20px" }}></div>
      {transcripts.map((item) => {
        const isError = (item.en || "").includes("⚠️");
        const cardStyle = {
          ...cardBase,
          backgroundColor: item.lowConfidence
            ? "rgba(120, 53, 15, 0.20)"
            : item.isPolished
            ? "rgba(15, 23, 42, 0.62)"
            : "rgba(15, 23, 42, 0.55)",
          border: isError
            ? "1px solid rgba(225, 29, 72, 0.55)"
            : item.lowConfidence
            ? "1px solid rgba(251,191,36,0.30)"
            : item.isPolished
            ? "1px solid rgba(196,181,253,0.28)"
            : "1px solid rgba(255,255,255,0.10)",
          boxShadow: item.isPolished
            ? "0 0 0 1px rgba(196,181,253,0.08), 0 12px 36px -8px rgba(99,102,241,0.18)"
            : "0 4px 16px -4px rgba(0,0,0,0.45)",
        };
        return (
          <div key={item.id} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
              <span style={speakerPillStyle}>
                <User size={12} />
                {item.speaker || "👩‍🏫 主讲人"}
              </span>
              <div style={{ display: "flex", gap: "5px" }}>
                {item.lowConfidence && (
                  <span style={tagStyle("warn")}>⚠ 低置信</span>
                )}
                {item.isPolished && (
                  <span style={tagStyle("polish")}>✨ AI 精调</span>
                )}
              </div>
            </div>
            <div style={enTextStyle(item)}>{item.en}</div>
            <div style={zhTextStyle}>{item.zh}</div>
          </div>
        );
      })}

      {(activeEn || activeZh) && (
        <div
          className="pip-card-active"
          style={{
            ...cardBase,
            position: "relative",
            overflow: "hidden",
            backgroundImage:
              "linear-gradient(135deg, rgba(99,102,241,0.14), rgba(168,85,247,0.06))",
            border: "1px solid rgba(99,102,241,0.34)",
            boxShadow:
              "0 0 0 1px rgba(99,102,241,0.16), 0 12px 36px rgba(99,102,241,0.20)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
            <span
              style={{
                ...speakerPillStyle,
                backgroundColor: "rgba(129,140,248,0.18)",
                color: "#a5b4fc",
                border: "1px solid rgba(129,140,248,0.40)",
              }}
            >
              <User size={12} />
              🕵️ 语境分析中…
            </span>
          </div>
          <div
            style={{
              ...enTextStyle({ isPolished: false, fromTab: false }),
              color: "#a5b4fc",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                flexShrink: 0,
                backgroundColor: "#818cf8",
                borderRadius: "50%",
                animation: "pulse 1.6s ease-in-out infinite",
              }}
            ></span>
            <span style={{ flex: 1 }}>{activeEn}</span>
          </div>
          <div style={{ ...zhTextStyle, color: "#ffffff" }}>
            {activeZh || "…"}
            <span className="pip-stream-cursor" aria-hidden></span>
          </div>
        </div>
      )}
      <div ref={bottomRef} style={{ height: "32px", flexShrink: 0 }} />

      {!isAutoScroll && (
        <div
          onClick={() => {
            setIsAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            position: "fixed",
            bottom: "18px",
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "rgba(99,102,241,0.85)",
            color: "white",
            padding: "8px 16px",
            borderRadius: "999px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: 700,
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            border: "1px solid rgba(255,255,255,0.20)",
            boxShadow: "0 12px 30px -6px rgba(99,102,241,0.55)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "sans-serif",
            letterSpacing: "0.2px",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          返回最新同传
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 转录列表的 2 分钟分桶（用于主页面的灰条分隔 + 右侧时间轴）
// ============================================================================
const HOME_BUCKET_MS = 2 * 60 * 1000;

const formatHHMM = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
};

const bucketStartOf = (ts) => {
  if (!ts) return 0;
  const d = new Date(ts);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 2) * 2);
  return d.getTime();
};

// 在 transcripts 序列里把"新桶起点"的位置标出来，并汇总每个桶的 metadata。
// items: 仍然按原顺序返回；buckets: 用于侧边时间轴。
const buildTranscriptRowsAndBuckets = (transcripts) => {
  const rows = [];
  const buckets = [];
  let lastBucket = null;
  for (const item of transcripts) {
    const ts = item?.createdAt || 0;
    if (ts) {
      const b = bucketStartOf(ts);
      if (b !== lastBucket) {
        rows.push({ kind: "separator", bucketStart: b, key: `bucket-${b}` });
        buckets.push({ startMs: b, count: 0 });
        lastBucket = b;
      }
      if (buckets.length > 0) buckets[buckets.length - 1].count += 1;
    }
    rows.push({ kind: "transcript", item, key: item.id });
  }
  return { rows, buckets };
};

// ============================================================================
// StreamingText：把流入的文本拆成"已稳定段 + 新增段"，新增段触发 CSS 渐入动画。
// 兼容回退（value 缩短或重置）：清空段队列重新开始。
// ============================================================================
// ============================================================================
// 单词级可编辑文本：把英文文本拆成 word / 非 word 两类 token，给 word token
// 加点击/悬停态，触发外部传入的 onWordClick(e, wordIndex, word)。
// ============================================================================
const WORD_TOKEN_RE = /[A-Za-z][A-Za-z0-9'’-]*|[^A-Za-z\s]+|\s+/g;

const tokenizeForWordEdit = (text) => {
  const str = String(text || "");
  const tokens = [];
  WORD_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = WORD_TOKEN_RE.exec(str)) !== null) {
    tokens.push({ text: m[0], isWord: /^[A-Za-z]/.test(m[0]) });
  }
  return tokens;
};

const replaceWordAt = (text, wordIdx, newWord) => {
  const tokens = tokenizeForWordEdit(text);
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].isWord) continue;
    if (count === wordIdx) {
      tokens[i] = { ...tokens[i], text: newWord };
      break;
    }
    count++;
  }
  return tokens.map((t) => t.text).join("");
};

const WordEditableText = ({ text, onWordClick, disabled }) => {
  const tokens = tokenizeForWordEdit(text);
  if (disabled || !onWordClick) {
    return <>{text}</>;
  }
  let wordCounter = 0;
  return (
    <>
      {tokens.map((t, i) => {
        if (!t.isWord) return <React.Fragment key={i}>{t.text}</React.Fragment>;
        const wordIdx = wordCounter++;
        return (
          <span
            key={i}
            className="ct-word-edit"
            onClick={(e) => onWordClick(e, wordIdx, t.text)}
            role="button"
            tabIndex={-1}
          >
            {t.text}
          </span>
        );
      })}
    </>
  );
};

const StreamingText = ({ value, animate, withCursor }) => {
  const [segments, setSegments] = useState(() => {
    const initial = String(value || "");
    return initial ? [{ text: initial, id: 0, animate: false }] : [];
  });
  const idCounterRef = useRef(0);
  const lastValueRef = useRef(String(value || ""));

  useEffect(() => {
    const next = String(value || "");
    const prev = lastValueRef.current;
    if (next === prev) return;

    if (animate && next.length > prev.length && next.startsWith(prev)) {
      const added = next.slice(prev.length);
      idCounterRef.current += 1;
      const id = idCounterRef.current;
      setSegments((segs) => [...segs, { text: added, id, animate: true }]);
    } else {
      idCounterRef.current += 1;
      const id = idCounterRef.current;
      setSegments(next ? [{ text: next, id, animate: false }] : []);
    }
    lastValueRef.current = next;
  }, [value, animate]);

  if (segments.length === 0 && !withCursor) return null;

  return (
    <>
      {segments.map((seg) =>
        seg.animate ? (
          <span key={seg.id} className="ct-stream-fade">
            {seg.text}
          </span>
        ) : (
          <span key={seg.id}>{seg.text}</span>
        )
      )}
      {withCursor && <span className="ct-stream-cursor" aria-hidden />}
    </>
  );
};

// ============================================================================
// 管线状态卡：固定右下角，显示收音 / 识别 / 润色 / 实时机翻 四段管线的当前状态
// ============================================================================
const PIPELINE_PILL_STATE_CLASS = {
  idle: "ct-pipeline-pill-idle",
  active: "ct-pipeline-pill-active",
  paused: "ct-pipeline-pill-paused",
  warn: "ct-pipeline-pill-warn",
  error: "ct-pipeline-pill-error",
};

const PipelineStatusPill = ({ icon: Icon, label, state, hint }) => {
  const styleKey = PIPELINE_PILL_STATE_CLASS[state] ? state : "idle";
  return (
    <div
      className={`ct-pipeline-pill ${PIPELINE_PILL_STATE_CLASS[styleKey]}`}
      title={hint || label}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
      <span
        className={`ml-1 inline-block w-1.5 h-1.5 rounded-full ${
          styleKey === "active"
            ? "bg-indigo-300"
            : styleKey === "paused" || styleKey === "warn"
            ? "bg-amber-300"
            : styleKey === "error"
            ? "bg-rose-300"
            : "bg-slate-500"
        }`}
      />
    </div>
  );
};

const PipelineStatusCard = ({ capture, asr, polish, realtime, captureHint, asrHint }) => {
  const allIdle =
    capture.state === "idle" &&
    asr.state === "idle" &&
    polish.state === "idle" &&
    realtime.state === "idle";
  if (allIdle) return null;

  return (
    <div
      className="ct-pipeline-card fixed bottom-5 right-5 z-40 px-3 py-2.5 flex flex-col gap-1.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
        管线状态
      </div>
      <PipelineStatusPill
        icon={capture.icon}
        label={capture.label}
        state={capture.state}
        hint={captureHint}
      />
      <PipelineStatusPill
        icon={asr.icon}
        label={asr.label}
        state={asr.state}
        hint={asrHint}
      />
      <PipelineStatusPill
        icon={polish.icon}
        label={polish.label}
        state={polish.state}
      />
      <PipelineStatusPill
        icon={realtime.icon}
        label={realtime.label}
        state={realtime.state}
      />
    </div>
  );
};

const USAGE_TYPE_LABELS = {
  polish: "AI 润色",
  realtime: "实时机翻",
  summary: "课堂纪要",
};

const formatUsageTimestamp = (ts) => {
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return "";
  }
};

const colorForModel = (model) => {
  const s = String(model || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
};

const startOfTodayMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// 把 log 按"小时桶"汇总：默认 anchor=今天 00:00，往后铺 24 桶
const computeHourlyBuckets = (entries, anchorMs, hours = 24) => {
  const HOUR = 3600 * 1000;
  const buckets = [];
  for (let i = 0; i < hours; i++) {
    buckets.push({ startMs: anchorMs + i * HOUR, total: 0, byModel: {} });
  }
  for (const entry of entries) {
    const ts = Number(entry?.timestamp || 0);
    if (ts < anchorMs || ts >= anchorMs + hours * HOUR) continue;
    const idx = Math.floor((ts - anchorMs) / HOUR);
    if (idx < 0 || idx >= hours) continue;
    const tokens = Number(entry.totalTokens || 0);
    const b = buckets[idx];
    b.total += tokens;
    const m = entry.model || "(unknown)";
    b.byModel[m] = (b.byModel[m] || 0) + tokens;
  }
  return buckets;
};

// 24h 堆叠柱状图（纯 SVG，无依赖）
const HourlyStackedChart = ({ buckets, modelOrder, nowMs }) => {
  const width = 960;
  const height = 140;
  const paddingLeft = 36;
  const paddingRight = 8;
  const paddingTop = 10;
  const paddingBottom = 22;
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const colWidth = chartWidth / buckets.length;
  const yTicks = 4;
  const niceTickFor = (v) => {
    if (v < 1000) return v;
    if (v < 10000) return Math.round(v / 100) * 100;
    if (v < 1000000) return Math.round(v / 1000) * 1000;
    return Math.round(v / 10000) * 10000;
  };
  const HOUR = 3600 * 1000;
  const nowBucketIdx = Math.floor((nowMs - buckets[0].startMs) / HOUR);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-36 block"
    >
      {/* 横向网格 + Y 轴标签 */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const y = paddingTop + (i / yTicks) * chartHeight;
        const value = niceTickFor(max * (1 - i / yTicks));
        return (
          <g key={i}>
            <line
              x1={paddingLeft}
              x2={width - paddingRight}
              y1={y}
              y2={y}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
            <text
              x={paddingLeft - 6}
              y={y + 3}
              fontSize="9"
              fill="#64748b"
              textAnchor="end"
              fontFamily="monospace"
            >
              {value >= 1000 ? `${Math.round(value / 1000)}k` : value}
            </text>
          </g>
        );
      })}

      {/* "现在"竖线 */}
      {nowBucketIdx >= 0 && nowBucketIdx <= buckets.length && (
        <line
          x1={paddingLeft + nowBucketIdx * colWidth}
          x2={paddingLeft + nowBucketIdx * colWidth}
          y1={paddingTop}
          y2={paddingTop + chartHeight}
          stroke="#a5b4fc"
          strokeWidth="1"
          strokeDasharray="2 2"
          opacity="0.7"
        />
      )}

      {/* 堆叠柱 */}
      {buckets.map((b, i) => {
        const x = paddingLeft + i * colWidth;
        let cumY = paddingTop + chartHeight;
        return (
          <g key={i}>
            {modelOrder.map((model) => {
              const tokens = b.byModel[model] || 0;
              if (!tokens) return null;
              const h = (tokens / max) * chartHeight;
              cumY -= h;
              return (
                <rect
                  key={model}
                  x={x + 1}
                  y={cumY}
                  width={Math.max(0.5, colWidth - 2)}
                  height={h}
                  fill={colorForModel(model)}
                  opacity={0.85}
                >
                  <title>{`${new Date(b.startMs).getHours()}:00 · ${model} · ${tokens.toLocaleString()} tokens`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}

      {/* X 轴小时标签：每 3h 一格 */}
      {buckets.map((b, i) => {
        if (i % 3 !== 0 && i !== buckets.length - 1) return null;
        const x = paddingLeft + i * colWidth + colWidth / 2;
        const hour = new Date(b.startMs).getHours();
        return (
          <text
            key={i}
            x={x}
            y={height - 6}
            fontSize="9"
            fill="#64748b"
            textAnchor="middle"
            fontFamily="monospace"
          >
            {String(hour).padStart(2, "0")}
          </text>
        );
      })}
    </svg>
  );
};

const UsageView = ({ log, onClear }) => {
  const entries = Array.isArray(log) ? log : [];
  const reversed = [...entries].slice(-50).reverse();

  const todayStart = startOfTodayMs();
  const nowMs = Date.now();

  const todayEntries = entries.filter(
    (e) => Number(e?.timestamp || 0) >= todayStart
  );

  const aggregateByModel = (list) =>
    list.reduce((acc, entry) => {
      const key = entry.model || "(unknown)";
      if (!acc[key]) {
        acc[key] = { calls: 0, prompt: 0, completion: 0, total: 0 };
      }
      acc[key].calls += 1;
      acc[key].prompt += Number(entry.promptTokens || 0);
      acc[key].completion += Number(entry.completionTokens || 0);
      acc[key].total += Number(entry.totalTokens || 0);
      return acc;
    }, {});

  const todayByModel = aggregateByModel(todayEntries);
  const totalsByModel = aggregateByModel(entries);

  const totalsByType = entries.reduce((acc, entry) => {
    const key = entry.type || "unknown";
    if (!acc[key]) acc[key] = { calls: 0, total: 0 };
    acc[key].calls += 1;
    acc[key].total += Number(entry.totalTokens || 0);
    return acc;
  }, {});

  const todayTotal = todayEntries.reduce(
    (s, e) => s + Number(e.totalTokens || 0),
    0
  );
  const grandTotal = entries.reduce(
    (s, e) => s + Number(e.totalTokens || 0),
    0
  );

  // 模型颜色顺序：按今日总量倒序，然后历史里出现过但今天没用的接在后面
  const modelOrder = (() => {
    const todayList = Object.entries(todayByModel)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([m]) => m);
    const todaySet = new Set(todayList);
    const restList = Object.keys(totalsByModel).filter((m) => !todaySet.has(m));
    return [...todayList, ...restList];
  })();

  const buckets = computeHourlyBuckets(entries, todayStart, 24);

  return (
    <div className="ct-panel p-6 space-y-6 min-h-[78vh]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-100 tracking-tight">AI 用量统计</h2>
          <p className="text-xs text-slate-400 mt-1">
            统计每次 LLM 调用的 token 消耗（本地仅保留最近 {USAGE_LOG_MAX_ENTRIES} 条）。Paraformer 语音识别按音频时长计费，不在此处统计。
          </p>
        </div>
        <button
          onClick={onClear}
          className="ct-btn-ghost text-xs px-3 py-2 rounded-lg font-semibold"
        >
          清空记录
        </button>
      </div>

      {/* 今日 hero 卡片 */}
      <div className="rounded-2xl border border-indigo-400/25 bg-gradient-to-br from-indigo-500/10 to-violet-500/[0.04] p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] text-indigo-300 font-bold uppercase tracking-wider">
              今日总用量
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-4xl font-bold text-indigo-100 tabular-nums">
                {todayTotal.toLocaleString()}
              </span>
              <span className="text-sm text-indigo-300 font-semibold">
                tokens · {todayEntries.length} 次调用
              </span>
            </div>
          </div>
          <div className="text-right text-xs text-slate-400">
            <div>累计：<span className="font-mono text-slate-200">{grandTotal.toLocaleString()}</span> tokens</div>
            <div>涉及模型：<span className="font-mono text-slate-200">{Object.keys(totalsByModel).length}</span></div>
          </div>
        </div>

        {Object.keys(todayByModel).length > 0 ? (
          <div className="mt-4 space-y-1.5">
            {Object.entries(todayByModel)
              .sort((a, b) => b[1].total - a[1].total)
              .map(([model, t]) => {
                const pct = todayTotal > 0 ? (t.total / todayTotal) * 100 : 0;
                return (
                  <div key={model} className="flex items-center gap-2 text-xs">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: colorForModel(model) }}
                    />
                    <span className="font-mono text-indigo-100 w-40 truncate">
                      {model}
                    </span>
                    <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: colorForModel(model),
                        }}
                      />
                    </div>
                    <span className="font-mono text-slate-200 w-20 text-right tabular-nums">
                      {t.total.toLocaleString()}
                    </span>
                    <span className="text-indigo-300 w-10 text-right tabular-nums">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="mt-4 text-sm text-indigo-200/70">
            今天还没有调用。开始一次同传或生成纪要即可看到数据。
          </div>
        )}
      </div>

      {/* 24h 堆叠柱状图 */}
      <div className="rounded-xl border border-white/10 overflow-hidden bg-white/[0.02]">
        <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold text-slate-200">
            今日 24 小时 token 走势（按模型堆叠）
          </span>
          <span className="text-[10px] font-mono text-slate-500">
            {new Date(todayStart).toLocaleDateString()}
          </span>
        </div>
        <div className="p-3">
          <HourlyStackedChart buckets={buckets} modelOrder={modelOrder} nowMs={nowMs} />
          {modelOrder.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 px-1">
              {modelOrder.map((model) => {
                const t = todayByModel[model] || totalsByModel[model];
                if (!t) return null;
                const isToday = !!todayByModel[model];
                return (
                  <div
                    key={model}
                    className={`flex items-center gap-1.5 text-[11px] ${
                      isToday ? "text-slate-200" : "text-slate-500"
                    }`}
                  >
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: colorForModel(model) }}
                    />
                    <span className="font-mono">{model}</span>
                    {!isToday && <span className="text-slate-500">(历史)</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 按调用类型快览 */}
      {Object.keys(totalsByType).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(totalsByType).map(([type, t]) => (
            <div
              key={type}
              className="ct-tag ct-tag-info"
            >
              <span className="font-semibold">{USAGE_TYPE_LABELS[type] || type}</span>
              <span className="opacity-60 mx-1">·</span>
              <span>{t.calls} 次 / {t.total.toLocaleString()} tokens</span>
            </div>
          ))}
        </div>
      )}

      {/* 按模型聚合（累计） */}
      {Object.keys(totalsByModel).length > 0 && (
        <div className="rounded-xl border border-white/10 overflow-hidden bg-white/[0.02]">
          <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 text-xs font-semibold text-slate-200">
            按模型聚合（累计）
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 bg-white/[0.02]">
              <tr>
                <th className="text-left px-4 py-2 font-medium">模型</th>
                <th className="text-right px-4 py-2 font-medium">调用</th>
                <th className="text-right px-4 py-2 font-medium">prompt</th>
                <th className="text-right px-4 py-2 font-medium">completion</th>
                <th className="text-right px-4 py-2 font-medium">total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(totalsByModel)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([model, t]) => (
                  <tr key={model} className="border-t border-white/5">
                    <td className="px-4 py-2 font-mono text-slate-200 flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm"
                        style={{ backgroundColor: colorForModel(model) }}
                      />
                      {model}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-300">{t.calls}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{t.prompt.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{t.completion.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-100">{t.total.toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-white/10 overflow-hidden bg-white/[0.02]">
        <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 text-xs font-semibold text-slate-200">
          最近调用（倒序）
        </div>
        {reversed.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            还没有记录。开始一次同传或生成纪要后这里会出现 token 消耗。
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 bg-white/[0.02]">
              <tr>
                <th className="text-left px-4 py-2 font-medium">时间</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">模型</th>
                <th className="text-right px-4 py-2 font-medium">prompt</th>
                <th className="text-right px-4 py-2 font-medium">completion</th>
                <th className="text-right px-4 py-2 font-medium">total</th>
              </tr>
            </thead>
            <tbody>
              {reversed.map((entry, idx) => (
                <tr
                  key={`${entry.timestamp}-${idx}`}
                  className="border-t border-white/5"
                >
                  <td className="px-4 py-2 text-slate-300 whitespace-nowrap">
                    {formatUsageTimestamp(entry.timestamp)}
                  </td>
                  <td className="px-4 py-2 text-slate-200">
                    {USAGE_TYPE_LABELS[entry.type] || entry.type}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-300">
                    {entry.model}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-400">
                    {Number(entry.promptTokens || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-400">
                    {Number(entry.completionTokens || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-100">
                    {Number(entry.totalTokens || 0).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const { user, loading: authLoading, signOut, session, isAdmin } = useAuth();
  
  if (authLoading) return null; // Wait for initial auth check

  return (
    <Routes>
      <Route path="/auth" element={user ? <Navigate to="/" /> : <AuthPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/*" element={user ? <MainApp user={user} signOut={signOut} authSession={session} isAdmin={isAdmin} /> : <Navigate to="/auth" />} />
    </Routes>
  );
}

function MainApp({ user, signOut, authSession, isAdmin }) {
  React.useEffect(() => { setGlobalApiToken(authSession?.access_token || ""); }, [authSession]);
  
  const { settings: globalSettings, loading: globalSettingsLoading, updateSettings } = useGlobalSettings();
  const { aiModelName, realtimeModelName, summaryModelName, asrModelName } = globalSettings;

  // One-time migration: Clear old localStorage values to force sync from database
  React.useEffect(() => {
    const migrationKey = 'classtrans.settings.migrated.v2';
    const alreadyMigrated = window.localStorage.getItem(migrationKey);
    
    if (!alreadyMigrated) {
      // Clear all old model settings from localStorage
      window.localStorage.removeItem(MODEL_STORAGE_KEY);
      window.localStorage.removeItem(REALTIME_MODEL_STORAGE_KEY);
      window.localStorage.removeItem(SUMMARY_MODEL_STORAGE_KEY);
      window.localStorage.removeItem(ASR_MODEL_STORAGE_KEY);
      
      // Mark migration as complete
      window.localStorage.setItem(migrationKey, 'true');
      
      console.log('[ClassTrans] Migrated to database-driven settings');
    }
  }, []);

  React.useEffect(() => {
    // Sync global settings from database to runtime variables and localStorage
    // This ensures admin changes take effect immediately for all users
    // IMPORTANT: Always sync from database to override any stale localStorage values
    if (aiModelName) {
      setGlobalModelName(aiModelName);
    }
    if (realtimeModelName) {
      setGlobalRealtimeModelName(realtimeModelName);
    }
    if (summaryModelName) {
      setGlobalSummaryModelName(summaryModelName);
    }
    if (asrModelName) {
      setGlobalAsrModelName(asrModelName);
    }
  }, [aiModelName, realtimeModelName, summaryModelName, asrModelName]);

  const [listeningMode, setListeningMode] = useState("none");
  const [isPaused, setIsPaused] = useState(false);
  const [transcripts, setTranscripts] = useState([]);
  const [recordingTime, setRecordingTime] = useState(0);

  const [activeEn, setActiveEn] = useState("");
  const [activeZh, setActiveZh] = useState("");
  const [activeConfidence, setActiveConfidence] = useState(1);
  const [unsupportedReason, setUnsupportedReason] = useState("");
  const [isSupported, setIsSupported] = useState(true);
  const [asrStatus, setAsrStatus] = useState("idle"); // 'idle' | 'connecting' | 'live' | 'error'
  const [asrErrorReason, setAsrErrorReason] = useState("");
  // 一体化语音翻译（livetranslate）：是否朗读中文译文，以及当前会话是否使用该模型。
  const [playTranslationAudio, setPlayTranslationAudioState] = useState(() => {
    try {
      return window.localStorage.getItem(TRANSLATION_AUDIO_STORAGE_KEY) === "1";
    } catch (e) {
      return false;
    }
  });
  const playTranslationAudioRef = useRef(playTranslationAudio);
  const [liveTranslateActive, setLiveTranslateActive] = useState(false);

  // 切换“朗读中文译文”。即时持久化，并对正在运行的 livetranslate 会话热更新输出模态。
  const toggleTranslationAudio = useCallback(() => {
    const next = !playTranslationAudioRef.current;
    playTranslationAudioRef.current = next;
    setPlayTranslationAudioState(next);
    try {
      window.localStorage.setItem(TRANSLATION_AUDIO_STORAGE_KEY, next ? "1" : "0");
    } catch (e) {}
    const s = paraformerSessionRef.current;
    if (s && typeof s.setAudioOutput === "function") s.setAudioOutput(next);
  }, []);

  // ---- Toasts: 可堆栈、自动消失、可手动关 -----------------------------------
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const toastTimeoutsRef = useRef(new Map());

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timeout = toastTimeoutsRef.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      toastTimeoutsRef.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(({ level = "info", text, ttl = 4500 } = {}) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((prev) => [...prev, { id, level, text: trimmed, ts: Date.now() }]);
    if (ttl > 0) {
      const timeout = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        toastTimeoutsRef.current.delete(id);
      }, ttl);
      toastTimeoutsRef.current.set(id, timeout);
    }
    return id;
  }, []);

  useEffect(
    () => () => {
      for (const timeout of toastTimeoutsRef.current.values()) clearTimeout(timeout);
      toastTimeoutsRef.current.clear();
    },
    []
  );

  // 兼容老调用点：setErrorMsg("") = 无操作；非空字符串走 toast
  // 文本里含"失败/异常/拒绝/无法" → error；"已..." / "建议" / "正在" → info；其他 → warn
  const setErrorMsg = useCallback(
    (text) => {
      const t = String(text || "").trim();
      if (!t) return;
      let level = "warn";
      if (/失败|异常|拒绝|无法|错误/.test(t)) level = "error";
      else if (/^已|^正在|建议|提示|^切换|^请/.test(t)) level = "info";
      pushToast({ level, text: t });
    },
    [pushToast]
  );

  const [pipWindow, setPipWindow] = useState(null);
  
  // 主页面滚动相关的 Refs 和 State
  const scrollRef = useRef(null);
  const mainRef = useRef(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("default");
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const deviceMenuRef = useRef(null);
  // Folder picker (header) + inline "new folder" form (文件夹 view)
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  const folderMenuRef = useRef(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState("indigo");
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Inline folder rename (文件夹 view)
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [editFolderName, setEditFolderName] = useState("");
  const [editFolderColor, setEditFolderColor] = useState("indigo");

  const [summaryResult, setSummaryResult] = useState("");
  const [isFinalizingSession, setIsFinalizingSession] = useState(false);
  const [finalizingProgress, setFinalizingProgress] = useState({
    done: 0,
    total: 0,
    phase: "idle",
  });
  const [customGlossaryPairs, setCustomGlossaryPairs] = useState([]);
  const [glossaryDraft, setGlossaryDraft] = useState("");
  const [glossaryError, setGlossaryError] = useState("");
  const [activeView, setActiveView] = useState("home");
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const {
    sessions: cloudSessions,
    loadSessions,
    getSession: cloudGetSession,
    saveSession: cloudSaveSession,
    deleteSession: cloudDeleteSession,
    updateSession: cloudUpdateSession,
    updateTranscript: cloudUpdateTranscript,
    replaceTranscripts: cloudReplaceTranscripts,
    moveSession: cloudMoveSession,
  } = useCloudSessions(user.id);
  const savedSessions = cloudSessions;
  const [temporarySessions, setTemporarySessions] = useState([]);
  const [selectedSavedSession, setSelectedSavedSession] = useState(null);
  const [savedSessionsQuery, setSavedSessionsQuery] = useState("");

  // ---- Cloud folders (organize recordings) --------------------------------
  const {
    folders,
    loadFolders,
    createFolder: cloudCreateFolder,
    updateFolder: cloudUpdateFolder,
    deleteFolder: cloudDeleteFolder,
  } = useCloudFolders(user.id);
  // The folder a NEW recording will be saved into (required before starting).
  const [currentFolderId, setCurrentFolderId] = useState(null);
  // Which folder's sessions are shown in the 文件夹 view (null = grid overview).
  const [openFolderId, setOpenFolderId] = useState(null);
  const currentFolder = folders.find((f) => f.id === currentFolderId) || null;
  // Mirror the target folder into a ref so the (async, closure-captured) save
  // path always reads the current selection rather than a stale value.
  const currentFolderIdRef = useRef(null);
  useEffect(() => {
    currentFolderIdRef.current = currentFolderId;
  }, [currentFolderId]);
  useEffect(() => {
    loadFolders();
  }, [loadFolders]);
  const [titleDraft, setTitleDraft] = useState(null); // null = not editing
  // Inline word-correction popover. shape: { x, y, originalWord, draft, scope, payload }
  const [wordEditPopover, setWordEditPopover] = useState(null);

  // UI theme: "dark" (default) | "light" — persisted to localStorage and
  // applied as data-theme="..." on the <html> element so the CSS variable
  // overrides + Tailwind utility overrides in index.css take effect.
  const { settings, updateSetting } = useCloudSettings(user.id);
  const theme = settings.theme || "dark";
  const setTheme = (t) => updateSetting('theme', t);
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (e) {}
  }, [theme]);
  const toggleTheme = useCallback(() => {
    // setTheme forwards its argument straight to updateSetting, so it is NOT a
    // React state setter — passing a functional updater would store the
    // function itself as the theme value. Compute the next value from `theme`.
    updateSetting("theme", theme === "dark" ? "light" : "dark");
  }, [theme, updateSetting]);
  // Whole-bubble editor draft. shape: { scope, key, payload, enDraft, zhDraft }
  const [bubbleEditDraft, setBubbleEditDraft] = useState(null);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);
  // 历史会话中正在重新 AI 精调的气泡 key 集合："${fileName}::${bubbleIdx}"
  const [polishingSavedKeys, setPolishingSavedKeys] = useState(() => new Set());
  const [sessionCompletionModal, setSessionCompletionModal] = useState({
    open: false,
    durationSec: 0,
    transcriptCount: 0,
    enWordCount: 0,
    zhCharCount: 0,
    mode: "mic",
  });

  useEffect(() => {
    loadSessions(0);
  }, [loadSessions]);

  const patchSelectedSavedSession = useCallback((fileName, patchOrUpdater) => {
    setSelectedSavedSession((prev) => {
      if (!prev || prev.fileName !== fileName) return prev;
      return typeof patchOrUpdater === "function"
        ? patchOrUpdater(prev)
        : { ...prev, ...patchOrUpdater };
    });
  }, []);

  const [modelDraft, setModelDraft] = useState("");
  const [realtimeModelDraft, setRealtimeModelDraft] = useState("");
  const [summaryModelDraft, setSummaryModelDraft] = useState("");
  const [asrModelDraft, setAsrModelDraft] = useState("");
  const [modelSuccessMsg, setModelSuccessMsg] = useState("");
  const [savingModelConfig, setSavingModelConfig] = useState(false);

  // Keep the admin form drafts in sync with the global settings loaded from the
  // database. Depending on the primitive values (not the settings object) means
  // this only re-runs when a value actually changes — so it won't overwrite
  // what the admin is currently typing.
  React.useEffect(() => {
    setModelDraft(aiModelName || "");
    setRealtimeModelDraft(realtimeModelName || "");
    setSummaryModelDraft(summaryModelName || "");
    setAsrModelDraft(asrModelName || "");
  }, [aiModelName, realtimeModelName, summaryModelName, asrModelName]);

  const [aiUsageLog, setAiUsageLog] = useState(() => readUsageLog());
  useEffect(() => subscribeUsageLog(setAiUsageLog), []);

  // --------------------------------------------------------------------------
  // [极致无缝引擎核心 Refs]
  // --------------------------------------------------------------------------
  const targetModeRef = useRef("mic");
  const shouldListenRef = useRef(false);
  const isPausedRef = useRef(false);
  const activeBlockIdRef = useRef(Date.now().toString());
  const lastTranslatedEnRef = useRef("");
  const isTranslatingRef = useRef(false);
  const silenceTimerRef = useRef(null);
  // 每个 finalize 块的 polish promise 链都注册到这里；autoSave 时可以
  // Promise.allSettled 等到全部落地，不再依赖 transcripts 状态轮询。
  const polishPromisesRef = useRef(new Set());
  const systemAudioStreamRef = useRef(null);
  const systemAudioTrackRef = useRef(null);
  const paraformerSessionRef = useRef(null);
  const micInputStreamRef = useRef(null);
  const micProcessedStreamRef = useRef(null);
  const micProcessedTrackRef = useRef(null);
  const isResizingSidebarRef = useRef(false);
  const transcriptsRef = useRef([]);
  const lastExpandedSidebarWidthRef = useRef(240);

  const TRANSLATE_INTERVAL = 700;

  const activeEnRef = useRef("");
  const activeZhRef = useRef("");
  const activeConfidenceRef = useRef(1);

  const processedLengthRef = useRef(0);
  const lastSessionStringRef = useRef("");
  const lastFinalSessionStringRef = useRef("");
  // One-pass speech-translation (Gummy) ASR-provided Chinese bookkeeping,
  // mirrored on the English processedLength logic. When the ASR streams its own
  // translation we display that directly and skip the LLM interim translate.
  const processedZhLengthRef = useRef(0);
  const lastTranslatedSessionStringRef = useRef("");
  const asrProvidesTranslationRef = useRef(false);

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  const { rows: homeRows, buckets: homeBuckets } = useMemo(
    () => buildTranscriptRowsAndBuckets(transcripts),
    [transcripts]
  );

  const scrollToBucket = useCallback((bucketStart) => {
    const target = document.getElementById(`ct-bucket-${bucketStart}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const fetchDevices = async () => {
    try {
      if (!navigator?.mediaDevices?.getUserMedia || !navigator?.mediaDevices?.enumerateDevices) {
        return;
      }

      await navigator.mediaDevices.getUserMedia({ audio: true });
      const availableDevices = await navigator.mediaDevices.enumerateDevices();
      if (!Array.isArray(availableDevices)) {
        return;
      }
      const audioInputDevices = availableDevices.filter(
        (device) => device.kind === "audioinput"
      );
      setDevices(audioInputDevices);
      if (audioInputDevices.length > 0 && selectedDeviceId === "default") {
        setSelectedDeviceId(audioInputDevices[0].deviceId);
      }
    } catch (err) {
      console.warn("无法获取设备列表:", err);
    }
  };

  // 计时器逻辑：finalizing 期间也停（按下停止后立刻冻结显示）
  useEffect(() => {
    let interval = null;
    if (
      (listeningMode === "mic" || listeningMode === "tab") &&
      !isPaused &&
      !isFinalizingSession
    ) {
      interval = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [listeningMode, isPaused, isFinalizingSession]);

  const formatTime = (totalSeconds) => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const getSessionStatsFromTranscripts = (items = []) => {
    const transcriptCount = items.length;
    const enWordCount = items.reduce((total, item) => {
      const words = String(item?.en || "").match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
      return total + (words ? words.length : 0);
    }, 0);
    const zhCharCount = items.reduce((total, item) => {
      const zhChars = String(item?.zh || "").match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
      return total + (zhChars ? zhChars.length : 0);
    }, 0);

    return {
      transcriptCount,
      enWordCount,
      zhCharCount,
    };
  };

  const stopSystemAudioCapture = useCallback(() => {
    if (systemAudioTrackRef.current) {
      try {
        systemAudioTrackRef.current.stop();
      } catch (e) {}
      systemAudioTrackRef.current = null;
    }

    if (systemAudioStreamRef.current) {
      systemAudioStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      systemAudioStreamRef.current = null;
    }
  }, []);

  const stopMicCaptureEnhancer = useCallback(() => {
    if (micProcessedTrackRef.current) {
      try {
        micProcessedTrackRef.current.stop();
      } catch (e) {}
      micProcessedTrackRef.current = null;
    }

    if (micProcessedStreamRef.current) {
      micProcessedStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      micProcessedStreamRef.current = null;
    }

    if (micInputStreamRef.current) {
      micInputStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      micInputStreamRef.current = null;
    }
  }, []);

  const prepareEnhancedMicCapture = useCallback(
    async (deviceId) => {
      if (!navigator?.mediaDevices?.getUserMedia) return null;

      stopMicCaptureEnhancer();

      const wantedDevice = deviceId || selectedDeviceId;
      const baseAudioConstraint = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      };

      const audioConstraint =
        wantedDevice && wantedDevice !== "default"
          ? { ...baseAudioConstraint, deviceId: { exact: wantedDevice } }
          : baseAudioConstraint;

      try {
        const inputStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
        micInputStreamRef.current = inputStream;

        const rawTrack = inputStream.getAudioTracks?.()[0] || null;
        micProcessedTrackRef.current = rawTrack;
        return rawTrack;
      } catch (err) {
        console.warn("麦克风增强链路初始化失败，回退默认收音:", err);
        stopMicCaptureEnhancer();
        return null;
      }
    },
    [selectedDeviceId, stopMicCaptureEnhancer]
  );

  const buildSessionPayload = useCallback(
    (overrideSummary = "") => {
      // Read from the ref, not the `transcripts` state: a bubble whose AI
      // polish finishes *after* "Stop" is clicked lands via setTranscripts
      // while this save runs inside a stale closure. The ref always holds the
      // latest committed transcripts (kept in sync by an effect), so the
      // just-finalized bubble is included instead of being dropped as a
      // still-pending placeholder.
      const cleaned = transcriptsRef.current.filter(
        (item) =>
          item &&
          item.en &&
          item.zh &&
          // 排除尚未 polish 完成的占位 / 流式块，避免把"AI 深度纠错与润色中..."
          // 或半截渐入的 ZH 文本写进存档
          !item.isTranslating &&
          !item.isStreamingPolish &&
          !/识别中/.test(String(item.speaker || "")) &&
          !item.en.includes("⚠️") &&
          !item.en.includes("🔊") &&
          item.zh !== "..."
      );
      return {
        id: `session_${Date.now()}`,
        createdAt: new Date().toISOString(),
        title: `课堂同传 ${new Date().toLocaleString()}`,
        summary: overrideSummary || summaryResult || "",
        transcripts: cleaned.map((item) => ({
          speaker: item.speaker || "👩‍🏫 主讲人",
          en: item.en,
          zh: item.zh,
          confidence: item.confidence || 0,
          // 持久化精调标记，让历史会话视图能区分"已 AI 精调" vs "机译/降级"
          isPolished: item.isPolished === true,
        })),
      };
    },
    [summaryResult]
  );

  const saveSessionToFolder = useCallback(
    async (overrideSummary = "", options = {}) => {
      const payload = buildSessionPayload(overrideSummary);
      if (!payload.transcripts.length && !payload.summary) return false;

      const stats = getSessionStatsFromTranscripts(payload.transcripts);
      const folderId = currentFolderIdRef.current || null;
      const fallbackTempSession = {
        fileName: `temp-${payload.id}`,
        createdAt: payload.createdAt,
        summary: payload.summary,
        transcripts: payload.transcripts,
        title: payload.title,
        folderId,
        isTemporary: true,
      };

      try {
        const saved = await cloudSaveSession({
          title: payload.title,
          summary: payload.summary,
          durationSec: options.durationSec || 0,
          wordCount: stats.enWordCount,
          mode: options.mode || "mic",
          transcripts: payload.transcripts,
          folderId,
        });

        if (!saved) {
          throw new Error("云端未返回保存结果");
        }

        setSelectedSavedSession(saved);
        return true;
      } catch (err) {
        console.error("云端保存同传记录失败，已转为临时内存保存:", err);
        setTemporarySessions((prev) => [
          fallbackTempSession,
          ...prev,
        ]);
        setSelectedSavedSession(fallbackTempSession);
        pushToast({
          level: "warn",
          text: "云端保存失败，本次记录已临时保存在当前页面，请稍后重试导出或刷新前处理。",
          ttl: 7000,
        });
        return true;
      }
    },
    [buildSessionPayload, cloudSaveSession, pushToast]
  );

  const loadSavedSessionsFromFolder = useCallback(async () => {
    try {
      return await loadSessions(0);
    } catch (err) {
      console.error("加载云端会话失败:", err);
      setErrorMsg("读取云端历史会话失败，请稍后重试。");
      return [];
    }
  }, [loadSessions, setErrorMsg]);

  const openFoldersView = useCallback(async () => {
    setOpenFolderId(null);
    await Promise.all([loadFolders(), loadSavedSessionsFromFolder()]);
    setActiveView("folders");
    return true;
  }, [loadFolders, loadSavedSessionsFromFolder]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      pushToast({ level: "warn", text: "请输入文件夹名称", ttl: 3000 });
      return;
    }
    setCreatingFolder(true);
    try {
      const folder = await cloudCreateFolder(name, newFolderColor);
      setNewFolderName("");
      setNewFolderColor("indigo");
      if (folder) {
        // Auto-select the new folder as the recording target for convenience.
        setCurrentFolderId(folder.id);
        pushToast({ level: "success", text: `已创建文件夹「${folder.name}」`, ttl: 2500 });
      }
    } catch (err) {
      pushToast({ level: "error", text: err && err.message ? err.message : "创建文件夹失败", ttl: 5000 });
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (folder) => {
    if (
      !window.confirm(
        `删除文件夹「${folder.name}」？\n其中的录音会移到「未归档」，不会被删除。`
      )
    ) {
      return;
    }
    const { error } = await cloudDeleteFolder(folder.id);
    if (error) {
      pushToast({ level: "error", text: "删除文件夹失败", ttl: 4000 });
      return;
    }
    if (currentFolderId === folder.id) setCurrentFolderId(null);
    if (openFolderId === folder.id) setOpenFolderId(null);
    // Sessions whose folder was deleted are now 未归档 (DB ON DELETE SET NULL);
    // refresh so the local list reflects that.
    await loadSavedSessionsFromFolder();
    pushToast({ level: "success", text: "文件夹已删除", ttl: 2500 });
  };

  const startRenameFolder = (folder) => {
    setEditingFolderId(folder.id);
    setEditFolderName(folder.name);
    setEditFolderColor(folder.color || "indigo");
  };

  const handleRenameFolder = async () => {
    const name = editFolderName.trim();
    if (!name) {
      pushToast({ level: "warn", text: "请输入文件夹名称", ttl: 3000 });
      return;
    }
    const folderId = editingFolderId;
    const { error } = await cloudUpdateFolder(folderId, { name, color: editFolderColor });
    if (error) {
      pushToast({ level: "error", text: "重命名失败，请重试", ttl: 4000 });
      return;
    }
    setEditingFolderId(null);
    pushToast({ level: "success", text: "文件夹已更新", ttl: 2000 });
  };

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GLOSSARY_STORAGE_KEY);
      if (!raw) {
        setRuntimeCustomGlossaryPairs([]);
        return;
      }

      const parsed = JSON.parse(raw);
      const safePairs = Array.isArray(parsed)
        ? parsed.filter((item) => item?.from && item?.to)
        : [];

      setCustomGlossaryPairs(safePairs);
      setRuntimeCustomGlossaryPairs(safePairs);
      setGlossaryDraft(safePairs.map((item) => `${item.from} => ${item.to}`).join("\n"));
    } catch (err) {
      console.warn("读取本地术语词典失败:", err);
      setRuntimeCustomGlossaryPairs([]);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    const handleClickOutside = (event) => {
      if (
        deviceMenuRef.current &&
        !deviceMenuRef.current.contains(event.target)
      ) {
        setIsDeviceMenuOpen(false);
      }
      if (
        folderMenuRef.current &&
        !folderMenuRef.current.contains(event.target)
      ) {
        setIsFolderMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!isResizingSidebarRef.current) return;
      const nextWidth = clamp(event.clientX, 200, 420);
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      if (!isResizingSidebarRef.current) return;
      isResizingSidebarRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const startSidebarResize = () => {
    if (isSidebarCollapsed) return;
    isResizingSidebarRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const toggleSidebarCollapse = () => {
    setIsSidebarCollapsed((prev) => {
      if (prev) {
        setSidebarWidth(lastExpandedSidebarWidthRef.current || 240);
        return false;
      }
      lastExpandedSidebarWidthRef.current = sidebarWidth;
      return true;
    });
  };

  const handleDeviceChange = async (deviceId) => {
    setSelectedDeviceId(deviceId);
    setIsDeviceMenuOpen(false);

    if (listeningMode !== "mic") return;

    // 关键：换麦不收尾本次同传，只把 Paraformer 会话原地重启到新设备上。
    setErrorMsg("已切换麦克风，正在继续当前同传…");
    await stopParaformerSession();

    let nextTrack = null;
    try {
      nextTrack = await prepareEnhancedMicCapture(deviceId);
    } catch (err) {
      console.warn("切换麦克风设备授权失败:", err);
    }

    if (!nextTrack) {
      setErrorMsg("切换后无法获取麦克风音频，请重试或换一个输入设备。");
      shouldListenRef.current = false;
      setListeningMode("none");
      return;
    }

    shouldListenRef.current = true;
    targetModeRef.current = "mic";

    try {
      await startParaformerForMode(nextTrack, "mic");
      setErrorMsg("");
    } catch (err) {
      console.error("切麦后启动 Paraformer 失败:", err);
      stopMicCaptureEnhancer();
      shouldListenRef.current = false;
      setListeningMode("none");
      setErrorMsg(`切麦后识别启动失败：${err && err.message ? err.message : err}`);
    }
  };

  const finalizeCurrentBlock = useCallback(() => {
    const textToFinalize = smartPunctuateEnglish(activeEnRef.current, true).trim();
    if (!textToFinalize) return;

    const id = activeBlockIdRef.current;
    const currentInterimZh = activeZhRef.current;
    const blockConfidence = activeConfidenceRef.current;
    const blockCreatedAt = Date.now();
    const isTabCapture = targetModeRef.current === "tab";

    // 跨块上下文：取最近 2 条已完成、干净的转录，给 polish 维持术语 / 代词一致
    const contextHistory = (transcriptsRef.current || [])
      .filter(
        (t) =>
          t &&
          !t.isTranslating &&
          t.en &&
          t.zh &&
          t.zh !== "..." &&
          !String(t.en).includes("⚠️") &&
          !String(t.en).includes("🔊") &&
          !String(t.speaker || "").includes("识别中")
      )
      .slice(-2)
      .map((t) => ({ en: t.en, zh: t.zh }));

    setTranscripts((prev) => [
      ...prev,
      {
        id,
        en: textToFinalize,
        zh: currentInterimZh || "...",
        confidence: blockConfidence,
        lowConfidence: blockConfidence < 0.65,
        isTranslating: true,
        isStreamingPolish: false,
        isPolished: false,
        fromTab: isTabCapture,
        speaker: "🕵️ 识别中...", // 初始状态为识别中，等待大模型覆盖
        createdAt: blockCreatedAt,
      },
    ]);

    activeBlockIdRef.current =
      Date.now().toString() + Math.random().toString(36).substring(2, 7);

  // Paraformer 的 sentence_end 通常滞后于用户的自然停顿，finalize 触发时 finalText
  // 还可能是空。所以这里推进到当前会话整段文本（含 interim），把已展示给用户的内容
  // 完整标记为已消费，避免下一条气泡复读上一段。
  processedLengthRef.current = lastSessionStringRef.current.length;
  // Advance the ASR-translation consume point in lock-step (Gummy path).
  processedZhLengthRef.current = lastTranslatedSessionStringRef.current.length;

    setActiveEn("");
    setActiveZh("");
  setActiveConfidence(1);
    activeEnRef.current = "";
    activeZhRef.current = "";
  activeConfidenceRef.current = 1;
    lastTranslatedEnRef.current = "";

    // ---- 懒加载 qwen-turbo 基线：仅当 polish 在 POLISH_BASELINE_DELAY_MS 内还没出第一个 ZH delta，
    //      或质量门控/polish 自身失败需要兜底时才启动。fast-polish 路径完全跳过这次调用。
    let baselinePromise = null;
    let firstDeltaSeen = false;
    let baselineTimerCleared = false;

    const ensureBaseline = () => {
      if (!baselinePromise) {
        baselinePromise = translateRealtimeFast(textToFinalize).catch((err) => {
          console.warn("baseline translate failed:", err);
          return "";
        });
      }
      return baselinePromise;
    };

    const baselineTimer = setTimeout(() => {
      baselineTimerCleared = true;
      if (!firstDeltaSeen) ensureBaseline();
    }, POLISH_BASELINE_DELAY_MS);

    const cancelBaselineTimer = () => {
      if (baselineTimerCleared) return;
      baselineTimerCleared = true;
      clearTimeout(baselineTimer);
    };

    const onPolishStream = (partialSegments) => {
      if (!partialSegments || partialSegments.length === 0) return;
      const head = partialSegments[0];
      const liveZh = String(head?.zh || "").trim();
      if (!liveZh) return;

      if (!firstDeltaSeen) {
        firstDeltaSeen = true;
        cancelBaselineTimer();
      }

      const liveSpeaker = String(head?.speaker || "").trim();

      setTranscripts((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;
        const cur = prev[idx];
        if (
          cur.zh === liveZh &&
          (!liveSpeaker || cur.speaker === liveSpeaker) &&
          !cur.isTranslating &&
          cur.isStreamingPolish
        ) {
          return prev;
        }
        const updated = [...prev];
        updated[idx] = {
          ...cur,
          zh: liveZh,
          speaker: liveSpeaker || cur.speaker,
          isTranslating: false,
          isStreamingPolish: true,
        };
        return updated;
      });
    };

    const applyFinalSegments = (finalSegments, isPolished) => {
      setTranscripts((prev) => {
        const index = prev.findIndex((t) => t.id === id);
        if (index === -1) return prev;

        const newItems = finalSegments.map((seg, idx) => ({
          id: `${id}-split-${idx}`,
          speaker: seg.speaker || "👩‍🏫 主讲人",
          en: smartPunctuateEnglish(seg.en || textToFinalize, true),
          zh: seg.zh || "...",
          confidence: blockConfidence,
          lowConfidence: blockConfidence < 0.65,
          isTranslating: false,
          isStreamingPolish: false,
          isPolished,
          fromTab: isTabCapture,
          createdAt: blockCreatedAt,
        }));

        const updatedTranscripts = [...prev];
        updatedTranscripts.splice(index, 1, ...newItems);
        return updatedTranscripts;
      });
    };

    // Track this block's polish chain so autoSave can Promise.allSettled
    // every in-flight finalize, instead of polling React state with a timeout.
    const polishWork = polishWithAI(textToFinalize, {
      onUpdate: onPolishStream,
      contextHistory,
    })
      .then(async (aiSegments) => {
        cancelBaselineTimer();

        // 仅在 baseline 已启动时等待它（用于质量门控长度对比）；否则跳过这次外部调用。
        const baselineZh = baselinePromise ? await baselinePromise : "";

        const qualityCheck = evaluateAiPolishQuality({
          rawEn: textToFinalize,
          aiSegments,
          basicZh: baselineZh,
        });

        if (qualityCheck.ok) {
          applyFinalSegments(aiSegments, true);
          return;
        }

        console.warn("AI polish quality gate fallback:", qualityCheck.reason);
        const fallback = baselineZh || (await ensureBaseline()) || currentInterimZh;
        applyFinalSegments(
          [
            {
              speaker: "🛡️ 质量守卫(机译保底)",
              en: textToFinalize,
              zh: fallback || "[基础翻译异常]",
            },
          ],
          false
        );
      })
      .catch(async (error) => {
        cancelBaselineTimer();
        console.warn("AI Polish failed:", error);
        const fallback = (await ensureBaseline()) || currentInterimZh;
        applyFinalSegments(
          [
            {
              speaker: "🛟 AI保底翻译",
              en: textToFinalize,
              zh: fallback || "[基础翻译异常]",
            },
          ],
          false
        );
      });

    polishPromisesRef.current.add(polishWork);
    polishWork.finally(() => {
      polishPromisesRef.current.delete(polishWork);
    });
  }, []);

  useEffect(() => {
    const intervalId = setInterval(async () => {
      if ((listeningMode !== "mic" && listeningMode !== "tab") || isPaused) return;
      // One-pass speech-translation (Gummy) supplies Chinese directly; don't
      // also run the LLM interim translate (it would double-work and clobber
      // the ASR translation).
      if (asrProvidesTranslationRef.current) return;

      const currentEn = activeEnRef.current.trim();
      const currentBlockId = activeBlockIdRef.current;

      if (
        currentEn &&
        currentEn !== lastTranslatedEnRef.current &&
        !isTranslatingRef.current
      ) {
        isTranslatingRef.current = true;
        const textToTranslate = currentEn;

        try {
          const zh = await translateRealtimeFast(textToTranslate);
          if (currentBlockId === activeBlockIdRef.current && zh) {
            setActiveZh(zh);
            activeZhRef.current = zh;
            lastTranslatedEnRef.current = textToTranslate;
          }
        } catch (error) {
          console.error("Real-time translation error", error);
        } finally {
          isTranslatingRef.current = false;
        }
      }
    }, TRANSLATE_INTERVAL);
    return () => clearInterval(intervalId);
  }, [listeningMode, isPaused]);

  // 通用的转录增量更新逻辑：mic 模式（webkitSpeechRecognition）和 tab 模式
  // (Paraformer) 都通过它写入活动文本、推进静音定时器。
  const applyTranscriptUpdate = useCallback(
    ({ fullText, finalText, confidence, translatedText }) => {
      if (isPausedRef.current) return;

      const next = fullText || "";
      const prev = lastSessionStringRef.current;
      // Session reset signal: ParaformerSession clears its sentence buffer on
      // task renewal / reconnect and emits an empty fullText. Realign our
      // cumulative-text bookkeeping so the new task's sentence_id=0 onwards
      // doesn't get hidden behind a stale processedLength from the old task.
      if (next === "" && prev.length > 0) {
        processedLengthRef.current = 0;
        processedZhLengthRef.current = 0;
      }

      lastSessionStringRef.current = next;
      lastFinalSessionStringRef.current = finalText || "";

      const safeProcessedLength = Math.min(
        processedLengthRef.current,
        next.length
      );
      // 上一条 finalize 后，Paraformer 才把上一句 sentence_end 补上，可能让消费点
      // 后面残留 ". " / "， " 等首字符；统一吃掉，避免 active 气泡显示孤立标点。
      const activeNewTextRaw = next
        .substring(safeProcessedLength)
        .replace(/^[\s.,;:!?。，；：！？]+/, "");
      const activeNewText = smartPunctuateEnglish(activeNewTextRaw, false);
      const safeConfidence = clamp(
        confidence || activeConfidenceRef.current || 0,
        0,
        1
      );

      setActiveEn(activeNewText);
      setActiveConfidence(safeConfidence);
      activeEnRef.current = activeNewText;
      activeConfidenceRef.current = safeConfidence;

      // One-pass speech-translation models (Gummy) stream their own Chinese.
      // When present, drive the live ZH directly from it (un-finalized tail,
      // mirroring the English processedLength logic) and skip the LLM interim
      // translate. Empty/absent translation → keep the LLM fallback path.
      if (translatedText !== undefined) {
        const zhNext = translatedText || "";
        lastTranslatedSessionStringRef.current = zhNext;
        if (zhNext.trim()) asrProvidesTranslationRef.current = true;
        const zhProcessed = Math.min(processedZhLengthRef.current, zhNext.length);
        const activeZhTail = zhNext
          .substring(zhProcessed)
          .replace(/^[\s.,;:!?。，；：！？]+/, "")
          .trim();
        setActiveZh(activeZhTail);
        activeZhRef.current = activeZhTail;
      }

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (activeNewText.trim()) {
        const adaptiveThreshold = getAdaptivePauseThreshold(activeNewText);
        silenceTimerRef.current = setTimeout(() => {
          finalizeCurrentBlock();
        }, adaptiveThreshold);
      }
    },
    [finalizeCurrentBlock]
  );

  // 浏览器最低能力检测：mic / tab 两条路都要 getUserMedia + WebSocket + AudioWorklet
  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      typeof window.WebSocket !== "undefined" &&
      navigator?.mediaDevices?.getUserMedia &&
      typeof window.AudioContext !== "undefined";
    if (!ok) {
      setIsSupported(false);
      setUnsupportedReason("当前浏览器缺少音频或 WebSocket 能力，请使用最新版 Chrome / Edge。");
    }
  }, []);

  // 卸载时确保收尾：停 Paraformer 会话 + 释放系统音频和麦克风资源
  useEffect(() => {
    return () => {
      shouldListenRef.current = false;
      const session = paraformerSessionRef.current;
      paraformerSessionRef.current = null;
      if (session) {
        session.stop().catch(() => {});
      }
      stopSystemAudioCapture();
      stopMicCaptureEnhancer();
    };
  }, [stopMicCaptureEnhancer, stopSystemAudioCapture]);

  const autoSaveCurrentSessionWithSummary = useCallback(async (options = {}) => {
    const {
      showCompletionModal = false,
      sessionDurationSec = 0,
      restartMode = "mic",
    } = options;

    const isAiPolishPending = (item) => {
      if (!item) return false;
      // 占位气泡仍在等 polish 第一波 ZH delta
      if (item.isTranslating) return true;
      // 流式 polish 已开始喷字、但尚未 splice 落定（applyFinalSegments 未跑）
      if (item.isStreamingPolish) return true;
      const speaker = String(item.speaker || "");
      const enText = String(item.en || "");
      // 防止状态不同步：即使两个 flag 都被错置为 false，仍以"识别中" / 残留标签作为未完成信号
      return /识别中/.test(speaker) || /<\/?[^>]+>/.test(enText);
    };

    const updatePolishProgress = () => {
      const current = transcriptsRef.current;
      const total = current.length;
      const done = current.filter((item) => !isAiPolishPending(item)).length;
      setFinalizingProgress({ done, total, phase: "polish" });
      return { done, total };
    };

    const waitForPolishCompletion = async () => {
      // 让最近一次 finalize 的注册和 setState 都先落地
      await new Promise((resolve) => setTimeout(resolve, 120));
      updatePolishProgress();

      // 直接等真实 polish promise 集合，每轮拿一份快照 allSettled。
      // 期间可能有新的 finalize 进队（active 文本被收口），所以要循环到清空。
      // 外层硬上限 3 min 兜底，防止某个 polish promise 永挂。
      const HARD_TIMEOUT_MS = 3 * 60_000;
      const sessionStarted = Date.now();
      let safety = 50;
      while (
        polishPromisesRef.current.size > 0 &&
        Date.now() - sessionStarted < HARD_TIMEOUT_MS &&
        safety-- > 0
      ) {
        const snapshot = [...polishPromisesRef.current];
        updatePolishProgress();
        const remaining = HARD_TIMEOUT_MS - (Date.now() - sessionStarted);
        await Promise.race([
          Promise.allSettled(snapshot),
          new Promise((resolve) => setTimeout(resolve, Math.max(1, remaining))),
        ]);
        // 给 React 一个 tick 让 splice 的 setState 落地，再决定是否还有新增
        await new Promise((resolve) => setTimeout(resolve, 80));
      }

      updatePolishProgress();
      const leftover = polishPromisesRef.current.size;
      if (leftover > 0) {
        console.warn(
          `autoSaveCurrentSessionWithSummary: ${leftover} polish promise(s) still in-flight after ${Math.round(
            HARD_TIMEOUT_MS / 1000
          )}s hard timeout`
        );
      }
    };

    setIsFinalizingSession(true);
    try {
      // 停止瞬间如果还有活动片段，先强制入队等待 AI 润色，避免“先生成纪要后出现识别中块”
      if (activeEnRef.current.trim()) {
        finalizeCurrentBlock();
      }

      // 关键修复：停止后先等所有转录块完成 AI 润色，再生成纪要和切换到“已保存”视图
      await waitForPolishCompletion();

      const latestTranscripts = transcriptsRef.current;
      if (latestTranscripts.length === 0) return;

      const cleaned = latestTranscripts.filter(
        (item) =>
          item &&
          item.en &&
          item.zh &&
          !isAiPolishPending(item) &&
          !item.en.includes("⚠️") &&
          !item.en.includes("🔊") &&
          item.zh !== "..."
      );

      const sessionStats = getSessionStatsFromTranscripts(cleaned);

      if (cleaned.length === 0) {
        await saveSessionToFolder(summaryResult, {
          durationSec: sessionDurationSec,
          mode: restartMode,
        });
        setActiveView("saved");
        if (showCompletionModal) {
          setSessionCompletionModal({
            open: true,
            durationSec: sessionDurationSec,
            transcriptCount: 0,
            enWordCount: 0,
            zhCharCount: 0,
            mode: restartMode,
          });
        }
        return;
      }

      setFinalizingProgress({
        done: cleaned.length,
        total: cleaned.length,
        phase: "summary",
      });

      const fullText = cleaned
        .map(
          (item) => `[${item.speaker || "主讲人"} - 英文]: ${item.en}\n[${item.speaker || "主讲人"} - 中文]: ${item.zh}`
        )
        .join("\n\n");

      let nextSummary = summaryResult || "";
      try {
        nextSummary = await generateSummaryWithAI(fullText);
        setSummaryResult(nextSummary);
      } catch (err) {
        console.warn("自动生成纪要失败，继续保存转录。", err);
        if (!nextSummary) {
          nextSummary = `⚠️ 自动纪要生成失败：${err.message}`;
          setSummaryResult(nextSummary);
        }
      }

      await saveSessionToFolder(nextSummary, {
        durationSec: sessionDurationSec,
        mode: restartMode,
      });
      setActiveView("saved");
      if (showCompletionModal) {
        setSessionCompletionModal({
          open: true,
          durationSec: sessionDurationSec,
          transcriptCount: sessionStats.transcriptCount,
          enWordCount: sessionStats.enWordCount,
          zhCharCount: sessionStats.zhCharCount,
          mode: restartMode,
        });
      }
    } finally {
      setIsFinalizingSession(false);
      setFinalizingProgress({ done: 0, total: 0, phase: "idle" });
      // 本次同传已保存到云端 / 已写入临时列表 → 把首页清空，回首页就是干净下一场的起点。
      // 完整内容仍可在"已保存"视图回看。
      setTranscripts([]);
      setActiveEn("");
      setActiveZh("");
      setActiveConfidence(1);
      activeEnRef.current = "";
      activeZhRef.current = "";
      activeConfidenceRef.current = 1;
      processedLengthRef.current = 0;
      lastSessionStringRef.current = "";
      lastFinalSessionStringRef.current = "";
      lastTranslatedEnRef.current = "";
      setSummaryResult("");
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    }
  }, [
    finalizeCurrentBlock,
    saveSessionToFolder,
    summaryResult,
  ]);

  const stopParaformerSession = useCallback(async () => {
    const session = paraformerSessionRef.current;
    if (!session) return;
    paraformerSessionRef.current = null;
    setLiveTranslateActive(false);
    setAsrStatus("idle");
    setAsrErrorReason("");
    try {
      await session.stop();
    } catch (e) {
      console.warn("Paraformer stop error:", e);
    }
  }, []);

  // 创建并启动一个 Paraformer 会话，把它绑到 paraformerSessionRef 上。
  // tab / mic 两个入口共用，确保会话生命周期与 onUpdate 路径一致。
  const startParaformerForMode = useCallback(
    async (audioTrack, mode) => {
      // 复位 session 累计标记，避免和上一次会话的 processedLength 串起来
      processedLengthRef.current = 0;
      lastSessionStringRef.current = "";
      lastFinalSessionStringRef.current = "";
      processedZhLengthRef.current = 0;
      lastTranslatedSessionStringRef.current = "";
      asrProvidesTranslationRef.current = false;

      setAsrStatus("connecting");
      setAsrErrorReason("");

      const useLiveTranslate = isLiveTranslateModel(runtimeAsrModelName);

      // 转录增量回调：两种会话共用。translatedText 仅在一体化翻译（livetranslate/Gummy）
      // 时出现；出现即由 applyTranscriptUpdate 直接驱动中文并跳过 LLM 实时翻译。
      const onUpdate = ({ fullText, finalText, confidence, translatedText }) => {
        applyTranscriptUpdate({ fullText, finalText, confidence, translatedText });
      };
      const onStatus = ({ phase, attempt, reason }) => {
        if (phase === "started") {
          setAsrStatus("live");
          setAsrErrorReason("");
        }
        if (phase === "reconnecting") {
          setAsrStatus("connecting");
          // Planned rotation / DashScope task-finished are part of the normal
          // long-session cycle. Update the pipeline pill briefly but don't pop
          // a toast — only true anomalies warrant one.
          const isQuietRecovery =
            reason === "rotation" ||
            reason === "task-finished" ||
            reason === "audio-toggle";
          if (!isQuietRecovery) {
            pushToast({
              level: "warn",
              text: `识别连接中断，正在自动重连 (${attempt}/${3})…`,
              ttl: 4000,
            });
          }
        }
      };
      const onError = (err) => {
        console.error("ASR error:", err);
        const label = mode === "tab" ? "系统音频识别" : "麦克风识别";
        const reason = err && err.message ? err.message : String(err);
        setAsrStatus("error");
        setAsrErrorReason(reason);
        pushToast({ level: "error", text: `${label}异常：${reason}`, ttl: 7000 });
      };

      // Defer rotation while user is mid-utterance; the session waits for this
      // "safe window" (true) before swapping the pipeline, with a hard ceiling.
      const canRotateNow = () => !activeEnRef.current.trim();

      const session = useLiveTranslate
        ? new LiveTranslateSession({
            wsUrl: buildRealtimeWsUrl(runtimeAsrModelName),
            audioTrack,
            model: runtimeAsrModelName,
            sourceLang: "en",
            target: "zh",
            audioOutput: playTranslationAudioRef.current,
            canRotateNow,
            onUpdate,
            onStatus,
            onError,
          })
        : new ParaformerSession({
            wsUrl: PARAFORMER_WS_URL,
            audioTrack,
            languageHints: ["en"],
            model: runtimeAsrModelName,
            // 热词偏置（vocabulary_id）目前是 Paraformer 独有功能；切到其他系列时不要带
            vocabularyId: isParaformerFamilyModel(runtimeAsrModelName)
              ? getStoredVocabularyId() || undefined
              : undefined,
            canRotateNow,
            onUpdate,
            onStatus,
            onError,
          });
      setLiveTranslateActive(useLiveTranslate);
      paraformerSessionRef.current = session;

      try {
        await session.start();
        return session;
      } catch (err) {
        setAsrStatus("error");
        setAsrErrorReason(err && err.message ? err.message : String(err));
        await stopParaformerSession();
        throw err;
      }
    },
    [applyTranscriptUpdate, pushToast, stopParaformerSession]
  );

  const stopTabMode = useCallback(async () => {
    const stopDurationSec = recordingTime;
    shouldListenRef.current = false;

    // End the session immediately so the header timer stops and Pause / Stop
    // revert to idle; the summary + save run afterwards via autoSave.
    setListeningMode("none");
    setIsPaused(false);
    isPausedRef.current = false;

    // 与麦克风模式保持一致：停止时先收口当前活跃片段
    if (activeEnRef.current.trim()) {
      finalizeCurrentBlock();
    }

    await stopParaformerSession();
    stopSystemAudioCapture();

    if (transcriptsRef.current.length > 0 || activeEnRef.current.trim()) {
      await autoSaveCurrentSessionWithSummary({
        showCompletionModal: true,
        sessionDurationSec: stopDurationSec,
        restartMode: "tab",
      });
    }

    // 复位 mic 模式恢复时需要的 session 累计标记
    processedLengthRef.current = 0;
    lastSessionStringRef.current = "";
    lastFinalSessionStringRef.current = "";
  }, [
    autoSaveCurrentSessionWithSummary,
    finalizeCurrentBlock,
    recordingTime,
    stopParaformerSession,
    stopSystemAudioCapture,
  ]);

  const startTabMode = useCallback(async () => {
    if (!currentFolderIdRef.current) {
      pushToast({ level: "warn", text: "请先在顶部选择或新建一个文件夹，再开始录音。", ttl: 4000 });
      return;
    }
    if (!navigator?.mediaDevices?.getDisplayMedia) {
      alert("当前浏览器不支持系统音频采集，请升级 Chrome/Edge。\n建议改用麦克风模式。");
      return;
    }

    if (!PARAFORMER_WS_URL) {
      alert(
        "未配置 Paraformer WebSocket 中继地址。\n请设置环境变量 REACT_APP_PARAFORMER_WS_URL 后重新部署，或先暂用麦克风模式。"
      );
      return;
    }

    try {
      if (listeningMode === "mic") {
        shouldListenRef.current = false;
        await stopParaformerSession();
        stopMicCaptureEnhancer();
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach((track) => track.stop());
        alert("未检测到系统音频轨道，请在弹窗中选择“Chrome 标签页”或“窗口”并勾选共享音频。");
        return;
      }

      audioTrack.onended = () => {
        if (shouldListenRef.current && targetModeRef.current === "tab") {
          stopTabMode();
        }
      };

      systemAudioStreamRef.current = stream;
      systemAudioTrackRef.current = audioTrack;

      targetModeRef.current = "tab";
      shouldListenRef.current = true;
      setRecordingTime(0);
      setIsAutoScroll(true);
      setActiveView("home");

      try {
        await startParaformerForMode(audioTrack, "tab");
      } catch (err) {
        console.error("Paraformer 启动失败:", err);
        stopSystemAudioCapture();
        shouldListenRef.current = false;
        targetModeRef.current = "mic";
        setListeningMode("none");
        alert(
          `Paraformer 系统音频识别启动失败：${err && err.message ? err.message : err}\n请检查中继 Worker 与 DASHSCOPE_API_KEY 是否就绪。`
        );
        return;
      }

      setListeningMode("tab");
      setIsPaused(false);
      isPausedRef.current = false;
      setErrorMsg("");
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("系统音频模式启动失败:", err);
        setErrorMsg("启动系统音频模式失败，请重试。");
      }
    }
  }, [
    listeningMode,
    setErrorMsg,
    startParaformerForMode,
    stopMicCaptureEnhancer,
    stopParaformerSession,
    stopSystemAudioCapture,
    stopTabMode,
  ]);

  const togglePip = async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }

    if (!("documentPictureInPicture" in window)) {
      alert(
        "您的浏览器不支持原生的文档悬浮窗功能。请尝试使用最新版 Chrome 或 Edge 浏览器。"
      );
      return;
    }

    try {
      const pip = await window.documentPictureInPicture.requestWindow({
        width: 800,
        height: 400,
      });

      const style = pip.document.createElement("style");
      style.textContent = `
        :root {
          --pip-bg: #06080F;
          --pip-text-1: #f1f5f9;
          --pip-text-2: #cbd5e1;
          --pip-text-3: #94a3b8;
          --pip-text-4: #64748b;
          --pip-card-bg: rgba(15, 23, 42, 0.55);
          --pip-border: rgba(255, 255, 255, 0.08);
          --pip-border-strong: rgba(255, 255, 255, 0.16);
          --pip-accent: #a5b4fc;
        }
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          padding: 0;
          background: var(--pip-bg);
          color: var(--pip-text-1);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
          -webkit-font-smoothing: antialiased;
          overflow: hidden;
        }
        body {
          background-image:
            radial-gradient(800px circle at 8% -10%, rgba(99, 102, 241, 0.18), transparent 55%),
            radial-gradient(700px circle at 100% 110%, rgba(56, 189, 248, 0.10), transparent 60%);
          background-attachment: fixed;
        }
        #pip-mount { height: 100vh; overflow: hidden; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.30); }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .5; }
        }
        @keyframes pip-active-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        @keyframes pip-cursor-blink {
          0%, 60% { opacity: 1; }
          61%, 100% { opacity: 0; }
        }
        @keyframes pip-stream-fade {
          from { opacity: 0; filter: blur(2px); }
          to { opacity: 1; filter: blur(0); }
        }
        .pip-stream-cursor {
          display: inline-block;
          width: 2px;
          height: 1em;
          vertical-align: -0.15em;
          margin-left: 4px;
          background-color: currentColor;
          border-radius: 1px;
          animation: pip-cursor-blink 0.9s infinite;
        }
        .pip-card-active::before {
          content: '';
          position: absolute;
          inset: 0 0 auto 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(165,180,252,0.85), transparent);
          background-size: 200% 100%;
          animation: pip-active-sweep 2.5s linear infinite;
          pointer-events: none;
        }
      `;
      pip.document.head.appendChild(style);

      const mount = pip.document.createElement("div");
      mount.id = "pip-mount";
      pip.document.body.appendChild(mount);

      pip.addEventListener("pagehide", () => {
        setPipWindow(null);
      });

      setPipWindow(pip);
    } catch (error) {
      console.error("打开悬浮窗失败:", error);
      alert("开启悬浮窗失败。");
    }
  };


  // --------------------------------------------------------------------------
  // 主页面智能滚屏逻辑 (Smart Auto-Scroll)
  // --------------------------------------------------------------------------
  const handleMainScroll = () => {
    if (!mainRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = mainRef.current;
    // 如果用户距离底部小于 100px，则视为在最底部，允许自动滚屏
    setIsAutoScroll(scrollHeight - scrollTop - clientHeight < 100);
  };

  useEffect(() => {
    // 只有在开启了自动滚屏时，才将页面拽到底部
    if (isAutoScroll && scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcripts, activeEn, activeZh, isAutoScroll]);

  const toggleMicMode = async () => {
    if (listeningMode !== "mic" && !currentFolderIdRef.current) {
      pushToast({ level: "warn", text: "请先在顶部选择或新建一个文件夹，再开始录音。", ttl: 4000 });
      return;
    }
    if (listeningMode === "mic") {
      const stopDurationSec = recordingTime;
      shouldListenRef.current = false;

      // End the recording session immediately so the header timer stops and the
      // Pause / Stop buttons revert to the idle state — regardless of whether we
      // were paused. (Summary + save then run in the background via autoSave.)
      setListeningMode("none");
      setIsPaused(false);
      isPausedRef.current = false;

      await stopParaformerSession();
      stopMicCaptureEnhancer();

      if (activeEnRef.current.trim()) finalizeCurrentBlock();

      if (transcriptsRef.current.length > 0 || activeEnRef.current.trim()) {
        await autoSaveCurrentSessionWithSummary({
          showCompletionModal: true,
          sessionDurationSec: stopDurationSec,
          restartMode: "mic",
        });
      }
    } else {
      if (listeningMode === "tab") await stopTabMode();

      if (!PARAFORMER_WS_URL) {
        alert(
          "未配置 Paraformer WebSocket 中继地址。\n请设置环境变量 REACT_APP_PARAFORMER_WS_URL 后重新部署。"
        );
        return;
      }

      const enhancedTrack = await prepareEnhancedMicCapture(selectedDeviceId);
      if (!enhancedTrack) {
        setErrorMsg("无法获取麦克风音频，请检查浏览器权限或换一个输入设备。");
        return;
      }

      targetModeRef.current = "mic";
      shouldListenRef.current = true;
      setActiveView("home");
      setRecordingTime(0);
      setIsAutoScroll(true);

      try {
        await startParaformerForMode(enhancedTrack, "mic");
      } catch (err) {
        console.error("Paraformer 启动失败:", err);
        stopMicCaptureEnhancer();
        shouldListenRef.current = false;
        setListeningMode("none");
        alert(
          `Paraformer 麦克风识别启动失败：${err && err.message ? err.message : err}\n请检查中继 Worker 与 DASHSCOPE_API_KEY 是否就绪。`
        );
        return;
      }

      setListeningMode("mic");
      setIsPaused(false);
      isPausedRef.current = false;
      setErrorMsg("");
    }
  };

  const handleStartNextRecording = async () => {
    const nextMode = sessionCompletionModal.mode || "mic";
    setSessionCompletionModal((prev) => ({ ...prev, open: false }));
    clearTranscripts();
    setSummaryResult("");
    setActiveView("home");
    setRecordingTime(0);

    if (nextMode === "tab") {
      await startTabMode();
      return;
    }

    await toggleMicMode();
  };

  const togglePause = () => {
    if (isPaused) {
      setIsPaused(false);
      isPausedRef.current = false;
      paraformerSessionRef.current?.resume();
    } else {
      setIsPaused(true);
      isPausedRef.current = true;
      // 暂停只挂起音频上行；Paraformer 会话保持打开，避免重复 task-started。
      paraformerSessionRef.current?.pause();
    }
  };

  // ---- 全局快捷键 ---------------------------------------------------------
  // 用 ref 拿最新闭包，避免每次重新绑定 listener
  const shortcutHandlersRef = useRef({});
  shortcutHandlersRef.current = {
    listeningMode,
    isFinalizingSession,
    togglePause,
    toggleMicMode,
    startTabMode,
    stopTabMode,
  };

  useEffect(() => {
    const isFromInput = (target) => {
      if (!target) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    };

    const onKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isFromInput(e.target)) return;

      const h = shortcutHandlersRef.current;
      if (h.isFinalizingSession) return; // 收尾期间快捷键全部冻结

      switch (e.code) {
        case "Space": {
          if (h.listeningMode === "none") return;
          e.preventDefault();
          h.togglePause();
          break;
        }
        case "KeyM": {
          e.preventDefault();
          h.toggleMicMode();
          break;
        }
        case "KeyT": {
          e.preventDefault();
          if (h.listeningMode === "tab") h.stopTabMode();
          else h.startTabMode();
          break;
        }
        case "Escape": {
          if (h.listeningMode === "none") return;
          e.preventDefault();
          if (h.listeningMode === "mic") h.toggleMicMode();
          else if (h.listeningMode === "tab") h.stopTabMode();
          break;
        }
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const clearTranscripts = () => {
    setTranscripts([]);
    setActiveEn("");
    setActiveZh("");
  setActiveConfidence(1);
    activeEnRef.current = "";
    activeZhRef.current = "";
  activeConfidenceRef.current = 1;
    processedLengthRef.current = 0;
    lastSessionStringRef.current = "";
    lastFinalSessionStringRef.current = "";
    lastTranslatedEnRef.current = "";
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    // Also discard the ASR session's accumulated transcript, otherwise the next
    // recognized speech replays the cleared bubbles and continues from their end.
    paraformerSessionRef.current?.resetTranscript();
  };

  const openGlossaryModal = () => {
    setGlossaryError("");
    setGlossaryDraft(
      customGlossaryPairs.map((item) => `${item.from} => ${item.to}`).join("\n")
    );
    setActiveView("glossary");
  };

  const handleSaveGlossary = () => {
    const result = parseGlossaryDraft(glossaryDraft);
    if (result.error) {
      setGlossaryError(result.error);
      return;
    }

    const nextPairs = result.pairs;
    setCustomGlossaryPairs(nextPairs);
    setRuntimeCustomGlossaryPairs(nextPairs);
    window.localStorage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(nextPairs));
    setGlossaryError("");
    setActiveView("home");

    // 后台异步把术语同步成 Paraformer 热词词典；本地正则纠错已立刻生效，
    // 这一步影响下一次 ASR 会话的声学层偏置。
    syncGlossaryToParaformerVocabulary(nextPairs)
      .then((res) => {
        if (res?.changed) {
          pushToast({
            level: "success",
            text: res.vocabularyId
              ? "热词词典已同步到 Paraformer，下次开启同传即生效。"
              : "热词词典已清空。",
          });
        }
      })
      .catch((err) => {
        console.warn("vocabulary sync failed:", err);
        pushToast({
          level: "warn",
          text: `热词同步到 Paraformer 失败：${err.message}（本地纠错已生效，可稍后重试）`,
          ttl: 7000,
        });
      });
  };

  const handleSaveAdminSettings = async () => {
    setSavingModelConfig(true);
    setModelSuccessMsg("");
    try {
      await updateSettings({
        aiModelName: modelDraft.trim(),
        realtimeModelName: realtimeModelDraft.trim(),
        summaryModelName: summaryModelDraft.trim(),
        asrModelName: asrModelDraft.trim(),
      });
      setModelSuccessMsg("✅ 模型配置已保存，全站立即生效。");
    } catch (err) {
      setModelSuccessMsg(`❌ 保存失败：${err && err.message ? err.message : err}`);
    } finally {
      setSavingModelConfig(false);
    }
  };

  const handleClearGlossary = () => {
    setCustomGlossaryPairs([]);
    setRuntimeCustomGlossaryPairs([]);
    setGlossaryDraft("");
    setGlossaryError("");
    window.localStorage.removeItem(GLOSSARY_STORAGE_KEY);

    syncGlossaryToParaformerVocabulary([]).catch((err) => {
      console.warn("vocabulary clear failed:", err);
    });
  };

  const openSavedSessions = async () => {
    setOpenFolderId(null);
    const loaded = await loadSavedSessionsFromFolder();
    setSelectedSavedSession((prev) => {
      if (prev) {
        return loaded.find((session) => session.fileName === prev.fileName) || prev;
      }
      return loaded[0] || allSavedSessions[0] || null;
    });
    setActiveView("saved");
  };

  const selectSavedSession = useCallback(
    async (session) => {
      if (!session) return;
      setSelectedSavedSession(session);
      if (session.isTemporary || !session.id) return;

      try {
        const fullSession = await cloudGetSession(session.id);
        if (fullSession) setSelectedSavedSession(fullSession);
      } catch (err) {
        console.error("加载云端会话详情失败:", err);
        pushToast({ level: "error", text: "加载会话详情失败，请重试", ttl: 5000 });
      }
    },
    [cloudGetSession, pushToast]
  );

  const formatSessionToHtml = useCallback((session) => {
    const summaryMarkdownHtml = renderMarkdownToSafeHtml(session?.summary || "（该会话未保存纪要）");
    const transcriptHtml = (session?.transcripts || [])
      .map(
        (item) => `
          <div style="margin-bottom:16px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;">
            <div style="font-size:12px;color:#64748b;font-weight:bold;margin-bottom:6px;">${escapeHtml(item.speaker || "👩‍🏫 主讲人")}</div>
            <div style="font-size:14px;color:#475569;line-height:1.6;">${escapeHtml(item.en || "")}</div>
            <div style="font-size:16px;color:#0f172a;line-height:1.7;font-weight:bold;margin-top:8px;">${escapeHtml(item.zh || "")}</div>
          </div>
        `
      )
      .join("");

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(session?.title || "课堂同传记录")}</title>
        <style>
          .markdown-summary { line-height: 1.8; color: #334155; }
          .markdown-summary h1, .markdown-summary h2, .markdown-summary h3, .markdown-summary h4, .markdown-summary h5, .markdown-summary h6 { color: #0f172a; margin: 12px 0 8px; font-weight: 700; }
          .markdown-summary h1 { font-size: 24px; }
          .markdown-summary h2 { font-size: 20px; }
          .markdown-summary h3 { font-size: 18px; }
          .markdown-summary p { margin: 8px 0; }
          .markdown-summary ul, .markdown-summary ol { margin: 8px 0 8px 20px; }
          .markdown-summary li { margin: 4px 0; }
          .markdown-summary blockquote { margin: 10px 0; padding: 8px 12px; border-left: 3px solid #a5b4fc; background: #f8fafc; color: #475569; }
          .markdown-summary code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #e2e8f0; padding: 2px 5px; border-radius: 4px; }
          .markdown-summary pre { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow: auto; }
          .markdown-summary pre code { background: transparent; padding: 0; color: inherit; }
          .markdown-summary hr { border: 0; border-top: 1px solid #cbd5e1; margin: 14px 0; }
          .markdown-summary a { color: #4f46e5; text-decoration: none; }
        </style>
      </head>
      <body style="font-family:'Microsoft YaHei','PingFang SC',sans-serif;line-height:1.7;color:#1e293b;">
        <h1 style="text-align:center;">${escapeHtml(session?.title || "课堂同传记录")}</h1>
        <p style="text-align:center;color:#64748b;">${escapeHtml(new Date(session?.createdAt || Date.now()).toLocaleString())}</p>
        <hr />
        <h2>课堂纪要</h2>
        <div class="markdown-summary" style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:14px;">
          ${summaryMarkdownHtml}
        </div>
        <h2 style="margin-top:24px;">转录内容</h2>
        ${transcriptHtml || "<p>（该会话暂无转录内容）</p>"}
      </body>
      </html>
    `;
  }, []);

  const exportSavedSessionToWord = useCallback((session) => {
    if (!session) return;
    const htmlContent = formatSessionToHtml(session);
    const blob = new Blob(["\ufeff", htmlContent], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(session.title, "classtrans_session")}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [formatSessionToHtml]);

  const exportSavedSessionToPdf = useCallback((session) => {
    if (!session) return;
    const printWindow = window.open("", "_blank", "noopener,noreferrer,width=980,height=760");
    if (!printWindow) {
      alert("浏览器阻止了新窗口，请允许弹窗后重试导出 PDF。");
      return;
    }

    printWindow.document.write(formatSessionToHtml(session));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      try {
        printWindow.print();
      } catch (e) {
        console.error("打印窗口失败:", e);
      }
    }, 300);
  }, [formatSessionToHtml]);

  // 重置编辑状态当切换到不同会话
  useEffect(() => {
    setTitleDraft(null);
  }, [selectedSavedSession?.fileName]);

  const handleRenameSavedSession = useCallback(
    async (session, rawTitle) => {
      const newTitle = String(rawTitle || "").trim();
      if (!session || !newTitle || newTitle === session.title) {
        setTitleDraft(null);
        return;
      }

      // 临时会话只在内存里改
      if (session.isTemporary) {
        setTemporarySessions((prev) =>
          prev.map((s) =>
            s.fileName === session.fileName ? { ...s, title: newTitle } : s
          )
        );
        setSelectedSavedSession((prev) =>
          prev && prev.fileName === session.fileName
            ? { ...prev, title: newTitle }
            : prev
        );
        setTitleDraft(null);
        pushToast({ level: "success", text: "会话标题已更新", ttl: 2500 });
        return;
      }

      try {
        const { error } = await cloudUpdateSession(session.id, { title: newTitle });
        if (error) throw error;
        patchSelectedSavedSession(session.fileName, { title: newTitle });
        pushToast({ level: "success", text: "会话标题已更新", ttl: 2500 });
      } catch (err) {
        console.error("重命名会话失败:", err);
        pushToast({
          level: "error",
          text: `重命名失败：${err && err.message ? err.message : err}`,
          ttl: 5000,
        });
      } finally {
        setTitleDraft(null);
      }
    },
    [cloudUpdateSession, patchSelectedSavedSession, pushToast]
  );

  // ---- 单词级修正：点词→弹小窗→替换+可选加入词典 ----------------------
  const openWordEditPopover = useCallback((event, payload) => {
    const target = event && event.currentTarget;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.bottom + 6;
    setWordEditPopover({
      x,
      y,
      originalWord: payload.originalWord,
      draft: payload.originalWord,
      scope: payload.scope,
      payload,
    });
  }, []);

  const closeWordEditPopover = useCallback(() => {
    setWordEditPopover(null);
  }, []);

  const applyWordReplacementInLive = useCallback((bubbleId, wordIdx, newWord) => {
    setTranscripts((prev) =>
      prev.map((item) =>
        item.id === bubbleId
          ? { ...item, en: replaceWordAt(item.en, wordIdx, newWord) }
          : item
      )
    );
  }, []);

  const applyWordReplacementInSaved = useCallback(
    async (session, bubbleIdx, wordIdx, newWord) => {
      if (!session) return;

      // 临时会话：仅改内存
      if (session.isTemporary) {
        const newTranscripts = (session.transcripts || []).map((item, idx) =>
          idx === bubbleIdx
            ? { ...item, en: replaceWordAt(item.en, wordIdx, newWord) }
            : item
        );
        setTemporarySessions((prev) =>
          prev.map((s) =>
            s.fileName === session.fileName
              ? { ...s, transcripts: newTranscripts }
              : s
          )
        );
        setSelectedSavedSession((prev) =>
          prev && prev.fileName === session.fileName
            ? { ...prev, transcripts: newTranscripts }
            : prev
        );
        return;
      }

      try {
        const currentTranscripts = Array.isArray(session.transcripts)
          ? session.transcripts
          : [];
        const target = currentTranscripts[bubbleIdx];
        if (!target?.id) throw new Error("会话转录缺少云端 ID");

        const nextEn = replaceWordAt(target.en, wordIdx, newWord);
        const nextTranscripts = currentTranscripts.map((item, idx) =>
          idx === bubbleIdx ? { ...item, en: nextEn } : item
        );
        const { error } = await cloudUpdateTranscript(target.id, { en: nextEn });
        if (error) throw error;
        patchSelectedSavedSession(session.fileName, { transcripts: nextTranscripts });
      } catch (err) {
        console.error("保存修正失败:", err);
        pushToast({
          level: "error",
          text: `保存修正失败：${err && err.message ? err.message : err}`,
          ttl: 5000,
        });
      }
    },
    [cloudUpdateTranscript, patchSelectedSavedSession, pushToast]
  );

  const addCorrectionToGlossary = useCallback(
    (originalWord, newWord) => {
      const from = String(originalWord || "").trim();
      const to = String(newWord || "").trim();
      if (!from || !to || from === to) return;

      const lowerFrom = from.toLowerCase();
      const existingIdx = customGlossaryPairs.findIndex(
        (p) => String(p.from || "").toLowerCase() === lowerFrom
      );
      const nextPairs =
        existingIdx >= 0
          ? customGlossaryPairs.map((p, i) =>
              i === existingIdx ? { from: p.from, to } : p
            )
          : [...customGlossaryPairs, { from, to }];

      setCustomGlossaryPairs(nextPairs);
      setRuntimeCustomGlossaryPairs(nextPairs);
      try {
        window.localStorage.setItem(
          GLOSSARY_STORAGE_KEY,
          JSON.stringify(nextPairs)
        );
      } catch (e) {}
      setGlossaryDraft(
        nextPairs.map((item) => `${item.from} => ${item.to}`).join("\n")
      );
      // 后台异步同步到 Paraformer 热词词典；失败不阻塞用户。
      syncGlossaryToParaformerVocabulary(nextPairs).catch((err) => {
        console.warn("vocabulary sync failed:", err);
      });
    },
    [customGlossaryPairs]
  );

  const commitWordEdit = useCallback(
    (alsoAddToGlossary) => {
      if (!wordEditPopover) return;
      const newWord = String(wordEditPopover.draft || "").trim();
      const original = wordEditPopover.originalWord;
      if (!newWord || newWord === original) {
        closeWordEditPopover();
        return;
      }

      const { scope, payload } = wordEditPopover;
      if (scope === "live") {
        applyWordReplacementInLive(payload.bubbleId, payload.wordIdx, newWord);
      } else if (scope === "saved") {
        // fire and forget; toast on failure
        applyWordReplacementInSaved(
          payload.session,
          payload.bubbleIdx,
          payload.wordIdx,
          newWord
        );
      }

      if (alsoAddToGlossary) {
        addCorrectionToGlossary(original, newWord);
        pushToast({
          level: "success",
          text: `已替换并加入词典：${original} → ${newWord}`,
          ttl: 3500,
        });
      } else {
        pushToast({
          level: "info",
          text: `已替换：${original} → ${newWord}`,
          ttl: 2500,
        });
      }

      closeWordEditPopover();
    },
    [
      wordEditPopover,
      closeWordEditPopover,
      applyWordReplacementInLive,
      applyWordReplacementInSaved,
      addCorrectionToGlossary,
      pushToast,
    ]
  );

  // ---- 整气泡编辑：用户点笔→中英文都进 textarea，自由改 -----------------
  const openBubbleEditor = useCallback((scope, payload, en, zh) => {
    const key =
      scope === "live"
        ? `live-${payload.bubbleId}`
        : `saved-${payload.session?.fileName || "?"}-${payload.bubbleIdx}`;
    setBubbleEditDraft({
      scope,
      key,
      payload,
      enDraft: String(en || ""),
      zhDraft: String(zh || ""),
    });
  }, []);

  const closeBubbleEditor = useCallback(() => {
    setBubbleEditDraft(null);
  }, []);

  const saveBubbleEdit = useCallback(async () => {
    if (!bubbleEditDraft) return;
    const newEn = String(bubbleEditDraft.enDraft || "").trim();
    const newZh = String(bubbleEditDraft.zhDraft || "").trim();
    if (!newEn && !newZh) {
      pushToast({ level: "warn", text: "中英文不能都为空", ttl: 3000 });
      return;
    }

    if (bubbleEditDraft.scope === "live") {
      setTranscripts((prev) =>
        prev.map((item) =>
          item.id === bubbleEditDraft.payload.bubbleId
            ? { ...item, en: newEn, zh: newZh }
            : item
        )
      );
      setBubbleEditDraft(null);
      pushToast({ level: "success", text: "气泡内容已更新", ttl: 2500 });
      return;
    }

    // scope === "saved"
    const { session, bubbleIdx } = bubbleEditDraft.payload;
    if (!session) {
      setBubbleEditDraft(null);
      return;
    }

    if (session.isTemporary) {
      const newTranscripts = (session.transcripts || []).map((t, i) =>
        i === bubbleIdx ? { ...t, en: newEn, zh: newZh } : t
      );
      setTemporarySessions((prev) =>
        prev.map((s) =>
          s.fileName === session.fileName
            ? { ...s, transcripts: newTranscripts }
            : s
        )
      );
      setSelectedSavedSession((prev) =>
        prev && prev.fileName === session.fileName
          ? { ...prev, transcripts: newTranscripts }
          : prev
      );
      setBubbleEditDraft(null);
      pushToast({ level: "success", text: "气泡内容已更新", ttl: 2500 });
      return;
    }

    try {
      const currentTranscripts = Array.isArray(session.transcripts)
        ? session.transcripts
        : [];
      const target = currentTranscripts[bubbleIdx];
      if (!target?.id) throw new Error("会话转录缺少云端 ID");

      const nextTranscripts = currentTranscripts.map((item, idx) =>
        idx === bubbleIdx
          ? {
              ...item,
              en: newEn,
              zh: newZh,
            }
          : item
      );
      const { error } = await cloudUpdateTranscript(target.id, {
        en: newEn,
        zh: newZh,
      });
      if (error) throw error;

      patchSelectedSavedSession(session.fileName, { transcripts: nextTranscripts });
      setBubbleEditDraft(null);
      pushToast({ level: "success", text: "气泡内容已更新", ttl: 2500 });
    } catch (err) {
      console.error("保存编辑失败:", err);
      pushToast({
        level: "error",
        text: `保存失败：${err && err.message ? err.message : err}`,
        ttl: 5000,
      });
    }
  }, [bubbleEditDraft, cloudUpdateTranscript, patchSelectedSavedSession, pushToast]);

  // ---- 已保存会话：重新生成课堂纪要 ------------------------------------
  const handleRegenerateSummary = useCallback(
    async (session) => {
      if (!session) return;
      const transcripts = Array.isArray(session.transcripts) ? session.transcripts : [];
      if (transcripts.length === 0) {
        pushToast({ level: "warn", text: "该会话没有转录内容，无法生成纪要", ttl: 3000 });
        return;
      }

      setIsRegeneratingSummary(true);
      try {
        const fullText = transcripts
          .map(
            (item) =>
              `[${item.speaker || "主讲人"} - 英文]: ${item.en}\n[${item.speaker || "主讲人"} - 中文]: ${item.zh}`
          )
          .join("\n\n");

        const newSummary = await generateSummaryWithAI(fullText);

        if (session.isTemporary) {
          setTemporarySessions((prev) =>
            prev.map((s) =>
              s.fileName === session.fileName ? { ...s, summary: newSummary } : s
            )
          );
          setSelectedSavedSession((prev) =>
            prev && prev.fileName === session.fileName
              ? { ...prev, summary: newSummary }
              : prev
          );
          pushToast({ level: "success", text: "课堂纪要已重新生成", ttl: 3000 });
          return;
        }

        const { error } = await cloudUpdateSession(session.id, { summary: newSummary });
        if (error) throw error;
        patchSelectedSavedSession(session.fileName, { summary: newSummary });

        pushToast({ level: "success", text: "课堂纪要已重新生成并保存到云端", ttl: 3000 });
      } catch (err) {
        console.error("重新生成纪要失败:", err);
        pushToast({
          level: "error",
          text: err && err.message ? err.message : `生成纪要失败：${err}`,
          ttl: 7000,
        });
      } finally {
        setIsRegeneratingSummary(false);
      }
    },
    [cloudUpdateSession, patchSelectedSavedSession, pushToast]
  );

  // 对历史会话中"未精调"的单条气泡触发 AI 精调；用法与 finalize 阶段一致：
  // - 取相邻 ≤2 条已成型转录作为术语 / 代词上下文
  // - 调用 polishWithAI 取得新的 segments
  // - 走同一套 evaluateAiPolishQuality 质量门控；不通过则保留原文
  // - 通过则用新 segments 在原位置 splice（AI 可能按说话人切分成多条）
  // - 临时会话仅改内存；云端会话写回 Supabase
  const polishSavedBubble = useCallback(
    async (session, bubbleIdx) => {
      if (!session) return;
      const transcripts = Array.isArray(session.transcripts) ? session.transcripts : [];
      const target = transcripts[bubbleIdx];
      if (!target) return;
      if (!isSavedBubbleUnpolished(target)) return;

      const rawEn = String(target.en || "").trim();
      if (!rawEn) {
        pushToast({ level: "warn", text: "该气泡没有英文内容，无法精调", ttl: 3000 });
        return;
      }

      const key = `${session.fileName}::${bubbleIdx}`;
      if (polishingSavedKeys.has(key)) return;

      setPolishingSavedKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });

      try {
        const contextHistory = transcripts
          .slice(0, bubbleIdx)
          .filter((t) => t && t.en && t.zh && t.zh !== "...")
          .slice(-2)
          .map((t) => ({ en: t.en, zh: t.zh }));

        const aiSegments = await polishWithAI(rawEn, { contextHistory });

        const qualityCheck = evaluateAiPolishQuality({
          rawEn,
          aiSegments,
          basicZh: String(target.zh || ""),
        });

        if (!qualityCheck.ok) {
          console.warn("AI polish quality gate fallback:", qualityCheck.reason);
          pushToast({
            level: "warn",
            text: "AI 精调结果未通过质量门控，已保留原文。",
            ttl: 5000,
          });
          return;
        }

        const baseId = target.id || `${session.fileName}-${bubbleIdx}`;
        const newItems = aiSegments.map((seg, idx) => ({
          id: `${baseId}-polish-${idx}`,
          speaker: seg.speaker || "👩‍🏫 主讲人",
          en: smartPunctuateEnglish(seg.en || rawEn, true),
          zh: seg.zh || target.zh,
          isPolished: true,
        }));

        const buildNextTranscripts = (current) => {
          const arr = Array.isArray(current) ? [...current] : [];
          if (!arr[bubbleIdx]) return arr;
          arr.splice(bubbleIdx, 1, ...newItems);
          return arr;
        };

        if (session.isTemporary) {
          setTemporarySessions((prev) =>
            prev.map((s) =>
              s.fileName === session.fileName
                ? { ...s, transcripts: buildNextTranscripts(s.transcripts) }
                : s
            )
          );
          setSelectedSavedSession((prev) =>
            prev && prev.fileName === session.fileName
              ? { ...prev, transcripts: buildNextTranscripts(prev.transcripts) }
              : prev
          );
          pushToast({ level: "success", text: "AI 精调完成", ttl: 2500 });
          return;
        }

        const nextTranscripts = buildNextTranscripts(transcripts);
        const { data, error } = await cloudReplaceTranscripts(session.id, nextTranscripts);
        if (error) throw error;
        patchSelectedSavedSession(session.fileName, {
          transcripts: data || nextTranscripts,
        });

        pushToast({ level: "success", text: "AI 精调完成并已保存到云端", ttl: 3000 });
      } catch (err) {
        console.error("AI 精调失败:", err);
        pushToast({
          level: "error",
          text: `AI 精调失败：${err && err.message ? err.message : err}`,
          ttl: 7000,
        });
      } finally {
        setPolishingSavedKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [cloudReplaceTranscripts, patchSelectedSavedSession, polishingSavedKeys, pushToast]
  );

  // 关闭 popover：点其他地方 / 滚动 / Esc
  useEffect(() => {
    if (!wordEditPopover) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeWordEditPopover();
    };
    const onScroll = () => closeWordEditPopover();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [wordEditPopover, closeWordEditPopover]);

  const handleDeleteSavedSession = useCallback(
    async (session) => {
      if (!session) return;

      if (session.isTemporary) {
        const shouldDeleteTemp = window.confirm("确认删除这条临时会话？");
        if (!shouldDeleteTemp) return;
        setTemporarySessions((prev) =>
          prev.filter((item) => item.fileName !== session.fileName)
        );
        if (selectedSavedSession?.fileName === session.fileName) {
          setSelectedSavedSession(null);
        }
        return;
      }

      const shouldDelete = window.confirm(`确认删除会话：${session.title || "未命名会话"}？此操作不可恢复。`);
      if (!shouldDelete) return;

      try {
        const { error } = await cloudDeleteSession(session.id);
        if (error) throw error;
        if (selectedSavedSession?.fileName === session.fileName) {
          setSelectedSavedSession(null);
        }
        pushToast({ level: "success", text: "会话已删除", ttl: 2500 });
      } catch (err) {
        console.error("删除会话失败:", err);
        pushToast({
          level: "error",
          text: `删除失败：${err && err.message ? err.message : err}`,
          ttl: 5000,
        });
      }
    },
    [cloudDeleteSession, pushToast, selectedSavedSession?.fileName]
  );

  if (!isSupported) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center border border-red-100">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-800 mb-2">浏览器不支持</h2>
          <p className="text-gray-600">{unsupportedReason}</p>
        </div>
      </div>
    );
  }

  const pipMountNode = pipWindow?.document.getElementById("pip-mount");
  const currentDeviceName =
    devices.find((d) => d.deviceId === selectedDeviceId)?.label || "默认麦克风";
  const allSavedSessions = [...savedSessions, ...temporarySessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  // Folder filter for the saved view: openFolderId may be a real folder id,
  // the "__unfiled__" sentinel (未归档), or null (no filter / show all).
  const activeFolderFilter =
    openFolderId === "__unfiled__"
      ? { id: "__unfiled__", name: "未归档", color: "slate" }
      : folders.find((f) => f.id === openFolderId) || null;
  const folderFilteredSessions =
    openFolderId == null
      ? allSavedSessions
      : allSavedSessions.filter((s) =>
          openFolderId === "__unfiled__" ? !s.folderId : s.folderId === openFolderId
        );
  const filteredSavedSessions = folderFilteredSessions.filter((session) => {
    const keyword = savedSessionsQuery.trim().toLowerCase();
    if (!keyword) return true;

    const haystack = [
      session.title,
      session.summary,
      session.fileName,
      ...(session.transcripts || []).flatMap((item) => [item.en, item.zh, item.speaker]),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(keyword);
  });
  const finalizingPercent =
    finalizingProgress.total > 0
      ? Math.min(
          100,
          Math.round((finalizingProgress.done / finalizingProgress.total) * 100)
        )
      : 0;

  return (
    <div className="h-screen flex font-sans relative overflow-hidden text-slate-100">
      <aside
        style={{ width: `${isSidebarCollapsed ? 72 : sidebarWidth}px` }}
        className="ct-sidebar h-full shrink-0 relative"
      >
        <div className="h-full flex flex-col">
          <div className={`border-b border-white/10 ${isSidebarCollapsed ? "px-2 py-3" : "px-4 py-4"}`}>
            <div className="flex items-center justify-between gap-2">
              {!isSidebarCollapsed && (
                <div>
                  <h2 className="text-lg font-bold text-slate-100 tracking-tight">ClassTrans Pro</h2>
                  <p className="text-xs text-slate-400 mt-1">课堂控制台</p>
                </div>
              )}
              <button
                onClick={toggleSidebarCollapse}
                className="h-8 w-8 rounded-lg border border-white/10 text-slate-400 hover:text-indigo-300 hover:border-indigo-400/40 hover:bg-indigo-500/10 flex items-center justify-center transition-colors"
                title={isSidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              >
                {isSidebarCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className={`space-y-2 overflow-y-auto ${isSidebarCollapsed ? "p-2" : "p-3"}`}>
            <button
              onClick={() => setActiveView("home")}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "home"
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="首页（同传）"
            >
              <Home className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>首页（同传）</span>}
            </button>

            <button
              onClick={openFoldersView}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "folders"
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="文件夹"
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>文件夹</span>}
            </button>

            <button
              onClick={openSavedSessions}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "saved"
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="查看已保存"
            >
              <BookOpen className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>查看已保存</span>}
            </button>

            <button
              onClick={openGlossaryModal}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "glossary"
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="术语词典"
            >
              <Settings className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>术语词典</span>}
            </button>


            {isAdmin && (
            <button
              onClick={() => setActiveView("admin")}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "admin"
                  ? "bg-amber-500/15 text-amber-200 border-amber-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="后台管理"
            >
              <Settings className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>后台管理</span>}
            </button>
            )}

            <button
              onClick={() => setActiveView("usage")}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "usage"
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
              title="AI 用量"
            >
              <Activity className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>AI 用量</span>}
            </button>

            <button
              onClick={toggleTheme}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100`}
              title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
            >
              {theme === "dark" ? (
                <Sun className="w-4 h-4 shrink-0" />
              ) : (
                <Moon className="w-4 h-4 shrink-0" />
              )}
              {!isSidebarCollapsed && (
                <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
              )}
            </button>
          </div>

          <div className="mt-auto border-t border-white/10">
            {!isSidebarCollapsed ? (
              <div className="px-3 py-3 space-y-2">
                <div className="flex items-center gap-2.5 px-1">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-sm shrink-0 uppercase">
                    {(user?.email || "U").charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-100 truncate" title={user?.email || ""}>
                      {user?.email || "用户"}
                    </p>
                    <span
                      className={`inline-block mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        isAdmin ? "bg-amber-500/15 text-amber-300" : "bg-white/[0.06] text-slate-400"
                      }`}
                    >
                      {isAdmin ? "管理员" : "已登录"}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => signOut()}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-rose-300 bg-rose-500/10 border border-rose-400/20 hover:bg-rose-500/20 transition-colors"
                >
                  <LogOut className="w-4 h-4" /> 退出登录
                </button>
              </div>
            ) : (
              <div className="py-3 flex flex-col items-center gap-2">
                <div
                  className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-sm uppercase"
                  title={user?.email || "用户"}
                >
                  {(user?.email || "U").charAt(0)}
                </div>
                <button
                  onClick={() => signOut()}
                  title="退出登录"
                  className="p-2 rounded-lg text-rose-300 hover:bg-rose-500/15 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {!isSidebarCollapsed && (
          <div
            onMouseDown={startSidebarResize}
            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-indigo-400/30 transition-colors"
            title="拖拽调整侧栏宽度"
          />
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 relative overflow-hidden">
      <header className="ct-header sticky top-0 z-10 shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          <div className="flex items-center space-x-3 w-full lg:w-auto justify-center lg:justify-start">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center relative overflow-hidden shrink-0 border border-white/10 shadow-[0_6px_20px_-6px_rgba(99,102,241,0.5)]">
              <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500 to-purple-500 z-0"></div>
              <Globe className="w-5 h-5 text-white relative z-10" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-100 leading-tight flex items-center tracking-tight">
                ClassTrans{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 to-purple-300 ml-1">
                  Pro
                </span>
              </h1>
              <p className="text-xs text-slate-400 font-medium">
                同传翻译 · 智能纪要
              </p>
            </div>
          </div>

          <div className="w-full lg:w-auto flex items-center justify-end gap-2">
            <div className="flex items-center flex-wrap gap-2 max-w-full pb-1 lg:pb-0 pr-1 overflow-visible">
            <div className="relative" ref={deviceMenuRef}>
              <button
                onClick={() => {
                  fetchDevices();
                  setIsDeviceMenuOpen(!isDeviceMenuOpen);
                }}
                className="flex items-center space-x-1 px-3 py-1.5 bg-white/[0.06] text-slate-300 rounded-lg text-xs font-medium hover:bg-white/[0.10] transition-colors max-w-[150px] truncate border border-white/10"
                title="选择录音设备"
              >
                <Settings className="w-3 h-3 shrink-0" />
                <span className="truncate">{currentDeviceName}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>

              {isDeviceMenuOpen && (
                <div className="absolute top-full left-0 mt-1 w-64 ct-glass-strong rounded-xl shadow-2xl z-50 py-1 max-h-64 overflow-y-auto">
                  {devices.length === 0 ? (
                    <div className="px-4 py-3 text-xs text-slate-400">
                      未检测到麦克风，请检查权限
                    </div>
                  ) : (
                    devices.map((device) => (
                      <button
                        key={device.deviceId}
                        onClick={() => handleDeviceChange(device.deviceId)}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-indigo-500/15 hover:text-indigo-200 transition-colors truncate ${
                          selectedDeviceId === device.deviceId
                            ? "bg-indigo-500/15 text-indigo-200 font-semibold"
                            : "text-slate-300"
                        }`}
                      >
                        {device.label ||
                          `麦克风 ${device.deviceId.substring(0, 5)}...`}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              onClick={togglePip}
              className={`p-2 rounded-lg transition-colors flex items-center justify-center border ${
                pipWindow
                  ? "bg-indigo-500/15 text-indigo-200 border-indigo-400/30"
                  : "text-slate-400 border-transparent hover:text-slate-100 hover:bg-white/[0.06] hover:border-white/10"
              }`}
              title={pipWindow ? "关闭悬浮气泡字幕" : "开启悬浮气泡字幕"}
            >
              <PictureInPicture className="w-4 h-4" />
            </button>

            <button
              onClick={clearTranscripts}
              className="p-2 text-slate-500 hover:text-rose-300 hover:bg-rose-500/12 rounded-lg transition-colors border border-transparent hover:border-rose-400/30"
              title="清空所有记录"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {listeningMode === "none" && (
              <div className="relative" ref={folderMenuRef}>
                <button
                  onClick={() => setIsFolderMenuOpen((o) => !o)}
                  className={`flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors max-w-[170px] ${
                    currentFolder
                      ? "bg-white/[0.06] text-slate-200 border-white/10 hover:bg-white/[0.10]"
                      : "bg-amber-500/12 text-amber-300 border-amber-400/30 hover:bg-amber-500/20"
                  }`}
                  title="选择录音要保存到的文件夹"
                >
                  <Folder className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{currentFolder ? currentFolder.name : "选择文件夹"}</span>
                  <ChevronDown className="w-3 h-3 shrink-0" />
                </button>
                {isFolderMenuOpen && (
                  <div className="absolute top-full left-0 mt-1 w-60 ct-glass-strong rounded-xl shadow-2xl z-50 py-1 max-h-72 overflow-y-auto">
                    {folders.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-slate-400">还没有文件夹</div>
                    ) : (
                      folders.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => {
                            setCurrentFolderId(f.id);
                            setIsFolderMenuOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] flex items-center gap-2"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: (FOLDER_COLORS[f.color] || FOLDER_COLORS.indigo).dot }}
                          />
                          <span className="truncate text-slate-200 flex-1">{f.name}</span>
                          {currentFolderId === f.id && <Check className="w-3.5 h-3.5 text-indigo-300 shrink-0" />}
                        </button>
                      ))
                    )}
                    <div className="border-t border-white/10 mt-1 pt-1">
                      <button
                        onClick={() => {
                          setIsFolderMenuOpen(false);
                          setOpenFolderId(null);
                          setActiveView("folders");
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-indigo-300 hover:bg-white/[0.06] flex items-center gap-2"
                      >
                        <FolderPlus className="w-4 h-4 shrink-0" /> 管理 / 新建文件夹
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {listeningMode === "none" ? (
              <button
                onClick={startTabMode}
                disabled={!currentFolderId}
                className={`ct-btn-tab flex items-center space-x-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all ${
                  !currentFolderId ? "opacity-50 cursor-not-allowed" : ""
                }`}
                title={currentFolder ? "系统音频录制（快捷键 T）：点击后在弹窗选择 Chrome 标签页 或 窗口" : "请先选择文件夹"}
              >
                <Headphones className="w-4 h-4" />
                <span>系统音频</span>
                <kbd className="hidden md:inline-block ml-1 px-1.5 py-0.5 bg-white/20 text-[10px] font-mono rounded border border-white/30">T</kbd>
              </button>
            ) : (
              <div className="flex items-center space-x-2 shrink-0">
                <div className="flex items-center justify-center px-3 py-1.5 bg-black/40 text-slate-100 rounded-lg text-sm font-mono font-bold tracking-wider border border-white/10 ml-1">
                  <span
                    className={`w-2 h-2 rounded-full mr-2 ${
                      isPaused ? "bg-amber-300" : "bg-rose-400 animate-pulse"
                    }`}
                  ></span>
                  {formatTime(recordingTime)}
                </div>

                {liveTranslateActive && (
                  <button
                    onClick={toggleTranslationAudio}
                    title={playTranslationAudio ? "关闭中文译文朗读" : "朗读中文译文（实时语音）"}
                    className={`flex items-center justify-center px-3 py-2 rounded-xl font-semibold text-sm border transition-colors ${
                      playTranslationAudio
                        ? "bg-emerald-500/20 text-emerald-200 border-emerald-400/40"
                        : "bg-black/30 text-slate-300 border-white/10 hover:text-slate-100"
                    }`}
                  >
                    {playTranslationAudio ? (
                      <Volume2 className="w-4 h-4" />
                    ) : (
                      <VolumeX className="w-4 h-4" />
                    )}
                    <span className="hidden lg:inline ml-1">译文朗读</span>
                  </button>
                )}

                {isPaused ? (
                  <button
                    onClick={togglePause}
                    disabled={isFinalizingSession}
                    title={isFinalizingSession ? "正在收尾，请稍候" : "继续收音（Space）"}
                    className={`ct-btn-success flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm ${
                      isFinalizingSession ? "opacity-50 cursor-not-allowed pointer-events-none" : ""
                    }`}
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">继续收音</span>
                    <kbd className="hidden md:inline-block ml-1 px-1.5 py-0.5 bg-white/20 text-[10px] font-mono rounded border border-white/30">Space</kbd>
                  </button>
                ) : (
                  <button
                    onClick={togglePause}
                    disabled={isFinalizingSession}
                    title={isFinalizingSession ? "正在收尾，请稍候" : "暂时挂起（Space）"}
                    className={`ct-btn-warn flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm ${
                      isFinalizingSession ? "opacity-50 cursor-not-allowed pointer-events-none" : ""
                    }`}
                  >
                    <Pause className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">暂时挂起</span>
                    <kbd className="hidden md:inline-block ml-1 px-1.5 py-0.5 bg-amber-300/15 text-[10px] font-mono rounded border border-amber-300/40">Space</kbd>
                  </button>
                )}

                <button
                  onClick={listeningMode === "mic" ? toggleMicMode : stopTabMode}
                  disabled={isFinalizingSession}
                  title={isFinalizingSession ? "正在收尾，请稍候" : "彻底停止（Esc）"}
                  className={`ct-btn-danger flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm ${
                    isFinalizingSession ? "opacity-50 cursor-not-allowed pointer-events-none" : ""
                  }`}
                >
                  <Square className="w-4 h-4 fill-current" />
                  <span className="hidden sm:inline">
                    {isFinalizingSession ? "收尾中…" : "彻底停止"}
                  </span>
                  {!isFinalizingSession && (
                    <kbd className="hidden md:inline-block ml-1 px-1.5 py-0.5 bg-rose-300/15 text-[10px] font-mono rounded border border-rose-300/40">Esc</kbd>
                  )}
                </button>
              </div>
            )}
            </div>

            <div className="shrink-0">
              {listeningMode === "none" ? (
                <button
                  onClick={toggleMicMode}
                  disabled={!currentFolderId}
                  className={`ct-btn-success flex items-center space-x-2 px-4 py-2 rounded-xl font-semibold text-sm ${
                    !currentFolderId ? "opacity-50 cursor-not-allowed" : ""
                  }`}
                  title={currentFolder ? "开始语音转录（快捷键 M）。设备从左侧下拉菜单选择。" : "请先选择文件夹"}
                >
                  <Play className="w-4 h-4" />
                  <span>开始语音转录</span>
                  <kbd className="hidden md:inline-block ml-1 px-1.5 py-0.5 bg-white/20 text-[10px] font-mono rounded border border-white/30">M</kbd>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))] pointer-events-none">
          {toasts.map((t) => {
            const levelClass =
              t.level === "error"
                ? "ct-toast-error"
                : t.level === "warn"
                ? "ct-toast-warn"
                : t.level === "success"
                ? "ct-toast-success"
                : "ct-toast-info";
            return (
              <div
                key={t.id}
                className={`ct-toast ${levelClass} pointer-events-auto rounded-xl shadow-lg px-4 py-3 flex items-start gap-3`}
                role={t.level === "error" ? "alert" : "status"}
              >
                {(t.level === "error" || t.level === "warn") && (
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 opacity-80" />
                )}
                {t.level === "success" && (
                  <Sparkles className="w-4 h-4 mt-0.5 shrink-0 opacity-80" />
                )}
                <p className="text-sm leading-relaxed flex-1 break-words">{t.text}</p>
                <button
                  onClick={() => dismissToast(t.id)}
                  className="opacity-50 hover:opacity-90 -mr-1 -mt-1 px-1 leading-none text-lg"
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {wordEditPopover && (
        <>
          {/* Backdrop click captures outside-click to close. */}
          <div
            className="fixed inset-0 z-[80]"
            onClick={closeWordEditPopover}
          />
          <div
            className="ct-word-popover fixed z-[81] p-3 w-72"
            style={{
              left: Math.max(
                8,
                Math.min(
                  (typeof window !== "undefined" ? window.innerWidth : 1024) - 296,
                  wordEditPopover.x - 144
                )
              ),
              top: Math.min(
                (typeof window !== "undefined" ? window.innerHeight : 768) - 220,
                wordEditPopover.y
              ),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                修正这个词
              </span>
              <button
                onClick={closeWordEditPopover}
                className="text-slate-500 hover:text-slate-200 -mr-1"
                aria-label="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-[11px] text-slate-400 mb-1">原词</div>
            <div className="font-mono text-sm text-slate-300 mb-3 px-2 py-1 rounded bg-white/[0.04] border border-white/10 break-all">
              {wordEditPopover.originalWord}
            </div>
            <div className="text-[11px] text-slate-400 mb-1">替换为</div>
            <input
              autoFocus
              value={wordEditPopover.draft}
              onChange={(e) =>
                setWordEditPopover((prev) =>
                  prev ? { ...prev, draft: e.target.value } : prev
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) commitWordEdit(true);
                  else commitWordEdit(false);
                }
              }}
              className="ct-input w-full text-sm font-mono px-2 py-1.5 mb-3"
              placeholder="新词"
            />
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => commitWordEdit(true)}
                className="ct-btn-primary text-xs px-3 py-2 rounded-md font-semibold flex items-center justify-center gap-1.5"
                title="替换并加入词典 (Shift+Enter)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                替换并加入词典
              </button>
              <button
                onClick={() => commitWordEdit(false)}
                className="ct-btn-ghost text-xs px-3 py-2 rounded-md font-semibold flex items-center justify-center gap-1.5"
                title="仅替换此处 (Enter)"
              >
                <Check className="w-3.5 h-3.5" />
                仅替换此处
              </button>
            </div>
            <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
              加入词典后，本地正则即时生效，下一次同传时 Paraformer 也会用作热词。
            </div>
          </div>
        </>
      )}

      <PipelineStatusCard
        capture={{
          icon: listeningMode === "tab" ? Headphones : Mic,
          label:
            listeningMode === "tab"
              ? "系统音频"
              : listeningMode === "mic"
              ? "麦克风"
              : "未收音",
          state:
            listeningMode === "none"
              ? "idle"
              : isPaused
              ? "paused"
              : "active",
        }}
        captureHint={
          listeningMode === "none"
            ? "未启动收音"
            : isPaused
            ? "已暂停（Space 恢复）"
            : "正在收音"
        }
        asr={{
          icon:
            asrStatus === "error"
              ? AlertCircle
              : asrStatus === "connecting"
              ? Loader2
              : Activity,
          label:
            asrStatus === "live"
              ? isPaused
                ? "识别已暂停"
                : "Paraformer"
              : asrStatus === "connecting"
              ? "连接中…"
              : asrStatus === "error"
              ? "识别异常"
              : "未识别",
          state:
            asrStatus === "live"
              ? isPaused
                ? "paused"
                : "active"
              : asrStatus === "connecting"
              ? "warn"
              : asrStatus === "error"
              ? "error"
              : "idle",
        }}
        asrHint={
          asrStatus === "error"
            ? `识别异常：${asrErrorReason}`
            : asrStatus === "connecting"
            ? "正在握手 Paraformer 任务"
            : asrStatus === "live"
            ? isPaused
              ? "暂停：音频帧不再上行"
              : "Paraformer 实时识别中"
            : "未识别"
        }
        polish={{
          icon: Sparkles,
          label: transcripts.some((t) => t.isTranslating || t.isStreamingPolish)
            ? "AI 润色中"
            : "润色就绪",
          state: transcripts.some((t) => t.isTranslating || t.isStreamingPolish)
            ? "active"
            : "idle",
        }}
        realtime={{
          icon: Globe,
          label: listeningMode !== "none" && !isPaused ? "实时机翻" : "实时机翻",
          state:
            listeningMode !== "none" && !isPaused ? "active" : "idle",
        }}
      />

      {activeView === "home" && homeBuckets.length >= 2 && (
        <div className="ct-pipeline-card hidden lg:flex fixed right-3 top-24 z-30 flex-col max-h-[50vh] w-[68px] p-1.5 gap-0.5 overflow-hidden">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider text-center pb-1 border-b border-white/10">
            时间轴
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col gap-0.5 pt-1">
            {homeBuckets.map((b) => (
              <button
                key={b.startMs}
                onClick={() => scrollToBucket(b.startMs)}
                title={`${formatHHMM(b.startMs)} – ${formatHHMM(b.startMs + HOME_BUCKET_MS)} · ${b.count} 段`}
                className="text-[11px] font-mono text-slate-400 hover:text-indigo-200 hover:bg-indigo-500/12 rounded-md px-1.5 py-1 transition-colors text-center"
              >
                {formatHHMM(b.startMs)}
              </button>
            ))}
          </div>
        </div>
      )}

      {isFinalizingSession && (
        <div className="max-w-6xl mx-auto w-full px-6 mt-4 shrink-0">
          <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/[0.08] backdrop-blur p-4">
            <div className="flex items-center justify-between text-sm font-semibold text-indigo-200 mb-2">
              <span>
                {finalizingProgress.phase === "summary"
                  ? "正在生成课堂纪要..."
                  : `正在等待 AI 润色完成（${finalizingProgress.done}/${finalizingProgress.total}）`}
              </span>
              <span className="font-mono">{finalizingPercent}%</span>
            </div>
            <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-all duration-300"
                style={{ width: `${finalizingPercent}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 注意：给 main 添加了 ref 和 onScroll 监听 */}
      <main
        ref={mainRef}
        onScroll={handleMainScroll}
        className={`flex-1 mx-auto w-full flex flex-col overflow-y-auto ${
          activeView === "saved"
            ? "max-w-none px-4 py-4 gap-3"
            : "max-w-6xl px-6 py-8 gap-4"
        }`}
      >
        {activeView === "home" && (
          <>
        {transcripts.length === 0 && !activeEn && listeningMode === "none" && (
          <div className="flex-1 flex flex-col items-center justify-center mt-10 md:mt-20">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-indigo-500/20 blur-2xl"></div>
              <Mic className="w-16 h-16 mb-4 stroke-[1.5] text-indigo-300 relative" />
            </div>
            {currentFolder ? (
              <>
                <p className="text-lg text-slate-200 font-medium tracking-wide mt-2">
                  当前文件夹：
                  <span className="inline-flex items-center gap-1.5 ml-1 align-middle">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: (FOLDER_COLORS[currentFolder.color] || FOLDER_COLORS.indigo).dot }}
                    />
                    <strong className="text-indigo-200">{currentFolder.name}</strong>
                  </span>
                </p>
                <p className="text-sm text-slate-400 mt-1.5">
                  点击右上角 <strong className="text-emerald-300">【开始语音转录】</strong> 或{" "}
                  <strong className="text-purple-300">【系统音频】</strong> 开始录音
                </p>
              </>
            ) : (
              <>
                <p className="text-lg text-slate-200 font-medium tracking-wide mt-2">
                  先选择一个<strong className="text-indigo-200">文件夹</strong>，再开始录音
                </p>
                <button
                  onClick={() => {
                    setOpenFolderId(null);
                    setActiveView("folders");
                  }}
                  className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white font-semibold text-sm transition-colors"
                >
                  <FolderPlus className="w-4 h-4" /> 选择 / 新建文件夹
                </button>
              </>
            )}
            <div className="ct-card text-sm mt-6 text-left max-w-md p-5 leading-relaxed text-slate-300">
              <div className="text-slate-100 font-semibold mb-2">💡 如何转录网课视频？</div>
              <ol className="list-decimal pl-5 space-y-1.5">
                <li>
                  先在顶部<strong className="text-indigo-300">选择文件夹</strong>，录音会自动归档到该文件夹并保存到云端。
                </li>
                <li>
                  推荐点
                  <strong className="text-purple-300">【系统音频】</strong>，在弹窗中选择
                  <strong className="text-purple-300">【Chrome 标签页】</strong>或
                  <strong className="text-purple-300">【窗口】</strong>并勾选
                  <strong className="text-purple-300">【共享音频】</strong>。
                </li>
                <li>
                  左侧下拉框选择
                  <strong className="text-indigo-300">【立体声混音 / Stereo Mix】</strong>
                  或使用虚拟声卡（如 VB-Cable）。
                </li>
                <li>
                  或者最简单的方法：直接用手机外放声音，让电脑麦克风听见即可！
                </li>
              </ol>
            </div>
          </div>
        )}

        {homeRows.map((row) => {
          if (row.kind === "separator") {
            return (
              <div
                key={row.key}
                id={`ct-bucket-${row.bucketStart}`}
                className="flex items-center gap-3 my-1 shrink-0 scroll-mt-24"
              >
                <div className="flex-1 h-px bg-white/10" />
                <div className="text-[11px] font-mono text-slate-400 tracking-wider px-3 py-0.5 rounded-full bg-white/[0.04] border border-white/10">
                  {formatHHMM(row.bucketStart)} – {formatHHMM(row.bucketStart + HOME_BUCKET_MS)}
                </div>
                <div className="flex-1 h-px bg-white/10" />
              </div>
            );
          }
          const item = row.item;
          return (
          <div
            key={item.id}
            className={`ct-card p-5 shrink-0 ${
              item.isPolished
                ? "ct-card-polished"
                : item.lowConfidence
                ? "ct-card-low-confidence"
                : ""
            }`}
          >
            {(() => {
              const liveEditKey = `live-${item.id}`;
              const isEditing =
                bubbleEditDraft && bubbleEditDraft.key === liveEditKey;
              const canEdit = !item.isTranslating && !item.isStreamingPolish;
              return (
                <>
                  <div className="flex items-center justify-between text-xs font-semibold mb-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="ct-speaker-pill">
                        <User className="w-3 h-3 opacity-70" />
                        {item.speaker || "👩‍🏫 主讲人"}
                      </div>
                    </div>
                    {canEdit && !isEditing && (
                      <button
                        onClick={() =>
                          openBubbleEditor(
                            "live",
                            { bubbleId: item.id },
                            item.en,
                            item.zh
                          )
                        }
                        className="opacity-40 hover:opacity-100 p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] border border-transparent hover:border-white/10 transition-all shrink-0"
                        title="编辑这一条转录的中英文"
                        aria-label="编辑气泡"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="space-y-2">
                      <div>
                        <div className="text-[11px] text-slate-500 mb-1">英文</div>
                        <textarea
                          value={bubbleEditDraft.enDraft}
                          onChange={(e) =>
                            setBubbleEditDraft((prev) =>
                              prev ? { ...prev, enDraft: e.target.value } : prev
                            )
                          }
                          rows={Math.min(6, Math.max(2, Math.ceil((bubbleEditDraft.enDraft || "").length / 80)))}
                          className="ct-textarea w-full text-sm font-sans p-2 leading-relaxed resize-y"
                        />
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-500 mb-1">中文</div>
                        <textarea
                          value={bubbleEditDraft.zhDraft}
                          onChange={(e) =>
                            setBubbleEditDraft((prev) =>
                              prev ? { ...prev, zhDraft: e.target.value } : prev
                            )
                          }
                          rows={Math.min(6, Math.max(2, Math.ceil((bubbleEditDraft.zhDraft || "").length / 60)))}
                          className="ct-textarea w-full text-base font-bold p-2 leading-relaxed resize-y"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2 justify-end pt-1">
                        <button
                          onClick={closeBubbleEditor}
                          className="ct-btn-ghost text-xs px-3 py-1.5 rounded-md font-semibold flex items-center gap-1"
                        >
                          <X className="w-3.5 h-3.5" /> 取消
                        </button>
                        <button
                          onClick={saveBubbleEdit}
                          className="ct-btn-primary text-xs px-3 py-1.5 rounded-md font-semibold flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" /> 保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start mb-2 gap-3">
                        <div
                          className={`text-sm md:text-base font-medium pr-2 leading-relaxed font-sans flex-1 ${
                            item.isPolished || item.fromTab
                              ? "ct-subtitle-en-polished"
                              : "ct-subtitle-en"
                          }`}
                        >
                          <WordEditableText
                            text={item.en}
                            disabled={item.isTranslating || item.isStreamingPolish}
                            onWordClick={(e, wordIdx, word) =>
                              openWordEditPopover(e, {
                                scope: "live",
                                bubbleId: item.id,
                                wordIdx,
                                originalWord: word,
                              })
                            }
                          />
                        </div>
                        <div className="ml-auto flex flex-col sm:flex-row items-end sm:items-center gap-1 sm:gap-2 shrink-0">
                          {item.lowConfidence && (
                            <div className="ct-tag ct-tag-warn">
                              <AlertCircle className="w-3 h-3" /> 低置信度
                            </div>
                          )}
                          {item.isPolished && (
                            <div className="ct-tag ct-tag-polish">
                              <Sparkles className="w-3 h-3" /> AI 精调
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="relative min-h-[1.75rem]">
                        {item.isTranslating ? (
                          <div className="flex items-center space-x-2 text-violet-300 text-sm mt-1">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="opacity-50 line-through mr-2 text-slate-500">
                              {item.zh !== "..." && !item.zh.startsWith("[")
                                ? item.zh
                                : ""}
                            </span>
                            <span className="font-medium">
                              {item.fromTab
                                ? "正在解析原生音频流..."
                                : "AI 深度纠错与润色中..."}
                            </span>
                          </div>
                        ) : (
                          <div
                            className={`text-lg md:text-2xl font-bold leading-relaxed tracking-wide ct-subtitle-zh ${
                              item.isStreamingPolish ? "ct-subtitle-zh-streaming" : ""
                            } ${
                              (item.en || "").includes("⚠️")
                                ? "text-rose-300 text-sm font-medium"
                                : ""
                            }`}
                          >
                            {item.isStreamingPolish ? (
                              <StreamingText value={item.zh} animate withCursor />
                  ) : (
                              item.zh
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </div>
          );
        })}

        {(listeningMode === "mic" || listeningMode === "tab") && (activeEn || isPaused) && (
          <div
            className={`ct-card-active p-5 shrink-0 ${isPaused ? "is-paused" : ""}`}
          >
            <div className="flex items-center text-xs font-bold mb-2 space-x-2">
              <div className="ct-tag ct-tag-info">
                <User className="w-3 h-3" />
                {listeningMode === "tab" ? "🎧 系统音频解析中..." : "🕵️ 语境分析中..."}
              </div>
            </div>

            <div className="text-slate-300 text-sm md:text-base font-medium mb-2 pr-8 leading-relaxed font-sans">
              <div>
                {activeEn}
                {!isPaused && (
                  <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-indigo-300 animate-pulse rounded-sm"></span>
                )}
              </div>
              {!isPaused && activeEn && activeConfidence < 0.65 && (
                <div className="mt-2 inline-flex items-center ct-tag ct-tag-warn">
                  <AlertCircle className="w-3 h-3" /> 当前片段噪声较高，建议靠近麦克风
                </div>
              )}
            </div>

            <div className="relative min-h-[1.75rem]">
              {isPaused ? (
                <div className="flex items-center space-x-2 text-amber-300 text-sm font-medium">
                  <Pause className="w-4 h-4" />
                  <span>{listeningMode === "tab" ? "系统音频解析已挂起" : "录音已挂起，按 Space 继续"}</span>
                </div>
              ) : activeZh ? (
                <div className="text-indigo-100 text-lg md:text-2xl font-bold leading-relaxed tracking-wide transition-all duration-300 ct-subtitle-zh ct-subtitle-zh-streaming">
                  {activeZh}
                </div>
              ) : (
                <div className="flex items-center space-x-2 text-indigo-300 text-sm font-medium">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>实时极速机译跟进中...</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={scrollRef} className="h-4 shrink-0" />
          </>
        )}

        {activeView === "saved" && (
          <div className="ct-panel overflow-hidden flex flex-1 min-h-[calc(100vh-160px)]">
            <div className="w-72 border-r border-white/10 bg-white/[0.02] flex flex-col shrink-0">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
                <h3 className="font-bold text-slate-100 text-sm">已保存会话</h3>
                <button
                  onClick={openSavedSessions}
                  className="text-xs px-2.5 py-1 rounded-md border border-white/10 text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                >
                  刷新
                </button>
              </div>
              <div className="px-3 py-2 border-b border-white/10">
                <input
                  value={savedSessionsQuery}
                  onChange={(e) => setSavedSessionsQuery(e.target.value)}
                  placeholder="搜索标题 / 关键词"
                  className="ct-input w-full text-xs px-3 py-2"
                />
              </div>
              {activeFolderFilter && (
                <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-2 bg-indigo-500/[0.06]">
                  <span className="inline-flex items-center gap-1.5 text-xs text-indigo-200 font-medium min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: (FOLDER_COLORS[activeFolderFilter.color] || FOLDER_COLORS.slate).dot }}
                    />
                    <span className="truncate">文件夹：{activeFolderFilter.name}</span>
                  </span>
                  <button
                    onClick={() => setOpenFolderId(null)}
                    className="text-[11px] text-slate-400 hover:text-slate-200 shrink-0"
                  >
                    显示全部
                  </button>
                </div>
              )}
              <div className="overflow-y-auto flex-1">
                {filteredSavedSessions.length === 0 ? (
                  <p className="text-xs text-slate-400 px-4 py-5">
                    {allSavedSessions.length === 0
                      ? "暂无已保存会话。"
                      : activeFolderFilter
                      ? "该文件夹暂无会话。"
                      : "未匹配到相关会话。"}
                  </p>
                ) : (
                  filteredSavedSessions.map((session) => (
                    <button
                      key={session.fileName}
                      onClick={() => selectSavedSession(session)}
                      className={`w-full text-left px-4 py-3 border-b border-white/5 transition-colors ${
                        selectedSavedSession?.fileName === session.fileName
                          ? "bg-indigo-500/12"
                          : "bg-transparent hover:bg-white/[0.04]"
                      }`}
                    >
                      <div className={`text-xs font-semibold truncate ${
                        selectedSavedSession?.fileName === session.fileName
                          ? "text-indigo-200"
                          : "text-slate-200"
                      }`}>
                        {session.title}
                        {session.isTemporary ? "（临时）" : ""}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 truncate">
                        {new Date(session.createdAt).toLocaleString()}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="flex-1 flex flex-col min-w-0">
              <div className="px-6 py-4 border-b border-white/10">
                {selectedSavedSession ? (
                  titleDraft !== null ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleRenameSavedSession(selectedSavedSession, titleDraft);
                          } else if (e.key === "Escape") {
                            setTitleDraft(null);
                          }
                        }}
                        className="ct-input flex-1 min-w-0 text-base font-bold px-3 py-1.5"
                        placeholder="会话标题"
                      />
                      <button
                        onClick={() =>
                          handleRenameSavedSession(selectedSavedSession, titleDraft)
                        }
                        className="ct-btn-success p-1.5 rounded-md"
                        title="保存（Enter）"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setTitleDraft(null)}
                        className="ct-btn-ghost p-1.5 rounded-md"
                        title="取消（Esc）"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="group flex items-center gap-2 min-w-0">
                      <h3 className="font-bold text-slate-100 text-base truncate">
                        {selectedSavedSession.title}
                      </h3>
                      <button
                        onClick={() => setTitleDraft(selectedSavedSession.title || "")}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] border border-transparent hover:border-white/10 transition-opacity"
                        title="重命名会话"
                        aria-label="重命名会话"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                ) : (
                  <h3 className="font-bold text-slate-100 text-base">
                    请选择左侧会话
                  </h3>
                )}
                {selectedSavedSession && (
                  <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
                    <p className="text-xs text-slate-400">
                      {new Date(selectedSavedSession.createdAt).toLocaleString()} · {selectedSavedSession.transcripts.length} 条转录
                    </p>
                    <div className="flex items-center gap-2">
                      {!selectedSavedSession.isTemporary && (
                        <select
                          value={selectedSavedSession.folderId || ""}
                          onChange={async (e) => {
                            const fid = e.target.value || null;
                            const { error } = await cloudMoveSession(selectedSavedSession.id, fid);
                            if (error) {
                              pushToast({ level: "error", text: "移动失败，请重试", ttl: 3000 });
                              return;
                            }
                            setSelectedSavedSession((prev) =>
                              prev ? { ...prev, folderId: fid } : prev
                            );
                            pushToast({ level: "success", text: "已移动文件夹", ttl: 2000 });
                          }}
                          className="ct-input text-xs px-2 py-1.5 rounded-md max-w-[140px]"
                          title="移动到文件夹"
                        >
                          <option value="">未归档</option>
                          {folders.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        onClick={() => handleRegenerateSummary(selectedSavedSession)}
                        disabled={isRegeneratingSummary}
                        className={`ct-btn-primary text-xs px-3 py-1.5 rounded-md font-semibold flex items-center gap-1.5 ${
                          isRegeneratingSummary ? "opacity-60 cursor-not-allowed pointer-events-none" : ""
                        }`}
                        title="基于当前转录内容重新生成课堂纪要并保存到云端"
                      >
                        {isRegeneratingSummary ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            生成中…
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-3.5 h-3.5" />
                            重新生成纪要
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => exportSavedSessionToWord(selectedSavedSession)}
                        className="ct-btn-ghost text-xs px-3 py-1.5 rounded-md font-semibold"
                      >
                        导出 Word
                      </button>
                      <button
                        onClick={() => exportSavedSessionToPdf(selectedSavedSession)}
                        className="ct-btn-ghost text-xs px-3 py-1.5 rounded-md font-semibold"
                      >
                        导出 PDF
                      </button>
                      <button
                        onClick={() => handleDeleteSavedSession(selectedSavedSession)}
                        className="ct-btn-danger text-xs px-3 py-1.5 rounded-md font-semibold"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                {!selectedSavedSession ? (
                  <div className="text-sm text-slate-400">选择一条会话后，这里会展示转录内容与课堂纪要。</div>
                ) : (
                  <>
                    <div className="rounded-2xl border border-indigo-400/20 bg-indigo-500/[0.06] p-5">
                      <h4 className="font-semibold text-indigo-200 mb-2">课堂纪要</h4>
                      <div
                        className="ct-markdown text-sm leading-relaxed break-words"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdownToSafeHtml(
                            selectedSavedSession.summary || "（该会话未保存纪要）"
                          ),
                        }}
                      />
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-semibold text-slate-100">转录内容</h4>
                      {selectedSavedSession.transcripts.length === 0 ? (
                        <p className="text-sm text-slate-400">（该会话暂无转录内容）</p>
                      ) : (
                        selectedSavedSession.transcripts.map((item, idx) => {
                          const savedEditKey = `saved-${selectedSavedSession.fileName}-${idx}`;
                          const isEditing =
                            bubbleEditDraft && bubbleEditDraft.key === savedEditKey;
                          const polishKey = `${selectedSavedSession.fileName}::${idx}`;
                          const isPolishingThis = polishingSavedKeys.has(polishKey);
                          const showPolishButton = isSavedBubbleUnpolished(item);
                          return (
                            <div key={`${selectedSavedSession.fileName}-${idx}`} className="ct-card p-4">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div className="ct-speaker-pill">
                                  <User className="w-3 h-3 opacity-70" />
                                  {item.speaker || "👩‍🏫 主讲人"}
                                </div>
                                {!isEditing && (
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {showPolishButton && (
                                      <button
                                        onClick={() =>
                                          polishSavedBubble(selectedSavedSession, idx)
                                        }
                                        disabled={isPolishingThis}
                                        className={`text-xs px-2 py-1 rounded-md font-semibold flex items-center gap-1 border transition-colors ${
                                          isPolishingThis
                                            ? "border-violet-400/30 bg-violet-500/10 text-violet-200 opacity-70 cursor-not-allowed"
                                            : "border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 hover:text-violet-100"
                                        }`}
                                        title="使用 AI 重新精调这一条转录的中英文（适用于因配额耗尽等原因未精调的气泡）"
                                        aria-label="AI 精调这一条转录"
                                      >
                                        {isPolishingThis ? (
                                          <>
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            精调中…
                                          </>
                                        ) : (
                                          <>
                                            <Sparkles className="w-3 h-3" />
                                            AI 精调
                                          </>
                                        )}
                                      </button>
                                    )}
                                    <button
                                      onClick={() =>
                                        openBubbleEditor(
                                          "saved",
                                          {
                                            session: selectedSavedSession,
                                            bubbleIdx: idx,
                                          },
                                          item.en,
                                          item.zh
                                        )
                                      }
                                      className="opacity-40 hover:opacity-100 p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] border border-transparent hover:border-white/10 transition-all"
                                      title="编辑这一条转录的中英文"
                                      aria-label="编辑气泡"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </div>
                              {isEditing ? (
                                <div className="space-y-2">
                                  <div>
                                    <div className="text-[11px] text-slate-500 mb-1">英文</div>
                                    <textarea
                                      value={bubbleEditDraft.enDraft}
                                      onChange={(e) =>
                                        setBubbleEditDraft((prev) =>
                                          prev ? { ...prev, enDraft: e.target.value } : prev
                                        )
                                      }
                                      rows={Math.min(6, Math.max(2, Math.ceil((bubbleEditDraft.enDraft || "").length / 80)))}
                                      className="ct-textarea w-full text-sm font-sans p-2 leading-relaxed resize-y"
                                    />
                                  </div>
                                  <div>
                                    <div className="text-[11px] text-slate-500 mb-1">中文</div>
                                    <textarea
                                      value={bubbleEditDraft.zhDraft}
                                      onChange={(e) =>
                                        setBubbleEditDraft((prev) =>
                                          prev ? { ...prev, zhDraft: e.target.value } : prev
                                        )
                                      }
                                      rows={Math.min(6, Math.max(2, Math.ceil((bubbleEditDraft.zhDraft || "").length / 60)))}
                                      className="ct-textarea w-full text-base font-bold p-2 leading-relaxed resize-y"
                                    />
                                  </div>
                                  <div className="flex flex-wrap gap-2 justify-end pt-1">
                                    <button
                                      onClick={closeBubbleEditor}
                                      className="ct-btn-ghost text-xs px-3 py-1.5 rounded-md font-semibold flex items-center gap-1"
                                    >
                                      <X className="w-3.5 h-3.5" /> 取消
                                    </button>
                                    <button
                                      onClick={saveBubbleEdit}
                                      className="ct-btn-primary text-xs px-3 py-1.5 rounded-md font-semibold flex items-center gap-1"
                                    >
                                      <Check className="w-3.5 h-3.5" /> 保存
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="ct-subtitle-en text-sm leading-relaxed">
                                    <WordEditableText
                                      text={item.en}
                                      onWordClick={(e, wordIdx, word) =>
                                        openWordEditPopover(e, {
                                          scope: "saved",
                                          session: selectedSavedSession,
                                          bubbleIdx: idx,
                                          wordIdx,
                                          originalWord: word,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="ct-subtitle-zh text-base font-semibold mt-2 leading-relaxed">{item.zh}</div>
                                </>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeView === "folders" && (
          <div className="ct-panel p-6 space-y-7 min-h-[78vh]">
            {/* Header + new folder */}
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
                  <FolderOpen className="w-6 h-6 text-indigo-300" /> 文件夹
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  管理你的所有语音转录记录 · 录音前请先选择或新建一个文件夹
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                <FolderPlus className="w-4 h-4 text-indigo-300 shrink-0" />
                <input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                  }}
                  placeholder="新建文件夹名称…"
                  className="ct-input flex-1 min-w-[160px] px-3 py-2 text-sm"
                />
                <div className="flex items-center gap-1.5">
                  {FOLDER_COLOR_KEYS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewFolderColor(c)}
                      className={`w-6 h-6 rounded-full bg-gradient-to-tr ${FOLDER_COLORS[c].grad} transition ${
                        newFolderColor === c
                          ? "ring-2 ring-white/80 scale-110"
                          : "opacity-70 hover:opacity-100"
                      }`}
                      title={c}
                      aria-label={`颜色 ${c}`}
                    />
                  ))}
                </div>
                <button
                  onClick={handleCreateFolder}
                  disabled={creatingFolder}
                  className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> {creatingFolder ? "创建中…" : "新建文件夹"}
                </button>
              </div>
            </div>

            {/* Folder grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              <button
                onClick={() => {
                  setOpenFolderId("__unfiled__");
                  setActiveView("saved");
                }}
                className="group text-left focus:outline-none"
              >
                <div className="relative h-28 rounded-2xl bg-gradient-to-br from-slate-500 to-slate-600 shadow-lg group-hover:-translate-y-0.5 transition-transform overflow-hidden">
                  <div className="absolute -top-1.5 left-5 w-16 h-4 rounded-t-lg bg-slate-400/90" />
                  <div className="absolute bottom-3 left-4 right-4">
                    <p className="text-white font-bold text-sm truncate">未归档</p>
                    <p className="text-white/70 text-xs mt-0.5">
                      {savedSessions.filter((s) => !s.folderId).length} 条记录
                    </p>
                  </div>
                </div>
              </button>

              {folders.map((f) =>
                editingFolderId === f.id ? (
                  <div
                    key={f.id}
                    className="h-28 rounded-2xl bg-white/[0.05] border border-white/15 p-2.5 flex flex-col gap-1.5"
                  >
                    <input
                      autoFocus
                      value={editFolderName}
                      onChange={(e) => setEditFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameFolder();
                        else if (e.key === "Escape") setEditingFolderId(null);
                      }}
                      className="ct-input w-full px-2 py-1.5 text-sm"
                      placeholder="文件夹名称"
                    />
                    <div className="flex items-center gap-1 flex-wrap">
                      {FOLDER_COLOR_KEYS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setEditFolderColor(c)}
                          className={`w-5 h-5 rounded-full bg-gradient-to-tr ${FOLDER_COLORS[c].grad} transition ${
                            editFolderColor === c ? "ring-2 ring-white/80 scale-110" : "opacity-70 hover:opacity-100"
                          }`}
                          aria-label={`颜色 ${c}`}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-auto">
                      <button
                        onClick={handleRenameFolder}
                        className="ct-btn-success px-2 py-1 rounded-md text-xs flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" /> 保存
                      </button>
                      <button
                        onClick={() => setEditingFolderId(null)}
                        className="ct-btn-ghost px-2 py-1 rounded-md text-xs flex items-center gap-1"
                      >
                        <X className="w-3.5 h-3.5" /> 取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={f.id} className="group relative">
                    <button
                      onClick={() => {
                        setOpenFolderId(f.id);
                        setActiveView("saved");
                      }}
                      className="w-full text-left focus:outline-none"
                    >
                      <div
                        className={`relative h-28 rounded-2xl bg-gradient-to-br ${folderGrad(
                          f.color
                        )} shadow-lg group-hover:-translate-y-0.5 transition-transform overflow-hidden`}
                      >
                        <div className="absolute -top-1.5 left-5 w-16 h-4 rounded-t-lg bg-white/25" />
                        <div className="absolute bottom-3 left-4 right-4">
                          <p className="text-white font-bold text-sm truncate">{f.name}</p>
                          <p className="text-white/70 text-xs mt-0.5">
                            {savedSessions.filter((s) => s.folderId === f.id).length} 条记录
                          </p>
                        </div>
                      </div>
                    </button>
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                      <button
                        onClick={() => startRenameFolder(f)}
                        title="重命名文件夹"
                        className="p-1.5 rounded-lg bg-black/30 text-white/70 hover:bg-black/50 hover:text-white"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteFolder(f)}
                        title="删除文件夹"
                        className="p-1.5 rounded-lg bg-black/30 text-white/70 hover:bg-black/50 hover:text-white"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>

            {/* Recent recordings */}
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-100">最近录音</h3>
                  <p className="text-xs text-slate-400 mt-0.5">快速回到你最新的转录记录</p>
                </div>
                <button
                  onClick={openSavedSessions}
                  className="text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                >
                  查看全部 →
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {savedSessions.length === 0 ? (
                  <p className="text-sm text-slate-400 py-8 text-center">
                    还没有录音。选择一个文件夹后，开始你的第一次同传。
                  </p>
                ) : (
                  savedSessions.slice(0, 6).map((s) => {
                    const folder = folders.find((ff) => ff.id === s.folderId);
                    const dot = folder
                      ? (FOLDER_COLORS[folder.color] || FOLDER_COLORS.indigo).dot
                      : "#64748b";
                    return (
                      <button
                        key={s.id}
                        onClick={() => {
                          selectSavedSession(s);
                          setActiveView("saved");
                        }}
                        className="w-full text-left p-3 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.06] hover:border-white/20 transition flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-100 truncate">{s.title}</p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            EN → ZH · {(s.transcripts || []).length} 句 ·{" "}
                            {new Date(s.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full bg-white/[0.06] text-slate-300 border border-white/10">
                          <span className="w-2 h-2 rounded-full" style={{ background: dot }} />
                          {folder ? folder.name : "未归档"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {activeView === "glossary" && (
          <div className="ct-panel p-6 space-y-4 min-h-[78vh]">
            <h2 className="text-lg font-bold text-slate-100 tracking-tight">课堂术语词典</h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              每行一条规则，格式：<span className="font-mono bg-white/[0.06] text-slate-200 px-1.5 py-0.5 rounded border border-white/10">原词 =&gt; 纠正词</span>。
              保存后会立刻作用于实时英文识别，并异步同步到 Paraformer 热词词典。
            </p>
            <p className="text-xs text-slate-400">已启用自定义术语：{customGlossaryPairs.length} 条</p>

            <textarea
              value={glossaryDraft}
              onChange={(e) => {
                setGlossaryDraft(e.target.value);
                if (glossaryError) setGlossaryError("");
              }}
              className="ct-textarea w-full min-h-[360px] p-4 text-sm leading-relaxed font-mono"
              placeholder={["chat g p t => ChatGPT", "open ai => OpenAI", "type script => TypeScript"].join("\n")}
            />

            {glossaryError && (
              <div className="text-sm rounded-lg px-3 py-2 ct-tag-error" style={{ display: "block" }}>
                {glossaryError}
              </div>
            )}

            <div className="flex flex-wrap gap-2 justify-between">
              <button
                onClick={handleClearGlossary}
                className="ct-btn-ghost text-sm px-4 py-2 rounded-lg font-semibold"
              >
                清空自定义词典
              </button>
              <button
                onClick={handleSaveGlossary}
                className="ct-btn-primary text-sm px-4 py-2 rounded-lg font-semibold"
              >
                保存并应用
              </button>
            </div>
          </div>
        )}


        
        {activeView === "admin" && isAdmin && (
          <div className="ct-panel p-6 space-y-5 min-h-[78vh]">
            <h2 className="text-lg font-bold text-amber-400 tracking-tight flex items-center gap-2">
              <Settings className="w-5 h-5" /> 后台管理 - 全局 AI 模型配置
            </h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              您是管理员。在此处修改的模型配置将立刻对全站所有用户生效。
            </p>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">润色模型 (Polish)</label>
                <input
                  type="text"
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  placeholder="例如 qwen3.6-35b-a3b"
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">实时机翻模型 (Realtime)</label>
                <input
                  type="text"
                  value={realtimeModelDraft}
                  onChange={(e) => setRealtimeModelDraft(e.target.value)}
                  placeholder="例如 deepseek-v4-flash"
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">课堂纪要模型 (Summary)</label>
                <input
                  type="text"
                  value={summaryModelDraft}
                  onChange={(e) => setSummaryModelDraft(e.target.value)}
                  placeholder="留空则沿用润色模型"
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">语音识别模型 (ASR)</label>
                <input
                  type="text"
                  value={asrModelDraft}
                  onChange={(e) => setAsrModelDraft(e.target.value)}
                  placeholder="例如 qwen3.5-livetranslate-flash-realtime"
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={handleSaveAdminSettings}
                disabled={savingModelConfig}
                className="px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingModelConfig ? "保存中…" : "保存设置"}
              </button>
              {modelSuccessMsg && (
                <span
                  className={`text-sm font-medium ${
                    modelSuccessMsg.startsWith("✅") ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {modelSuccessMsg}
                </span>
              )}
            </div>
          </div>
        )}

        {activeView === "usage" && (
          <UsageView log={aiUsageLog} onClear={() => clearUsageLog()} />
        )}
      </main>

      {/* 主页面智能悬浮按钮：当用户向上滚动查看记录时出现 */}
      {activeView === "home" && !isAutoScroll && (transcripts.length > 0 || activeEn) && (
        <button
          onClick={() => {
            setIsAutoScroll(true);
            scrollRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          className="absolute bottom-16 left-1/2 transform -translate-x-1/2 bg-indigo-600/95 text-white px-5 py-2.5 rounded-full shadow-lg shadow-indigo-500/30 text-sm font-bold flex items-center space-x-2 hover:bg-indigo-700 hover:-translate-y-1 transition-all z-20 backdrop-blur-sm border border-indigo-400"
        >
          <ChevronDown className="w-4 h-4" />
          <span>返回最新同传</span>
        </button>
      )}

      {pipMountNode &&
        createPortal(
          <PipContent
            transcripts={transcripts}
            activeEn={activeEn}
            activeZh={activeZh}
          />,
          pipMountNode
        )}

      {sessionCompletionModal.open && (
        <div className="absolute inset-0 z-40 bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md ct-panel p-6">
            <h3 className="text-lg font-bold text-slate-100 tracking-tight">本次录制已完成</h3>
            <p className="text-sm text-slate-400 mt-1">
              AI 润色与纪要已处理完成，下面是本次同传统计：
            </p>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-3 py-2">
                <p className="text-xs text-indigo-300 font-semibold">录制时长</p>
                <p className="text-base font-bold text-indigo-100 mt-1 font-mono">{formatTime(sessionCompletionModal.durationSec)}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                <p className="text-xs text-slate-400 font-semibold">转录块数</p>
                <p className="text-base font-bold text-slate-100 mt-1 font-mono">{sessionCompletionModal.transcriptCount}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                <p className="text-xs text-slate-400 font-semibold">英文词数</p>
                <p className="text-base font-bold text-slate-100 mt-1 font-mono">{sessionCompletionModal.enWordCount}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                <p className="text-xs text-slate-400 font-semibold">中文字数</p>
                <p className="text-base font-bold text-slate-100 mt-1 font-mono">{sessionCompletionModal.zhCharCount}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                onClick={() => setSessionCompletionModal((prev) => ({ ...prev, open: false }))}
                className="ct-btn-ghost px-3.5 py-2 text-sm rounded-lg font-semibold"
              >
                稍后再录
              </button>
              <button
                onClick={handleStartNextRecording}
                className="ct-btn-primary px-4 py-2 text-sm rounded-lg font-semibold"
              >
                开始下一场录制
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center py-4 text-xs text-slate-500 flex flex-wrap items-center justify-center gap-2 shrink-0 border-t border-white/10 bg-black/20 backdrop-blur-sm">
        <span>Dual Mode Translation Engine</span>
        <span className="hidden sm:inline w-1 h-1 rounded-full bg-slate-600"></span>
        <span>Aliyun DashScope & Paraformer Realtime</span>
      </footer>
      </div>
    </div>
  );
}
