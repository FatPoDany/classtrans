import React, { useState, useEffect, useRef, useCallback } from "react";
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
  FileText,
  ChevronDown,
  Settings,
  Pause,
  Play,
  User,
  Save,
  Headphones,
  Home,
  FolderOpen,
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

// ============================================================================
// 引擎 1：免费谷歌翻译公共接口 (用于麦克风模式的实时快速跟进)
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
// 引擎 2：AI 深度引擎 (阿里云 DashScope) - 用于文本润色 & 生成课堂总结
// ============================================================================
// API Key 现已交由 Vercel 后端 (/api 目录下的接口) 安全管理，前端不再直接引用以避免 process 环境变量报错
const modelName = "qwen3.6-plus"; 

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
const SESSION_FILE_SUFFIX = ".classtrans.json";
let customClassroomTermRules = [];

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

const escapeHtml = (value) =>
  String(value ?? "")
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
    const token = `@@INLINE_CODE_${codeTokens.length}@@`;
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

  return html.replace(/@@INLINE_CODE_(\d+)@@/g, (_, index) => {
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
      closeList();
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

// ============================================================================
// 轻量英文可读性增强：实时阶段先做基础标点与大小写修正（不改写语义）
// ============================================================================
const smartPunctuateEnglish = (input, forceTerminalPunctuation = false) => {
  if (!input) return "";

  let text = applyClassroomGlossary(input)
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

const pickBestTranscriptAlternative = (result) => {
  if (!result || result.length === 0) return "";
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    const candidate = result[i];
    if ((candidate?.confidence ?? 0) > (best?.confidence ?? 0)) {
      best = candidate;
    }
  }
  return (best?.transcript || "").replace(/\s+/g, " ").trim();
};

const pickBestAlternativeConfidence = (result) => {
  if (!result || result.length === 0) return 0;
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    const candidate = result[i];
    if ((candidate?.confidence ?? 0) > (best?.confidence ?? 0)) {
      best = candidate;
    }
  }
  return Number(best?.confidence ?? 0);
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getAdaptivePauseThreshold = (text) => {
  const cleanText = (text || "").trim();
  if (!cleanText) return 1500;

  const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
  let threshold = 1500;

  // 短句更容易是“思考停顿”，延迟一点再截断，降低漏字率
  if (wordCount <= 4) threshold += 700;
  else if (wordCount <= 8) threshold += 350;
  else if (wordCount >= 20) threshold -= 250;

  // 若明显已成句，适当提前截断，减少延迟
  if (/[.!?…]$/.test(cleanText)) threshold -= 450;
  else if (/[,;:]$/.test(cleanText)) threshold += 250;

  // 超长 active 文本避免无限等待
  if (cleanText.length > 160) threshold -= 350;

  return clamp(threshold, 900, 2800);
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

const polishWithAI = async (rawEn) => {
  const url = `/api/polish`; 
  
  const payload = {
    model: modelName,
    messages: [
      {
        role: "system",
        // 核心修复：强化“保真优先 + 不劣于机译”的系统指令
        content: `You are a professional interpreter and context analyzer. IMPORTANT: You must output strictly a **JSON object** containing a "segments" array.

        HARD QUALITY BAR:
        1. Your Chinese translation quality must be at least as good as literal machine translation baseline.
        2. Never omit, summarize, or weaken factual details.
        3. Keep technical terms, numbers, names, versions, API names and code identifiers accurate.
        4. If a phrase is uncertain, prefer conservative literal translation over free paraphrase.

        STEP 1: Split into segments ONLY when speaker clearly changes. Keep continuous speech together.
        STEP 2: Infer speaker role (e.g., "👩‍🏫 主讲人", "🙋‍♂️ 提问者", "🗣️ 互动者").
        STEP 3: Correct English punctuation only. Do NOT rewrite meaning.
        STEP 4: Translate ENTIRE text into polished Simplified Chinese with full fidelity.
        STEP 5: Self-check before output:
          - no missing clauses
          - no missing numbers/entities
          - no markdown fences or explanations
          - output valid JSON only

        Output EXACTLY this JSON format:
        {
          "segments": [
            {
              "speaker": "role with emoji",
              "en": "Corrected English text without speaker prefixes",
              "zh": "Polished Chinese translation without speaker prefixes"
            }
          ]
        }`,
      },
      {
        role: "user",
        content: `Raw text: "${rawEn}"`,
      },
    ],
    response_format: { type: "json_object" },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (data.error) {
    console.error("API Error Detail:", data.error.message);
    throw new Error(data.error.message);
  }

  const textResult = data.choices[0].message.content;
  let parsed = {};
  
  // 核心修复：超强容错解析机制
  try {
    let cleanText = textResult.replace(/```json/gi, "").replace(/```/g, "").trim();
    
    // 智能截取首尾的括号，防止 AI 在前后加了废话或者返回破损的结构
    const firstBrace = cleanText.indexOf('{');
    const firstBracket = cleanText.indexOf('[');
    let startIdx = -1;
    if (firstBrace !== -1 && firstBracket !== -1) {
        startIdx = Math.min(firstBrace, firstBracket);
    } else {
        startIdx = Math.max(firstBrace, firstBracket);
    }

    if (startIdx !== -1) {
        const lastBrace = cleanText.lastIndexOf('}');
        const lastBracket = cleanText.lastIndexOf(']');
        const endIdx = Math.max(lastBrace, lastBracket);
        if (endIdx !== -1 && endIdx >= startIdx) {
            cleanText = cleanText.substring(startIdx, endIdx + 1);
        } else {
            cleanText = cleanText.substring(startIdx);
        }
    }

    parsed = JSON.parse(cleanText);
  } catch (e) {
    console.warn("AI JSON 解析失败，抛出异常触发机译兜底。Raw output:", textResult);
    // 绝不返回乱码展示在页面上！抛出异常让外层触发安全的机器翻译兜底。
    throw new Error("AI 返回了无法解析的乱码");
  }
  
  // 智能寻找 segments 的位置（应对 AI 随性修改 JSON 层级的问题）
  let segments = [];
  if (Array.isArray(parsed)) {
    segments = parsed;
  } else if (parsed && Array.isArray(parsed.segments)) {
    segments = parsed.segments;
  } else if (parsed && parsed.result && Array.isArray(parsed.result.segments)) {
    segments = parsed.result.segments;
  } else if (parsed && typeof parsed === 'object') {
    segments = [parsed];
  }

  // 过滤出有效数据
  const validSegments = segments
    .filter(seg => seg && (seg.en || seg.zh)) 
    .map(seg => ({
      speaker: seg.speaker || "👩‍🏫 主讲人",
      en: seg.en || seg.correctedEn || rawEn,
      zh: seg.zh || seg.polishedZh || ""
    }));

  if (validSegments.length > 0 && validSegments.every((seg) => String(seg.zh || "").trim())) {
    return validSegments;
  }

  // 终极兜底
  throw new Error("AI 返回了结构异常的数据");
};

const generateSummaryWithAI = async (fullTextContent) => {
  const url = `/api/summary`; 

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Summary request failed: ${response.status}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
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

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "20px",
        boxSizing: "border-box",
        height: "100vh",
        overflowY: "auto",
        overflowX: "hidden",
        backgroundColor: "#0f172a",
        position: "relative",
      }}
    >
      <div style={{ flex: 1, minHeight: "20px" }}></div>
      {transcripts.map((item) => (
        <div
          key={item.id}
          style={{
            backgroundColor: "#1e293b",
            borderRadius: "16px",
            padding: "16px 20px",
            marginBottom: "16px",
            boxShadow:
              "0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
            border: item.en.includes("⚠️")
              ? "1px solid #e11d48"
              : "1px solid rgba(255, 255, 255, 0.05)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: "0.75rem", padding: "2px 8px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "4px" }}>
              <User size={12} />
              {item.speaker || "👩‍🏫 主讲人"}
            </span>
          </div>
          <div
            style={{
              color: "#94a3b8",
              fontSize: "1rem",
              lineHeight: "1.5",
              marginBottom: "8px",
              fontFamily: "sans-serif",
            }}
          >
            {item.en}
          </div>
          <div
            style={{
              color: "#f8fafc",
              fontSize: "1.4rem",
              fontWeight: "bold",
              lineHeight: "1.5",
              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
              letterSpacing: "0.5px",
            }}
          >
            {item.zh}
          </div>
        </div>
      ))}

      {(activeEn || activeZh) && (
        <div
          style={{
            backgroundColor: "rgba(79, 70, 229, 0.15)",
            borderRadius: "16px",
            padding: "16px 20px",
            marginBottom: "16px",
            border: "1px solid rgba(79, 70, 229, 0.4)",
            boxShadow: "0 4px 12px rgba(79, 70, 229, 0.1)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
            <span style={{ backgroundColor: "rgba(129, 140, 248, 0.2)", color: "#a5b4fc", fontSize: "0.75rem", padding: "2px 8px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "4px" }}>
              <User size={12} />
              🕵️ 分析中...
            </span>
          </div>
          <div
            style={{
              color: "#a5b4fc",
              fontSize: "1rem",
              lineHeight: "1.5",
              marginBottom: "8px",
              fontFamily: "sans-serif",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "6px",
                backgroundColor: "#818cf8",
                borderRadius: "50%",
                marginRight: "8px",
                animation: "pulse 2s infinite",
              }}
            ></span>
            {activeEn}
          </div>
          <div
            style={{
              color: "#ffffff",
              fontSize: "1.4rem",
              fontWeight: "bold",
              lineHeight: "1.5",
              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
              letterSpacing: "0.5px",
            }}
          >
            {activeZh || "..."}
          </div>
        </div>
      )}
      <div ref={bottomRef} style={{ height: "40px", flexShrink: 0 }} />

      {/* 画中画悬浮返回按钮 */}
      {!isAutoScroll && (
        <div
          onClick={() => {
            setIsAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            position: "fixed",
            bottom: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "rgba(79, 70, 229, 0.95)",
            color: "white",
            padding: "10px 20px",
            borderRadius: "30px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: "bold",
            boxShadow: "0 4px 15px rgba(0,0,0,0.4)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "sans-serif",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          返回最新同传
        </div>
      )}
    </div>
  );
};

export default function App() {

  const [listeningMode, setListeningMode] = useState("none");
  const [isPaused, setIsPaused] = useState(false);
  const [transcripts, setTranscripts] = useState([]);
  const [recordingTime, setRecordingTime] = useState(0);

  const [activeEn, setActiveEn] = useState("");
  const [activeZh, setActiveZh] = useState("");
  const [activeConfidence, setActiveConfidence] = useState(1);
  const [errorMsg, setErrorMsg] = useState("");
  const [isSupported, setIsSupported] = useState(true);

  const [pipWindow, setPipWindow] = useState(null);
  
  // 主页面滚动相关的 Refs 和 State
  const scrollRef = useRef(null);
  const mainRef = useRef(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("default");
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const deviceMenuRef = useRef(null);

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
  const [sessionFolderHandle, setSessionFolderHandle] = useState(null);
  const [sessionFolderName, setSessionFolderName] = useState("");
  const [savedSessions, setSavedSessions] = useState([]);
  const [temporarySessions, setTemporarySessions] = useState([]);
  const [selectedSavedSession, setSelectedSavedSession] = useState(null);
  const [savedSessionsQuery, setSavedSessionsQuery] = useState("");
  const [sessionCompletionModal, setSessionCompletionModal] = useState({
    open: false,
    durationSec: 0,
    transcriptCount: 0,
    enWordCount: 0,
    zhCharCount: 0,
    mode: "mic",
  });

  // --------------------------------------------------------------------------
  // [极致无缝引擎核心 Refs]
  // --------------------------------------------------------------------------
  const recognitionRef = useRef(null);
  const targetModeRef = useRef("mic");
  const shouldListenRef = useRef(false);
  const isPausedRef = useRef(false);
  const activeBlockIdRef = useRef(Date.now().toString());
  const lastTranslatedEnRef = useRef("");
  const isTranslatingRef = useRef(false);
  const silenceTimerRef = useRef(null);
  const systemAudioStreamRef = useRef(null);
  const systemAudioTrackRef = useRef(null);
  const isResizingSidebarRef = useRef(false);
  const transcriptsRef = useRef([]);
  const lastExpandedSidebarWidthRef = useRef(240);

  const TRANSLATE_INTERVAL = 1200;

  const activeEnRef = useRef("");
  const activeZhRef = useRef("");
  const activeConfidenceRef = useRef(1);

  const processedLengthRef = useRef(0);
  const lastSessionStringRef = useRef("");
  const lastFinalSessionStringRef = useRef("");

  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

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

  // 计时器逻辑
  useEffect(() => {
    let interval = null;
    if ((listeningMode === "mic" || listeningMode === "tab") && !isPaused) {
      interval = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [listeningMode, isPaused]);

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

  const supportsDirectoryPicker =
    typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

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

  const buildSessionPayload = useCallback(
    (overrideSummary = "") => {
      const cleaned = transcripts.filter(
        (item) =>
          item &&
          item.en &&
          item.zh &&
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
        })),
      };
    },
    [summaryResult, transcripts]
  );

  const saveSessionToFolder = useCallback(
    async (overrideSummary = "") => {
      const payload = buildSessionPayload(overrideSummary);
      if (!payload.transcripts.length && !payload.summary) return false;

      if (!sessionFolderHandle) {
        setTemporarySessions((prev) => [
          {
            fileName: `temp-${payload.id}`,
            createdAt: payload.createdAt,
            summary: payload.summary,
            transcripts: payload.transcripts,
            title: payload.title,
            isTemporary: true,
          },
          ...prev,
        ]);
        return true;
      }

      try {
        const permission = await sessionFolderHandle.requestPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          setErrorMsg("未获得文件夹写入权限，无法保存本次同传记录。");
          return false;
        }

        const stamp = new Date().toISOString().replace(/[.:]/g, "-");
        const fileHandle = await sessionFolderHandle.getFileHandle(
          `classtrans_${stamp}${SESSION_FILE_SUFFIX}`,
          { create: true }
        );
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
        return true;
      } catch (err) {
        console.error("保存同传记录失败:", err);
        setErrorMsg("保存同传记录失败，请检查文件夹权限。" );
        return false;
      }
    },
    [buildSessionPayload, sessionFolderHandle]
  );

  const loadSavedSessionsFromFolder = useCallback(async (folderHandle) => {
    if (!folderHandle) {
      setSavedSessions([]);
      return;
    }

    try {
      const sessions = [];
      for await (const [name, entry] of folderHandle.entries()) {
        if (entry.kind !== "file" || !name.endsWith(SESSION_FILE_SUFFIX)) continue;

        try {
          const file = await entry.getFile();
          const text = await file.text();
          const data = JSON.parse(text);
          sessions.push({
            fileName: name,
            createdAt: data.createdAt || file.lastModified,
            summary: data.summary || "",
            transcripts: Array.isArray(data.transcripts) ? data.transcripts : [],
            title: data.title || name,
            isTemporary: false,
          });
        } catch (err) {
          console.warn("读取会话文件失败:", name, err);
        }
      }

      sessions.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setSavedSessions(sessions);
    } catch (err) {
      console.error("加载已保存会话失败:", err);
      setErrorMsg("读取文件夹中的历史会话失败，请重新选择文件夹。");
    }
  }, []);

  const pickSessionFolder = useCallback(async () => {
    if (!supportsDirectoryPicker) {
      alert("当前浏览器不支持文件夹选择功能，请使用最新版 Chrome 或 Edge。");
      return false;
    }

    try {
      const folderHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      setSessionFolderHandle(folderHandle);
      setSessionFolderName(folderHandle.name || "未命名文件夹");
      await loadSavedSessionsFromFolder(folderHandle);
      return true;
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("选择文件夹失败:", err);
        setErrorMsg("选择文件夹失败，请重试。");
      }
      return false;
    }
  }, [loadSavedSessionsFromFolder, supportsDirectoryPicker]);

  const ensureSessionFolderSelected = useCallback(async () => {
    if (sessionFolderHandle) return true;
    alert("开启同传前，请先选择或新建一个文件夹用于保存本次内容。");
    return pickSessionFolder();
  }, [pickSessionFolder, sessionFolderHandle]);

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

    if (listeningMode === "mic") {
      try {
        if (deviceId && deviceId !== "default") {
          await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId } },
          });
        } else {
          await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } catch (err) {
        console.warn("切换麦克风设备授权失败:", err);
      }

      // 关键修复：仅重启识别引擎，不触发停止收尾与生成纪要
      shouldListenRef.current = true;
      targetModeRef.current = "mic";
      if (!isPausedRef.current) {
        setErrorMsg("已切换麦克风，正在继续当前同传…");
        try {
          recognitionRef.current?.stop();
        } catch (e) {}
      }
    } else if (listeningMode === "none") {
      setTimeout(() => {
        toggleMicMode();
      }, 120);
    }
  };

  const handleMicEntryClick = async () => {
    await fetchDevices();
    setIsDeviceMenuOpen(true);
  };

  const finalizeCurrentBlock = useCallback(() => {
    const textToFinalize = smartPunctuateEnglish(activeEnRef.current, true).trim();
    if (!textToFinalize) return;

    const id = activeBlockIdRef.current;
    const currentInterimZh = activeZhRef.current;
    const blockConfidence = activeConfidenceRef.current;
    const isTabCapture = targetModeRef.current === "tab";

    setTranscripts((prev) => [
      ...prev,
      {
        id,
        en: textToFinalize,
        zh: currentInterimZh || "...",
        confidence: blockConfidence,
        lowConfidence: blockConfidence < 0.65,
        isTranslating: true,
        isPolished: false,
        fromTab: isTabCapture,
        speaker: "🕵️ 识别中...", // 初始状态为识别中，等待大模型覆盖
      },
    ]);

    activeBlockIdRef.current =
      Date.now().toString() + Math.random().toString(36).substring(2, 7);

  // 关键修复：只推进“已最终确认(final)”文本长度，避免 interim 被提前消费导致漏字
  processedLengthRef.current = lastFinalSessionStringRef.current.length;

    setActiveEn("");
    setActiveZh("");
  setActiveConfidence(1);
    activeEnRef.current = "";
    activeZhRef.current = "";
  activeConfidenceRef.current = 1;
    lastTranslatedEnRef.current = "";

    Promise.allSettled([polishWithAI(textToFinalize), translateTextBasic(textToFinalize)])
      .then((results) => {
        const aiResult = results[0];
        const basicResult = results[1];
        const basicZh =
          basicResult.status === "fulfilled" && basicResult.value
            ? String(basicResult.value)
            : "";

        let finalSegments = [];
        let degradedByQualityGate = false;

        if (aiResult.status === "fulfilled") {
          const qualityCheck = evaluateAiPolishQuality({
            rawEn: textToFinalize,
            aiSegments: aiResult.value,
            basicZh,
          });

          if (qualityCheck.ok) {
            finalSegments = aiResult.value;
          } else {
            degradedByQualityGate = true;
            console.warn("AI polish quality gate fallback:", qualityCheck.reason);
          }
        } else {
          console.warn("AI Polish failed:", aiResult.reason);
          degradedByQualityGate = true;
        }

        if (!finalSegments.length) {
          finalSegments = [
            {
              speaker: degradedByQualityGate ? "🛡️ 质量守卫(机译保底)" : "⚠️ AI超时降级",
              en: textToFinalize,
              zh: basicZh || "[基础翻译异常]",
            },
          ];
        }

        // 核心修复：用 AI 返回的数组动态分裂并替换原本的单一气泡
        setTranscripts((prev) => {
          const index = prev.findIndex((t) => t.id === id);
          if (index === -1) return prev;

          // 将数组中的每一个段落转化为独立的方框条目
          const newItems = finalSegments.map((seg, idx) => ({
            id: `${id}-split-${idx}`, // 生成新的防冲突 ID
            speaker: seg.speaker || "👩‍🏫 主讲人",
            en: smartPunctuateEnglish(seg.en || textToFinalize, true),
            zh: seg.zh || basicZh || "...",
            confidence: blockConfidence,
            lowConfidence: blockConfidence < 0.65,
            isTranslating: false,
            isPolished: !degradedByQualityGate,
            fromTab: isTabCapture,
          }));

          const updatedTranscripts = [...prev];
          // 利用 splice 将原本的 1 个“识别中”条目，无缝替换为 N 个已精调拆分好的条目
          updatedTranscripts.splice(index, 1, ...newItems);
          return updatedTranscripts;
        });
      })
      .catch((error) => {
        console.warn("Polish pipeline failed:", error);
        translateTextBasic(textToFinalize).then((basicZh) => {
          setTranscripts((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, speaker: "⚠️ AI超时降级", zh: basicZh + " (机译兜底)", isTranslating: false, isPolished: false }
                : t
            )
          );
        });
      });
  }, []);

  useEffect(() => {
    const intervalId = setInterval(async () => {
      if ((listeningMode !== "mic" && listeningMode !== "tab") || isPaused) return;

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
          const zh = await translateTextBasic(textToTranslate);
          if (currentBlockId === activeBlockIdRef.current) {
            setActiveZh(zh);
            activeZhRef.current = zh;
            lastTranslatedEnRef.current = textToTranslate;
          }
        } catch (error) {
          console.error("Real-time basic translation error", error);
        } finally {
          isTranslatingRef.current = false;
        }
      }
    }, TRANSLATE_INTERVAL);
    return () => clearInterval(intervalId);
  }, [listeningMode, isPaused]);

  const initSpeechRecognition = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsSupported(false);
      setErrorMsg("您的浏览器不支持语音识别 API。");
      return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
  recognition.maxAlternatives = 5;

    recognition.onstart = () => {
      setListeningMode(targetModeRef.current === "tab" ? "tab" : "mic");
      setIsPaused(false);
      isPausedRef.current = false;
      setErrorMsg("");
    };

    recognition.onresult = (event) => {
      if (isPausedRef.current) return; 

      let currentSessionFullText = "";
      let currentSessionFinalText = "";
      let latestConfidence = 0;
      for (let i = 0; i < event.results.length; ++i) {
        const result = event.results[i];
        const transcript = pickBestTranscriptAlternative(result);
        if (!transcript) continue;

        latestConfidence = Math.max(
          latestConfidence,
          pickBestAlternativeConfidence(result)
        );

        currentSessionFullText +=
          (currentSessionFullText ? " " : "") + transcript;

        if (result.isFinal) {
          currentSessionFinalText +=
            (currentSessionFinalText ? " " : "") + transcript;
        }
      }
      lastSessionStringRef.current = currentSessionFullText;
      lastFinalSessionStringRef.current = currentSessionFinalText;

      const safeProcessedLength = Math.min(
        processedLengthRef.current,
        currentSessionFullText.length
      );
      const activeNewTextRaw = currentSessionFullText.substring(
        safeProcessedLength
      );
      const activeNewText = smartPunctuateEnglish(activeNewTextRaw, false);
      const safeConfidence = clamp(latestConfidence || activeConfidenceRef.current || 0, 0, 1);

      setActiveEn(activeNewText);
      setActiveConfidence(safeConfidence);
      activeEnRef.current = activeNewText;
      activeConfidenceRef.current = safeConfidence;

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (activeNewText.trim()) {
        const adaptiveThreshold = getAdaptivePauseThreshold(activeNewText);
        silenceTimerRef.current = setTimeout(() => {
          finalizeCurrentBlock();
        }, adaptiveThreshold);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed") {
        setErrorMsg("麦克风权限被拒绝。");
        shouldListenRef.current = false;
        setListeningMode("none");
      }
    };

    recognition.onend = () => {
      if (activeEnRef.current.trim()) finalizeCurrentBlock();

      processedLengthRef.current = 0;
      lastSessionStringRef.current = "";
      lastFinalSessionStringRef.current = "";

      if (shouldListenRef.current && !isPausedRef.current) {
        try {
          if (targetModeRef.current === "tab" && systemAudioTrackRef.current) {
            recognition.start(systemAudioTrackRef.current);
          } else {
            recognition.start();
          }
        } catch (e) {
          setListeningMode("none");
        }
      } else if (!shouldListenRef.current) {
        setListeningMode("none");
      }
    };
    return recognition;
  };

  useEffect(() => {
    recognitionRef.current = initSpeechRecognition();
    return () => {
      shouldListenRef.current = false;
      if (recognitionRef.current) recognitionRef.current.stop();
      stopSystemAudioCapture();
    };
  }, [finalizeCurrentBlock, stopSystemAudioCapture]);

  const autoSaveCurrentSessionWithSummary = useCallback(async (options = {}) => {
    const {
      showCompletionModal = false,
      sessionDurationSec = 0,
      restartMode = "mic",
    } = options;

    const isAiPolishPending = (item) => {
      if (!item) return false;
      if (item.isTranslating) return true;
      const speaker = String(item.speaker || "");
      // 防止出现状态不同步：即使 isTranslating 被错误置为 false，仍以“识别中”作为未完成信号
      return /识别中/.test(speaker);
    };

    const updatePolishProgress = () => {
      const current = transcriptsRef.current;
      const total = current.length;
      const done = current.filter((item) => !isAiPolishPending(item)).length;
      setFinalizingProgress({ done, total, phase: "polish" });
      return { done, total };
    };

    const waitForPolishCompletion = async (timeoutMs = 22000, pollMs = 250) => {
      // 先让最近一次 finalize 的 setState 落地，避免“还未入队就开始检查”的竞态
      await new Promise((resolve) => setTimeout(resolve, 120));

      updatePolishProgress();

      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        updatePolishProgress();
        const hasPending = transcriptsRef.current.some((item) => item?.isTranslating);
        if (!hasPending) return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      updatePolishProgress();
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
        await saveSessionToFolder(summaryResult);
        if (sessionFolderHandle) {
          await loadSavedSessionsFromFolder(sessionFolderHandle);
        }
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

      await saveSessionToFolder(nextSummary);
      if (sessionFolderHandle) {
        await loadSavedSessionsFromFolder(sessionFolderHandle);
      }
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
    }
  }, [
    finalizeCurrentBlock,
    loadSavedSessionsFromFolder,
    saveSessionToFolder,
    sessionFolderHandle,
    summaryResult,
  ]);

  const stopTabMode = useCallback(async () => {
    const stopDurationSec = recordingTime;
    shouldListenRef.current = false;

    // 与麦克风模式保持一致：停止时先收口当前活跃片段
    if (activeEnRef.current.trim()) {
      finalizeCurrentBlock();
    }

    try {
      recognitionRef.current?.stop();
    } catch (e) {}

    stopSystemAudioCapture();
    if (transcriptsRef.current.length > 0 || activeEnRef.current.trim()) {
      await autoSaveCurrentSessionWithSummary({
        showCompletionModal: true,
        sessionDurationSec: stopDurationSec,
        restartMode: "tab",
      });
    }

    setListeningMode("none");
    setIsPaused(false);
    isPausedRef.current = false;
  }, [autoSaveCurrentSessionWithSummary, finalizeCurrentBlock, recordingTime, stopSystemAudioCapture]);

  const startTabMode = useCallback(async () => {
    if (!recognitionRef.current) return;

    if (!navigator?.mediaDevices?.getDisplayMedia) {
      alert("当前浏览器不支持系统音频采集，请升级 Chrome/Edge。\n建议改用麦克风模式。");
      return;
    }

    try {
      if (listeningMode === "mic") {
        shouldListenRef.current = false;
        recognitionRef.current.stop();
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
      setListeningMode("tab");
  setActiveView("home");

      try {
        // 优先尝试通过系统音频轨道启动（部分浏览器实验支持）
        recognitionRef.current.start(audioTrack);
      } catch (err) {
        try {
          // 兜底：退回标准 start，至少保证识别引擎进入运行态
          recognitionRef.current.start();
          setErrorMsg("当前浏览器可能不支持直接识别系统音频轨道，已启用兼容模式。建议使用 Chrome 标签页并确认勾选共享音频。");
        } catch (fallbackErr) {
          stopSystemAudioCapture();
          shouldListenRef.current = false;
          targetModeRef.current = "mic";
          setListeningMode("none");
          alert("系统音频识别启动失败。请在弹窗中选择 Chrome 标签页/窗口并勾选共享音频后重试。");
        }
      }

      // 双保险：若 1.2s 后仍未进入识别运行态，尝试一次标准启动
      setTimeout(() => {
        if (shouldListenRef.current && targetModeRef.current === "tab" && listeningMode === "none") {
          try {
            recognitionRef.current.start();
          } catch (e) {}
        }
      }, 1200);
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("系统音频模式启动失败:", err);
        setErrorMsg("启动系统音频模式失败，请重试。");
      }
    }
  }, [listeningMode, stopSystemAudioCapture, stopTabMode]);

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
      // 注意这里的修改：将 #pip-mount 设置为 overflow: hidden，把滚动权交还给 PipContent 组件内部，实现智能滚屏
      style.textContent = `
        body { margin: 0; padding: 0; background-color: #0f172a; overflow: hidden; }
        #pip-mount { height: 100vh; overflow: hidden; } 
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .5; }
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

  const getCleanedTranscripts = () => {
    const filteredTranscripts = [];
    const normalizeText = (text) => {
      return text
        .replace(/[^\w\s\u4e00-\u9fa5]/gi, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    };

    for (let i = 0; i < transcripts.length; i++) {
      const currentItem = transcripts[i];
      if (
        currentItem.en.includes("⚠️") ||
        currentItem.en.includes("🔊") ||
        currentItem.zh === "..."
      )
        continue;

      let isDuplicateOrSubstr = false;
      for (
        let j = Math.max(0, filteredTranscripts.length - 3);
        j < filteredTranscripts.length;
        j++
      ) {
        const prevItem = filteredTranscripts[j];
        const normCurrEn = normalizeText(currentItem.en);
        const normPrevEn = normalizeText(prevItem.en);

        if (normCurrEn.includes(normPrevEn) && normPrevEn.length > 5) {
          filteredTranscripts[j] = currentItem;
          isDuplicateOrSubstr = true;
          break;
        } else if (normPrevEn.includes(normCurrEn) && normCurrEn.length > 5) {
          isDuplicateOrSubstr = true;
          break;
        }
      }
      if (!isDuplicateOrSubstr) {
        filteredTranscripts.push(currentItem);
      }
    }
    return filteredTranscripts;
  };

  const handleGenerateSummary = async () => {
    const cleaned = getCleanedTranscripts();
    if (cleaned.length === 0) {
      alert("没有足够的记录来生成总结！");
      return;
    }
    setSummaryResult("");

    // 总结时带上发言人信息，帮助 AI 更好地区分上下文逻辑
    const fullText = cleaned
      .map((item) => `[${item.speaker || "主讲人"} - 英文]: ${item.en}\n[${item.speaker || "主讲人"} - 中文]: ${item.zh}`)
      .join("\n\n");

    try {
      const summary = await generateSummaryWithAI(fullText);
      setSummaryResult(summary);

      const saved = await saveSessionToFolder(summary);
      if (saved && sessionFolderHandle) {
        await loadSavedSessionsFromFolder(sessionFolderHandle);
      }
      setActiveView("saved");
    } catch (err) {
      console.error(err);
      setSummaryResult(`⚠️ 生成总结失败：\n${err.message}`);
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
    if (!recognitionRef.current) return;

    if (listeningMode === "mic") {
      const stopDurationSec = recordingTime;
      shouldListenRef.current = false;
      
      if (isPausedRef.current) {
        setListeningMode("none");
        setIsPaused(false);
        isPausedRef.current = false;
      }
      
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      
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

      if (selectedDeviceId !== "default") {
        try {
          await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: selectedDeviceId } },
          });
        } catch (e) {
          console.warn("尝试绑定特定麦克风失败", e);
        }
      }

      shouldListenRef.current = true;
    targetModeRef.current = "mic";
    setActiveView("home");
      setRecordingTime(0); 
      // 开启时默认将页面拽到底部
      setIsAutoScroll(true);
      
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.error("启动录音失败", e);
      }
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
      if (listeningMode === "mic") {
        try {
          recognitionRef.current.start();
        } catch (e) {}
      }
    } else {
      setIsPaused(true);
      isPausedRef.current = true;
      if (listeningMode === "mic") {
        recognitionRef.current.stop();
      }
    }
  };

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
  };

  const handleClearGlossary = () => {
    setCustomGlossaryPairs([]);
    setRuntimeCustomGlossaryPairs([]);
    setGlossaryDraft("");
    setGlossaryError("");
    window.localStorage.removeItem(GLOSSARY_STORAGE_KEY);
  };

  const openSavedSessions = async () => {
    if (sessionFolderHandle) {
      await loadSavedSessionsFromFolder(sessionFolderHandle);
    }
    setSelectedSavedSession((prev) => prev || allSavedSessions[0] || null);
    setActiveView("saved");
  };

  const handleManualSaveSession = async () => {
    const hasFolder = await ensureSessionFolderSelected();
    if (!hasFolder) return;

    const ok = await saveSessionToFolder();
    if (ok && sessionFolderHandle) {
      await loadSavedSessionsFromFolder(sessionFolderHandle);
      alert("本次同传记录已保存到所选文件夹。");
    }
  };

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

      if (!sessionFolderHandle) return;

      const shouldDelete = window.confirm(`确认删除会话文件：${session.fileName}？此操作不可恢复。`);
      if (!shouldDelete) return;

      try {
        const permission = await sessionFolderHandle.requestPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          alert("未获得删除权限，请重新授权文件夹权限。");
          return;
        }

        await sessionFolderHandle.removeEntry(session.fileName);
        if (selectedSavedSession?.fileName === session.fileName) {
          setSelectedSavedSession(null);
        }
        await loadSavedSessionsFromFolder(sessionFolderHandle);
      } catch (err) {
        console.error("删除会话失败:", err);
        alert("删除失败，请检查文件夹权限或稍后重试。");
      }
    },
    [loadSavedSessionsFromFolder, selectedSavedSession?.fileName, sessionFolderHandle]
  );

  if (!isSupported) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center border border-red-100">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-800 mb-2">浏览器不支持</h2>
          <p className="text-gray-600">{errorMsg}</p>
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
  const filteredSavedSessions = allSavedSessions.filter((session) => {
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
    <div className="h-screen bg-slate-50 flex font-sans relative overflow-hidden">
      <aside
        style={{ width: `${isSidebarCollapsed ? 72 : sidebarWidth}px` }}
        className="h-full bg-white border-r border-slate-200 shadow-sm shrink-0 relative"
      >
        <div className="h-full flex flex-col">
          <div className={`border-b border-slate-100 ${isSidebarCollapsed ? "px-2 py-3" : "px-4 py-4"}`}>
            <div className="flex items-center justify-between gap-2">
              {!isSidebarCollapsed && (
                <div>
                  <h2 className="text-lg font-bold text-slate-800">ClassTrans Pro</h2>
                  <p className="text-xs text-slate-500 mt-1">课堂控制台</p>
                </div>
              )}
              <button
                onClick={toggleSidebarCollapse}
                className="h-8 w-8 rounded-lg border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 flex items-center justify-center"
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
                  ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
              title="首页（同传）"
            >
              <Home className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>首页（同传）</span>}
            </button>

            <button
              onClick={pickSessionFolder}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 transition-colors`}
              title={sessionFolderName ? `保存文件夹：${sessionFolderName}` : "保存文件夹"}
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>保存文件夹</span>}
            </button>

            <button
              onClick={openSavedSessions}
              className={`w-full ${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                activeView === "saved"
                  ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
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
                  ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
              title="术语词典"
            >
              <Settings className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>术语词典</span>}
            </button>
          </div>

          {!isSidebarCollapsed && (
            <div className="px-3 py-3 border-t border-slate-100 text-xs text-slate-500">
              {sessionFolderName
                ? `当前目录：${sessionFolderName}`
                : "当前为临时转录模式（未选择保存目录）"}
            </div>
          )}
        </div>

        {!isSidebarCollapsed && (
          <div
            onMouseDown={startSidebarResize}
            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-indigo-200/70 transition-colors"
            title="拖拽调整侧栏宽度"
          />
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 relative overflow-hidden">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm shrink-0">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          <div className="flex items-center space-x-3 w-full lg:w-auto justify-center lg:justify-start">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-inner relative overflow-hidden shrink-0">
              <Globe className="w-6 h-6 text-white relative z-10" />
              <div className="absolute inset-0 bg-gradient-to-tr from-indigo-600 to-purple-500 z-0"></div>
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-800 leading-tight flex items-center">
                ClassTrans{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600 ml-1">
                  Pro
                </span>
              </h1>
              <p className="text-xs text-slate-500 font-medium">
                同传翻译 · 智能纪要
              </p>
              {!sessionFolderHandle && (
                <p className="text-[11px] text-amber-600 font-medium mt-0.5">
                  当前为临时转录模式（未绑定保存文件夹）
                </p>
              )}
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
                className="flex items-center space-x-1 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-200 transition-colors max-w-[150px] truncate border border-slate-200"
                title="选择录音设备"
              >
                <Settings className="w-3 h-3 shrink-0" />
                <span className="truncate">{currentDeviceName}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>

              {isDeviceMenuOpen && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-slate-100 rounded-xl shadow-lg z-50 py-1 max-h-64 overflow-y-auto">
                  {devices.length === 0 ? (
                    <div className="px-4 py-3 text-xs text-slate-500">
                      未检测到麦克风，请检查权限
                    </div>
                  ) : (
                    devices.map((device) => (
                      <button
                        key={device.deviceId}
                        onClick={() => handleDeviceChange(device.deviceId)}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-indigo-50 hover:text-indigo-700 transition-colors truncate ${
                          selectedDeviceId === device.deviceId
                            ? "bg-indigo-50/50 text-indigo-600 font-semibold"
                            : "text-slate-700"
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

            {transcripts.length > 0 && (
              <button
                onClick={handleGenerateSummary}
                className="flex items-center space-x-1 p-2 bg-purple-50 text-purple-600 hover:bg-purple-100 rounded-lg transition-colors text-sm font-medium border border-purple-100"
                title="AI 一键生成课堂纪要"
              >
                <FileText className="w-4 h-4" />
                <span className="hidden lg:inline">生成纪要</span>
              </button>
            )}

            <div className="h-6 w-px bg-slate-200 mx-1 hidden sm:block"></div>

            {transcripts.length > 0 && (
              <button
                onClick={handleManualSaveSession}
                className="p-2 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-100"
                title="保存当前同传到所选文件夹"
              >
                <Save className="w-4 h-4" />
              </button>
            )}

            <button
              onClick={togglePip}
              className={`p-2 rounded-lg transition-colors flex items-center justify-center border ${
                pipWindow
                  ? "bg-indigo-100 text-indigo-700 border-indigo-200"
                  : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-100 hover:border-slate-200"
              }`}
              title={pipWindow ? "关闭悬浮气泡字幕" : "开启悬浮气泡字幕"}
            >
              <PictureInPicture className="w-4 h-4" />
            </button>

            <button
              onClick={clearTranscripts}
              className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors border border-transparent hover:border-rose-100"
              title="清空所有记录"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {listeningMode === "none" ? (
              <button
                onClick={startTabMode}
                className="flex items-center space-x-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-purple-600 text-white hover:bg-purple-700 hover:shadow-md"
                title="系统音频录制：点击后在弹窗选择 Chrome 标签页 或 窗口"
              >
                <Headphones className="w-4 h-4" />
                <span>系统音频</span>
              </button>
            ) : (
              <div className="flex items-center space-x-2 shrink-0">
                <div className="flex items-center justify-center px-3 py-1.5 bg-slate-800 text-white rounded-lg text-sm font-mono font-bold tracking-wider shadow-inner border border-slate-700 ml-1">
                  <span
                    className={`w-2 h-2 rounded-full mr-2 ${
                      isPaused ? "bg-amber-400" : "bg-rose-500 animate-pulse"
                    }`}
                  ></span>
                  {formatTime(recordingTime)}
                </div>

                {listeningMode === "mic" && isPaused ? (
                  <button
                    onClick={togglePause}
                    className="flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-emerald-500 text-white hover:bg-emerald-600 hover:shadow-md"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">继续收音</span>
                  </button>
                ) : listeningMode === "mic" ? (
                  <button
                    onClick={togglePause}
                    className="flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-amber-100 text-amber-700 hover:bg-amber-200 border border-amber-200"
                  >
                    <Pause className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">暂时挂起</span>
                  </button>
                ) : null}
                
                <button
                  onClick={listeningMode === "mic" ? toggleMicMode : stopTabMode}
                  className="flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-rose-100 text-rose-700 hover:bg-rose-200 border border-rose-200"
                >
                  <Square className="w-4 h-4 fill-current" />
                  <span className="hidden sm:inline">彻底停止</span>
                </button>
              </div>
            )}
            </div>

            <div className="shrink-0">
              {listeningMode === "none" ? (
                <button
                  onClick={handleMicEntryClick}
                  className="flex items-center space-x-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md"
                  title="点击选择麦克风设备"
                >
                  <Mic className="w-4 h-4" />
                  <span>选择麦克风</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {errorMsg && (
        <div className="max-w-4xl mx-auto w-full px-4 mt-4 shrink-0">
          <div className="bg-rose-50 border-l-4 border-rose-500 p-4 rounded-r-lg flex items-start">
            <AlertCircle className="w-5 h-5 text-rose-500 mt-0.5 mr-3 flex-shrink-0" />
            <p className="text-sm text-rose-700">{errorMsg}</p>
          </div>
        </div>
      )}

      {isFinalizingSession && (
        <div className="max-w-4xl mx-auto w-full px-4 mt-4 shrink-0">
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
            <div className="flex items-center justify-between text-sm font-semibold text-indigo-700 mb-2">
              <span>
                {finalizingProgress.phase === "summary"
                  ? "正在生成课堂纪要..."
                  : `正在等待 AI 润色完成（${finalizingProgress.done}/${finalizingProgress.total}）`}
              </span>
              <span>{finalizingPercent}%</span>
            </div>
            <div className="h-2 bg-indigo-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-300"
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
        className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 flex flex-col gap-4 overflow-y-auto"
      >
        {activeView === "home" && (
          <>
        {transcripts.length === 0 && !activeEn && listeningMode === "none" && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 opacity-60 mt-10 md:mt-20">
            <Mic className="w-16 h-16 mb-4 stroke-[1.5] text-indigo-400" />
            <p className="text-lg text-slate-600 font-medium">
              选择麦克风，点击右上角开始上课
            </p>
            <div className="text-sm mt-4 text-center max-w-md bg-white p-4 rounded-xl border border-slate-100 shadow-sm leading-relaxed">
              <strong className="text-slate-700">💡 如何翻译网课视频？</strong>
              <br />
              0. 可直接开始临时转录；若希望自动存档，再点顶部
              <strong className="text-emerald-600">「选择保存文件夹」</strong>。
              <br />
              1. 推荐点
              <strong className="text-purple-600">「系统音频」</strong>，在弹窗中选择
              <strong className="text-purple-600">「Chrome 标签页」</strong>或
              <strong className="text-purple-600">「窗口」</strong>并勾选共享音频。
              <br />
              2. 左侧下拉框选择{" "}
              <strong className="text-indigo-500">
                立体声混音/Stereo Mix
              </strong>{" "}
              或使用虚拟声卡（如 VB-Cable）。
              <br />
              3. 或者最简单的方法：直接用手机外放声音，让电脑麦克风听见即可！
            </div>
          </div>
        )}

        {transcripts.map((item) => (
          <div
            key={item.id}
            className={`bg-white rounded-2xl p-5 shadow-sm border transition-all hover:shadow-md shrink-0 ${
              item.isPolished
                ? "border-purple-100/60 shadow-purple-900/5"
                : item.lowConfidence
                ? "border-amber-200 bg-amber-50/30"
                : "border-slate-100"
            }`}
          >
            {/* 新增：显示已入库记录的发言人标签 */}
            <div className="flex items-center text-xs font-semibold text-slate-500 mb-2 space-x-2">
              <div className="flex items-center bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200/60">
                <User className="w-3 h-3 mr-1 text-slate-400" />
                {item.speaker || "👩‍🏫 主讲人"}
              </div>
            </div>
            
            <div className="flex items-start mb-2">
              <div
                className={`text-sm md:text-base font-medium pr-8 leading-relaxed font-sans ${
                  item.isPolished || item.fromTab
                    ? "text-slate-600"
                    : "text-slate-400"
                }`}
              >
                {item.en}
              </div>
              <div className="ml-auto flex flex-col sm:flex-row items-end sm:items-center space-y-1 sm:space-y-0 sm:space-x-2">
                {item.lowConfidence && (
                  <div className="flex-shrink-0 flex items-center text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-1 rounded-md border border-amber-200">
                    <AlertCircle className="w-3 h-3 mr-1" /> 低置信度
                  </div>
                )}
                {item.isPolished && (
                  <div className="flex-shrink-0 flex items-center text-xs font-semibold text-purple-500 bg-purple-50 px-2 py-1 rounded-md border border-purple-100">
                    <Sparkles className="w-3 h-3 mr-1" /> AI精调
                  </div>
                )}
              </div>
            </div>

            <div className="relative min-h-[1.5rem]">
              {item.isTranslating ? (
                <div className="flex items-center space-x-2 text-purple-500 text-sm mt-1">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="opacity-60 line-through mr-2 text-slate-400">
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
                  className={`text-lg md:text-xl font-bold leading-relaxed tracking-wide ${
                    item.isPolished || item.fromTab
                      ? "text-slate-800"
                      : "text-slate-600"
                  } ${
                    // 修复 6：容错保护主界面的渲染崩溃问题
                    (item.en || "").includes("⚠️")
                      ? "text-rose-600 text-sm font-medium"
                      : ""
                  }`}
                >
                  {item.zh}
                </div>
              )}
            </div>
          </div>
        ))}

        {(listeningMode === "mic" || listeningMode === "tab") && (activeEn || isPaused) && (
          <div
            className={`bg-white rounded-2xl p-5 shadow-sm border-2 transition-all relative overflow-hidden shrink-0 ${
              isPaused
                ? "bg-amber-50/50 border-amber-200"
                : activeConfidence < 0.65
                ? "bg-amber-50/40 border-amber-200"
                : "bg-indigo-50/40 border-indigo-100"
            }`}
          >
            {!isPaused && (
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500/0 via-indigo-400/30 to-indigo-500/0 animate-[pulse_2s_ease-in-out_infinite]"></div>
            )}

            {/* 正在收音时，固定显示分析中 */}
            <div className="flex items-center text-xs font-bold text-indigo-500 mb-2 space-x-2">
              <div className="flex items-center bg-indigo-100/60 px-2.5 py-1 rounded-md border border-indigo-200/60">
                <User className="w-3 h-3 mr-1" />
                {listeningMode === "tab" ? "🎧 系统音频解析中..." : "🕵️ 语境分析中..."}
              </div>
            </div>

            <div className="text-slate-500 text-sm md:text-base font-medium mb-2 pr-8 leading-relaxed font-sans">
              <div>
                {activeEn}
                {!isPaused && (
                  <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-indigo-400 animate-pulse"></span>
                )}
              </div>
              {!isPaused && activeEn && activeConfidence < 0.65 && (
                <div className="mt-2 inline-flex items-center text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-1 rounded-md border border-amber-200">
                  <AlertCircle className="w-3 h-3 mr-1" /> 当前片段噪声较高，建议靠近麦克风
                </div>
              )}
            </div>

            <div className="relative min-h-[1.5rem]">
              {isPaused ? (
                <div className="flex items-center space-x-2 text-amber-600 text-sm font-medium">
                  <Pause className="w-4 h-4" />
                  <span>{listeningMode === "tab" ? "系统音频解析已挂起" : "录音已挂起，点击右上角继续"}</span>
                </div>
              ) : activeZh ? (
                <div className="text-indigo-900 text-lg md:text-xl font-bold leading-relaxed tracking-wide transition-all duration-300">
                  {activeZh}
                </div>
              ) : (
                <div className="flex items-center space-x-2 text-indigo-400 text-sm font-medium">
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
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex min-h-[70vh]">
            <div className="w-72 border-r border-slate-100 bg-slate-50 flex flex-col shrink-0">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-sm">已保存会话</h3>
                <button
                  onClick={openSavedSessions}
                  className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
                >
                  刷新
                </button>
              </div>
              <div className="px-3 py-2 border-b border-slate-100 bg-white">
                <input
                  value={savedSessionsQuery}
                  onChange={(e) => setSavedSessionsQuery(e.target.value)}
                  placeholder="搜索标题 / 关键词"
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
              <div className="overflow-y-auto flex-1">
                {filteredSavedSessions.length === 0 ? (
                  <p className="text-xs text-slate-500 px-4 py-5">
                    {allSavedSessions.length === 0 ? "暂无已保存会话。" : "未匹配到相关会话。"}
                  </p>
                ) : (
                  filteredSavedSessions.map((session) => (
                    <button
                      key={session.fileName}
                      onClick={() => setSelectedSavedSession(session)}
                      className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-indigo-50 transition-colors ${
                        selectedSavedSession?.fileName === session.fileName
                          ? "bg-indigo-50"
                          : "bg-transparent"
                      }`}
                    >
                      <div className="text-xs font-semibold text-slate-700 truncate">
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
              <div className="px-6 py-4 border-b border-slate-100 bg-white">
                <h3 className="font-bold text-slate-800">
                  {selectedSavedSession?.title || "请选择左侧会话"}
                </h3>
                {selectedSavedSession && (
                  <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                    <p className="text-xs text-slate-500">
                      {new Date(selectedSavedSession.createdAt).toLocaleString()} · {selectedSavedSession.transcripts.length} 条转录
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => exportSavedSessionToWord(selectedSavedSession)}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                      >
                        导出 Word
                      </button>
                      <button
                        onClick={() => exportSavedSessionToPdf(selectedSavedSession)}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-slate-700 text-white hover:bg-slate-800"
                      >
                        导出 PDF
                      </button>
                      <button
                        onClick={() => handleDeleteSavedSession(selectedSavedSession)}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                {!selectedSavedSession ? (
                  <div className="text-sm text-slate-500">选择一条会话后，这里会展示转录内容与课堂纪要。</div>
                ) : (
                  <>
                    <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-4">
                      <h4 className="font-semibold text-indigo-900 mb-2">课堂纪要</h4>
                      <div
                        className="text-sm text-slate-700 leading-relaxed break-words [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-slate-900 [&_h1]:mt-3 [&_h1]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-slate-900 [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:my-1 [&_blockquote]:border-l-4 [&_blockquote]:border-indigo-300 [&_blockquote]:bg-white/70 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:rounded-r-md [&_code]:bg-slate-200 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_pre]:bg-slate-900 [&_pre]:text-slate-100 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:my-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:my-3 [&_a]:text-indigo-700 [&_a]:underline"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdownToSafeHtml(
                            selectedSavedSession.summary || "（该会话未保存纪要）"
                          ),
                        }}
                      />
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-semibold text-slate-800">转录内容</h4>
                      {selectedSavedSession.transcripts.length === 0 ? (
                        <p className="text-sm text-slate-500">（该会话暂无转录内容）</p>
                      ) : (
                        selectedSavedSession.transcripts.map((item, idx) => (
                          <div key={`${selectedSavedSession.fileName}-${idx}`} className="border border-slate-100 rounded-xl p-4 bg-white">
                            <div className="text-xs text-slate-500 font-semibold mb-2">{item.speaker || "👩‍🏫 主讲人"}</div>
                            <div className="text-sm text-slate-600 leading-relaxed">{item.en}</div>
                            <div className="text-base text-slate-900 font-semibold mt-2 leading-relaxed">{item.zh}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeView === "glossary" && (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4 min-h-[70vh]">
            <h2 className="text-lg font-bold text-indigo-900">课堂术语词典</h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              每行一条规则，格式：<span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">原词 =&gt; 纠正词</span>。
              保存后会立刻作用于实时英文识别。
            </p>
            <p className="text-xs text-slate-500">已启用自定义术语：{customGlossaryPairs.length} 条</p>

            <textarea
              value={glossaryDraft}
              onChange={(e) => {
                setGlossaryDraft(e.target.value);
                if (glossaryError) setGlossaryError("");
              }}
              className="w-full min-h-[360px] rounded-xl border border-slate-200 p-4 text-sm leading-relaxed font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              placeholder={["chat g p t => ChatGPT", "open ai => OpenAI", "type script => TypeScript"].join("\n")}
            />

            {glossaryError && (
              <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                {glossaryError}
              </div>
            )}

            <div className="flex flex-wrap gap-2 justify-between">
              <button
                onClick={handleClearGlossary}
                className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
              >
                清空自定义词典
              </button>
              <button
                onClick={handleSaveGlossary}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
              >
                保存并应用
              </button>
            </div>
          </div>
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
        <div className="absolute inset-0 z-40 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6">
            <h3 className="text-lg font-bold text-slate-900">本次录制已完成</h3>
            <p className="text-sm text-slate-500 mt-1">
              AI 润色与纪要已处理完成，下面是本次同传统计：
            </p>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2">
                <p className="text-xs text-indigo-600 font-semibold">录制时长</p>
                <p className="text-base font-bold text-indigo-900 mt-1">{formatTime(sessionCompletionModal.durationSec)}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500 font-semibold">转录块数</p>
                <p className="text-base font-bold text-slate-900 mt-1">{sessionCompletionModal.transcriptCount}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500 font-semibold">英文词数</p>
                <p className="text-base font-bold text-slate-900 mt-1">{sessionCompletionModal.enWordCount}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500 font-semibold">中文字数</p>
                <p className="text-base font-bold text-slate-900 mt-1">{sessionCompletionModal.zhCharCount}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                onClick={() => setSessionCompletionModal((prev) => ({ ...prev, open: false }))}
                className="px-3.5 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100"
              >
                稍后再录
              </button>
              <button
                onClick={handleStartNextRecording}
                className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
              >
                开始下一场录制
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center py-4 text-xs text-slate-400 flex flex-wrap items-center justify-center gap-2 shrink-0 border-t border-slate-200 bg-slate-50">
        <span>Dual Mode Translation Engine</span>
        <span className="hidden sm:inline w-1 h-1 rounded-full bg-slate-300"></span>
        <span>Aliyun DashScope & Web Speech API</span>
      </footer>
      </div>
    </div>
  );
}