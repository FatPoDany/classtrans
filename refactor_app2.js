const fs = require('fs');
let code = fs.readFileSync('src/App.js.tmp', 'utf8');

// 4. Remove localStorage hooks and File System API logic, replace with cloud hooks

// Replace Theme and Model state initialization
code = code.replace(/const \[uiTheme, setUiTheme\] = useState\(\(\) => \{[^]*?\}\);/, 
  `const { settings, updateSetting } = useCloudSettings(user.id);
  const uiTheme = settings.theme;
  const setUiTheme = (theme) => updateSetting('theme', theme);`);

code = code.replace(/const \[aiModelName, setAiModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const aiModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[realtimeModelName, setRealtimeModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const realtimeModelName = 'qwen-turbo';`);
code = code.replace(/const \[summaryModelName, setSummaryModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const summaryModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[asrModelName, setAsrModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const asrModelName = 'paraformer-realtime-v2';`);

// Glossary replacement
code = code.replace(/const \[customGlossaryTerms, setCustomGlossaryTerms\] = useState\(\(\) => \{[^]*?\}\);/, 
  `const { terms: customGlossaryTerms, addTerm, removeTerm } = useCloudGlossary(user.id);`);

// File system replacement
code = code.replace(/const \[savedSessions, setSavedSessions\] = useState\(\[\]\);/, 
  `const {
    sessions: savedSessions,
    loadSessions,
    saveSession: cloudSaveSession,
    getSession: cloudGetSession,
    deleteSession: cloudDeleteSession,
    updateSession: cloudUpdateSession,
    updateTranscript: cloudUpdateTranscript
  } = useCloudSessions(user.id);

  // Load sessions when the tab is opened
  useEffect(() => {
    if (activeView === 'saved') {
      loadSessions();
    }
  }, [activeView, loadSessions]);
  `);

code = code.replace(/const \[temporarySessions, setTemporarySessions\] = useState\(\[\]\);/, ``);
code = code.replace(/const \[sessionDirHandle, setSessionDirHandle\] = useState\(null\);/, ``);

// Remove local save functions completely or replace them
code = code.replace(/const autoSaveCurrentSessionWithSummary = async \(summaryText = ""\) => \{[^]*?\n  \};/m, 
`const autoSaveCurrentSessionWithSummary = async (summaryText = "") => {
    if (!currentSessionIdRef.current) return;
    const finalTranscripts = [...historicalTranscripts];
    const duration = Date.now() - sessionStartTimeRef.current;
    
    await cloudSaveSession({
      title: \`Classroom Session \${new Date().toLocaleString()}\`,
      summary: summaryText,
      durationSec: Math.floor(duration / 1000),
      wordCount: finalTranscripts.reduce((acc, t) => acc + (t.en ? t.en.split(' ').length : 0), 0),
      mode: mode,
      transcripts: finalTranscripts
    });
  };`);

// Write changes
fs.writeFileSync('src/App.js.tmp2', code);
console.log('App.js.tmp2 created');
