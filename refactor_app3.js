const fs = require('fs');
let code = fs.readFileSync('src/App.js.bak', 'utf8');

// 1. Add imports
const importsToAdd = `
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import AuthPage from './pages/AuthPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { useCloudSettings } from './hooks/useCloudSettings';
import { useCloudGlossary } from './hooks/useCloudGlossary';
import { useCloudSessions } from './hooks/useCloudSessions';
`;
code = code.replace(/import React.*?from "react";/, match => match + '\n' + importsToAdd);

// 2. Wrap App into MainApp
code = code.replace(/export default function App\(\) \{/, `export default function App() {
  const { user, loading, signOut, session } = useAuth();
  if (loading) return <div className="h-screen w-screen flex items-center justify-center bg-slate-950 text-white"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  return (
    <Routes>
      <Route path="/auth" element={user ? <Navigate to="/" /> : <AuthPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/*" element={user ? <MainApp user={user} signOut={signOut} authSession={session} /> : <Navigate to="/auth" />} />
    </Routes>
  );
}

function MainApp({ user, signOut, authSession }) {`);

// 3. Update the 3 AI functions to accept token
code = code.replace(/const translateRealtimeWithQwen = async \(text, customTerms, modelName\) => \{/, 
  `const translateRealtimeWithQwen = async (text, customTerms, modelName, token) => {`);
code = code.replace(/const polishWithAI = async \(.*?\) => \{/, 
  `const polishWithAI = async ({ text, translatedText, customTerms, modelName, onChunk, onDone, onError, token }) => {`);
code = code.replace(/const generateSummaryWithAI = async \(text, customTerms, modelName\) => \{/, 
  `const generateSummaryWithAI = async (text, customTerms, modelName, token) => {`);

// 4. Update fetch headers inside those functions
code = code.replace(/headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\}/g, 
  `headers: { "Content-Type": "application/json", "Authorization": token ? \`Bearer \${token}\` : "" }`);

// 5. Update call sites for the 3 AI functions
code = code.replace(/translateRealtimeWithQwen\((\w+),\s*(\w+),\s*(\w+)\)/g, `translateRealtimeWithQwen($1, $2, $3, authSession?.access_token)`);
code = code.replace(/generateSummaryWithAI\((\w+),\s*(\w+),\s*(\w+)\)/g, `generateSummaryWithAI($1, $2, $3, authSession?.access_token)`);
code = code.replace(/polishWithAI\(\{([\s\S]*?)\}\);/g, `polishWithAI({$1, token: authSession?.access_token});`);

// 6. Replace State Hooks with Cloud Hooks
code = code.replace(/const \[uiTheme, setUiTheme\] = useState\(\(\) => \{[^]*?\}\);/, 
  `const { settings, updateSetting } = useCloudSettings(user.id);
  const uiTheme = settings.theme;
  const setUiTheme = (theme) => updateSetting('theme', theme);`);

code = code.replace(/const \[aiModelName, setAiModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const aiModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[realtimeModelName, setRealtimeModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const realtimeModelName = 'qwen-turbo';`);
code = code.replace(/const \[summaryModelName, setSummaryModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const summaryModelName = 'qwen3.5-122b-a10b';`);
code = code.replace(/const \[asrModelName, setAsrModelName\] = useState\(\(\) => \{[^]*?\}\);/, `const asrModelName = 'paraformer-realtime-v2';`);
code = code.replace(/const \[customGlossaryTerms, setCustomGlossaryTerms\] = useState\(\(\) => \{[^]*?\}\);/, 
  `const { terms: customGlossaryTerms, addTerm, removeTerm } = useCloudGlossary(user.id);`);

// 7. Stub local sessions to use cloud sessions
code = code.replace(/const \[savedSessions, setSavedSessions\] = useState\(\[\]\);/, 
  `const {
    sessions: cloudSessions,
    loadSessions,
    saveSession: cloudSaveSession,
    deleteSession: cloudDeleteSession,
    updateSession: cloudUpdateSession,
    updateTranscript: cloudUpdateTranscript
  } = useCloudSessions(user.id);
  
  const savedSessions = cloudSessions;
  const setSavedSessions = () => {}; // Stubbed
  
  useEffect(() => {
    if (activeView === 'saved') loadSessions();
  }, [activeView, loadSessions]);
  `);

code = code.replace(/const \[temporarySessions, setTemporarySessions\] = useState\(\[\]\);/, 
  `const temporarySessions = [];
  const setTemporarySessions = () => {}; // Stubbed`);

code = code.replace(/const \[sessionDirHandle, setSessionDirHandle\] = useState\(null\);/, 
  `const sessionDirHandle = true; // Stubbed to always "have" a folder
  const setSessionDirHandle = () => {};`);

// 8. Replace saveSessionFile with cloud save
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

// Write out
fs.writeFileSync('src/App.js', code);
console.log('App.js rewritten successfully.');
