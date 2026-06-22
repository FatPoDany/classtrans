const fs = require('fs');
let code = fs.readFileSync('src/App.js', 'utf8');

// Add useGlobalSettings hook
code = code.replace(
  "import { useCloudSettings } from './hooks/useCloudSettings';",
  "import { useCloudSettings } from './hooks/useCloudSettings';\nimport { useGlobalSettings } from './hooks/useGlobalSettings';"
);

// Remove hardcoded AI models inside MainApp
code = code.replace(
  /const aiModelName = "qwen3\.5-122b-a10b";/,
  "// Global settings replaced hardcoded values"
);
code = code.replace(
  /const realtimeModelName = "qwen-turbo";/,
  ""
);
code = code.replace(
  /const summaryModelName = "qwen3\.5-122b-a10b";/,
  ""
);
code = code.replace(
  /const asrModelName = "paraformer-realtime-v2";/,
  ""
);

// Add the hook inside MainApp
code = code.replace(
  "const { signOut } = useAuth();",
  "const { signOut, isAdmin } = useAuth();\n  const { settings: globalSettings, loading: globalSettingsLoading, updateSettings } = useGlobalSettings();\n  const { aiModelName, realtimeModelName, summaryModelName, asrModelName } = globalSettings;"
);

// Wait for global settings to load
code = code.replace(
  "if (cloudSettingsLoading) {",
  "if (cloudSettingsLoading || globalSettingsLoading) {"
);

// Add admin sidebar button
code = code.replace(
  '<button\n              onClick={() => setActiveView("usage")}',
  `{isAdmin && (
            <button
              onClick={() => setActiveView("admin")}
              className={\`w-full \${isSidebarCollapsed ? "justify-center" : "justify-start"} flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border transition-colors \${
                activeView === "admin"
                  ? "bg-amber-500/15 text-amber-200 border-amber-400/30"
                  : "bg-white/[0.03] text-slate-400 border-white/10 hover:bg-white/[0.08] hover:text-slate-100"
              }\`}
              title="后台管理"
            >
              <Settings className="w-4 h-4 shrink-0" />
              {!isSidebarCollapsed && <span>后台管理</span>}
            </button>
            )}

            <button
              onClick={() => setActiveView("usage")}`
);

// Add admin view
const adminView = `
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
                  value={aiModelName}
                  onChange={(e) => updateSettings({ aiModelName: e.target.value })}
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">实时机翻模型 (Realtime)</label>
                <input
                  type="text"
                  value={realtimeModelName}
                  onChange={(e) => updateSettings({ realtimeModelName: e.target.value })}
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">课堂纪要模型 (Summary)</label>
                <input
                  type="text"
                  value={summaryModelName}
                  onChange={(e) => updateSettings({ summaryModelName: e.target.value })}
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-200">语音识别模型 (ASR)</label>
                <input
                  type="text"
                  value={asrModelName}
                  onChange={(e) => updateSettings({ asrModelName: e.target.value })}
                  className="ct-input w-full p-3 text-sm font-mono"
                />
              </div>
            </div>
          </div>
        )}
`;

code = code.replace(
  '{activeView === "usage" && (',
  adminView + '\n        {activeView === "usage" && ('
);

fs.writeFileSync('src/App.js', code);
