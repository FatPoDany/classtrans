const fs = require('fs');
let code = fs.readFileSync('src/App.js', 'utf8');

// 1. Add global token logic
code = code.replace(/const PARAFORMER_WS_URL = .*?;/, 
  match => match + '\n\nlet globalApiToken = "";\nexport const setGlobalApiToken = (token) => { globalApiToken = token; };\n');

// 2. Add useEffect inside MainApp to sync token
code = code.replace(/function MainApp\(\{[^}]*\}\) \{/, match => match + `\n  React.useEffect(() => { setGlobalApiToken(authSession?.access_token || ""); }, [authSession]);\n`);

// 3. Update headers in fetch calls
code = code.replace(/headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\}/g, 
  `headers: { "Content-Type": "application/json", "Authorization": globalApiToken ? \`Bearer \${globalApiToken}\` : "" }`);

// 4. Replace Theme, Models, Glossary hooks
code = code.replace(/const \[theme, setTheme\] = useState\(\(\) => \{[^]*?\}\);/m, 
  `const { settings, updateSetting } = useCloudSettings(user.id);
  const theme = settings.theme || "dark";
  const setTheme = (t) => updateSetting('theme', t);`);
// There are models defined inside MainApp:
code = code.replace(/const \[aiModelName, setAiModelName\] = useState\([^;]+;/g, `const aiModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[realtimeModelName, setRealtimeModelName\] = useState\([^;]+;/g, `const realtimeModelName = 'qwen-turbo';`);
code = code.replace(/const \[summaryModelName, setSummaryModelName\] = useState\([^;]+;/g, `const summaryModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[asrModelName, setAsrModelName\] = useState\([^;]+;/g, `const asrModelName = 'paraformer-realtime-v2';`);
// The user settings model initialization has a `useEffect` to save back to localStorage, we can safely ignore or remove them.

code = code.replace(/const \[customGlossaryTerms, setCustomGlossaryTerms\] = useState\([^;]+;/g, 
  `const { terms: customGlossaryTerms, addTerm, removeTerm, updateTerm } = useCloudGlossary(user.id);`);

// 5. Replace session states with stubs and useCloudSessions
code = code.replace(/const \[savedSessions, setSavedSessions\] = useState\(\[\]\);/g, 
  `const {
    sessions: cloudSessions,
    loadSessions,
    saveSession: cloudSaveSession,
    deleteSession: cloudDeleteSession,
    updateSession: cloudUpdateSession,
    updateTranscript: cloudUpdateTranscript
  } = useCloudSessions(user.id);
  const savedSessions = cloudSessions;
  const setSavedSessions = () => {};`);

code = code.replace(/const \[temporarySessions, setTemporarySessions\] = useState\(\[\]\);/g, 
  `const temporarySessions = [];
  const setTemporarySessions = () => {};`);

code = code.replace(/const \[sessionFolderHandle, setSessionFolderHandle\] = useState\(null\);/g, 
  `const sessionFolderHandle = true;
  const setSessionFolderHandle = () => {};`);

// 6. Rewrite autoSaveCurrentSessionWithSummary
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

fs.writeFileSync('src/App.js', code);
console.log('App.js rewritten successfully.');
