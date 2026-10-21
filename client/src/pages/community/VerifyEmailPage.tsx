import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthSplitLayout } from '../../components/community.tsx';
import { Spinner } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import { useAuth } from '../../state/AuthContext.tsx';

/** Landing page for emailed links: confirm a new account's email, or a changed email (?type=change). */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { user, refresh, community } = useAuth();
  const token = params.get('token') ?? '';
  const isChange = params.get('type') === 'change';
  const [state, setState] = useState<'working' | 'done' | 'error'>(token ? 'working' : 'error');
  const [already, setAlready] = useState(false);
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token.');
  const sent = useRef(false);

  useEffect(() => {
    // Links are single-use; StrictMode's double effect must not spend it twice.
    if (!token || sent.current) return;
    sent.current = true;
    api
      .post<{ alreadyVerified?: boolean }>(isChange ? '/auth/confirm-email-change' : '/auth/verify-email', { token })
      .then(async (result) => {
        setAlready(!!result.alreadyVerified);
        setState('done');
        await refresh().catch(() => undefined);
      })
      .catch((caught) => {
        setState('error');
        setMessage(caught instanceof ApiError ? caught.message : 'That link could not be used.');
      });
  }, [token, isChange, refresh]);

  const next =
    !user ? { to: '/login', label: 'Sign in' } : community && !community.onboardingCompleted ? { to: '/signup', label: 'Finish signing up' } : { to: '/', label: 'Go to the community' };

  return (
    <AuthSplitLayout>
      {state === 'working' && <Spinner label="Confirming your email" />}
      {state === 'done' && (
        <div role="status">
          <h2 className="text-2xl font-bold text-navy-800">{isChange ? 'Email updated' : 'Email confirmed'}</h2>
          <p className="mt-2 text-sm text-slate-600">
            {already
              ? 'This link was already used, and your email is confirmed. You are all set.'
              : isChange
                ? 'Use your new address the next time you sign in.'
                : 'Thanks! Your email address is confirmed.'}
          </p>
          <Link to={next.to} className="btn-primary mt-6">
            {next.label}
          </Link>
        </div>
      )}
      {state === 'error' && (
        <div role="alert">
          <h2 className="text-2xl font-bold text-navy-800">That link didn't work</h2>
          <p className="mt-2 text-sm text-slate-600">{message}</p>
          <Link to={user ? '/signup' : '/login'} className="btn-ghost mt-6">
            {user ? 'Request a new link' : 'Sign in'}
          </Link>
        </div>
      )}
    </AuthSplitLayout>
  );
}
