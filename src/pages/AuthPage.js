import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Link } from 'react-router-dom';
import {
  Mic,
  Languages,
  Sparkles,
  FolderOpen,
  Mail,
  Lock,
  User,
  Eye,
  EyeOff,
  ArrowRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  AudioLines,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// AuthPage – Login / Register
// 左侧品牌区（桌面端）+ 右侧玻璃拟态表单卡。逻辑（signIn/signUp、校验、错误
// 文案）与旧版一致，仅重排视觉。
// ---------------------------------------------------------------------------

const FEATURES = [
  {
    icon: Mic,
    title: '实时收音转录',
    desc: '麦克风 / 系统音频双通道，课堂语音即时成文',
  },
  {
    icon: Languages,
    title: '一体化中英同传',
    desc: 'Qwen LiveTranslate 一遍过：英文原文与中文译文同步流式呈现',
  },
  {
    icon: Sparkles,
    title: 'AI 润色与课堂纪要',
    desc: '大模型深度纠错润色，一键生成结构化课堂纪要',
  },
  {
    icon: FolderOpen,
    title: '云端归档随时回看',
    desc: '按文件夹归档到云端，跨设备查阅历史课堂',
  },
];

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
  const [showPassword, setShowPassword] = useState(false);

  // ---- Switch mode & reset transient state --------------------------------
  const switchMode = (newMode) => {
    setMode(newMode);
    setError('');
    setSuccess('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
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

  const inputWrapClass =
    'relative flex items-center';
  const inputClass =
    'w-full bg-white/5 border border-white/10 text-white placeholder-slate-500 rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 focus:bg-white/[0.08] transition-all duration-200';
  const inputIconClass =
    'absolute left-3.5 w-[18px] h-[18px] text-slate-500 pointer-events-none';

  // ---- Render -------------------------------------------------------------
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-4 py-10 relative overflow-hidden">
      {/* Decorative background blobs */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[560px] h-[560px] rounded-full bg-cyan-500/10 blur-3xl animate-blob-drift" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 w-[560px] h-[560px] rounded-full bg-indigo-500/10 blur-3xl animate-blob-drift-rev" />
      <div className="pointer-events-none absolute top-1/3 left-1/2 -translate-x-1/2 w-[420px] h-[420px] rounded-full bg-purple-500/[0.07] blur-3xl" />
      {/* Faint grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%, black, transparent)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%, black, transparent)',
        }}
      />

      <div className="w-full max-w-5xl relative z-10 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-10 lg:gap-14 items-center">
        {/* ==================== 左侧品牌区（桌面端） ==================== */}
        <div className="hidden lg:block animate-fade-in">
          <div className="flex items-center gap-3.5 mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/25 shrink-0">
              <AudioLines className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight leading-tight">
                ClassTrans Pro
              </h1>
              <p className="text-slate-400 text-sm mt-0.5">课堂录音 → 实时同传 → 结构化笔记</p>
            </div>
          </div>

          <h2 className="text-2xl xl:text-3xl font-bold text-slate-100 leading-snug tracking-tight">
            听得懂的课堂，
            <br />
            从<span className="bg-gradient-to-r from-cyan-400 to-indigo-400 bg-clip-text text-transparent">实时中英同传</span>开始
          </h2>

          <ul className="mt-8 space-y-4">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex items-start gap-3.5 group">
                <div className="w-9 h-9 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0 mt-0.5 group-hover:bg-cyan-500/15 group-hover:border-cyan-400/30 transition-colors duration-300">
                  <Icon className="w-[18px] h-[18px] text-cyan-300" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-200">{title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ==================== 右侧表单卡 ==================== */}
        <div className="w-full max-w-md mx-auto lg:mx-0 animate-fade-in-delay">
          {/* 移动端精简品牌头 */}
          <div className="text-center mb-7 lg:hidden">
            <div className="mx-auto mb-3 w-14 h-14 rounded-2xl bg-gradient-to-br from-cyan-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/25">
              <AudioLines className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">
              ClassTrans Pro
            </h1>
            <p className="text-slate-400 text-xs mt-1">课堂录音 → 实时同传 → 结构化笔记</p>
          </div>

          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-7 sm:p-8 shadow-2xl shadow-black/40 relative overflow-hidden">
            {/* 卡片顶部渐变描边 */}
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />

            <h3 className="text-lg font-bold text-slate-100 tracking-tight">
              {mode === 'login' ? '欢迎回来' : '创建账户'}
            </h3>
            <p className="text-xs text-slate-500 mt-1 mb-5">
              {mode === 'login'
                ? '登录以继续你的课堂同传与笔记'
                : '注册后即可开始录制并云端归档你的课堂'}
            </p>

            {/* Tab switcher */}
            <div className="flex mb-6 bg-black/25 rounded-xl p-1 border border-white/[0.06]">
              {[
                { key: 'login', label: '登录' },
                { key: 'register', label: '注册' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchMode(key)}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all duration-300 ${
                    mode === key
                      ? 'bg-gradient-to-r from-cyan-500/80 to-indigo-500/80 text-white shadow-lg shadow-cyan-500/20'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Success message */}
            {success && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm flex items-start gap-2">
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
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
                <div className={inputWrapClass}>
                  <Mail className={inputIconClass} />
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Display name – register only */}
              {mode === 'register' && (
                <div className="animate-slide-down">
                  <label htmlFor="displayName" className="block text-sm font-medium text-slate-300 mb-1.5">
                    显示名称 <span className="text-slate-500">（可选）</span>
                  </label>
                  <div className={inputWrapClass}>
                    <User className={inputIconClass} />
                    <input
                      id="displayName"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="你的名字"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              {/* Password */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1.5">
                  密码
                </label>
                <div className={inputWrapClass}>
                  <Lock className={inputIconClass} />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? '至少 6 个字符' : '输入密码'}
                    minLength={mode === 'register' ? 6 : undefined}
                    className={`${inputClass} pr-11`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 p-1 text-slate-500 hover:text-slate-300 transition-colors"
                    title={showPassword ? '隐藏密码' : '显示密码'}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm password – register only */}
              {mode === 'register' && (
                <div className="animate-slide-down">
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300 mb-1.5">
                    确认密码
                  </label>
                  <div className={inputWrapClass}>
                    <Lock className={inputIconClass} />
                    <input
                      id="confirmPassword"
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="再次输入密码"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              {/* Submit button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 disabled:from-slate-600 disabled:to-slate-600 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-4 py-3 text-sm transition-all duration-300 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 flex items-center justify-center gap-2 group"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : null}
                {loading
                  ? mode === 'login'
                    ? '登录中…'
                    : '注册中…'
                  : mode === 'login'
                  ? '登 录'
                  : '注 册'}
                {!loading && (
                  <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5" />
                )}
              </button>
            </form>

            {/* Footer links */}
            {mode === 'login' ? (
              <div className="mt-5 text-center">
                <Link
                  to="/reset-password"
                  className="text-sm text-slate-400 hover:text-cyan-400 transition-colors duration-200"
                >
                  忘记密码?
                </Link>
              </div>
            ) : (
              <p className="mt-5 text-center text-xs text-slate-500">
                已有账户？
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-cyan-400 hover:text-cyan-300 font-semibold ml-1 transition-colors"
                >
                  直接登录
                </button>
              </p>
            )}
          </div>

          {/* Bottom text */}
          <p className="text-center text-xs text-slate-600 mt-5">
            继续即表示你同意我们的服务条款和隐私政策
          </p>
        </div>
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
        @keyframes blob-drift {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%      { transform: translate(40px, 24px) scale(1.06); }
        }
        @keyframes blob-drift-rev {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%      { transform: translate(-36px, -20px) scale(1.05); }
        }
        .animate-fade-in        { animation: fade-in 0.6s ease-out both; }
        .animate-fade-in-delay  { animation: fade-in 0.6s ease-out 0.12s both; }
        .animate-slide-down     { animation: slide-down 0.3s ease-out both; }
        .animate-blob-drift     { animation: blob-drift 14s ease-in-out infinite; }
        .animate-blob-drift-rev { animation: blob-drift-rev 16s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
