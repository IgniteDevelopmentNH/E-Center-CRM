import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { AuthSplitLayout } from '../../components/community.tsx';
import {
  PhotoUpload,
  ProfileFields,
  ResumeUpload,
  draftFrom,
  payloadFrom,
} from '../../components/profileFields.tsx';
import type { ProfileDraft } from '../../components/profileFields.tsx';
import { Checkbox, Field, TextInput } from '../../components/ui.tsx';
import { ApiError, api } from '../../lib/api.ts';
import type { AccountType, CommunityState } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

type Role = Exclude<AccountType, 'staff'>;

function useFieldErrors() {
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const capture = (caught: unknown) =>
    setError(
      caught instanceof ApiError
        ? { message: caught.message, field: caught.field }
        : { message: 'Something went wrong. Please try again.' },
    );
  const errorFor = (field: string) => (error?.field === field ? error.message : null);
  return { error, setError, capture, errorFor };
}

function StepIndicator({ step }: { step: 1 | 2 }) {
  const steps = ['Account', 'About you'];
  return (
    <ol className="mb-6 flex items-center gap-3" aria-label={`Step ${step} of 2`}>
      {steps.map((label, index) => {
        const number = index + 1;
        const state = number < step ? 'done' : number === step ? 'current' : 'todo';
        return (
          <li key={label} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
            <span
              className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${
                state === 'todo' ? 'bg-slate-100 text-slate-500' : 'bg-teal text-white'
              }`}
            >
              {state === 'done' ? '✓' : number}
            </span>
            <span className={`text-sm font-semibold ${state === 'todo' ? 'text-slate-400' : 'text-navy-800'}`}>{label}</span>
            {number < steps.length && <span className="mx-1 h-px w-8 bg-slate-200" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function RoleCard({
  role,
  selected,
  onSelect,
  title,
  description,
  icon,
}: {
  role: Role;
  selected: boolean;
  onSelect: (role: Role) => void;
  title: string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer flex-col gap-2 rounded-xl border-2 p-4 transition focus-within:ring-2 focus-within:ring-teal focus-within:ring-offset-2 ${
        selected ? 'border-teal bg-teal-50' : 'border-slate-200 bg-white hover:border-teal-200'
      }`}
    >
      <input
        type="radio"
        name="account-type"
        value={role}
        checked={selected}
        onChange={() => onSelect(role)}
        className="sr-only"
      />
      <span className="flex items-center justify-between">
        <span className={`grid h-10 w-10 place-items-center rounded-full text-lg ${selected ? 'bg-teal text-white' : 'bg-navy-50 text-navy'}`} aria-hidden="true">
          {icon}
        </span>
        <span
          className={`grid h-5 w-5 place-items-center rounded-full border-2 ${selected ? 'border-teal bg-teal' : 'border-slate-300'}`}
          aria-hidden="true"
        >
          {selected && <span className="h-2 w-2 rounded-full bg-white" />}
        </span>
      </span>
      <span className="text-base font-bold text-navy-800">{title}</span>
      <span className="text-sm text-slate-500">{description}</span>
    </label>
  );
}

export function SignupPage() {
  const { user, community, isStaff, startSession, setCommunity, refresh } = useAuth();
  const navigate = useNavigate();
  const signedInPending = !!user && community?.status === 'pending';
  const [step, setStep] = useState<1 | 2>(signedInPending && !community?.onboardingCompleted ? 2 : 1);

  // Step 1 state
  const [role, setRole] = useState<Role | null>((community?.accountType as Role | undefined) ?? null);
  const [firstName, setFirstName] = useState(community?.profile.firstName ?? '');
  const [lastName, setLastName] = useState(community?.profile.lastName ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Step 2 state
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(community));
  const [busy, setBusy] = useState(false);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);
  const [announcements, setAnnouncements] = useState(true);
  const { error, setError, capture, errorFor } = useFieldErrors();

  useEffect(() => {
    if (community && !draft.firstName) setDraft(draftFrom(community));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community]);

  if (user && community?.status === 'active') return <Navigate to="/" replace />;
  if (user && isStaff && !community) return <Navigate to="/profile" replace />;
  if (user && !community) return <Navigate to="/" replace />;
  if (user && community?.status === 'deactivated') {
    return (
      <AuthSplitLayout>
        <h2 className="text-2xl font-bold text-navy-800">This account is not active</h2>
        <p className="mt-2 text-sm text-slate-500">Please contact the ECenter if you think this is a mistake.</p>
      </AuthSplitLayout>
    );
  }

  async function submitStep1(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!role) {
      setError({ message: 'Choose Student or Mentor to continue.', field: 'Account type' });
      return;
    }
    if (signedInPending) {
      // Already have an account: carry the edits into step 2's save.
      setDraft((d) => ({ ...d, firstName, lastName }));
      setStep(2);
      return;
    }
    setBusy(true);
    try {
      const response = await api.post<{ token: string; community: CommunityState; verificationEmailSent: boolean }>(
        '/community/signup',
        { accountType: role, firstName, lastName, email, password },
      );
      await startSession(response.token);
      setEmailSent(response.verificationEmailSent);
      setDraft(draftFrom(response.community));
      setStep(2);
    } catch (caught) {
      capture(caught);
    } finally {
      setBusy(false);
    }
  }

  async function finish(skipDetails: boolean) {
    if (!community || !role) return;
    setBusy(true);
    setError(null);
    try {
      const base = skipDetails ? { ...draftFrom(null), firstName: draft.firstName, lastName: draft.lastName } : draft;
      await api.put('/community/profile', payloadFrom(base, role));
      if (!announcements) await api.put('/community/profile/notifications', { announcements: false });
      const done = await api.post<{ community: CommunityState }>('/community/onboarding/complete');
      setCommunity(done.community);
      if (done.community.status === 'active') navigate('/', { replace: true });
    } catch (caught) {
      capture(caught);
    } finally {
      setBusy(false);
    }
  }

  // Onboarding done, waiting on email verification.
  if (signedInPending && community?.onboardingCompleted) {
    return (
      <AuthSplitLayout>
        <VerifyNotice email={community.email} emailSent={emailSent} onRefresh={refresh} />
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout>
      <StepIndicator step={step} />

      {step === 1 ? (
        <form onSubmit={submitStep1} noValidate className="space-y-5">
          <div>
            <h2 className="text-2xl font-bold text-navy-800">Create your account</h2>
            <p className="mt-1 text-sm text-slate-500">Join UNH students and mentors in the ECenter community.</p>
          </div>

          <fieldset>
            <legend className="label">Are you a student or a mentor?</legend>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
              <RoleCard
                role="student"
                selected={role === 'student'}
                onSelect={setRole}
                title="Student"
                description="I'm a UNH student looking for guidance, ideas and connections."
                icon="✎"
              />
              <RoleCard
                role="mentor"
                selected={role === 'mentor'}
                onSelect={setRole}
                title="Mentor"
                description="I'd like to share my experience with student entrepreneurs."
                icon="★"
              />
            </div>
            {errorFor('Account type') && <p className="mt-1 text-xs font-semibold text-urgent">{errorFor('Account type')}</p>}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required error={errorFor('First name')}>
              <TextInput value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" invalid={!!errorFor('First name')} />
            </Field>
            <Field label="Last name" required error={errorFor('Last name')}>
              <TextInput value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" invalid={!!errorFor('Last name')} />
            </Field>
          </div>

          {signedInPending ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Signed in as <span className="font-semibold">{community?.email}</span>
            </p>
          ) : (
            <>
              <Field label="Email" required error={errorFor('Email')}>
                <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" invalid={!!errorFor('Email')} />
              </Field>
              <Field label="Password" required error={errorFor('Password')} hint="At least 8 characters.">
                <div className="relative">
                  <TextInput
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    invalid={!!errorFor('Password')}
                  />
                  <button
                    type="button"
                    className="btn-quiet absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
            </>
          )}

          {error && !error.field && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">
              {error.message}
            </p>
          )}
          {error?.field === 'Email' && error.message.includes('Sign in') && (
            <p className="text-sm">
              <Link to="/login" className="font-semibold text-teal-700 hover:underline">Go to sign in</Link>
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Creating your account...' : 'Next'}
          </button>
          {!user && (
            <p className="text-center text-sm text-slate-600">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold text-teal-700 hover:underline">Sign in</Link>
            </p>
          )}
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void finish(false);
          }}
          noValidate
          className="space-y-5"
        >
          <div>
            <h2 className="text-2xl font-bold text-navy-800">About you</h2>
            <p className="mt-1 text-sm text-slate-500">
              Everything on this step is optional. You can skip it and edit your profile any time.
            </p>
          </div>

          {emailSent === false && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
              Your account was created, but we couldn't send the verification email just now. You can resend it at the next step.
            </p>
          )}
          {emailSent === true && community && (
            <div className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800" role="status">
              <p>
                We sent a confirmation email to <span className="font-semibold">{community.email}</span>.
              </p>
              <p className="mt-1">If you don't see it in your inbox within a few minutes, check your spam or junk folder and mark it “Not spam” so future emails arrive normally.</p>
            </div>
          )}

          {community && <PhotoUpload community={community} onUpdated={setCommunity} />}

          <ProfileFields accountType={role ?? 'student'} draft={draft} onChange={setDraft} errorFor={errorFor} />

          {community && <ResumeUpload community={community} onUpdated={setCommunity} />}

          <Checkbox
            label="Email me about new ECenter posts and events (you can turn this off any time)"
            checked={announcements}
            onChange={setAnnouncements}
          />

          {error && !['Bio', 'LinkedIn URL', 'Scheduling link', 'Graduation year', 'Major', 'Role', 'Company', 'Interests', 'Help topics'].includes(error.field ?? '') && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">
              {error.message}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button type="button" className="btn-ghost" onClick={() => setStep(1)} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn-quiet sm:ml-auto" onClick={() => finish(true)} disabled={busy}>
              Skip for now
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving...' : 'Create account'}
            </button>
          </div>
        </form>
      )}
    </AuthSplitLayout>
  );
}

function VerifyNotice({
  email,
  emailSent,
  onRefresh,
}: {
  email: string;
  emailSent: boolean | null;
  onRefresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    emailSent === false
      ? { tone: 'error', text: "We couldn't send the verification email. Try resending; if it keeps failing, contact the ECenter." }
      : null,
  );
  const [busy, setBusy] = useState(false);

  // If they confirm from another device or tab, move on without needing a click.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void onRefresh().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [onRefresh]);

  async function resend() {
    setBusy(true);
    try {
      const response = await api.post<{ verificationEmailSent?: boolean; alreadyVerified?: boolean }>('/community/verification/resend');
      if (response.alreadyVerified) await onRefresh();
      else
        setStatus(
          response.verificationEmailSent
            ? { tone: 'ok', text: 'A new link is on its way. Remember to check your spam or junk folder.' }
            : { tone: 'error', text: "We couldn't send the email. Please contact the ECenter." },
        );
    } catch (caught) {
      setStatus({ tone: 'error', text: caught instanceof ApiError ? caught.message : 'Could not resend.' });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    await onRefresh();
    setBusy(false);
    setStatus({ tone: 'error', text: "We haven't seen the confirmation yet. Open the link in the email, then try again." });
  }

  return (
    <div>
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-teal-50 text-xl text-teal-700" aria-hidden="true">✉</div>
      <h2 className="text-2xl font-bold text-navy-800">Confirm your email</h2>
      <p className="mt-2 text-sm text-slate-600">
        We sent a link to <span className="font-semibold">{email}</span>. Open it to activate your account. Your profile is saved.
      </p>
      <p className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
        <span className="font-semibold">Can't find it?</span> If you don't see it in your inbox within a few minutes, check your spam or junk folder and mark it “Not spam” so future emails arrive normally.
      </p>
      {status && (
        <p
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${status.tone === 'ok' ? 'bg-green-50 text-success' : 'bg-amber-50 text-amber-800'}`}
          role="status"
        >
          {status.text}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-primary" onClick={check} disabled={busy}>
          I've confirmed my email
        </button>
        <button type="button" className="btn-ghost" onClick={resend} disabled={busy}>
          Resend email
        </button>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Wrong address? <Link to="/profile" className="font-semibold text-teal-700 hover:underline">Change it in your account settings</Link>.
      </p>
    </div>
  );
}
