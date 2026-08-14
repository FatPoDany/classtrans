import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  AudioLines,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Languages,
  Loader2,
  Lock,
  Mail,
  Mic,
  ShieldCheck,
  Sparkles,
  User,
  AlertTriangle,
} from 'lucide-react';

const FEATURES = [
  { icon: Mic, title: '低延迟转录', desc: '课堂内容边听边记' },
  { icon: Languages, title: '中英同传', desc: '原文译文同步呈现' },
  { icon: FolderOpen, title: '云端知识库', desc: '自动归档随时回看' },
];

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const switchMode = (newMode) => {
    setMode(newMode);
    setError('');
    setSuccess('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (mode === 'register') {
        if (password.length < 6) {
          setError('密码至少需要 6 个字符');
          return;
        }
        if (password !== confirmPassword) {
          setError('两次输入的密码不一致');
          return;
        }
        const { error: signUpError } = await signUp(email, password, displayName);
        if (signUpError) {
          setError(signUpError.message);
        } else {
          setSuccess('账户已创建，请前往邮箱完成验证后登录。');
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
            setError('请先前往邮箱完成账户验证');
          } else {
            setError(signInError.message);
          }
        }
      }
    } catch (err) {
      setError('网络连接异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="ct-auth-page">
      <div className="ct-auth-orb ct-auth-orb-one" />
      <div className="ct-auth-orb ct-auth-orb-two" />
      <div className="ct-auth-grid" />

      <section className="ct-auth-shell" aria-label="ClassTrans 账户入口">
        <div className="ct-auth-story">
          <div className="ct-auth-brand">
            <div className="ct-brand-mark" aria-hidden="true">
              <AudioLines />
            </div>
            <div>
              <div className="ct-brand-name">ClassTrans <span>Pro</span></div>
              <div className="ct-brand-caption">AI 课堂同传工作台</div>
            </div>
          </div>

          <div className="ct-auth-copy">
            <div className="ct-auth-kicker"><Sparkles /> 为学习者打造的实时 AI 笔记</div>
            <h1>让每一堂课，<br />沉淀为<span>可搜索的知识</span></h1>
            <p>实时捕捉课堂语音，同步完成中英翻译、智能润色与结构化纪要。专注听讲，其余交给 ClassTrans。</p>
          </div>

          <div className="ct-auth-preview" aria-hidden="true">
            <div className="ct-auth-preview-head">
              <div className="ct-preview-status"><span /> 正在同传</div>
              <div className="ct-preview-time">00:18:42</div>
            </div>
            <div className="ct-preview-line">
              <span className="ct-preview-speaker">LECTURER</span>
              <p>Neural networks learn patterns by adjusting the weights between connected layers.</p>
              <strong>神经网络通过调整相连层之间的权重来学习规律。</strong>
            </div>
            <div className="ct-preview-wave">
              {[10, 18, 28, 16, 34, 22, 42, 26, 18, 32, 14, 24, 38, 20, 12, 30, 18, 8].map((height, index) => (
                <i key={index} style={{ height }} />
              ))}
            </div>
          </div>

          <div className="ct-auth-features">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div className="ct-auth-feature" key={title}>
                <Icon />
                <div><strong>{title}</strong><span>{desc}</span></div>
              </div>
            ))}
          </div>
        </div>

        <div className="ct-auth-panel">
          <div className="ct-auth-mobile-brand">
            <div className="ct-brand-mark"><AudioLines /></div>
            <div className="ct-brand-name">ClassTrans <span>Pro</span></div>
          </div>

          <div className="ct-auth-panel-head">
            <span className="ct-auth-eyebrow">{mode === 'login' ? '欢迎回来' : '开始使用'}</span>
            <h2>{mode === 'login' ? '登录你的工作台' : '创建一个新账户'}</h2>
            <p>{mode === 'login' ? '继续整理你的课堂、录音与笔记。' : '只需一分钟，开启更专注的课堂体验。'}</p>
          </div>

          <div className="ct-auth-tabs" role="tablist" aria-label="账户操作">
            <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => switchMode('login')} className={mode === 'login' ? 'is-active' : ''}>登录</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => switchMode('register')} className={mode === 'register' ? 'is-active' : ''}>注册</button>
          </div>

          {success && <div className="ct-auth-alert is-success" role="status"><CheckCircle2 /><span>{success}</span></div>}
          {error && <div className="ct-auth-alert is-error" role="alert"><AlertTriangle /><span>{error}</span></div>}

          <form onSubmit={handleSubmit} className="ct-auth-form">
            <label className="ct-auth-field">
              <span>邮箱地址</span>
              <div><Mail /><input id="email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div>
            </label>

            {mode === 'register' && (
              <label className="ct-auth-field ct-auth-field-enter">
                <span>显示名称 <small>选填</small></span>
                <div><User /><input id="displayName" type="text" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="同学，怎么称呼你？" /></div>
              </label>
            )}

            <label className="ct-auth-field">
              <span>密码</span>
              <div>
                <Lock />
                <input id="password" type={showPassword ? 'text' : 'password'} required autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={mode === 'register' ? 6 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'register' ? '至少 6 个字符' : '输入你的密码'} />
                <button type="button" className="ct-password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? '隐藏密码' : '显示密码'} title={showPassword ? '隐藏密码' : '显示密码'}>
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </label>

            {mode === 'register' && (
              <label className="ct-auth-field ct-auth-field-enter">
                <span>确认密码</span>
                <div><Lock /><input id="confirmPassword" type={showPassword ? 'text' : 'password'} required autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" /></div>
              </label>
            )}

            {mode === 'login' && <div className="ct-auth-form-link"><Link to="/reset-password">忘记密码？</Link></div>}

            <button type="submit" className="ct-auth-submit" disabled={loading}>
              {loading ? <Loader2 className="ct-spin" /> : <span className="ct-submit-icon"><ArrowRight /></span>}
              <span>{loading ? (mode === 'login' ? '正在登录…' : '正在创建…') : (mode === 'login' ? '进入工作台' : '创建账户')}</span>
              {!loading && <ArrowRight className="ct-submit-arrow" />}
            </button>
          </form>

          <div className="ct-auth-secure"><ShieldCheck /> 登录信息经加密传输，并仅用于账户验证</div>
          <p className="ct-auth-terms">继续即表示你同意服务条款与隐私政策</p>
        </div>
      </section>
    </main>
  );
}
