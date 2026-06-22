import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// AuthPage – Login / Register with dark glassmorphism card
// ---------------------------------------------------------------------------
export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // ---- Switch mode & reset transient state --------------------------------
  const switchMode = (newMode) => {
    setMode(newMode);
    setError('');
    setSuccess('');
    setPassword('');
    setConfirmPassword('');
  };

  // ---- Form submission ----------------------------------------------------
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (mode === 'register') {
        if (password.length < 6) {
          setError('密码至少需要 6 个字符');
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError('两次输入的密码不一致');
          setLoading(false);
          return;
        }
        const { error: signUpError } = await signUp(email, password, displayName);
        if (signUpError) {
          setError(signUpError.message);
        } else {
          setSuccess('注册成功！请查看邮箱完成验证后再登录。');
          setMode('login');
          setPassword('');
          setConfirmPassword('');
        }
      } else {
        const { error: signInError } = await signIn(email, password);
        if (signInError) {
          if (signInError.message.includes('Invalid login')) {
            setError('邮箱或密码错误');
          } else if (signInError.message.includes('Email not confirmed')) {
            setError('请先查看邮箱完成验证');
          } else {
            setError(signInError.message);
          }
        }
        // On successful login the AuthContext will redirect automatically
      }
    } catch (err) {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // ---- Render -------------------------------------------------------------
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-4 py-12 relative overflow-hidden">
      {/* Decorative background blobs */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-indigo-500/10 blur-3xl" />

      <div className="w-full max-w-md relative z-10">
        {/* ---- Branding ---- */}
        <div className="text-center mb-8 animate-fade-in">
          {/* Glowing icon circle */}
          <div className="mx-auto mb-4 w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/25">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">
            ClassTrans Pro
          </h1>
          <p className="text-slate-400 text-sm mt-1">课堂录音 → 结构化笔记</p>
        </div>

        {/* ---- Glass card ---- */}
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl shadow-black/30">
          {/* Tab switcher */}
          <div className="flex mb-6 bg-white/5 rounded-lg p-1">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-md transition-all duration-300 ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-cyan-500/80 to-indigo-500/80 text-white shadow-lg shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-md transition-all duration-300 ${
                mode === 'register'
                  ? 'bg-gradient-to-r from-cyan-500/80 to-indigo-500/80 text-white shadow-lg shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              注册
            </button>
          </div>

          {/* Success message */}
          {success && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm flex items-start gap-2">
              <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{success}</span>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-2">
              <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1.5">
                邮箱地址
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-white/5 border border-white/10 text-white placeholder-slate-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all duration-200"
              />
            </div>

            {/* Display name – register only */}
            {mode === 'register' && (
              <div className="animate-slide-down">
                <label htmlFor="displayName" className="block text-sm font-medium text-slate-300 mb-1.5">
                  显示名称 <span className="text-slate-500">（可选）</span>
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="你的名字"
                  className="w-full bg-white/5 border border-white/10 text-white placeholder-slate-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all duration-200"
                />
              </div>
            )}

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1.5">
                密码
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 6 个字符' : '输入密码'}
                minLength={mode === 'register' ? 6 : undefined}
                className="w-full bg-white/5 border border-white/10 text-white placeholder-slate-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all duration-200"
              />
            </div>

            {/* Confirm password – register only */}
            {mode === 'register' && (
              <div className="animate-slide-down">
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300 mb-1.5">
                  确认密码
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                  className="w-full bg-white/5 border border-white/10 text-white placeholder-slate-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all duration-200"
                />
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-3 text-sm transition-all duration-300 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/30 flex items-center justify-center gap-2"
            >
              {loading && (
                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {loading
                ? (mode === 'login' ? '登录中…' : '注册中…')
                : (mode === 'login' ? '登 录' : '注 册')}
            </button>
          </form>

          {/* Footer links */}
          {mode === 'login' && (
            <div className="mt-5 text-center">
              <Link
                to="/reset-password"
                className="text-sm text-slate-400 hover:text-cyan-400 transition-colors duration-200"
              >
                忘记密码?
              </Link>
            </div>
          )}
        </div>

        {/* Bottom text */}
        <p className="text-center text-xs text-slate-500 mt-6">
          继续即表示你同意我们的服务条款和隐私政策
        </p>
      </div>

      {/* Inline keyframes for animations (Tailwind-compatible) */}
      <style>{`
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(-12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slide-down {
          from { opacity: 0; max-height: 0; transform: translateY(-8px); }
          to   { opacity: 1; max-height: 120px; transform: translateY(0); }
        }
        .animate-fade-in  { animation: fade-in 0.6s ease-out both; }
        .animate-slide-down { animation: slide-down 0.3s ease-out both; }
      `}</style>
    </div>
  );
}
