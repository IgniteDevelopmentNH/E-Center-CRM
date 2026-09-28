import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ContactPanel } from './ContactPanel.tsx';
import { ContactForm } from '../components/forms.tsx';
import { Modal } from '../components/overlays.tsx';
import {
  Avatar,
  CONTACT_STATUS_TONES,
  Chip,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  Select,
  StatusChip,
  TagChip,
  TagPicker,
  TextInput,
} from '../components/ui.tsx';
import { buildQuery, downloadCsv } from '../lib/api.ts';
import { CONTACT_STATUSES, CONTACT_TAGS } from '../lib/constants.ts';
import { formatRelative, truncate } from '../lib/format.ts';
import { useApi, useDebounced } from '../lib/hooks.ts';
import type { Contact, ContactsResponse, OrganizationsResponse } from '../lib/types.ts';
import { useAuth } from '../state/AuthContext.tsx';
import { useToast } from '../state/ToastContext.tsx';
import { api } from '../lib/api.ts';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'name_desc', label: 'Name (Z-A)' },
  { value: 'interaction', label: 'Recently contacted' },
  { value: 'interaction_asc', label: 'Gone quiet longest' },
  { value: 'added', label: 'Newest added' },
  { value: 'added_asc', label: 'Oldest added' },
];

export function ContactsPage() {
  const { canEdit } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [term, setTerm] = useState('');
  const [status, setStatus] = useState('all');
  const [tag, setTag] = useState('all');
  const [organizationId, setOrganizationId] = useState('all');
  const [sort, setSort] = useState('name');
  const [interactionFrom, setInteractionFrom] = useState('');
  const [interactionTo, setInteractionTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(searchParams.get('new') === '1');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const openId = searchParams.get('open');
  const debouncedTerm = useDebounced(term, 300);

  const query = useMemo(
    () =>
      buildQuery({
        q: debouncedTerm.trim(),
        status,
        tag,
        organizationId,
        sort,
        interactionFrom,
        interactionTo,
        page,
        limit: 20,
      }),
    [debouncedTerm, status, tag, organizationId, sort, interactionFrom, interactionTo, page],
  );

  const { data, loading, error, reload } = useApi<ContactsResponse>(`/contacts${query}`);
  const { data: orgs } = useApi<OrganizationsResponse>('/organizations?limit=200');
  const { data: facets, reload: reloadFacets } = useApi<{ tags: { tag: string; count: number }[] }>(
    '/contacts/facets',
  );

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedTerm, status, tag, organizationId, sort, interactionFrom, interactionTo]);

  const setOpenId = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('open', id);
    else next.delete('open');
    next.delete('new');
    setSearchParams(next, { replace: true });
  };

  const clearNewParam = () => {
    if (searchParams.has('new')) {
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  };

  const activeFilterCount = [
    status !== 'all',
    tag !== 'all',
    organizationId !== 'all',
    !!interactionFrom,
    !!interactionTo,
  ].filter(Boolean).length;

  async function applyBulkTags(mode: 'add' | 'remove') {
    if (!bulkTags.length) {
      toast.error('Choose at least one tag first.');
      return;
    }
    setBulkBusy(true);
    try {
      const response = await api.post<{ updated: number }>('/contacts/bulk-tags', {
        ids: selectedIds,
        [mode]: bulkTags,
      });
      toast.success(
        `${mode === 'add' ? 'Tagged' : 'Untagged'} ${response.updated} ${
          response.updated === 1 ? 'contact' : 'contacts'
        }.`,
      );
      setSelectedIds([]);
      setBulkTags([]);
      reload();
      reloadFacets();
    } catch {
      toast.error('Those tags could not be applied.');
    } finally {
      setBulkBusy(false);
    }
  }

  const contacts = data?.contacts ?? [];

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Contacts</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            The people you work with, and how you know each of them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              downloadCsv(`/contacts/export.csv${query}`, 'ecenter-contacts.csv').catch(() =>
                toast.error('That export could not be generated.'),
              )
            }
          >
            Export CSV
          </button>
          {canEdit && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              + Add contact
            </button>
          )}
        </div>
      </header>

      <div className="card mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
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
              placeholder="Search name, email, tag, organization, or how you connected"
              aria-label="Search contacts"
              className="input pl-9"
            />
          </div>
          <div className="shrink-0 sm:w-52">
            <Select
              value={sort}
              options={SORT_OPTIONS}
              onChange={(event) => setSort(event.target.value)}
              aria-label="Sort contacts"
            />
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
          >
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 rounded-full bg-teal px-1.5 text-xs text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="label">Status</span>
              <Select
                value={status}
                options={CONTACT_STATUSES}
                includeAll
                allLabel="Any status"
                onChange={(event) => setStatus(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Tag</span>
              <Select
                value={tag}
                options={(facets?.tags ?? []).map((entry) => ({
                  value: entry.tag,
                  label: `${entry.tag} (${entry.count})`,
                }))}
                includeAll
                allLabel="Any tag"
                onChange={(event) => setTag(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="label">Organization</span>
              <Select
                value={organizationId}
                options={(orgs?.organizations ?? []).map((org) => ({ value: org.id, label: org.name }))}
                includeAll
                allLabel="Any organization"
                onChange={(event) => setOrganizationId(event.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">Contacted from</span>
                <TextInput
                  type="date"
                  value={interactionFrom}
                  onChange={(event) => setInteractionFrom(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">to</span>
                <TextInput
                  type="date"
                  value={interactionTo}
                  onChange={(event) => setInteractionTo(event.target.value)}
                />
              </label>
            </div>

            {activeFilterCount > 0 && (
              <button
                type="button"
                className="btn-quiet justify-self-start"
                onClick={() => {
                  setStatus('all');
                  setTag('all');
                  setOrganizationId('all');
                  setInteractionFrom('');
                  setInteractionTo('');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {canEdit && selectedIds.length > 0 && (
        <div className="card mb-5 border-teal-200 bg-teal-50 p-4">
          <p className="mb-2 text-sm font-semibold text-teal-800">
            {selectedIds.length} selected
            <button
              type="button"
              className="ml-2 font-normal text-teal-700 underline"
              onClick={() => setSelectedIds([])}
            >
              clear
            </button>
          </p>
          <TagPicker value={bulkTags} onChange={setBulkTags} suggestions={CONTACT_TAGS} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={bulkBusy}
              onClick={() => applyBulkTags('add')}
            >
              Add tags
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={bulkBusy}
              onClick={() => applyBulkTags('remove')}
            >
              Remove tags
            </button>
          </div>
        </div>
      )}

      {loading && !data && <LoadingBlock label="Loading contacts" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}

      {data && contacts.length === 0 && (
        <EmptyState
          icon="☺"
          title={debouncedTerm || activeFilterCount ? 'No contacts match that' : 'No contacts yet'}
          message={
            debouncedTerm || activeFilterCount
              ? 'Try a different search, or clear the filters to see everyone.'
              : 'Add the first person you work with and record how you know them.'
          }
          action={
            canEdit && !debouncedTerm && !activeFilterCount ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                + Add contact
              </button>
            ) : undefined
          }
        />
      )}

      {contacts.length > 0 && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {contacts.map((contact) => (
              <ContactCard
                key={contact.id}
                contact={contact}
                selectable={canEdit}
                selected={selectedIds.includes(contact.id)}
                onToggleSelect={(checked) =>
                  setSelectedIds((current) =>
                    checked ? [...current, contact.id] : current.filter((id) => id !== contact.id),
                  )
                }
                onOpen={() => setOpenId(contact.id)}
              />
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

      <Modal
        open={creating}
        title="Add a contact"
        onClose={() => {
          setCreating(false);
          clearNewParam();
        }}
        width="max-w-2xl"
      >
        <ContactForm
          onCancel={() => {
            setCreating(false);
            clearNewParam();
          }}
          onSaved={(contact) => {
            setCreating(false);
            clearNewParam();
            reload();
            reloadFacets();
            setOpenId(contact.id);
          }}
        />
      </Modal>

      {openId && (
        <ContactPanel
          contactId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            reload();
            reloadFacets();
          }}
        />
      )}
    </div>
  );
}

function ContactCard({
  contact,
  selectable,
  selected,
  onToggleSelect,
  onOpen,
}: {
  contact: Contact;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div className={`card-interactive relative p-4 ${selected ? 'border-teal ring-1 ring-teal' : ''}`}>
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onToggleSelect(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${contact.fullName}`}
          className="absolute right-3 top-3 h-4 w-4 rounded border-slate-300 text-teal focus:ring-teal"
        />
      )}

      <button type="button" onClick={onOpen} className="w-full text-left">
        <div className="flex items-start gap-3 pr-6">
          <Avatar name={contact.fullName} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate font-bold text-navy-800">{contact.fullName}</h3>
              {contact.isStudentFounder && <Chip tone="gold">Student Founder</Chip>}
            </div>
            {contact.organizationName ? (
              <p className="truncate text-sm text-slate-600">
                {contact.orgRole ? `${contact.orgRole}, ` : ''}
                {contact.organizationName}
                {contact.organizations.length > 1 && (
                  <span className="text-slate-400"> +{contact.organizations.length - 1} more</span>
                )}
              </p>
            ) : (
              <p className="truncate text-sm text-slate-500">{contact.email}</p>
            )}
          </div>
        </div>

        {contact.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {contact.tags
              .filter((tag) => tag !== 'Student Founder')
              .map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
            <StatusChip value={contact.status} tones={CONTACT_STATUS_TONES} />
          </div>
        )}

        {contact.latestNoteSnippet && (
          <p className="mt-3 border-l-2 border-slate-200 pl-2.5 text-sm italic text-slate-500">
            {truncate(contact.latestNoteSnippet, 96)}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs">
          <span className={contact.lastInteractionAt ? 'text-slate-500' : 'font-semibold text-amber-600'}>
            {contact.lastInteractionAt
              ? `Last contact ${formatRelative(contact.lastInteractionAt).toLowerCase()}`
              : 'No interactions logged'}
          </span>
          <span className="flex items-center gap-2 text-slate-400">
            <span title={`${contact.noteCount} notes`}>✎ {contact.noteCount}</span>
            <span
              title={`${contact.openTaskCount} open follow-ups`}
              className={contact.openTaskCount > 0 ? 'font-semibold text-teal-700' : ''}
            >
              ✓ {contact.openTaskCount}
            </span>
            <span title={`${contact.documentCount} documents`}>▤ {contact.documentCount}</span>
          </span>
        </div>
      </button>
    </div>
  );
}
