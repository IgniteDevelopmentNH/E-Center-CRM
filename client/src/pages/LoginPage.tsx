import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { Checkbox, Field, TextInput } from '../components/ui.tsx';
import { AuthSplitLayout } from '../components/community.tsx';

/** Only same-site paths are honoured as a post-login destination. */
function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export function LoginPage() {
  const { signIn, user, isStaff } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  if (user) return <Navigate to={next ?? (isStaff ? '/admin' : '/')} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signedIn = await signIn(email, password, remember);
      navigate(next ?? (signedIn.isStaff ? '/admin' : '/'), { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSplitLayout>
      <h2 className="text-2xl font-bold text-navy-800">Sign in</h2>
      <p className="mt-1 text-sm text-slate-500">Welcome back to the UNH ECenter.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Email" required>
          <TextInput
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            placeholder="you@unh.edu"
            invalid={!!error}
          />
        </Field>

        <Field label="Password" required>
          <TextInput
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            invalid={!!error}
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Checkbox label="Keep me signed in" checked={remember} onChange={setRemember} />
          <Link to="/forgot-password" className="text-sm font-semibold text-teal-700 hover:underline">
            Forgot password?
          </Link>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">
        New to the ECenter community?{' '}
        <Link to="/signup" className="font-semibold text-teal-700 hover:underline">
          Create an account
        </Link>
      </p>
    </AuthSplitLayout>
  );
}
