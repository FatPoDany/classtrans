import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../AuthContext';

export default function ResetPasswordPage() {
  const { resetPassword, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [hasToken, setHasToken] = useState(false);
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHasToken(Boolean(window.location.hash?.includes('access_token')));
  }, []);

  const handleRequestReset = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const { error: resetError } = await resetPassword(email);
      if (resetError) setError(resetError.message);
      else setSuccess('重置链接已发送，请检查收件箱和垃圾邮件。');
    } catch (err) {
      setError('网络连接异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const handleSetPassword = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword.length < 6) {
      setError('密码至少需要 6 个字符');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await updatePassword(newPassword);
      if (updateError) setError(updateError.message);
      else {
        setSuccess('密码已更新，正在返回工作台…');
        setTimeout(() => navigate('/'), 1600);
      }
    } catch (err) {
      setError('网络连接异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="ct-auth-page ct-reset-page">
      <div className="ct-auth-orb ct-auth-orb-one" />
      <div className="ct-auth-orb ct-auth-orb-two" />
      <div className="ct-auth-grid" />

      <section className="ct-reset-shell">
        <div className="ct-reset-story">
          <div className="ct-auth-brand">
            <div className="ct-brand-mark"><AudioLines /></div>
            <div>
              <div className="ct-brand-name">ClassTrans <span>Pro</span></div>
              <div className="ct-brand-caption">AI 课堂同传工作台</div>
            </div>
          </div>
          <div className="ct-reset-illustration">
            <div className="ct-reset-shield"><ShieldCheck /></div>
            <span className="ct-reset-orbit"><KeyRound /></span>
          </div>
          <h1>{hasToken ? '创建一个新的安全密码' : '找回你的 ClassTrans 账户'}</h1>
          <p>{hasToken ? '设置完成后，你的录音、课堂笔记和云端归档都会保持原样。' : '我们会向你的注册邮箱发送一次性重置链接，账户内容不会受到影响。'}</p>
          <div className="ct-reset-note"><Lock /> 重置链接仅在短时间内有效，请勿转发给他人。</div>
        </div>

        <div className="ct-auth-panel ct-reset-panel">
          <div className="ct-auth-panel-head">
            <span className="ct-auth-eyebrow">账户安全</span>
            <h2>{hasToken ? '设置新密码' : '重置密码'}</h2>
            <p>{hasToken ? '请输入至少 6 个字符的新密码。' : '输入与你账户关联的邮箱地址。'}</p>
          </div>

          {success && <div className="ct-auth-alert is-success" role="status"><CheckCircle2 /><span>{success}</span></div>}
          {error && <div className="ct-auth-alert is-error" role="alert"><AlertTriangle /><span>{error}</span></div>}

          {!hasToken ? (
            <form onSubmit={handleRequestReset} className="ct-auth-form">
              <label className="ct-auth-field">
                <span>邮箱地址</span>
                <div><Mail /><input id="reset-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></div>
              </label>
              <button type="submit" className="ct-auth-submit" disabled={loading}>
                {loading ? <Loader2 className="ct-spin" /> : <span className="ct-submit-icon"><Mail /></span>}
                <span>{loading ? '正在发送…' : '发送重置链接'}</span>
                {!loading && <ArrowRight className="ct-submit-arrow" />}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetPassword} className="ct-auth-form">
              <label className="ct-auth-field">
                <span>新密码</span>
                <div><Lock /><input id="new-password" type="password" required minLength={6} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 6 个字符" /></div>
              </label>
              <label className="ct-auth-field">
                <span>确认新密码</span>
                <div><Lock /><input id="confirm-new-password" type="password" required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" /></div>
              </label>
              <button type="submit" className="ct-auth-submit" disabled={loading}>
                {loading ? <Loader2 className="ct-spin" /> : <span className="ct-submit-icon"><KeyRound /></span>}
                <span>{loading ? '正在更新…' : '更新密码'}</span>
                {!loading && <ArrowRight className="ct-submit-arrow" />}
              </button>
            </form>
          )}

          <Link to="/auth" className="ct-auth-back"><ArrowLeft /> 返回登录</Link>
          <div className="ct-auth-secure"><ShieldCheck /> ClassTrans 不会通过邮件向你索要密码</div>
        </div>
      </section>
    </main>
  );
}
