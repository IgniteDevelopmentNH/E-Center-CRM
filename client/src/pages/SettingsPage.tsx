import { useState } from 'react';
import { ConfirmDialog, Modal } from '../components/overlays.tsx';
import {
  Chip,
  ErrorBlock,
  Field,
  LoadingBlock,
  SectionHeader,
  Select,
  TextInput,
} from '../components/ui.tsx';
import { ApiError, api, downloadCsv } from '../lib/api.ts';
import { USER_ROLES } from '../lib/constants.ts';
import { formatDate, formatDateTime, humanise } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type { AuditLogEntry, SettingsResponse, TeamMember } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

export function SettingsPage() {
  const { user, isOwner, canEdit } = useAuth();
  const toast = useToast();
  const settings = useApi<SettingsResponse>('/settings');
  const users = useApi<{ users: TeamMember[] }>('/settings/users');

  if (settings.loading && !settings.data) return <LoadingBlock label="Loading settings" />;
  if (settings.error) return <ErrorBlock message={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return null;

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-navy-800">Settings</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Your team, your preferences, and the integrations behind the CRM.
        </p>
      </header>

      <TeamSection
        users={users.data?.users ?? []}
        currentUserId={user?.id ?? ''}
        isOwner={isOwner}
        onChanged={users.reload}
      />

      <PreferencesSection settings={settings.data} onSaved={settings.reload} />

      <CalendarSection settings={settings.data} isOwner={isOwner} onChanged={settings.reload} />

      <section className="card p-5">
        <SectionHeader title="Data export" />
        <p className="mb-3 text-sm text-slate-500">
          Download your records as CSV. Exports are recorded in the audit log.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Contacts', path: '/contacts/export.csv', file: 'ecenter-contacts.csv' },
            { label: 'Notes', path: '/notes/export.csv', file: 'ecenter-notes.csv' },
            { label: 'Follow-ups', path: '/tasks/export.csv', file: 'ecenter-tasks.csv' },
          ].map((option) => (
            <button
              key={option.path}
              type="button"
              className="btn-ghost"
              onClick={() =>
                downloadCsv(option.path, option.file).catch(() =>
                  toast.error('That export could not be generated.'),
                )
              }
            >
              {option.label} CSV
            </button>
          ))}
        </div>
      </section>

      <section className="card p-5">
        <SectionHeader title="Documents" />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Storage">
            {settings.data.documents.storageDriver === 'r2'
              ? 'Cloudflare R2, encrypted at rest'
              : 'Local disk (development)'}
          </Detail>
          <Detail label="Maximum file size">{settings.data.documents.maxFileSizeMb} MB</Detail>
          <Detail label="Download links expire after">
            {settings.data.documents.downloadUrlTtlMinutes} minutes
          </Detail>
          <Detail label="Allowed types">
            {settings.data.documents.allowedExtensions.join(', ')}
          </Detail>
        </dl>
      </section>

      {canEdit && <AuditSection />}

      <section className="card p-5">
        <SectionHeader title="About" />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Application">UNH ECenter CRM {settings.data.about.version}</Detail>
          <Detail label="Account">{settings.data.customer.name}</Detail>
          <Detail label="Database">{settings.data.about.databaseDriver}</Detail>
          <Detail label="Account created">{formatDate(settings.data.customer.createdAt)}</Detail>
        </dl>
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
          © University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
        </p>
      </section>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-slate-600">{children}</dd>
    </div>
  );
}

function TeamSection({
  users,
  currentUserId,
  isOwner,
  onChanged,
}: {
  users: TeamMember[];
  currentUserId: string;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(member: TeamMember) {
    setBusy(true);
    try {
      await api.delete(`/settings/users/${member.id}`);
      toast.success(`${member.name} removed.`);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That person could not be removed.');
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  return (
    <section className="card p-5">
      <SectionHeader
        title="Team"
        count={users.length}
        action={
          isOwner ? (
            <button type="button" className="btn-quiet" onClick={() => setAdding(true)}>
              + Add member
            </button>
          ) : undefined
        }
      />
      <p className="mb-3 text-sm text-slate-500">
        Everyone on the team sees the same contacts, notes and follow-ups.
      </p>

      <ul className="divide-y divide-slate-100">
        {users.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-navy-800">
                {member.name}
                {member.id === currentUserId && <span className="ml-1 text-xs text-slate-400">(you)</span>}
              </p>
              <p className="truncate text-xs text-slate-500">{member.email}</p>
            </div>
            <Chip tone={member.role === 'owner' ? 'navy' : member.role === 'editor' ? 'teal' : 'slate'}>
              {humanise(member.role)}
            </Chip>
            <span className="text-xs text-slate-400">
              {member.openTaskCount} open · last in {member.lastLoginAt ? formatDate(member.lastLoginAt) : 'never'}
            </span>
            {isOwner && (
              <div className="flex gap-1">
                <button type="button" className="btn-quiet" onClick={() => setEditing(member)}>
                  Edit
                </button>
                {member.id !== currentUserId && (
                  <button
                    type="button"
                    className="btn-quiet text-urgent hover:bg-red-50"
                    onClick={() => setRemoving(member)}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Modal open={adding} title="Add a team member" onClose={() => setAdding(false)}>
        <MemberForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      </Modal>

      <Modal open={!!editing} title="Edit team member" onClose={() => setEditing(null)}>
        {editing && (
          <MemberForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        title="Remove this team member?"
        message={`${removing?.name ?? 'They'} will lose access. Their open follow-ups become unassigned so nothing is lost.`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}

function MemberForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: TeamMember;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState(initial?.role ?? 'editor');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.put(`/settings/users/${initial.id}`, { name, role });
        toast.success('Team member updated.');
      } else {
        await api.post('/settings/users', { name, email, role, password });
        toast.success(`${name} added. Share the temporary password with them.`);
      }
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({ field: caught.field, message: caught.message });
        if (!caught.field) toast.error(caught.message);
      } else {
        toast.error('That did not save. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: string) => (error?.field === field ? error.message : null);

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <Field label="Name" required error={errorFor('Name')}>
        <TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>

      {!initial && (
        <>
          <Field label="Email" required error={errorFor('Email')}>
            <TextInput
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              invalid={!!errorFor('Email')}
            />
          </Field>
          <Field
            label="Temporary password"
            required
            hint="At least 8 characters. They can change it after signing in."
            error={errorFor('Temporary password')}
          >
            <TextInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={!!errorFor('Temporary password')}
            />
          </Field>
        </>
      )}

      <Field label="Role" error={errorFor('Role')}>
        <Select
          value={role}
          options={USER_ROLES}
          onChange={(event) => setRole(event.target.value as TeamMember['role'])}
        />
      </Field>

      <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving...' : initial ? 'Save changes' : 'Add member'}
        </button>
      </div>
    </form>
  );
}

function PreferencesSection({
  settings,
  onSaved,
}: {
  settings: SettingsResponse;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [emailDigest, setEmailDigest] = useState(settings.preferences.emailDigest);
  const [reminderLeadDays, setReminderLeadDays] = useState(settings.preferences.reminderLeadDays);
  const [timezone, setTimezone] = useState(settings.preferences.timezone);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.put('/settings/preferences', { emailDigest, reminderLeadDays, timezone });
      toast.success('Preferences saved.');
      onSaved();
    } catch {
      toast.error('Those preferences could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-5">
      <SectionHeader title="Preferences" />
      <form className="grid gap-4 sm:grid-cols-3" onSubmit={save}>
        <Field label="Email digest" hint="Reminders show in-app today.">
          <Select
            value={emailDigest}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
            ]}
            onChange={(event) =>
              setEmailDigest(event.target.value as SettingsResponse['preferences']['emailDigest'])
            }
          />
        </Field>
        <Field label="Reminder lead time">
          <Select
            value={String(reminderLeadDays)}
            options={[
              { value: '1', label: '1 day before' },
              { value: '3', label: '3 days before' },
              { value: '7', label: '1 week before' },
            ]}
            onChange={(event) => setReminderLeadDays(Number(event.target.value))}
          />
        </Field>
        <Field label="Timezone">
          <Select
            value={timezone}
            options={[
              { value: 'America/New_York', label: 'Eastern (America/New_York)' },
              { value: 'America/Chicago', label: 'Central (America/Chicago)' },
              { value: 'America/Denver', label: 'Mountain (America/Denver)' },
              { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
              { value: 'UTC', label: 'UTC' },
            ]}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </Field>
        <div className="sm:col-span-3">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving...' : 'Save preferences'}
          </button>
        </div>
      </form>
    </section>
  );
}

function CalendarSection({
  settings,
  isOwner,
  onChanged,
}: {
  settings: SettingsResponse;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const status = useApi<{
    configured: boolean;
    connected: boolean;
    accountEmail: string | null;
    clientId: string | null;
    tenantId: string | null;
    redirectUri: string;
    lastSyncAt: string | null;
    syncStatus: string;
    errorMessage: string | null;
  }>('/calendar/status');

  const [showCredentials, setShowCredentials] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState('common');
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const calendar = status.data;

  async function saveCredentials(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.put('/calendar/credentials', { clientId, clientSecret, tenantId });
      toast.success('App registration saved. You can connect Outlook now.');
      setShowCredentials(false);
      setClientSecret('');
      status.reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Those details could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const response = await api.post<{ url: string }>('/calendar/authorize');
      // Microsoft consent happens in its own window; the callback page closes the loop.
      window.open(response.url, 'outlook-consent', 'width=520,height=680');
      toast.info('Approve access in the Microsoft window, then run a sync.');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Outlook could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    try {
      const result = await api.post<{ pulled: number; pushed: number }>('/calendar/sync');
      toast.success(`Sync complete: ${result.pulled} pulled in, ${result.pushed} pushed out.`);
      status.reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That sync did not finish.');
      status.reload();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.post('/calendar/disconnect');
      toast.success('Outlook disconnected.');
      status.reload();
      onChanged();
    } catch {
      toast.error('Outlook could not be disconnected.');
    } finally {
      setBusy(false);
      setConfirmDisconnect(false);
    }
  }

  return (
    <section className="card p-5">
      <SectionHeader
        title="Outlook calendar"
        action={
          <Chip tone={settings.calendar.connected ? 'green' : 'slate'}>
            {settings.calendar.connected ? 'Connected' : calendar?.configured ? 'Not connected' : 'Not set up'}
          </Chip>
        }
      />

      <p className="mb-3 text-sm text-slate-500">
        Two-way sync over a 30-day window. Events created here are pushed to Outlook, and Outlook
        events appear in the CRM.
      </p>

      <dl className="mb-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Detail label="Account">{settings.calendar.accountEmail ?? 'Not connected'}</Detail>
        <Detail label="Last sync">
          {settings.calendar.lastSyncAt ? formatDateTime(settings.calendar.lastSyncAt) : 'Never'}
        </Detail>
        <Detail label="Status">{humanise(settings.calendar.syncStatus)}</Detail>
        <Detail label="Records moved">
          {settings.calendar.eventsPulled} in / {settings.calendar.eventsPushed} out
        </Detail>
      </dl>

      {settings.calendar.errorMessage && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-urgent">
          {settings.calendar.errorMessage}
        </p>
      )}

      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" onClick={() => setShowCredentials(true)}>
            {calendar?.configured ? 'Update app registration' : 'Add app registration'}
          </button>
          {calendar?.configured && (
            <button type="button" className="btn-secondary" onClick={connect} disabled={busy}>
              {settings.calendar.connected ? 'Reconnect' : 'Connect Outlook'}
            </button>
          )}
          {settings.calendar.connected && (
            <>
              <button type="button" className="btn-primary" onClick={sync} disabled={busy}>
                {busy ? 'Syncing...' : 'Sync now'}
              </button>
              <button
                type="button"
                className="btn-quiet text-urgent hover:bg-red-50"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">Only an account owner can change the calendar connection.</p>
      )}

      <Modal
        open={showCredentials}
        title="Microsoft app registration"
        onClose={() => setShowCredentials(false)}
      >
        <form className="space-y-4" onSubmit={saveCredentials} noValidate>
          <p className="rounded-lg bg-navy-50 p-3 text-xs text-navy-900">
            In the Azure portal, register an app with the <strong>Calendars.ReadWrite</strong> delegated
            permission and add this redirect URI as a Web platform:
            <code className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-[11px]">
              {calendar?.redirectUri}
            </code>
          </p>
          <Field label="Application (client) ID" required>
            <TextInput value={clientId} onChange={(event) => setClientId(event.target.value)} autoFocus />
          </Field>
          <Field label="Client secret" required hint="Stored AES-256-GCM encrypted; never shown again.">
            <TextInput
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Field>
          <Field label="Directory (tenant) ID" hint="Use 'common' for multi-tenant apps.">
            <TextInput value={tenantId} onChange={(event) => setTenantId(event.target.value)} />
          </Field>
          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowCredentials(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving...' : 'Save registration'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Outlook?"
        message="The stored access and refresh tokens are deleted. Events already in the CRM are kept."
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </section>
  );
}

function AuditSection() {
  const [open, setOpen] = useState(false);
  const logs = useApi<{ logs: AuditLogEntry[] }>(open ? '/settings/audit-logs?limit=100' : null);

  return (
    <section className="card p-5">
      <SectionHeader
        title="Audit log"
        action={
          <button type="button" className="btn-quiet" onClick={() => setOpen((current) => !current)}>
            {open ? 'Hide' : 'Show'}
          </button>
        }
      />
      <p className="text-sm text-slate-500">
        Document access, calendar syncs, exports, deletions and sign-ins are recorded.
      </p>

      {open && (
        <div className="scroll-x mt-3">
          {logs.loading && !logs.data && <LoadingBlock label="Loading log" />}
          {logs.data && (
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3 font-semibold">When</th>
                  <th className="py-2 pr-3 font-semibold">Action</th>
                  <th className="py-2 pr-3 font-semibold">Who</th>
                  <th className="py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.data.logs.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap py-2 pr-3 text-slate-500">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <Chip tone={entry.action.includes('delete') ? 'red' : 'slate'}>{entry.action}</Chip>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{entry.userName ?? 'System'}</td>
                    <td className="max-w-[16rem] truncate py-2 text-slate-400">{entry.metadata ?? '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
