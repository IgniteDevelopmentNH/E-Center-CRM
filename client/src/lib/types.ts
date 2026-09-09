/** Wire types, mirroring the mappers in server/src/records.ts. */

export type ContactStatus = 'active' | 'past' | 'on_hold';
export type NoteType = 'email' | 'call' | 'meeting' | 'workshop' | 'referral' | 'other';
export type TaskStatus = 'open' | 'in_progress' | 'complete';
export type TaskDisplayStatus = TaskStatus | 'overdue';
export type TaskPriority = 'high' | 'medium' | 'low';
export type TaskRecurrence = 'none' | 'weekly' | 'biweekly' | 'monthly';
export type ReminderOffset = 'one_day' | 'three_days' | 'on_date';
export type OrgType = 'startup' | 'established' | 'club' | 'nonprofit' | 'other';
export type OrgStatus = 'active' | 'inactive' | 'prospect';
export type EventType =
  | 'workshop'
  | 'speaker_series'
  | 'ideathon'
  | 'networking'
  | 'one_on_one'
  | 'other';
export type UserRole = 'owner' | 'editor' | 'viewer';

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string | null;
  howWeConnected: string | null;
  tags: string[];
  organizationId: string | null;
  organizationName: string | null;
  orgRole: string | null;
  status: ContactStatus;
  isStudentFounder: boolean;
  dateAdded: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  lastEditedBy: string | null;
  lastInteractionAt: string | null;
  latestNoteSnippet: string | null;
  noteCount: number;
  openTaskCount: number;
  documentCount: number;
}

export interface Note {
  id: string;
  contactId: string;
  contactName: string | null;
  noteType: NoteType;
  content: string;
  wordCount: number;
  tags: string[];
  source: 'manual' | 'event' | 'system';
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export interface Task {
  id: string;
  title: string;
  dueDate: string;
  isOverdue: boolean;
  displayStatus: TaskDisplayStatus;
  contactId: string | null;
  contactName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  reminderEnabled: boolean;
  reminderOffset: ReminderOffset;
  contextNotes: string | null;
  recurrence: TaskRecurrence;
  recurrenceParentId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface Organization {
  id: string;
  name: string;
  orgType: OrgType;
  location: string | null;
  website: string | null;
  relationship: string | null;
  status: OrgStatus;
  contactCount: number;
  documentCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface CrmEvent {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  eventType: EventType;
  location: string | null;
  description: string | null;
  followupNotes: string | null;
  attendeeCount: number;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDocument {
  id: string;
  contactId: string | null;
  organizationId: string | null;
  fileName: string;
  fileSize: number;
  fileType: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  lastLoginAt: string | null;
  createdAt: string;
  openTaskCount: number;
  overdueTaskCount?: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface Paged {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export type ContactsResponse = Paged & { contacts: Contact[] };
export type NotesResponse = Paged & { notes: Note[] };
export type TasksResponse = Paged & {
  tasks: Task[];
  summary: { total: number; overdue: number; dueSoon: number; complete: number };
};
export type OrganizationsResponse = Paged & { organizations: Organization[] };

export interface DashboardResponse {
  stats: {
    activeContacts: number;
    totalContacts: number;
    tasksDueThisWeek: number;
    overdueTasks: number;
    upcomingEvents: number;
    teamMembers: number;
    organizations: number;
    nextEventAt: string | null;
    nextEventName: string | null;
  };
  overdueTasks: Task[];
  thisWeek: Task[];
  upcomingEvents: CrmEvent[];
  team: TeamMember[];
  activity: {
    type: 'note' | 'contact' | 'task';
    at: string;
    title: string;
    detail: string | null;
    contactId: string | null;
    entityId: string;
  }[];
  generatedAt: string;
}

export interface SearchResponse {
  query: string;
  contacts: Contact[];
  organizations: Organization[];
  notes: Note[];
  tasks: Task[];
  events: CrmEvent[];
}

export interface SettingsResponse {
  preferences: { emailDigest: 'off' | 'daily' | 'weekly'; reminderLeadDays: number; timezone: string };
  customer: { name: string; slug: string; createdAt: string | null };
  calendar: {
    configured: boolean;
    connected: boolean;
    accountEmail: string | null;
    lastSyncAt: string | null;
    syncStatus: string;
    errorMessage: string | null;
    eventsPulled: number;
    eventsPushed: number;
  };
  documents: {
    storageDriver: string;
    maxFileSizeMb: number;
    allowedExtensions: string[];
    downloadUrlTtlMinutes: number;
  };
  about: { version: string; databaseDriver: string; serverDate: string };
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  userName: string | null;
  metadata: string | null;
  ipAddress: string | null;
  createdAt: string;
}
