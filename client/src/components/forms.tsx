import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { DEFAULT_EVENT_LOCATION } from '../lib/constants.ts';
import {
  CONTACT_STATUSES,
  CONTACT_TAGS,
  EVENT_TYPES,
  NOTE_TAGS,
  NOTE_TYPES,
  ORG_STATUSES,
  ORG_TYPES,
  REMINDER_OFFSETS,
  TASK_PRIORITIES,
  TASK_RECURRENCES,
  TASK_STATUSES,
} from '../lib/constants.ts';
import { toDateTimeInput, todayInput } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import type {
  Contact,
  CrmEvent,
  Note,
  Organization,
  OrganizationsResponse,
  Task,
  TeamMember,
} from '../lib/types.ts';
import { useToast } from '../state/ToastContext.tsx';
import { Checkbox, Field, RadioGroup, Select, TagPicker, TextArea, TextInput } from './ui.tsx';

/** Shared submit plumbing: busy state, field-level errors, toast on failure. */
function useSubmit<T>(onSaved: (result: T) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);

  const submit = async (event: FormEvent, action: () => Promise<T>, successMessage: string) => {
    event.preventDefault();
    setBusy(true);
    setFieldError(null);
    try {
      const result = await action();
      toast.success(successMessage);
      onSaved(result);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldError({ field: caught.field, message: caught.message });
        if (!caught.field) toast.error(caught.message);
      } else {
        toast.error('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  return { busy, submit, errorFor, generalError: fieldError && !fieldError.field ? fieldError.message : null };
}

function FormActions({
  busy,
  onCancel,
  submitLabel,
  children,
}: {
  busy: boolean;
  onCancel: () => void;
  submitLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-end">
      {children}
      <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Saving...' : submitLabel}
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- contacts -- */

export function ContactForm({
  initial,
  onSaved,
  onCancel,
  lockOrganizationId,
}: {
  initial?: Contact | null;
  onSaved: (contact: Contact) => void;
  onCancel: () => void;
  lockOrganizationId?: string;
}) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? '');
  const [lastName, setLastName] = useState(initial?.lastName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [howWeConnected, setHowWeConnected] = useState(initial?.howWeConnected ?? '');
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [organizationId, setOrganizationId] = useState(
    initial?.organizationId ?? lockOrganizationId ?? '',
  );
  const [orgRole, setOrgRole] = useState(initial?.orgRole ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'active');

  const { data: orgs } = useApi<OrganizationsResponse>('/organizations?limit=200');
  const { busy, submit, errorFor } = useSubmit(onSaved);

  const isStudentFounder = tags.includes('Student Founder');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) =>
        submit(
          event,
          async () => {
            const payload = {
              firstName,
              lastName,
              email,
              phone,
              howWeConnected,
              tags,
              organizationId: organizationId || null,
              orgRole,
              status,
            };
            const response = initial
              ? await api.put<{ contact: Contact }>(`/contacts/${initial.id}`, payload)
              : await api.post<{ contact: Contact }>('/contacts', payload);
            return response.contact;
          },
          initial ? 'Contact updated.' : 'Contact added.',
        )
      }
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" required error={errorFor('First name')}>
          <TextInput
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            invalid={!!errorFor('First name')}
            autoFocus
          />
        </Field>
        <Field label="Last name" required error={errorFor('Last name')}>
          <TextInput
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            invalid={!!errorFor('Last name')}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" required error={errorFor('Email')}>
          <TextInput
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={!!errorFor('Email')}
          />
        </Field>
        <Field label="Phone" error={errorFor('Phone')}>
          <TextInput
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="Optional"
          />
        </Field>
      </div>

      <Field
        label="How we connected"
        hint="Who introduced them, where you met, what they need or can offer. This is the relationship history."
        error={errorFor('How we connected')}
      >
        <TextArea
          value={howWeConnected}
          onChange={(event) => setHowWeConnected(event.target.value)}
          rows={4}
          placeholder="Introduced by ... at ... They are looking for ... and can offer ..."
        />
      </Field>

      <Field label="Tags" error={errorFor('Tags')}>
        <TagPicker value={tags} onChange={setTags} suggestions={CONTACT_TAGS} />
      </Field>

      {isStudentFounder && (
        <p className="rounded-lg bg-gold-100 px-3 py-2 text-xs text-gold-600">
          Tracked as a business owner. Record business and founder details only -- no personal or
          student information.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Organization" error={errorFor('Organization')}>
          <select
            className="input pr-8"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            disabled={!!lockOrganizationId}
          >
            <option value="">No organization</option>
            {(orgs?.organizations ?? []).map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role there" error={errorFor('Role')}>
          <TextInput
            value={orgRole}
            onChange={(event) => setOrgRole(event.target.value)}
            placeholder="Founder, VP Operations, ..."
          />
        </Field>
      </div>

      <Field label="Status" error={errorFor('Status')}>
        <RadioGroup
          name="contact-status"
          value={status}
          options={CONTACT_STATUSES}
          onChange={(value) => setStatus(value as Contact['status'])}
        />
      </Field>

      <FormActions busy={busy} onCancel={onCancel} submitLabel={initial ? 'Save changes' : 'Add contact'} />
    </form>
  );
}

/* ------------------------------------------------------------------ notes -- */

export function NoteForm({
  initial,
  contactId,
  contacts,
  onSaved,
  onCancel,
}: {
  initial?: Note | null;
  contactId?: string;
  /** Passed in when the caller already has the list, to avoid a second fetch. */
  contacts?: Contact[];
  onSaved: (note: Note) => void;
  onCancel: () => void;
}) {
  const [selectedContact, setSelectedContact] = useState(initial?.contactId ?? contactId ?? '');
  const [noteType, setNoteType] = useState(initial?.noteType ?? 'meeting');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);

  const needsContacts = !contacts && !contactId && !initial;
  const { data: fetched } = useApi<{ contacts: Contact[] }>(
    needsContacts ? '/contacts?limit=200&sort=name' : null,
  );
  const options = contacts ?? fetched?.contacts ?? [];

  const { busy, submit, errorFor } = useSubmit(onSaved);
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) =>
        submit(
          event,
          async () => {
            const payload = { contactId: selectedContact, noteType, content, tags };
            const response = initial
              ? await api.put<{ note: Note }>(`/notes/${initial.id}`, payload)
              : await api.post<{ note: Note }>('/notes', payload);
            return response.note;
          },
          initial ? 'Note updated.' : 'Note added.',
        )
      }
      noValidate
    >
      {!initial && !contactId && (
        <Field label="Contact" required error={errorFor('Contact')}>
          <select
            className="input pr-8"
            value={selectedContact}
            onChange={(event) => setSelectedContact(event.target.value)}
          >
            <option value="">Choose a contact</option>
            {options.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.fullName}
                {contact.organizationName ? ` -- ${contact.organizationName}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Type" error={errorFor('Note type')}>
        <Select
          value={noteType}
          options={NOTE_TYPES}
          onChange={(event) => setNoteType(event.target.value as Note['noteType'])}
        />
      </Field>

      <Field label="Note" required error={errorFor('Note')}>
        <TextArea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={7}
          autoFocus
          placeholder="What was discussed, what they need, what happens next..."
          invalid={!!errorFor('Note')}
        />
      </Field>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {words} {words === 1 ? 'word' : 'words'}
        </span>
        <span>
          {initial ? 'Original timestamp is preserved' : 'Timestamped automatically when you save'}
        </span>
      </div>

      <Field label="Tags" error={errorFor('Tags')}>
        <TagPicker value={tags} onChange={setTags} suggestions={NOTE_TAGS} />
      </Field>

      <FormActions busy={busy} onCancel={onCancel} submitLabel={initial ? 'Save note' : 'Add note'} />
    </form>
  );
}

/* ------------------------------------------------------------------ tasks -- */

export function TaskForm({
  initial,
  contactId,
  onSaved,
  onCancel,
}: {
  initial?: Task | null;
  contactId?: string;
  onSaved: (task: Task) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? todayInput());
  const [selectedContact, setSelectedContact] = useState(initial?.contactId ?? contactId ?? '');
  const [assignedTo, setAssignedTo] = useState(initial?.assignedTo ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'open');
  const [priority, setPriority] = useState(initial?.priority ?? 'medium');
  const [reminderEnabled, setReminderEnabled] = useState(initial?.reminderEnabled ?? false);
  const [reminderOffset, setReminderOffset] = useState(initial?.reminderOffset ?? 'one_day');
  const [contextNotes, setContextNotes] = useState(initial?.contextNotes ?? '');
  const [recurrence, setRecurrence] = useState(initial?.recurrence ?? 'none');

  const { data: contactData } = useApi<{ contacts: Contact[] }>('/contacts?limit=200&sort=name');
  const { data: userData } = useApi<{ users: TeamMember[] }>('/settings/users');
  const { busy, submit, errorFor } = useSubmit(onSaved);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) =>
        submit(
          event,
          async () => {
            const payload = {
              title,
              dueDate,
              contactId: selectedContact || null,
              assignedTo: assignedTo || null,
              status,
              priority,
              reminderEnabled,
              reminderOffset,
              contextNotes,
              recurrence,
            };
            const response = initial
              ? await api.put<{ task: Task }>(`/tasks/${initial.id}`, payload)
              : await api.post<{ task: Task }>('/tasks', payload);
            return response.task;
          },
          initial ? 'Follow-up updated.' : 'Follow-up added.',
        )
      }
      noValidate
    >
      <Field label="What needs to happen" required error={errorFor('Task title')}>
        <TextInput
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
          placeholder="Send Marcus the sponsorship one-pager"
          invalid={!!errorFor('Task title')}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date" required error={errorFor('Due date')}>
          <TextInput
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            invalid={!!errorFor('Due date')}
          />
        </Field>
        <Field label="Assigned to" error={errorFor('Assigned to')}>
          <select
            className="input pr-8"
            value={assignedTo}
            onChange={(event) => setAssignedTo(event.target.value)}
          >
            <option value="">Unassigned</option>
            {(userData?.users ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="About which contact" error={errorFor('Contact')}>
        <select
          className="input pr-8"
          value={selectedContact}
          onChange={(event) => setSelectedContact(event.target.value)}
          disabled={!!contactId && !initial}
        >
          <option value="">No specific contact</option>
          {(contactData?.contacts ?? []).map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.fullName}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Priority" error={errorFor('Priority')}>
          <Select
            value={priority}
            options={TASK_PRIORITIES}
            onChange={(event) => setPriority(event.target.value as Task['priority'])}
          />
        </Field>
        <Field label="Status" error={errorFor('Status')}>
          <Select
            value={status}
            options={TASK_STATUSES}
            onChange={(event) => setStatus(event.target.value as Task['status'])}
          />
        </Field>
      </div>

      <Field label="Repeats" hint="A completed repeating follow-up schedules its next occurrence automatically.">
        <Select
          value={recurrence}
          options={TASK_RECURRENCES}
          onChange={(event) => setRecurrence(event.target.value as Task['recurrence'])}
        />
      </Field>

      <div className="rounded-lg border border-slate-200 p-3">
        <Checkbox label="Remind me about this" checked={reminderEnabled} onChange={setReminderEnabled} />
        {reminderEnabled && (
          <div className="mt-2">
            <Select
              value={reminderOffset}
              options={REMINDER_OFFSETS}
              onChange={(event) => setReminderOffset(event.target.value as Task['reminderOffset'])}
            />
          </div>
        )}
      </div>

      <Field label="Context" error={errorFor('Context notes')}>
        <TextArea
          value={contextNotes}
          onChange={(event) => setContextNotes(event.target.value)}
          rows={3}
          placeholder="Why this matters, what they asked for..."
        />
      </Field>

      <FormActions busy={busy} onCancel={onCancel} submitLabel={initial ? 'Save changes' : 'Add follow-up'} />
    </form>
  );
}

/* ---------------------------------------------------------- organizations -- */

export function OrganizationForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Organization | null;
  onSaved: (organization: Organization) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [orgType, setOrgType] = useState(initial?.orgType ?? 'startup');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [website, setWebsite] = useState(initial?.website ?? '');
  const [relationship, setRelationship] = useState(initial?.relationship ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'active');
  const { busy, submit, errorFor } = useSubmit(onSaved);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) =>
        submit(
          event,
          async () => {
            const payload = { name, orgType, location, website, relationship, status };
            const response = initial
              ? await api.put<{ organization: Organization }>(`/organizations/${initial.id}`, payload)
              : await api.post<{ organization: Organization }>('/organizations', payload);
            return response.organization;
          },
          initial ? 'Organization updated.' : 'Organization added.',
        )
      }
      noValidate
    >
      <Field label="Organization name" required error={errorFor('Organization name')}>
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          invalid={!!errorFor('Organization name')}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" error={errorFor('Type')}>
          <Select
            value={orgType}
            options={ORG_TYPES}
            onChange={(event) => setOrgType(event.target.value as Organization['orgType'])}
          />
        </Field>
        <Field label="Status" error={errorFor('Status')}>
          <Select
            value={status}
            options={ORG_STATUSES}
            onChange={(event) => setStatus(event.target.value as Organization['status'])}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location" error={errorFor('Location')}>
          <TextInput
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Durham, NH"
          />
        </Field>
        <Field label="Website" error={errorFor('Website')}>
          <TextInput
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder="example.com"
            invalid={!!errorFor('Website')}
          />
        </Field>
      </div>

      <Field
        label="Our relationship"
        hint="How and why the ECenter works with them."
        error={errorFor('Our relationship')}
      >
        <TextArea
          value={relationship}
          onChange={(event) => setRelationship(event.target.value)}
          rows={4}
        />
      </Field>

      <FormActions
        busy={busy}
        onCancel={onCancel}
        submitLabel={initial ? 'Save changes' : 'Add organization'}
      />
    </form>
  );
}

/* ----------------------------------------------------------------- events -- */

export function EventForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: CrmEvent | null;
  onSaved: (event: CrmEvent) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [startsAt, setStartsAt] = useState(toDateTimeInput(initial?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toDateTimeInput(initial?.endsAt ?? null));
  const [eventType, setEventType] = useState(initial?.eventType ?? 'workshop');
  const [location, setLocation] = useState(initial?.location ?? DEFAULT_EVENT_LOCATION);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [followupNotes, setFollowupNotes] = useState(initial?.followupNotes ?? '');
  const [contactIds, setContactIds] = useState<string[]>([]);

  const { data: contactData } = useApi<{ contacts: Contact[] }>('/contacts?limit=200&sort=name');
  const { busy, submit, errorFor } = useSubmit(onSaved);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) =>
        submit(
          event,
          async () => {
            const payload = {
              name,
              startsAt: startsAt ? new Date(startsAt).toISOString() : '',
              endsAt: endsAt ? new Date(endsAt).toISOString() : null,
              eventType,
              location,
              description,
              followupNotes,
              ...(initial ? {} : { contactIds }),
            };
            const response = initial
              ? await api.put<{ event: CrmEvent }>(`/events/${initial.id}`, payload)
              : await api.post<{ event: CrmEvent }>('/events', payload);
            return response.event;
          },
          initial ? 'Event updated.' : 'Event added.',
        )
      }
      noValidate
    >
      <Field label="Event name" required error={errorFor('Event name')}>
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          invalid={!!errorFor('Event name')}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Starts" required error={errorFor('Event date')}>
          <TextInput
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            invalid={!!errorFor('Event date')}
          />
        </Field>
        <Field label="Ends" error={errorFor('End time')}>
          <TextInput
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            invalid={!!errorFor('End time')}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" error={errorFor('Event type')}>
          <Select
            value={eventType}
            options={EVENT_TYPES}
            onChange={(event) => setEventType(event.target.value as CrmEvent['eventType'])}
          />
        </Field>
        <Field label="Location" error={errorFor('Location')}>
          <TextInput value={location} onChange={(event) => setLocation(event.target.value)} />
        </Field>
      </div>

      <Field label="Description" error={errorFor('Description')}>
        <TextArea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
      </Field>

      {!initial && (
        <Field
          label="Who is attending"
          hint="Each person linked here gets a dated attendance note on their timeline."
        >
          <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {(contactData?.contacts ?? []).map((contact) => (
              <Checkbox
                key={contact.id}
                label={
                  <span>
                    {contact.fullName}
                    {contact.organizationName && (
                      <span className="text-slate-400"> -- {contact.organizationName}</span>
                    )}
                  </span>
                }
                checked={contactIds.includes(contact.id)}
                onChange={(checked) =>
                  setContactIds((current) =>
                    checked ? [...current, contact.id] : current.filter((id) => id !== contact.id),
                  )
                }
              />
            ))}
          </div>
        </Field>
      )}

      {initial && (
        <Field label="Follow-up notes" hint="Post-event debrief." error={errorFor('Follow-up notes')}>
          <TextArea
            value={followupNotes}
            onChange={(event) => setFollowupNotes(event.target.value)}
            rows={4}
          />
        </Field>
      )}

      <FormActions busy={busy} onCancel={onCancel} submitLabel={initial ? 'Save changes' : 'Add event'} />
    </form>
  );
}
