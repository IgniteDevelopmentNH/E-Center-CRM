import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../lib/api.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { Checkbox, Field, TextInput } from '../components/ui.tsx';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password, remember);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-navy">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <img
              src="/unh-logo.svg"
              alt="University of New Hampshire"
              className="mx-auto h-10 w-auto sm:h-12"
            />
            <h1 className="mt-6 text-3xl font-bold text-white">ECenter CRM</h1>
          </div>

          <form onSubmit={onSubmit} className="card space-y-4 p-6" noValidate>
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

            <Checkbox label="Keep me signed in" checked={remember} onChange={setRemember} />

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-navy-100">
            © University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
          </p>
        </div>
      </div>
    </div>
  );
}
