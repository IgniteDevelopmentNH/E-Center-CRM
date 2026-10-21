import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { accountTypeLabel } from '../../components/community.tsx';
import { PhotoUpload, ProfileFields, ResumeUpload, draftFrom, payloadFrom } from '../../components/profileFields.tsx';
import type { ProfileDraft } from '../../components/profileFields.tsx';
import { Checkbox, Field, TextInput } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import type { CommunityState } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

function useFieldError() {
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  return {
    error,
    clear: () => setError(null),
    capture: (caught: unknown) =>
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Something went wrong.' }),
    errorFor: (field: string) => (error?.field === field ? error.message : null),
  };
}

export function ProfilePage() {
  const { community, isStaff, setCommunity } = useAuth();

  if (!community) {
    if (!isStaff) return <Navigate to="/signup" replace />;
    return <StaffJoin onJoined={setCommunity} />;
  }
  if (community.status === 'pending' && !community.onboardingCompleted) return <Navigate to="/signup" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">My profile</h1>
          <p className="mt-1 text-sm text-slate-500">
            {accountTypeLabel(community.accountType)} ·{' '}
            {community.status === 'active' ? 'Visible to signed-in community members' : 'Not visible until your email is confirmed'}
          </p>
        </div>
        {community.status === 'active' && (
          <Link to={`/members/${community.userId}`} className="btn-ghost">View public profile</Link>
        )}
      </div>

      {community.status === 'pending' && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          Confirm your email to activate your account. <Link to="/signup" className="font-semibold underline">Resend the link</Link>
        </p>
      )}

      <ProfileForm community={community} onSaved={setCommunity} />
      <NotificationSettings community={community} onSaved={setCommunity} />
      <AccountSettings community={community} />
    </div>
  );
}

function ProfileForm({ community, onSaved }: { community: CommunityState; onSaved: (c: CommunityState) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(community));
  const [busy, setBusy] = useState(false);
  const { error, capture, clear, errorFor } = useFieldError();

  useEffect(() => setDraft(draftFrom(community)), [community.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    clear();
    try {
      const response = await api.put<{ community: CommunityState }>('/community/profile', payloadFrom(draft, community.accountType));
      onSaved(response.community);
      toast.success('Profile saved.');
    } catch (caught) {
      capture(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-6 p-6" noValidate aria-labelledby="profile-heading">
      <h2 id="profile-heading" className="text-sm font-bold uppercase tracking-wide text-navy-800">Public profile</h2>
      <PhotoUpload community={community} onUpdated={onSaved} />
      <ProfileFields accountType={community.accountType} draft={draft} onChange={setDraft} errorFor={errorFor} showNames />
      {error && !error.field && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error.message}</p>
      )}
      {error?.field && (
        <p className="text-sm font-semibold text-urgent" role="alert">Please fix the highlighted field: {error.message}</p>
      )}
      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving...' : 'Save profile'}
        </button>
      </div>
      <hr className="border-slate-100" />
      <ResumeUpload community={community} onUpdated={onSaved} />
    </form>
  );
}

function NotificationSettings({ community, onSaved }: { community: CommunityState; onSaved: (c: CommunityState) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function set(key: keyof CommunityState['notifications'], value: boolean) {
    setBusy(true);
    try {
      onSaved((await api.put<{ community: CommunityState }>('/community/profile/notifications', { [key]: value })).community);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card p-6" aria-labelledby="notify-heading">
      <h2 id="notify-heading" className="text-sm font-bold uppercase tracking-wide text-navy-800">Email notifications</h2>
      <p className="mt-1 text-sm text-slate-500">Sent to {community.email}. Every email also has a one-click unsubscribe link.</p>
      <div className="mt-3">
        <Checkbox label="When someone sends me a message (if I haven't read it within a couple of minutes)" checked={community.notifications.messages} onChange={(v) => set('messages', v)} disabled={busy} />
        <Checkbox label="When someone mentions me in a post or comment" checked={community.notifications.mentions} onChange={(v) => set('mentions', v)} disabled={busy} />
        <Checkbox label="New ECenter posts and events" checked={community.notifications.announcements} onChange={(v) => set('announcements', v)} disabled={busy} />
      </div>
    </section>
  );
}

function AccountSettings({ community }: { community: CommunityState }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const emailErrors = useFieldError();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const pwErrors = useFieldError();

  async function changeEmail(event: FormEvent) {
    event.preventDefault();
    setEmailBusy(true);
    emailErrors.clear();
    try {
      const response = await api.post<{ verificationEmailSent: boolean }>('/community/account/email', {
        email: newEmail,
        password: emailPassword,
      });
      if (response.verificationEmailSent) toast.success(`Check ${newEmail} for a confirmation link (and your spam folder).`);
      else toast.error("We couldn't send the confirmation email. Please try again later.");
      setNewEmail('');
      setEmailPassword('');
      await refresh();
    } catch (caught) {
      emailErrors.capture(caught);
    } finally {
      setEmailBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setPwBusy(true);
    pwErrors.clear();
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success('Password changed.');
      setCurrent('');
      setNext('');
    } catch (caught) {
      pwErrors.capture(caught);
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <section className="card space-y-6 p-6" aria-labelledby="account-heading" id="account">
      <div>
        <h2 id="account-heading" className="text-sm font-bold uppercase tracking-wide text-navy-800">Account</h2>
        <p className="mt-1 text-sm text-slate-500">Private. Never shown on your profile.</p>
      </div>

      <form onSubmit={changeEmail} className="space-y-3" noValidate>
        <p className="text-sm text-slate-700">
          Sign-in email: <span className="font-semibold">{community.email}</span>{' '}
          {community.emailVerified ? <span className="chip bg-green-50 text-success">Confirmed</span> : <span className="chip bg-amber-50 text-amber-700">Not confirmed</span>}
        </p>
        {community.pendingEmail && (
          <p className="text-xs text-slate-500">Waiting for you to confirm {community.pendingEmail}. Your current email keeps working until then.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New email" error={emailErrors.errorFor('New email')}>
            <TextInput type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" />
          </Field>
          <Field label="Current password" error={emailErrors.errorFor('Current password')}>
            <TextInput type="password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        </div>
        {emailErrors.error && !emailErrors.error.field && <p className="text-sm text-urgent" role="alert">{emailErrors.error.message}</p>}
        <button type="submit" className="btn-ghost" disabled={emailBusy || !newEmail || !emailPassword}>
          {emailBusy ? 'Sending...' : 'Change email'}
        </button>
      </form>

      <hr className="border-slate-100" />

      <form onSubmit={changePassword} className="space-y-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current password" error={pwErrors.errorFor('Current password')}>
            <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" error={pwErrors.errorFor('New password')} hint="At least 10 characters.">
            <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        {pwErrors.error && !pwErrors.error.field && <p className="text-sm text-urgent" role="alert">{pwErrors.error.message}</p>}
        <button type="submit" className="btn-ghost" disabled={pwBusy || !current || !next}>
          {pwBusy ? 'Saving...' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function StaffJoin({ onJoined }: { onJoined: (c: CommunityState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      onJoined((await api.post<{ community: CommunityState }>('/community/staff-identity')).community);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create your community profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mx-auto max-w-xl p-8 text-center">
      <h1 className="text-2xl font-bold text-navy-800">Join the community as ECenter staff</h1>
      <p className="mt-2 text-sm text-slate-600">
        You can already read the feed and browse members. To message students and mentors, create a community profile.
        It will be labelled “ECenter staff”. Your admin access is unchanged, and it never opens other people's
        conversations.
      </p>
      {error && <p className="mt-4 text-sm font-semibold text-urgent" role="alert">{error}</p>}
      <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
        <button type="button" className="btn-primary" onClick={join} disabled={busy}>
          {busy ? 'Creating...' : 'Create my community profile'}
        </button>
        <Link to="/" className="btn-ghost">Back to the feed</Link>
      </div>
    </div>
  );
}
