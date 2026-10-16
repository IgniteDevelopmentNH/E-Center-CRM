import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthSplitLayout } from '../../components/community.tsx';
import { Field, TextInput } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSplitLayout>
      <h2 className="text-2xl font-bold text-navy-800">Reset your password</h2>
      {done ? (
        <div role="status">
          <p className="mt-2 text-sm text-slate-600">
            If an account exists for <span className="font-semibold">{email}</span>, we've sent a link to choose a new
            password. It expires in one hour.
          </p>
          <Link to="/login" className="btn-ghost mt-6">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
          <p className="text-sm text-slate-500">Enter the email you sign in with and we'll send you a reset link.</p>
          <Field label="Email" required error={error}>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus invalid={!!error} />
          </Field>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Sending...' : 'Send reset link'}
          </button>
          <p className="text-center text-sm">
            <Link to="/login" className="font-semibold text-teal-700 hover:underline">Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthSplitLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its token.');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSplitLayout>
      <h2 className="text-2xl font-bold text-navy-800">Choose a new password</h2>
      {done ? (
        <div role="status">
          <p className="mt-2 text-sm text-slate-600">Your password has been changed. You've been signed out everywhere else.</p>
          <Link to="/login" className="btn-primary mt-6">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
          <Field label="New password" required hint="At least 8 characters.">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </Field>
          <Field label="Confirm new password" required>
            <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy || !token}>
            {busy ? 'Saving...' : 'Set new password'}
          </button>
        </form>
      )}
    </AuthSplitLayout>
  );
}
