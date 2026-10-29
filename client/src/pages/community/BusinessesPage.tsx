import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { Modal } from '../../components/overlays.tsx';
import { Checkbox, EmptyState, ErrorBlock, Field, LoadingBlock, TextArea, TextInput } from '../../components/ui.tsx';
import { ApiError, api, buildQuery } from '../../lib/api.ts';
import { initials } from '../../lib/format.ts';
import { useApi, useDebounced } from '../../lib/hooks.ts';
import type { Business } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';
import { useToast } from '../../state/ToastContext.tsx';

interface ListResponse {
  businesses: Business[];
  industries: string[];
  total: number;
  hasMore: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Logo({ business, size = 'md' }: { business: Business; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-20 w-20 text-2xl' : 'h-14 w-14 text-lg';
  if (business.logoUrl) {
    return <img src={business.logoUrl} alt="" className={`${box} shrink-0 rounded-xl border border-slate-200 bg-white object-cover`} />;
  }
  return (
    <span className={`${box} grid shrink-0 place-items-center rounded-xl bg-navy-50 font-bold text-navy-700`} aria-hidden="true">
      {initials(business.name) || '?'}
    </span>
  );
}

function Flags({ business }: { business: Business }) {
  if (!business.hiring && !business.networking) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {business.hiring && <span className="chip bg-green-50 font-semibold text-green-800">Hiring</span>}
      {business.networking && <span className="chip bg-teal-50 font-semibold text-teal-800">Open to networking</span>}
    </div>
  );
}

export function BusinessCard({ business }: { business: Business }) {
  return (
    <li className="card flex flex-col p-4 sm:p-5">
      <Link to={`/businesses/${business.id}`} className="flex items-start gap-3">
        <Logo business={business} />
        <span className="min-w-0">
          <span className="block truncate text-lg font-bold text-navy-800 hover:underline">{business.name}</span>
          {business.tagline && <span className="line-clamp-2 block text-sm text-slate-600">{business.tagline}</span>}
          {business.industry && <span className="mt-0.5 block text-xs text-slate-500">{business.industry}</span>}
        </span>
      </Link>
      <div className="mt-3">
        <Flags business={business} />
      </div>
      <p className="mt-auto flex items-center gap-2 pt-3 text-xs text-slate-500">
        <MemberAvatar name={business.owner.name} photoUrl={business.owner.photoUrl} size="sm" />
        <span className="truncate">
          {business.owner.name} · {accountTypeLabel(business.owner.accountType)}
        </span>
      </p>
    </li>
  );
}

/** Create or edit a business, then manage its logo and photos. */
function BusinessEditor({
  business,
  onClose,
  onSaved,
}: {
  business: Business | null;
  onClose: () => void;
  onSaved: (business: Business) => void;
}) {
  const [name, setName] = useState(business?.name ?? '');
  const [tagline, setTagline] = useState(business?.tagline ?? '');
  const [description, setDescription] = useState(business?.description ?? '');
  const [industry, setIndustry] = useState(business?.industry ?? '');
  const [website, setWebsite] = useState(business?.website ?? '');
  const [location, setLocation] = useState(business?.location ?? '');
  const [hiring, setHiring] = useState(business?.hiring ?? false);
  const [hiringDetails, setHiringDetails] = useState(business?.hiringDetails ?? '');
  const [networking, setNetworking] = useState(business?.networking ?? false);
  const [lookingFor, setLookingFor] = useState(business?.lookingFor ?? '');
  const [logo, setLogo] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const errorFor = (field: string) => (error?.field === field ? error.message : null);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { name, tagline, description, industry, website, location, hiring, hiringDetails, networking, lookingFor };
      let saved = business
        ? (await api.put<{ business: Business }>(`/community/businesses/${business.id}`, payload)).business
        : (await api.post<{ business: Business }>('/community/businesses', payload)).business;
      if (logo) {
        const form = new FormData();
        form.set('file', logo);
        saved = (await api.post<{ business: Business }>(`/community/businesses/${saved.id}/logo`, form)).business;
      }
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, field: caught.field } : { message: 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={business ? 'Edit business' : 'Add your business'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => save()} disabled={busy}>
            {busy ? 'Saving...' : business ? 'Save changes' : 'Create profile'}
          </button>
        </div>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Business name" required error={errorFor('Business name')}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} invalid={!!errorFor('Business name')} />
        </Field>
        <Field label="Tagline" hint="One line about what you do." error={errorFor('Tagline')}>
          <TextInput value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={160} />
        </Field>
        <Field label="About" error={errorFor('About')}>
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={5000} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Industry" error={errorFor('Industry')}>
            <TextInput value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={80} placeholder="e.g. Food & beverage" />
          </Field>
          <Field label="Location" error={errorFor('Location')}>
            <TextInput value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="e.g. Durham, NH" />
          </Field>
        </div>
        <Field label="Website" error={errorFor('Website')}>
          <TextInput type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" invalid={!!errorFor('Website')} />
        </Field>

        <div className="rounded-lg border border-slate-200 p-3">
          <Checkbox label="We're hiring" checked={hiring} onChange={setHiring} />
          {hiring && (
            <Field label="Roles or details" error={errorFor('Hiring details')}>
              <TextArea value={hiringDetails} onChange={(e) => setHiringDetails(e.target.value)} rows={2} maxLength={1000} placeholder="e.g. Part-time marketing intern, spring semester" />
            </Field>
          )}
          <Checkbox label="Looking to network" checked={networking} onChange={setNetworking} />
          {networking && (
            <Field label="Looking for" error={errorFor('Looking for')}>
              <TextArea value={lookingFor} onChange={(e) => setLookingFor(e.target.value)} rows={2} maxLength={1000} placeholder="e.g. Co-founder with a finance background, suppliers, advisors" />
            </Field>
          )}
        </div>

        <div>
          <p className="label">Profile picture / logo</p>
          {business?.logoUrl && !logo && <img src={business.logoUrl} alt="" className="mb-2 h-16 w-16 rounded-xl object-cover" />}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-lg file:border-0 file:bg-navy-50 file:px-3 file:font-semibold file:text-navy-700"
            aria-label="Choose a logo"
          />
          <p className="mt-1 text-xs text-slate-500">JPEG, PNG or WebP, up to 5 MB. Add more photos from the business page.</p>
          {errorFor('File') && <p className="mt-1 text-xs font-semibold text-urgent">{errorFor('File')}</p>}
        </div>
        {error && !error.field && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{error.message}</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ list -- */

export function BusinessesPage() {
  const navigate = useNavigate();
  const { isActiveMember } = useAuth();
  const [q, setQ] = useState('');
  const [hiring, setHiring] = useState(false);
  const [networking, setNetworking] = useState(false);
  const [industry, setIndustry] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q.trim(), 300);
  const { data, loading, error, reload } = useApi<ListResponse>(
    `/community/businesses${buildQuery({
      q: debounced,
      hiring: hiring ? 1 : undefined,
      networking: networking ? 1 : undefined,
      industry: industry || undefined,
      owner: mine ? 'me' : undefined,
      limit: 60,
    })}`,
  );

  const toggle = (active: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`chip min-h-[36px] border px-3 ${active ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-navy-200'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Businesses</h1>
          <p className="mt-1 text-sm text-slate-500">Ventures started by students and mentors in the ECenter community.</p>
        </div>
        {isActiveMember && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Add your business</button>
        )}
      </div>

      <div className="card space-y-3 p-4">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search businesses, industries or owners" aria-label="Search businesses" className="input" />
        <div className="flex flex-wrap items-center gap-2">
          {toggle(hiring, 'Hiring', () => setHiring((v) => !v))}
          {toggle(networking, 'Open to networking', () => setNetworking((v) => !v))}
          {toggle(mine, 'Mine', () => setMine((v) => !v))}
          {data && data.industries.length > 0 && (
            <select value={industry} onChange={(e) => setIndustry(e.target.value)} className="input w-auto min-w-[10rem] py-1.5" aria-label="Industry">
              <option value="">All industries</option>
              {data.industries.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loading && !data && <LoadingBlock label="Loading businesses" />}
      {error && <ErrorBlock message={error} onRetry={reload} />}
      {data && data.businesses.length === 0 && (
        <EmptyState
          title={mine ? "You haven't added a business yet" : 'No businesses match'}
          message={mine ? 'Add yours so the community can find it.' : 'Try a broader search.'}
          icon="▣"
        />
      )}
      {data && data.businesses.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.businesses.map((business) => (
            <BusinessCard key={business.id} business={business} />
          ))}
        </ul>
      )}

      {creating && (
        <BusinessEditor
          business={null}
          onClose={() => setCreating(false)}
          onSaved={(saved) => {
            setCreating(false);
            navigate(`/businesses/${saved.id}`);
          }}
        />
      )}
    </div>
  );
}

/** A member's businesses, for their profile page. */
export function MemberBusinesses({ userId }: { userId: string }) {
  const { data } = useApi<ListResponse>(`/community/businesses?owner=${encodeURIComponent(userId)}`);
  if (!data || data.businesses.length === 0) return null;
  return (
    <section aria-labelledby="member-businesses">
      <h2 id="member-businesses" className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-800">Businesses</h2>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {data.businesses.map((business) => (
          <BusinessCard key={business.id} business={business} />
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------- detail -- */

export function BusinessDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ business: Business }>(id ? `/community/businesses/${id}` : null);
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const [viewing, setViewing] = useState<Business['photos'][number] | null>(null);

  if (loading && !data) return <LoadingBlock label="Loading business" />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That business is not available.'} onRetry={reload} />
        <Link to="/businesses" className="btn-ghost">All businesses</Link>
      </div>
    );
  }
  const { business } = data;
  const setBusiness = (next: Business) => setData(() => ({ business: next }));

  async function addPhoto(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      const query = caption.trim() ? `?caption=${encodeURIComponent(caption.trim())}` : '';
      setBusiness((await api.post<{ business: Business }>(`/community/businesses/${business.id}/photos${query}`, form)).business);
      setCaption('');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'The photo was not uploaded.');
    } finally {
      setUploading(false);
    }
  }

  async function removePhoto(photoId: string) {
    if (!window.confirm('Remove this photo?')) return;
    try {
      setBusiness((await api.delete<{ business: Business }>(`/community/businesses/${business.id}/photos/${photoId}`)).business);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${business.name} from the community?`)) return;
    try {
      await api.delete(`/community/businesses/${business.id}`);
      toast.success('Business removed.');
      navigate('/businesses', { replace: true });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not work.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/businesses" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span>&nbsp;Businesses
      </Link>

      <article className="card overflow-hidden">
        <div className="h-16 bg-gradient-to-r from-navy to-teal-700" aria-hidden="true" />
        <div className="-mt-8 space-y-4 px-4 pb-6 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Logo business={business} size="lg" />
            {business.canEdit && (
              <div className="flex gap-2">
                <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>Edit</button>
                <button type="button" className="btn-quiet text-urgent" onClick={remove}>Remove</button>
              </div>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-navy-800">{business.name}</h1>
            {business.tagline && <p className="mt-1 text-slate-600">{business.tagline}</p>}
            <p className="mt-1 text-sm text-slate-500">
              {[business.industry, business.location].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Flags business={business} />
          {business.website && (
            <a href={business.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-teal-700 hover:underline">
              {hostOf(business.website)} <span aria-hidden="true">↗</span>
            </a>
          )}
          {business.description && <p className="whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{business.description}</p>}

          {business.hiring && business.hiringDetails && (
            <section className="rounded-lg bg-green-50 p-3">
              <h2 className="text-sm font-bold text-green-900">Hiring</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-green-900">{business.hiringDetails}</p>
            </section>
          )}
          {business.networking && business.lookingFor && (
            <section className="rounded-lg bg-teal-50 p-3">
              <h2 className="text-sm font-bold text-teal-900">Looking for</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-teal-900">{business.lookingFor}</p>
            </section>
          )}

          <Link to={`/members/${business.owner.id}`} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 hover:border-teal-200">
            <MemberAvatar name={business.owner.name} photoUrl={business.owner.photoUrl} size="sm" />
            <span className="min-w-0">
              <span className="block text-xs text-slate-500">Founder</span>
              <span className="block truncate font-semibold text-navy-800">{business.owner.name}</span>
            </span>
            <span className="ml-auto text-xs text-slate-500">{accountTypeLabel(business.owner.accountType)}</span>
          </Link>
        </div>
      </article>

      {(business.photos.length > 0 || business.canEdit) && (
        <section className="card p-4 sm:p-6" aria-labelledby="business-photos">
          <h2 id="business-photos" className="text-sm font-bold uppercase tracking-wide text-navy-800">Photos</h2>
          {business.photos.length === 0 && <p className="mt-2 text-sm text-slate-500">No photos yet.</p>}
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {business.photos.map((photo) => (
              <li key={photo.id} className="group relative">
                <button type="button" onClick={() => setViewing(photo)} className="block w-full">
                  <img src={photo.url} alt={photo.caption ?? ''} className="aspect-square w-full rounded-lg object-cover" loading="lazy" />
                </button>
                {photo.caption && <p className="mt-1 truncate text-xs text-slate-500">{photo.caption}</p>}
                {business.canEdit && (
                  <button type="button" className="absolute right-1 top-1 rounded bg-white/90 px-2 py-1 text-xs font-semibold text-urgent shadow" onClick={() => removePhoto(photo.id)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {business.canEdit && business.photos.length < 12 && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
              <TextInput value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={200} placeholder="Caption (optional)" aria-label="Photo caption" />
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void addPhoto(file);
                }}
                className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-lg file:border-0 file:bg-navy-50 file:px-3 file:font-semibold file:text-navy-700"
                aria-label="Add a photo"
              />
              <p className="text-xs text-slate-500">{uploading ? 'Uploading...' : `Up to 12 photos. ${12 - business.photos.length} left.`}</p>
            </div>
          )}
        </section>
      )}

      {viewing && (
        <Modal open title={viewing.caption ?? business.name} onClose={() => setViewing(null)} width="max-w-3xl">
          <img src={viewing.url} alt={viewing.caption ?? ''} className="w-full rounded-lg" />
        </Modal>
      )}
      {editing && (
        <BusinessEditor
          business={business}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setBusiness(saved);
          }}
        />
      )}
    </div>
  );
}
