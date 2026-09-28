import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ContactForm, OrganizationForm } from '../components/forms.tsx';
import { ConfirmDialog, Modal, SlideOver } from '../components/overlays.tsx';
import {
  Avatar,
  Chip,
  CollapsibleList,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  ORG_TYPE_TONES,
  Pagination,
  SectionHeader,
  Select,
  StatusChip,
  TextInput,
} from '../components/ui.tsx';
import { ApiError, api, buildQuery, openDocument } from '../lib/api.ts';
import { ORG_STATUSES, ORG_TYPES } from '../lib/constants.ts';
import { formatBytes, formatRelative, humanise } from '../lib/format.ts';
import { useApi, useDebounced } from '../lib/hooks.ts';
import type { Contact, CrmDocument, Organization, OrganizationsResponse } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'name_desc', label: 'Name (Z-A)' },
  { value: 'activity', label: 'Recent activity' },
  { value: 'people', label: 'Most people' },
];

export function OrganizationsPage() {
  const { canEdit } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [term, setTerm] = useState('');
  const [orgType, setOrgType] = useState('all');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const openId = searchParams.get('open');
  const debouncedTerm = useDebounced(term, 300);

  const query = useMemo(
    () => buildQuery({ q: debouncedTerm.trim(), orgType, status, sort, page, limit: 20 }),
    [debouncedTerm, orgType, status, sort, page],
  );

  const { data, loading, error, reload } = useApi<OrganizationsResponse>(`/organizations${query}`);

  useEffect(() => {
    setPage(1);
  }, [debouncedTerm, orgType, status, sort]);

  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('open', id);
    else next.delete('open');
    setSearchParams(next, { replace: true });
  };

  const organizations = data?.organizations ?? [];

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Organizations</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Businesses, clubs and groups, with everyone you know at each one.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Add organization
          </button>
        )}
      </header>

      <div className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative lg:col-span-2">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          >
            ⌕
          </span>
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search organizations"
            aria-label="Search organizations"
            className="input pl-9"
          />
        </div>
        <Select
          value={orgType}
          options={ORG_TYPES}
          includeAll
          allLabel="Any type"
          onChange={(event) => setOrgType(event.target.value)}
          aria-label="Filter by type"
        />
        <Select
          value={status}
          options={ORG_STATUSES}
          includeAll
          allLabel="Any status"
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
        />
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Sort by</span>
          <div className="w-52">
            <Select value={sort} options={SORT_OPTIONS} onChange={(event) => setSort(event.target.value)} />
          </div>
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading organizations" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {data && organizations.length === 0 && (
        <EmptyState
          icon="⌂"
          title={debouncedTerm ? 'No organizations match that' : 'No organizations yet'}
          message={
            debouncedTerm
              ? 'Try a different search.'
              : 'Group the people you know at the same business, club or group.'
          }
          action={
            canEdit && !debouncedTerm ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                + Add organization
              </button>
            ) : undefined
          }
        />
      )}

      {organizations.length > 0 && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {organizations.map((organization) => (
              <button
                key={organization.id}
                type="button"
                onClick={() => setOpenId(organization.id)}
                className="card-interactive p-4 text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-navy-800">{organization.name}</h3>
                  <Chip tone="teal">
                    {organization.contactCount} {organization.contactCount === 1 ? 'person' : 'people'}
                  </Chip>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusChip value={organization.orgType} tones={ORG_TYPE_TONES} />
                  <Chip tone={organization.status === 'active' ? 'green' : organization.status === 'prospect' ? 'amber' : 'slate'}>
                    {humanise(organization.status)}
                  </Chip>
                </div>

                {organization.location && (
                  <p className="mt-2 text-sm text-slate-500">{organization.location}</p>
                )}

                {organization.relationship && (
                  <p className="mt-2 line-clamp-3 text-sm text-slate-600">{organization.relationship}</p>
                )}

                <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-400">
                  {organization.lastActivityAt
                    ? `Last activity ${formatRelative(organization.lastActivityAt).toLowerCase()}`
                    : 'No interactions logged'}
                </p>
              </button>
            ))}
          </div>

          <Pagination
            page={data?.page ?? 1}
            limit={data?.limit ?? 20}
            total={data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}

      <Modal open={creating} title="Add an organization" onClose={() => setCreating(false)}>
        <OrganizationForm
          onCancel={() => setCreating(false)}
          onSaved={(organization) => {
            setCreating(false);
            reload();
            setOpenId(organization.id);
          }}
        />
      </Modal>

      {openId && (
        <OrganizationPanel organizationId={openId} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
    </div>
  );
}

function OrganizationPanel({
  organizationId,
  onClose,
  onChanged,
}: {
  organizationId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canEdit } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{
    organization: Organization;
    contacts: Contact[];
  }>(`/organizations/${organizationId}`);

  const [editing, setEditing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState('');
  const [linkRole, setLinkRole] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: allContacts } = useApi<{ contacts: Contact[] }>(
    linking ? '/contacts?limit=200&sort=name' : null,
  );

  const documents = useApi<{ documents: CrmDocument[] }>(
    `/documents?organizationId=${organizationId}`,
  );
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<CrmDocument | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const organization = data?.organization;

  async function uploadDocument(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('organizationId', organizationId);
      await api.post('/documents', form);
      toast.success(`${file.name} uploaded.`);
      documents.reload();
      reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That file could not be uploaded.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function saveRename() {
    if (!renaming) return;
    const fileName = renameValue.trim();
    if (!fileName) return;
    try {
      await api.put(`/documents/${renaming.id}`, { fileName });
      toast.success('Attachment renamed.');
      setRenaming(null);
      documents.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That attachment could not be renamed.');
    }
  }

  async function removeDocument(doc: CrmDocument) {
    try {
      await api.delete(`/documents/${doc.id}`);
      toast.success('Attachment removed.');
      documents.reload();
      reload();
      onChanged();
    } catch {
      toast.error('That attachment could not be removed.');
    }
  }

  async function link() {
    if (!linkId) {
      toast.error('Choose a contact to link.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/organizations/${organizationId}/contacts`, {
        contactId: linkId,
        orgRole: linkRole,
      });
      toast.success('Contact linked.');
      setLinking(false);
      setLinkId('');
      setLinkRole('');
      reload();
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That contact could not be linked.');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(contact: Contact) {
    try {
      await api.delete(`/organizations/${organizationId}/contacts/${contact.id}`);
      toast.success(`${contact.fullName} unlinked.`);
      reload();
      onChanged();
    } catch {
      toast.error('That contact could not be unlinked.');
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/organizations/${organizationId}`);
      toast.success('Organization deleted. Its contacts were kept.');
      onChanged();
      onClose();
    } catch {
      toast.error('That organization could not be deleted.');
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const unlinked = (allContacts?.contacts ?? []).filter(
    (contact) => !contact.organizations.some((org) => org.id === organizationId),
  );

  return (
    <SlideOver
      open
      title={organization?.name ?? 'Organization'}
      subtitle={organization ? humanise(organization.orgType) : undefined}
      onClose={onClose}
      footer={
        canEdit && organization ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => setLinking(true)}>
              + Link a contact
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="btn-quiet ml-auto text-urgent hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          </div>
        ) : undefined
      }
    >
      {loading && !organization && <LoadingBlock label="Loading organization" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {organization && (
        <div className="space-y-6">
          <section>
            <SectionHeader title="Our relationship" />
            {organization.relationship ? (
              <p className="whitespace-pre-line rounded-lg bg-navy-50 p-3 text-sm leading-relaxed text-navy-900">
                {organization.relationship}
              </p>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500">
                No relationship notes yet.
              </p>
            )}
          </section>

          <section>
            <SectionHeader title="Details" />
            <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Type</dt>
                <dd className="mt-0.5">
                  <StatusChip value={organization.orgType} tones={ORG_TYPE_TONES} />
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</dt>
                <dd className="text-slate-600">{humanise(organization.status)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Location</dt>
                <dd className="text-slate-600">{organization.location ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Website</dt>
                <dd>
                  {organization.website ? (
                    <a
                      href={organization.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="break-all text-teal-700 hover:underline"
                    >
                      {organization.website.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    <span className="text-slate-400">--</span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <SectionHeader
              title="People here"
              count={data?.contacts.length}
              action={
                canEdit ? (
                  <button type="button" className="btn-quiet" onClick={() => setAddingContact(true)}>
                    + New contact
                  </button>
                ) : undefined
              }
            />
            {data && data.contacts.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nobody linked yet. Link an existing contact or add a new one.
              </p>
            ) : (
              <CollapsibleList
                items={data?.contacts ?? []}
                getKey={(contact) => contact.id}
                searchText={(contact) => `${contact.fullName} ${contact.orgRole ?? ''}`}
                searchPlaceholder="Search people here"
                emptyText="No people match that."
                renderItem={(contact) => (
                  <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                    <Avatar name={contact.fullName} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/contacts?open=${contact.id}`}
                        onClick={onClose}
                        className="block truncate font-semibold text-navy-800 hover:underline"
                      >
                        {contact.fullName}
                      </Link>
                      <p className="truncate text-xs text-slate-500">
                        {contact.orgRole ?? 'Role not recorded'} ·{' '}
                        {formatRelative(contact.lastInteractionAt)}
                      </p>
                    </div>
                    {canEdit && (
                      <button type="button" className="btn-quiet" onClick={() => unlink(contact)}>
                        Unlink
                      </button>
                    )}
                  </div>
                )}
              />
            )}
          </section>

          <section>
            <SectionHeader
              title="Attachments"
              count={documents.data?.documents.length}
              action={
                canEdit ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) uploadDocument(file);
                      }}
                    />
                    <button
                      type="button"
                      className="btn-quiet"
                      disabled={uploading}
                      onClick={() => fileInput.current?.click()}
                    >
                      {uploading ? 'Uploading...' : '+ Add attachment'}
                    </button>
                  </>
                ) : undefined
              }
            />
            {documents.data && documents.data.documents.length === 0 ? (
              <p className="text-sm text-slate-500">
                No attachments yet. PDF, image, Word, Excel and text files are accepted.
              </p>
            ) : (
              <CollapsibleList
                items={documents.data?.documents ?? []}
                getKey={(doc) => doc.id}
                searchText={(doc) => doc.fileName}
                searchPlaceholder="Search attachments"
                emptyText="No attachments match that."
                renderItem={(doc) => (
                  <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded bg-navy-50 text-navy-600"
                      aria-hidden="true"
                    >
                      ▤
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-navy-800">{doc.fileName}</p>
                      <p className="text-xs text-slate-500">{formatBytes(doc.fileSize)}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-quiet"
                      onClick={() =>
                        openDocument(doc.id).catch(() =>
                          toast.error('That attachment could not be opened.'),
                        )
                      }
                    >
                      Download
                    </button>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          className="btn-quiet"
                          onClick={() => {
                            setRenaming(doc);
                            setRenameValue(doc.fileName);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn-quiet text-urgent hover:bg-red-50"
                          onClick={() => removeDocument(doc)}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                )}
              />
            )}
          </section>
        </div>
      )}

      <Modal open={editing} title="Edit organization" onClose={() => setEditing(false)}>
        {organization && (
          <OrganizationForm
            initial={organization}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              reload();
              onChanged();
            }}
          />
        )}
      </Modal>

      <Modal
        open={addingContact}
        title="Add a contact here"
        onClose={() => setAddingContact(false)}
        width="max-w-2xl"
      >
        <ContactForm
          lockOrganizationId={organizationId}
          onCancel={() => setAddingContact(false)}
          onSaved={() => {
            setAddingContact(false);
            reload();
            onChanged();
          }}
        />
      </Modal>

      <Modal open={linking} title="Link an existing contact" onClose={() => setLinking(false)}>
        <div className="space-y-4">
          <label className="block">
            <span className="label">Contact</span>
            <select className="input pr-8" value={linkId} onChange={(event) => setLinkId(event.target.value)}>
              <option value="">Choose a contact</option>
              {unlinked.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.fullName}
                  {contact.organizationName ? ` (currently ${contact.organizationName})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Role there</span>
            <input
              className="input"
              value={linkRole}
              onChange={(event) => setLinkRole(event.target.value)}
              placeholder="Founder, Board member, ..."
            />
          </label>
          <p className="text-xs text-slate-500">
            A contact can belong to several organizations. Linking adds them here without
            removing them from anywhere else.
          </p>
          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost" onClick={() => setLinking(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={link} disabled={busy}>
              {busy ? 'Linking...' : 'Link contact'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!renaming} title="Rename attachment" onClose={() => setRenaming(null)}>
        <div className="space-y-4">
          <label className="block">
            <span className="label">File name</span>
            <TextInput
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveRename();
                }
              }}
            />
          </label>
          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={saveRename} disabled={!renameValue.trim()}>
              Save name
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this organization?"
        message="The organization is removed from your lists. The people linked to it are kept as contacts."
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </SlideOver>
  );
}
