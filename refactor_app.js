const fs = require('fs');
let code = fs.readFileSync('src/App.js', 'utf8');

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

// 2. Rename export default function App() to MainApp
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

// 3. Replace API authorization
code = code.replace(/headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\}/g, 
  `headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${authSession?.access_token}\` }`);

// write back temporarily to check
fs.writeFileSync('src/App.js.tmp', code);
console.log('App.js.tmp created');
