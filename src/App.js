import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  Square,
  Trash2,
  Globe,
  AlertCircle,
  Loader2,
  Volume2,
  Sparkles,
  Monitor,
  PictureInPicture,
  Download,
  FileText,
  ChevronDown,
  Settings,
  Pause,
  Play,
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
const modelName = "qwen3.5-flash-2026-02-23"; 

const polishWithAI = async (rawEn) => {
  const url = `/api/polish`; 
  
  const payload = {
    model: modelName,
    messages: [
      {
        role: "system",
        content: `You are a professional interpreter. IMPORTANT: You must output the result as a **json** object. 

        STEP 1: REWRITE the English text with proper punctuation.
        STEP 2: Translate it into polished Simplified Chinese.
        
        Return ONLY a valid **json** object with these exact keys: "correctedEn" and "polishedZh".`,
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
  return JSON.parse(textResult);
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

  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [summaryResult, setSummaryResult] = useState("");
  const [showSummaryModal, setShowSummaryModal] = useState(false);

  // --------------------------------------------------------------------------
  // [极致无缝引擎核心 Refs]
  // --------------------------------------------------------------------------
  const recognitionRef = useRef(null);
  const shouldListenRef = useRef(false);
  const isPausedRef = useRef(false);
  const activeBlockIdRef = useRef(Date.now().toString());
  const lastTranslatedEnRef = useRef("");
  const isTranslatingRef = useRef(false);
  const silenceTimerRef = useRef(null);

  const PAUSE_THRESHOLD = 2500; 
  const TRANSLATE_INTERVAL = 1200;

  const activeEnRef = useRef("");
  const activeZhRef = useRef("");

  const processedLengthRef = useRef(0);
  const lastSessionStringRef = useRef("");

  const fetchDevices = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const availableDevices = await navigator.mediaDevices.enumerateDevices();
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
    if (listeningMode === "mic" && !isPaused) {
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

  const handleDeviceChange = (deviceId) => {
    setSelectedDeviceId(deviceId);
    setIsDeviceMenuOpen(false);
    if (listeningMode === "mic") {
      toggleMicMode();
      setTimeout(() => toggleMicMode(), 500);
    }
  };

  const finalizeCurrentBlock = useCallback(() => {
    const textToFinalize = activeEnRef.current.trim();
    if (!textToFinalize) return;

    const id = activeBlockIdRef.current;
    const currentInterimZh = activeZhRef.current;

    setTranscripts((prev) => [
      ...prev,
      {
        id,
        en: textToFinalize,
        zh: currentInterimZh || "...",
        isTranslating: true,
        isPolished: false,
        fromTab: false,
      },
    ]);

    activeBlockIdRef.current =
      Date.now().toString() + Math.random().toString(36).substring(2, 7);

    processedLengthRef.current = lastSessionStringRef.current.length;

    setActiveEn("");
    setActiveZh("");
    activeEnRef.current = "";
    activeZhRef.current = "";
    lastTranslatedEnRef.current = "";

    polishWithAI(textToFinalize)
      .then((aiResult) => {
        setTranscripts((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  en: aiResult.correctedEn,
                  zh: aiResult.polishedZh,
                  isTranslating: false,
                  isPolished: true,
                }
              : t
          )
        );
      })
      .catch((error) => {
        console.warn("AI Polish failed:", error);
        translateTextBasic(textToFinalize).then((basicZh) => {
          setTranscripts((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, zh: basicZh, isTranslating: false, isPolished: false }
                : t
            )
          );
        });
      });
  }, []);

  useEffect(() => {
    const intervalId = setInterval(async () => {
      if (listeningMode !== "mic" || isPaused) return;

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

    recognition.onstart = () => {
      setListeningMode("mic");
      setIsPaused(false);
      isPausedRef.current = false;
      setErrorMsg("");
    };

    recognition.onresult = (event) => {
      if (isPausedRef.current) return; 

      let currentSessionFullText = "";
      for (let i = 0; i < event.results.length; ++i) {
        currentSessionFullText += event.results[i][0].transcript;
      }
      lastSessionStringRef.current = currentSessionFullText;

      const activeNewText = currentSessionFullText.substring(
        processedLengthRef.current
      );

      setActiveEn(activeNewText);
      activeEnRef.current = activeNewText;

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (activeNewText.trim()) {
        silenceTimerRef.current = setTimeout(() => {
          finalizeCurrentBlock();
        }, PAUSE_THRESHOLD);
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

      if (shouldListenRef.current && !isPausedRef.current) {
        try {
          recognition.start();
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
    };
  }, [finalizeCurrentBlock]);

  const startTabMode = () => {
    alert(
      "当前使用的阿里云文本模型不支持原生音频流解析。请使用『麦克风上课』模式，并将网课声音通过扬声器外放以实现无缝翻译！"
    );
  };

  const stopTabMode = () => {
    setListeningMode("none");
    setIsPaused(false);
    isPausedRef.current = false;
  };

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

  const exportToWord = () => {
    if (transcripts.length === 0) {
      alert("没有可导出的翻译记录！");
      return;
    }

    const filteredTranscripts = getCleanedTranscripts();
    let htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="utf-8">
        <title>课堂翻译记录</title>
        <style>
          body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; font-size: 14pt; line-height: 1.6; }
          .entry { margin-bottom: 20px; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
          .en { color: #555; font-size: 12pt; margin-bottom: 8px; }
          .zh { color: #000; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1 style="text-align: center;">课堂同传记录</h1>
        <p style="text-align: center; color: #666;">生成时间：${new Date().toLocaleString()}</p>
        <hr>
    `;

    filteredTranscripts.forEach((item) => {
      htmlContent += `
        <div class="entry">
          <div class="en">${item.en}</div>
          <div class="zh">${item.zh}</div>
        </div>
      `;
    });
    htmlContent += `</body></html>`;

    const blob = new Blob(["\ufeff", htmlContent], {
      type: "application/msword",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `课堂翻译记录_${new Date()
      .toLocaleDateString()
      .replace(/[\/:]/g, "")}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportSummaryToWord = () => {
    if (!summaryResult) return;
    const formattedSummary = summaryResult.replace(/\n/g, "<br/>");
    let htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="utf-8">
        <title>AI 课堂纪要</title>
        <style>
          body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; font-size: 12pt; line-height: 1.8; }
          h1 { text-align: center; color: #333; }
        </style>
      </head>
      <body>
        <h1>💡 AI 课堂纪要总结</h1>
        <p style="text-align: center; color: #666; font-size: 10pt;">生成时间：${new Date().toLocaleString()}</p>
        <hr>
        <div style="margin-top: 20px;">
          ${formattedSummary}
        </div>
      </body>
      </html>
    `;

    const blob = new Blob(["\ufeff", htmlContent], {
      type: "application/msword",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `AI课堂纪要_${new Date()
      .toLocaleDateString()
      .replace(/[\/:]/g, "")}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleGenerateSummary = async () => {
    const cleaned = getCleanedTranscripts();
    if (cleaned.length === 0) {
      alert("没有足够的记录来生成总结！");
      return;
    }
    setIsGeneratingSummary(true);
    setShowSummaryModal(true);
    setSummaryResult("");

    const fullText = cleaned
      .map((item) => `[英文]: ${item.en}\n[中文]: ${item.zh}`)
      .join("\n\n");

    try {
      const summary = await generateSummaryWithAI(fullText);
      setSummaryResult(summary);
    } catch (err) {
      console.error(err);
      setSummaryResult(`⚠️ 生成总结失败：\n${err.message}`);
    } finally {
      setIsGeneratingSummary(false);
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
    } else {
      if (listeningMode === "tab") stopTabMode();

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
    activeEnRef.current = "";
    activeZhRef.current = "";
    processedLengthRef.current = 0;
    lastSessionStringRef.current = "";
    lastTranslatedEnRef.current = "";
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  };

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

  return (
    // 修复：将 min-h-screen 更改为 h-screen 和 overflow-hidden，让主页面的 scroll 事件正确挂载在 main 元素上
    <div className="h-screen bg-slate-50 flex flex-col font-sans relative overflow-hidden">
      {/* AI 纪要弹窗 */}
      {showSummaryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-indigo-50/50">
              <h2 className="text-lg font-bold text-indigo-900 flex items-center">
                <Sparkles className="w-5 h-5 text-indigo-500 mr-2" /> AI
                课堂纪要
              </h2>
              <button
                onClick={() => setShowSummaryModal(false)}
                className="text-slate-400 hover:text-slate-700 bg-white p-1 rounded-md shadow-sm"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto">
              {isGeneratingSummary ? (
                <div className="flex flex-col items-center justify-center h-48 space-y-4">
                  <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                  <p className="text-slate-500 font-medium animate-pulse">
                    AI 正在阅读全文并提炼要点，请稍候...
                  </p>
                </div>
              ) : (
                <div className="text-slate-700 leading-relaxed space-y-4 whitespace-pre-wrap">
                  {summaryResult}
                </div>
              )}
            </div>

            {!isGeneratingSummary &&
              summaryResult &&
              !summaryResult.includes("失败") && (
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end">
                  <button
                    onClick={exportSummaryToWord}
                    className="flex items-center space-x-2 bg-indigo-600 text-white px-5 py-2 rounded-xl font-semibold text-sm hover:bg-indigo-700 shadow-sm transition-all"
                  >
                    <Download className="w-4 h-4" />
                    <span>导出纪要 (Word)</span>
                  </button>
                </div>
              )}
          </div>
        </div>
      )}

      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm shrink-0">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-auto py-3 md:h-16 md:py-0 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-3 w-full md:w-auto justify-center md:justify-start">
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
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center md:justify-end gap-2 w-full md:w-auto">
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
                onClick={exportToWord}
                className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-indigo-100"
                title="导出全文翻译记录为 Word"
              >
                <Download className="w-4 h-4" />
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
                onClick={toggleMicMode}
                className="flex items-center space-x-2 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md ml-1"
              >
                <Mic className="w-4 h-4" />
                <span>开始上课</span>
              </button>
            ) : (
              <div className="flex items-center space-x-2">
                <div className="flex items-center justify-center px-3 py-1.5 bg-slate-800 text-white rounded-lg text-sm font-mono font-bold tracking-wider shadow-inner border border-slate-700 ml-1">
                  <span
                    className={`w-2 h-2 rounded-full mr-2 ${
                      isPaused ? "bg-amber-400" : "bg-rose-500 animate-pulse"
                    }`}
                  ></span>
                  {formatTime(recordingTime)}
                </div>

                {isPaused ? (
                  <button
                    onClick={togglePause}
                    className="flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-emerald-500 text-white hover:bg-emerald-600 hover:shadow-md"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">继续收音</span>
                  </button>
                ) : (
                  <button
                    onClick={togglePause}
                    className="flex items-center space-x-1 px-4 py-2 rounded-xl font-semibold text-sm transition-all shadow-sm bg-amber-100 text-amber-700 hover:bg-amber-200 border border-amber-200"
                  >
                    <Pause className="w-4 h-4 fill-current" />
                    <span className="hidden sm:inline">暂时挂起</span>
                  </button>
                )}
                
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

      {/* 注意：给 main 添加了 ref 和 onScroll 监听 */}
      <main 
        ref={mainRef}
        onScroll={handleMainScroll}
        className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 flex flex-col gap-4 overflow-y-auto"
      >
        {transcripts.length === 0 && !activeEn && listeningMode === "none" && (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 opacity-60 mt-10 md:mt-20">
            <Mic className="w-16 h-16 mb-4 stroke-[1.5] text-indigo-400" />
            <p className="text-lg text-slate-600 font-medium">
              选择麦克风，点击右上角开始上课
            </p>
            <div className="text-sm mt-4 text-center max-w-md bg-white p-4 rounded-xl border border-slate-100 shadow-sm leading-relaxed">
              <strong className="text-slate-700">💡 如何翻译网课视频？</strong>
              <br />
              1. 左侧下拉框选择{" "}
              <strong className="text-indigo-500">
                立体声混音/Stereo Mix
              </strong>{" "}
              或使用虚拟声卡（如 VB-Cable）。
              <br />
              2. 或者最简单的方法：直接用手机外放声音，让电脑麦克风听见即可！
            </div>
          </div>
        )}

        {transcripts.map((item) => (
          <div
            key={item.id}
            className={`bg-white rounded-2xl p-5 shadow-sm border transition-all hover:shadow-md shrink-0 ${
              item.isPolished
                ? "border-purple-100/60 shadow-purple-900/5"
                : "border-slate-100"
            }`}
          >
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
                {item.fromTab && (
                  <div className="flex-shrink-0 flex items-center text-xs font-semibold text-blue-500 bg-blue-50 px-2 py-1 rounded-md border border-blue-100">
                    <Monitor className="w-3 h-3 mr-1" /> 网课直连
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
                    item.en.includes("⚠️")
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

        {listeningMode === "mic" && (activeEn || isPaused) && (
          <div
            className={`bg-white rounded-2xl p-5 shadow-sm border-2 transition-all relative overflow-hidden shrink-0 ${
              isPaused
                ? "bg-amber-50/50 border-amber-200"
                : "bg-indigo-50/40 border-indigo-100"
            }`}
          >
            {!isPaused && (
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500/0 via-indigo-400/30 to-indigo-500/0 animate-[pulse_2s_ease-in-out_infinite]"></div>
            )}

            <div className="text-slate-500 text-sm md:text-base font-medium mb-2 pr-8 leading-relaxed font-sans">
              {activeEn}
              {!isPaused && (
                <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-indigo-400 animate-pulse"></span>
              )}
            </div>

            <div className="relative min-h-[1.5rem]">
              {isPaused ? (
                <div className="flex items-center space-x-2 text-amber-600 text-sm font-medium">
                  <Pause className="w-4 h-4" />
                  <span>录音已挂起，点击右上角继续</span>
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
      </main>

      {/* 主页面智能悬浮按钮：当用户向上滚动查看记录时出现 */}
      {!isAutoScroll && (transcripts.length > 0 || activeEn) && (
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

      <footer className="text-center py-4 text-xs text-slate-400 flex flex-wrap items-center justify-center gap-2 shrink-0 border-t border-slate-200 bg-slate-50">
        <span>Dual Mode Translation Engine</span>
        <span className="hidden sm:inline w-1 h-1 rounded-full bg-slate-300"></span>
        <span>Aliyun DashScope & Web Speech API</span>
      </footer>
    </div>
  );
}