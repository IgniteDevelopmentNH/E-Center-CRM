import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthSplitLayout } from '../../components/community.tsx';
import { ApiError, api } from '../../lib/api.ts';

const LABELS: Record<string, string> = {
  messages: 'new direct messages',
  mentions: 'when someone mentions you',
  announcements: 'new ECenter posts and events',
};

/**
 * Opened from the link in a notification email. It asks before changing
 * anything, because email security scanners open links automatically.
 */
export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'ask' | 'busy' | 'done' | 'error'>(token ? 'ask' : 'error');
  const [message, setMessage] = useState(token ? '' : 'This link is missing its token.');
  const [preference, setPreference] = useState<string | null>(null);

  async function confirm() {
    setState('busy');
    try {
      const result = await api.post<{ preference: string }>('/community/unsubscribe', { token });
      setPreference(result.preference);
      setState('done');
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'That did not work. Please try again.');
      setState('error');
    }
  }

  return (
    <AuthSplitLayout>
      <h2 className="text-2xl font-bold text-navy-800">Email preferences</h2>
      {state === 'ask' || state === 'busy' ? (
        <>
          <p className="mt-2 text-sm text-slate-600">Stop getting this kind of email from ECenter Community?</p>
          <button type="button" className="btn-primary mt-6" onClick={confirm} disabled={state === 'busy'}>
            {state === 'busy' ? 'Saving...' : 'Unsubscribe'}
          </button>
        </>
      ) : state === 'done' ? (
        <div role="status">
          <p className="mt-2 text-sm text-slate-600">
            Done. You won't get emails about {LABELS[preference ?? ''] ?? 'this'} anymore. You can turn them back on any
            time from your profile.
          </p>
          <Link to="/profile" className="btn-ghost mt-6">Go to my profile</Link>
        </div>
      ) : (
        <p className="mt-2 text-sm text-urgent" role="alert">{message}</p>
      )}
    </AuthSplitLayout>
  );
}
