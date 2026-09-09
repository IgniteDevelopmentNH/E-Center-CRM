/** Option lists, mirroring the server-side enums in records.ts. */

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

/** Suggested note tags. Free-text entry adds to this at will. */
export const NOTE_TAGS = ['#FollowUp', '#Interested', '#Needs', '#Ideas', '#Intro', '#Event'] as const;

export const TASK_STATUSES = ['open', 'in_progress', 'complete'] as const;
export const TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export const TASK_RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly'] as const;

export const REMINDER_OFFSETS = [
  { value: 'one_day', label: '1 day before' },
  { value: 'three_days', label: '3 days before' },
  { value: 'on_date', label: 'On the due date' },
] as const;

export const ORG_TYPES = [
  { value: 'startup', label: 'Startup' },
  { value: 'established', label: 'Established business' },
  { value: 'club', label: 'Club' },
  { value: 'nonprofit', label: 'Non-profit' },
  { value: 'other', label: 'Other' },
] as const;

export const ORG_STATUSES = ['active', 'inactive', 'prospect'] as const;

export const EVENT_TYPES = [
  { value: 'workshop', label: 'Workshop' },
  { value: 'speaker_series', label: 'Speaker series' },
  { value: 'ideathon', label: 'Ideathon' },
  { value: 'networking', label: 'Networking' },
  { value: 'one_on_one', label: '1-on-1 meeting' },
  { value: 'other', label: 'Other' },
] as const;

export const USER_ROLES = [
  { value: 'owner', label: 'Owner -- full access, manages the team' },
  { value: 'editor', label: 'Editor -- can add and change records' },
  { value: 'viewer', label: 'Viewer -- read only' },
] as const;

export const DEFAULT_EVENT_LOCATION = 'Madbury Commons';
