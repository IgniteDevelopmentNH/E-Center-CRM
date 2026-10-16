import { useRef, useState } from 'react';
import { ApiError, api, openSignedUrl } from '../lib/api.ts';
import { formatBytes } from '../lib/format.ts';
import type { AccountType, CommunityState } from '../lib/types.ts';
import { useToast } from '../state/ToastContext.tsx';
import { MemberAvatar, TopicPicker } from './community.tsx';
import { Field, TextArea, TextInput } from './ui.tsx';

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  bio: string;
  linkedinUrl: string;
  major: string;
  graduationYear: string;
  roleTitle: string;
  company: string;
  schedulingUrl: string;
  interests: string[];
  help: string[];
}

export function draftFrom(community: CommunityState | null): ProfileDraft {
  const p = community?.profile;
  return {
    firstName: p?.firstName ?? '',
    lastName: p?.lastName ?? '',
    bio: p?.bio ?? '',
    linkedinUrl: p?.linkedinUrl ?? '',
    major: p?.major ?? '',
    graduationYear: p?.graduationYear ? String(p.graduationYear) : '',
    roleTitle: p?.roleTitle ?? '',
    company: p?.company ?? '',
    schedulingUrl: p?.schedulingUrl ?? '',
    interests: p?.interests.map((t) => t.slug) ?? [],
    help: p?.help.map((t) => t.slug) ?? [],
  };
}

export function payloadFrom(draft: ProfileDraft, accountType: AccountType) {
  return {
    accountType: accountType === 'staff' ? undefined : accountType,
    firstName: draft.firstName,
    lastName: draft.lastName,
    bio: draft.bio,
    linkedinUrl: draft.linkedinUrl,
    major: draft.major,
    graduationYear: draft.graduationYear,
    roleTitle: draft.roleTitle,
    company: draft.company,
    schedulingUrl: draft.schedulingUrl,
    interests: draft.interests,
    help: draft.help,
  };
}

const BIO_MAX = 600;

/** The optional "About you" fields. Everything here can be skipped and edited later. */
export function ProfileFields({
  accountType,
  draft,
  onChange,
  errorFor,
  showNames,
}: {
  accountType: AccountType;
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
  errorFor: (field: string) => string | null;
  showNames?: boolean;
}) {
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => onChange({ ...draft, [key]: value });
  const isStudent = accountType === 'student';

  return (
    <div className="space-y-5">
      {showNames && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errorFor('First name')}>
            <TextInput value={draft.firstName} onChange={(e) => set('firstName', e.target.value)} autoComplete="given-name" invalid={!!errorFor('First name')} />
          </Field>
          <Field label="Last name" required error={errorFor('Last name')}>
            <TextInput value={draft.lastName} onChange={(e) => set('lastName', e.target.value)} autoComplete="family-name" invalid={!!errorFor('Last name')} />
          </Field>
        </div>
      )}

      <Field label="Short bio" error={errorFor('Bio')} hint={`${draft.bio.length}/${BIO_MAX} characters. Shown on your profile.`}>
        <TextArea
          value={draft.bio}
          maxLength={BIO_MAX}
          rows={3}
          onChange={(e) => set('bio', e.target.value)}
          placeholder={isStudent ? 'What are you studying or building?' : 'A sentence or two about your background.'}
          invalid={!!errorFor('Bio')}
        />
      </Field>

      {isStudent ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Major" error={errorFor('Major')}>
            <TextInput value={draft.major} onChange={(e) => set('major', e.target.value)} invalid={!!errorFor('Major')} />
          </Field>
          <Field label="Graduation year" error={errorFor('Graduation year')}>
            <TextInput
              inputMode="numeric"
              maxLength={4}
              placeholder="e.g. 2027"
              value={draft.graduationYear}
              onChange={(e) => set('graduationYear', e.target.value.replace(/\D/g, ''))}
              invalid={!!errorFor('Graduation year')}
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role" error={errorFor('Role')}>
            <TextInput value={draft.roleTitle} onChange={(e) => set('roleTitle', e.target.value)} placeholder="e.g. Product Manager" invalid={!!errorFor('Role')} />
          </Field>
          <Field label="Company" error={errorFor('Company')}>
            <TextInput value={draft.company} onChange={(e) => set('company', e.target.value)} autoComplete="organization" invalid={!!errorFor('Company')} />
          </Field>
        </div>
      )}

      <Field label="LinkedIn URL" error={errorFor('LinkedIn URL')} hint="e.g. https://www.linkedin.com/in/your-name">
        <TextInput type="url" value={draft.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} invalid={!!errorFor('LinkedIn URL')} />
      </Field>

      <TopicPicker
        idPrefix="interests"
        label={isStudent ? 'Your interests' : 'Your areas of expertise'}
        hint="Used to match students and mentors. Shown on your profile."
        value={draft.interests}
        onChange={(slugs) => set('interests', slugs)}
      />
      {errorFor('Interests') && <p className="-mt-3 text-xs font-semibold text-urgent">{errorFor('Interests')}</p>}

      <TopicPicker
        idPrefix="help"
        label={isStudent ? 'What would you like help with?' : 'What can you help with?'}
        value={draft.help}
        onChange={(slugs) => set('help', slugs)}
      />
      {errorFor('Help topics') && <p className="-mt-3 text-xs font-semibold text-urgent">{errorFor('Help topics')}</p>}

      {accountType === 'mentor' && (
        <Field
          label="Scheduling link"
          error={errorFor('Scheduling link')}
          hint="Optional. A Calendly, Microsoft Bookings or similar https link. Students will see a “Book a meeting” button."
        >
          <TextInput type="url" value={draft.schedulingUrl} onChange={(e) => set('schedulingUrl', e.target.value)} invalid={!!errorFor('Scheduling link')} />
        </Field>
      )}
    </div>
  );
}

/** Photo upload (JPEG/PNG/WebP, 5 MB). Uploads immediately; returns the updated community state. */
export function PhotoUpload({
  community,
  onUpdated,
}: {
  community: CommunityState;
  onUpdated: (community: CommunityState) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = `${community.profile.firstName} ${community.profile.lastName}`;

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await api.post<{ community: CommunityState }>('/community/profile/photo', form);
      onUpdated(response.community);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onUpdated((await api.delete<{ community: CommunityState }>('/community/profile/photo')).community);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="label">Profile photo</p>
      <div className="flex items-center gap-4">
        <MemberAvatar name={name} photoUrl={community.profile.photoUrl} size="lg" />
        <div className="flex flex-wrap gap-2">
          <label className={`btn-ghost cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            {busy ? 'Uploading...' : community.profile.photoUrl ? 'Change photo' : 'Upload photo'}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
          {community.profile.photoUrl && (
            <button type="button" className="btn-quiet" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">Optional. JPEG, PNG or WebP, up to 5 MB.</p>
      {error && <p className="mt-1 text-xs font-semibold text-urgent" role="alert">{error}</p>}
    </div>
  );
}

/** Private resume upload. Visible only to the member and ECenter staff. */
export function ResumeUpload({
  community,
  onUpdated,
}: {
  community: CommunityState;
  onUpdated: (community: CommunityState) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      onUpdated((await api.post<{ community: CommunityState }>('/community/profile/resume', form)).community);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function download() {
    try {
      const { url } = await api.get<{ url: string }>('/community/profile/resume');
      openSignedUrl(url);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not open your resume.');
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onUpdated((await api.delete<{ community: CommunityState }>('/community/profile/resume')).community);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="label">Resume</p>
      {community.resume ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
            {community.resume.fileName}{' '}
            <span className="text-xs text-slate-400">({formatBytes(community.resume.size)})</span>
          </span>
          <button type="button" className="btn-quiet" onClick={download}>
            View
          </button>
          <button type="button" className="btn-quiet" onClick={remove} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <label className={`btn-ghost cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {busy ? 'Uploading...' : 'Upload resume'}
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      )}
      <p className="mt-1 text-xs text-slate-500">
        Optional. PDF or Word, up to 5 MB. Private: only you and ECenter staff can see it.
      </p>
      {error && <p className="mt-1 text-xs font-semibold text-urgent" role="alert">{error}</p>}
    </div>
  );
}
