/**
 * Row shapes as stored, plus the mappers that turn them into the camelCase JSON
 * the client consumes. Keeping the translation in one place means the wire format
 * stays stable even if a column is renamed.
 *
 * `num()` matters: node-postgres returns COUNT()/bigint as a string, while
 * node:sqlite returns a number. Coercing here keeps both dialects identical
 * from the client's point of view.
 */

import { todayDate } from './lib/time.ts';

export const CONTACT_TAGS = [
  'Student',
  'Mentor',
  'Alumni',
  'Partner',
  'Investor',
  'Sponsor',
  'Founder',
  'Student Founder',
  'Other',
] as const;

export const CONTACT_STATUSES = ['active', 'past', 'on_hold'] as const;
export const NOTE_TYPES = ['email', 'call', 'meeting', 'workshop', 'referral', 'other'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'complete'] as const;
export const TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export const TASK_RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly'] as const;
export const REMINDER_OFFSETS = ['one_day', 'three_days', 'on_date'] as const;
export const ORG_TYPES = ['startup', 'established', 'club', 'nonprofit', 'other'] as const;
export const ORG_STATUSES = ['active', 'inactive', 'prospect'] as const;
export const EVENT_TYPES = [
  'workshop',
  'speaker_series',
  'ideathon',
  'networking',
  'one_on_one',
  'other',
] as const;
export const USER_ROLES = ['owner', 'editor', 'viewer'] as const;

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** Timestamps are stored as ISO text, but a Postgres TIMESTAMPTZ column would
 *  arrive as a Date. Normalise either into an ISO string. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function tags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Parses a `json_group_array(json_object(...))` column into typed objects. */
function jsonObjects(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
  } catch {
    return [];
  }
}

/** {id, name, role} membership rows for a contact, sorted by organization name. */
function organizationLinks(value: unknown) {
  return jsonObjects(value)
    .map((row) => ({ id: String(row.id), name: String(row.name), role: text(row.role) }))
    .filter((row) => row.id && row.id !== 'null')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** {id, name} contact rows for a note, sorted by name. */
function contactLinks(value: unknown) {
  return jsonObjects(value)
    .map((row) => ({ id: String(row.id), name: String(row.name) }))
    .filter((row) => row.id && row.id !== 'null')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** {id, name, size} attachment rows for a note. */
function attachmentLinks(value: unknown) {
  return jsonObjects(value)
    .map((row) => ({ id: String(row.id), name: String(row.name), size: num(row.size) }))
    .filter((row) => row.id && row.id !== 'null');
}

export interface AuditFields {
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: string | null;
  last_edited_by: string | null;
}

export function contactOut(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    firstName: String(row.first_name),
    lastName: String(row.last_name),
    fullName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
    email: String(row.email),
    phone: text(row.phone),
    howWeConnected: text(row.how_we_connected),
    tags: tags(row.tags),
    organizationId: text(row.organization_id),
    organizationName: text(row.organization_name),
    orgRole: text(row.org_role),
    // Every organization this contact belongs to. Present when the query supplies it.
    organizations: organizationLinks(row.organizations_json),
    status: String(row.status),
    isStudentFounder: num(row.is_student_founder) === 1,
    dateAdded: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdBy: text(row.created_by),
    createdByName: text(row.created_by_name),
    lastEditedBy: text(row.last_edited_by),
    // Aggregates, present on list/detail queries.
    lastInteractionAt: iso(row.last_interaction_at),
    latestNoteSnippet: text(row.latest_note),
    noteCount: num(row.note_count),
    openTaskCount: num(row.open_task_count),
    documentCount: num(row.document_count),
  };
}

export function noteOut(row: Record<string, unknown>) {
  const content = String(row.content ?? '');
  return {
    id: String(row.id),
    contactId: text(row.contact_id),
    contactName: text(row.contact_name),
    // Every contact this note is filed under. Present when the query supplies it.
    contacts: contactLinks(row.contacts_json),
    attachments: attachmentLinks(row.attachments_json),
    noteType: String(row.note_type),
    content,
    wordCount: content.trim() ? content.trim().split(/\s+/).length : 0,
    tags: tags(row.tags),
    source: String(row.source),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdBy: text(row.created_by),
    createdByName: text(row.created_by_name),
  };
}

export function taskOut(row: Record<string, unknown>) {
  const status = String(row.status);
  const dueDate = String(row.due_date);
  // "Overdue" is derived, never stored, so it can never drift out of date.
  const isOverdue = status !== 'complete' && dueDate < todayDate();
  return {
    id: String(row.id),
    title: String(row.title),
    dueDate,
    isOverdue,
    /** Convenience status for badges: the four states the UI colour-codes. */
    displayStatus: isOverdue ? 'overdue' : status,
    contactId: text(row.contact_id),
    contactName: text(row.contact_name),
    assignedTo: text(row.assigned_to),
    assignedToName: text(row.assigned_to_name),
    status: String(row.status),
    priority: String(row.priority),
    reminderEnabled: num(row.reminder_enabled) === 1,
    reminderOffset: String(row.reminder_offset),
    contextNotes: text(row.context_notes),
    recurrence: String(row.recurrence),
    recurrenceParentId: text(row.recurrence_parent_id),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdBy: text(row.created_by),
  };
}

export function organizationOut(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    orgType: String(row.org_type),
    location: text(row.location),
    website: text(row.website),
    relationship: text(row.relationship),
    status: String(row.status),
    contactCount: num(row.contact_count),
    documentCount: num(row.document_count),
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    createdBy: text(row.created_by),
  };
}

export function eventOut(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    eventType: String(row.event_type),
    location: text(row.location),
    description: text(row.description),
    followupNotes: text(row.followup_notes),
    attendeeCount: num(row.attendee_count),
    externalId: text(row.external_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function documentOut(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    contactId: text(row.contact_id),
    organizationId: text(row.organization_id),
    noteId: text(row.note_id),
    fileName: String(row.file_name),
    fileSize: num(row.file_size),
    fileType: String(row.file_type),
    uploadedBy: text(row.uploaded_by),
    uploadedByName: text(row.uploaded_by_name),
    createdAt: iso(row.created_at),
  };
}

export function userOut(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
    openTaskCount: num(row.open_task_count),
  };
}

export { num as toNumber, tags as parseTags };
