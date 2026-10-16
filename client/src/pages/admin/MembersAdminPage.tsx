import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { accountTypeLabel } from '../../components/community.tsx';
import { Modal, SlideOver } from '../../components/overlays.tsx';
import { ACCOUNT_STATUS_TONES, Chip, EmptyState, ErrorBlock, Field, LoadingBlock, Pagination, Select, TextArea } from '../../components/ui.tsx';
import type { Tone } from '../../components/ui.tsx';
import { ApiError, api, buildQuery, openSignedUrl } from '../../lib/api.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { useApi, useDebounced } from '../../lib/hooks.ts';
import type { AccountStatus, AdminCommunityAccount, LinkCandidate, LinkState } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

const STATUS_LABELS: Record<AccountStatus, string> = { active: 'Active', pending: 'Pending', deactivated: 'Deactivated' };
const LINK_LABELS: Record<LinkState, { label: string; tone: Tone }> = {
  linked: { label: 'Linked to contact', tone: 'teal' },
  pending: { label: 'Link pending', tone: 'amber' },
  conflict: { label: 'Needs review', tone: 'red' },
  unlinked: { label: 'Not linked', tone: 'slate' },
  not_applicable: { label: 'Staff identity', tone: 'navy' },
};

export function AccountStatusChip({ status }: { status: AccountStatus }) {
  return <Chip tone={ACCOUNT_STATUS_TONES[status]}>{STATUS_LABELS[status]}</Chip>;
}

interface ListResponse {
  accounts: AdminCommunityAccount[];
  total: number;
  limit: number;
  summary: { pending: number; active: number; deactivated: number; conflicts: number };
}

/** Community accounts as staff see them: status, CRM link, deactivation. Never anyone's messages. */
export function MembersAdminPage() {
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [link, setLink] = useState(params.get('link') ?? 'all');
  const [page, setPage] = useState(1);
  const q = useDebounced(term.trim(), 300);
  const { data, loading, error, reload } = useApi<ListResponse>(
    `/admin/community/accounts${buildQuery({ q, status, type, link, page, limit: 25 })}`,
  );
  const openId = params.get('open');

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-bold text-navy-800">Community members</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Student, mentor and staff accounts in the community portal, and how each links to a CRM contact.
        </p>
      </header>

      {data && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Active', value: data.summary.active, onClick: () => setStatus('active') },
            { label: 'Pending', value: data.summary.pending, onClick: () => setStatus('pending') },
            { label: 'Deactivated', value: data.summary.deactivated, onClick: () => setStatus('deactivated') },
            { label: 'Needs review', value: data.summary.conflicts, onClick: () => setLink('conflict') },
          ].map((stat) => (
            <button key={stat.label} type="button" className="card-interactive p-3 text-left" onClick={() => { stat.onClick(); setPage(1); }}>
              <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">{stat.label}</span>
              <span className={`text-2xl font-bold ${stat.label === 'Needs review' && stat.value ? 'text-urgent' : 'text-navy'}`}>{stat.value}</span>
            </button>
          ))}
        </div>
      )}

      <div className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <input
          type="search"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setPage(1); }}
          placeholder="Search name or email"
          aria-label="Search members"
          className="input"
        />
        <Select value={status} aria-label="Account status" onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[{ value: 'all', label: 'Any status' }, { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'deactivated', label: 'Deactivated' }]} />
        <Select value={type} aria-label="Account type" onChange={(e) => { setType(e.target.value); setPage(1); }}
          options={[{ value: 'all', label: 'Any type' }, { value: 'student', label: 'Students' }, { value: 'mentor', label: 'Mentors' }, { value: 'staff', label: 'Staff identities' }]} />
        <Select value={link} aria-label="CRM link" onChange={(e) => { setLink(e.target.value); setPage(1); }}
          options={[{ value: 'all', label: 'Any link state' }, { value: 'conflict', label: 'Needs review' }, { value: 'linked', label: 'Linked' }, { value: 'pending', label: 'Link pending' }, { value: 'unlinked', label: 'Not linked' }]} />
      </div>

      {loading && !data && <LoadingBlock label="Loading members" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.accounts.length === 0 && (
        <EmptyState title="No community accounts match" message="Accounts appear here when students and mentors sign up." icon="◎" />
      )}

      {data && data.accounts.length > 0 && (
        <div className="card scroll-x">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-bold">Member</th>
                <th className="px-4 py-3 font-bold">Type</th>
                <th className="px-4 py-3 font-bold">Status</th>
                <th className="px-4 py-3 font-bold">CRM contact</th>
                <th className="px-4 py-3 font-bold">Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.userId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <button type="button" className="text-left font-semibold text-navy-800 hover:underline" onClick={() => setParams({ open: account.userId })}>
                      {account.fullName}
                    </button>
                    <span className="block text-xs text-slate-500">{account.email}</span>
                  </td>
                  <td className="px-4 py-3">{accountTypeLabel(account.accountType)}</td>
                  <td className="px-4 py-3"><AccountStatusChip status={account.status} /></td>
                  <td className="px-4 py-3">
                    {account.contactId ? (
                      <Link to={`/admin/contacts?open=${account.contactId}`} className="font-semibold text-teal-700 hover:underline">
                        {account.contactName}
                      </Link>
                    ) : (
                      <Chip tone={LINK_LABELS[account.linkState].tone}>{LINK_LABELS[account.linkState].label}</Chip>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />}

      {openId && (
        <AccountPanel
          userId={openId}
          onClose={() => setParams({})}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function AccountPanel({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) {
  const { canEdit } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ account: AdminCommunityAccount; candidates: LinkCandidate[] }>(
    `/admin/community/accounts/${userId}`,
  );
  const [busy, setBusy] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [reason, setReason] = useState('');

  async function act(path: string, body?: unknown, success?: string) {
    setBusy(true);
    try {
      const response = await api.post<{ account: AdminCommunityAccount; candidates: LinkCandidate[] }>(
        `/admin/community/accounts/${userId}/${path}`,
        body,
      );
      setData(() => response);
      onChanged();
      if (success) toast.success(success);
      return true;
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function viewResume() {
    try {
      openSignedUrl((await api.get<{ url: string }>(`/admin/community/accounts/${userId}/resume`)).url);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not open the resume.');
    }
  }

  const account = data?.account;

  return (
    <SlideOver
      open
      title={account?.fullName ?? 'Community member'}
      subtitle={account ? accountTypeLabel(account.accountType) : undefined}
      onClose={onClose}
      footer={
        canEdit && account ? (
          <div className="flex flex-wrap gap-2">
            {account.status === 'deactivated' ? (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => act('reactivate', undefined, 'Community access restored.')}>
                Reactivate
              </button>
            ) : (
              <button type="button" className="btn-quiet text-urgent hover:bg-red-50" disabled={busy} onClick={() => setDeactivating(true)}>
                Remove from community
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {loading && !data && <LoadingBlock label="Loading account" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {account && (
        <div className="space-y-6 text-sm">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <AccountStatusChip status={account.status} />
              <Chip tone={account.emailVerified ? 'green' : 'amber'}>{account.emailVerified ? 'Email confirmed' : 'Email not confirmed'}</Chip>
              {!account.onboardingCompleted && <Chip tone="amber">Onboarding not finished</Chip>}
            </div>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-slate-500">Sign-in email</dt><dd className="break-all">{account.email}</dd>
              <dt className="text-slate-500">Joined</dt><dd>{formatDateTime(account.createdAt)}</dd>
              <dt className="text-slate-500">Last sign-in</dt><dd>{account.lastLoginAt ? formatDateTime(account.lastLoginAt) : '--'}</dd>
              {account.deactivatedAt && (
                <>
                  <dt className="text-slate-500">Deactivated</dt>
                  <dd>
                    {formatDateTime(account.deactivatedAt)}
                    {account.deactivatedByName ? ` by ${account.deactivatedByName}` : ''}
                    {account.deactivationReason && <span className="block text-slate-500">“{account.deactivationReason}”</span>}
                  </dd>
                </>
              )}
            </dl>
          </section>

          {account.accountType !== 'staff' && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-navy-800">CRM contact</h3>
              {account.contactId ? (
                <div className="rounded-lg border border-slate-200 p-3">
                  <Link to={`/admin/contacts?open=${account.contactId}`} className="font-semibold text-teal-700 hover:underline">
                    {account.contactName}
                  </Link>
                  <p className="text-xs text-slate-500">{account.contactEmail}</p>
                  {account.emailDiffersFromContact && (
                    <p className="mt-2 text-xs text-amber-700">
                      The member's sign-in email differs from the contact's email. The link was kept; update the contact if appropriate.
                    </p>
                  )}
                </div>
              ) : (
                <LinkResolver account={account} candidates={data?.candidates ?? []} busy={busy} canEdit={canEdit} act={act} />
              )}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-navy-800">Profile (member-managed)</h3>
            {account.profile.bio && <p className="text-slate-700">{account.profile.bio}</p>}
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              {account.profile.roleTitle && (<><dt className="text-slate-500">Role</dt><dd>{account.profile.roleTitle}{account.profile.company ? ` at ${account.profile.company}` : ''}</dd></>)}
              {account.profile.major && (<><dt className="text-slate-500">Major</dt><dd>{account.profile.major}{account.profile.graduationYear ? `, ${account.profile.graduationYear}` : ''}</dd></>)}
              {account.profile.linkedinUrl && (<><dt className="text-slate-500">LinkedIn</dt><dd><a href={account.profile.linkedinUrl} target="_blank" rel="noopener noreferrer" className="break-all text-teal-700 hover:underline">{account.profile.linkedinUrl}</a></dd></>)}
              {account.profile.schedulingUrl && (<><dt className="text-slate-500">Scheduling</dt><dd className="break-all">{account.profile.schedulingUrl}</dd></>)}
              {!!account.interests?.length && (<><dt className="text-slate-500">Topics</dt><dd>{[...(account.interests ?? []), ...(account.help ?? [])].map((t) => t.label).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</dd></>)}
            </dl>
            {account.hasResume && (
              <button type="button" className="btn-ghost" onClick={viewResume}>View resume (private)</button>
            )}
          </section>
        </div>
      )}

      <Modal open={deactivating} title="Remove from the community?" onClose={() => setDeactivating(false)} width="max-w-md">
        <p className="text-sm text-slate-600">
          This deactivates their community account: they are signed out, removed from the directory and mentor
          recommendations, and can't send or receive new messages. Their CRM contact, notes and conversation history are
          kept. You can reactivate them later.
        </p>
        <Field label="Reason (staff only, optional)">
          <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={() => setDeactivating(false)} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              if (await act('deactivate', { reason }, 'Removed from the community.')) {
                setDeactivating(false);
                setReason('');
              }
            }}
          >
            {busy ? 'Working...' : 'Deactivate'}
          </button>
        </div>
      </Modal>
    </SlideOver>
  );
}

function LinkResolver({
  account,
  candidates,
  busy,
  canEdit,
  act,
}: {
  account: AdminCommunityAccount;
  candidates: LinkCandidate[];
  busy: boolean;
  canEdit: boolean;
  act: (path: string, body?: unknown, success?: string) => Promise<boolean>;
}) {
  if (account.linkState === 'conflict') {
    return (
      <div className="space-y-3 rounded-lg border border-urgent/30 bg-red-50 p-3">
        <p className="text-sm text-slate-700">
          More than one contact matches <span className="font-semibold">{account.email}</span>. Nothing was linked
          automatically. Choose the right contact, or create a new one.
        </p>
        <ul className="space-y-2">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2">
              <span className="min-w-0 flex-1">
                <Link to={`/admin/contacts?open=${candidate.id}`} className="font-semibold text-navy-800 hover:underline">{candidate.fullName}</Link>
                <span className="block text-xs text-slate-500">
                  {candidate.email}
                  {candidate.organizationName ? ` · ${candidate.organizationName}` : ''} · added {formatDate(candidate.createdAt)}
                </span>
                {candidate.linkedToAnotherAccount && <span className="block text-xs text-urgent">Already linked to another account</span>}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="btn-ghost min-h-[36px]"
                  disabled={busy || candidate.linkedToAnotherAccount}
                  onClick={() => act('link', { contactId: candidate.id }, 'Linked to contact.')}
                >
                  Link
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => act('link', { createNew: true }, 'Linked to a new contact.')}>
              Create a new contact instead
            </button>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => act('retry-link', undefined, 'Matching re-run.')}>
              Re-run matching
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <p className="text-slate-600">
        {account.linkState === 'pending'
          ? account.emailVerified
            ? 'Linking has not completed yet. It retries automatically; you can also run it now.'
            : 'Links once the member confirms their email address.'
          : 'This account is not linked to a contact (for example, the contact was deleted).'}
      </p>
      {canEdit && account.emailVerified && (
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => act('retry-link', undefined, 'Matching re-run.')}>
          Run matching now
        </button>
      )}
    </div>
  );
}
