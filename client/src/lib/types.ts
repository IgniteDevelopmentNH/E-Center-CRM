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

export interface OrganizationLink {
  id: string;
  name: string;
  role: string | null;
}

export interface ContactLink {
  id: string;
  name: string;
}

export interface NoteAttachment {
  id: string;
  name: string;
  size: number;
}

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
  organizations: OrganizationLink[];
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
  /** Linked community account, if this contact signed up to the portal. */
  communityAccount: { userId: string; accountType: string; status: AccountStatus } | null;
}

export interface Note {
  id: string;
  contactId: string | null;
  contactName: string | null;
  contacts: ContactLink[];
  attachments: NoteAttachment[];
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
  communityVisible: boolean;
  communityDetails: string | null;
  communityRsvp: boolean;
  communityRsvpCount: number;
  communityNotifiedAt: string | null;
  attendeeCount: number;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDocument {
  id: string;
  contactId: string | null;
  organizationId: string | null;
  noteId: string | null;
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
  /** owner | editor | viewer are staff; 'member' is a community-only login. */
  role: UserRole | 'member';
  isStaff: boolean;
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

/* -------------------------------------------------------- community portal -- */

export type AccountType = 'student' | 'mentor' | 'staff';
export type AccountStatus = 'pending' | 'active' | 'deactivated';

export interface InterestTag {
  slug: string;
  label: string;
  /** Featured topics show first; the rest are behind "See more". */
  featured?: boolean;
}

export type PostPermission = 'none' | 'approval' | 'direct';

/** The caller's own community record (private: includes email and resume). */
export interface CommunityState {
  userId: string;
  accountType: AccountType;
  status: AccountStatus;
  onboardingCompleted: boolean;
  emailVerified: boolean;
  email: string;
  pendingEmail: string | null;
  profile: {
    firstName: string;
    lastName: string;
    bio: string | null;
    linkedinUrl: string | null;
    photoUrl: string | null;
    major: string | null;
    graduationYear: number | null;
    roleTitle: string | null;
    company: string | null;
    schedulingUrl: string | null;
    interests: InterestTag[];
    help: InterestTag[];
  };
  resume: { fileName: string; size: number; uploadedAt: string; public: boolean } | null;
  postPermission: PostPermission;
  notifications: { messages: boolean; mentions: boolean; announcements: boolean };
}

/** How a member appears to other members. Public fields only. */
export interface PublicMember {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  accountType: AccountType;
  bio: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  major: string | null;
  graduationYear: number | null;
  roleTitle: string | null;
  company: string | null;
  schedulingUrl: string | null;
  interests: InterestTag[];
  help: InterestTag[];
  hasPublicResume: boolean;
  available: boolean;
}

export type MembersResponse = Paged & { members: PublicMember[] };

export interface CommunityEvent {
  id: string;
  /** 'event' = a CRM event shown to the community; 'post' = an event post. */
  source: 'event' | 'post';
  name: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
}

export interface CommunityEventDetail {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  details: string | null;
  rsvpEnabled: boolean;
  rsvpCount: number;
  going: boolean;
}

export interface FeedPost {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  imageUrl: string | null;
  status: 'draft' | 'pending' | 'published' | 'rejected' | 'archived';
  publishedAt: string | null;
  updatedAt: string;
  reviewNote: string | null;
  author: {
    kind: 'member' | 'staff';
    id: string | null;
    name: string;
    accountType: string;
    photoUrl: string | null;
  };
  event: {
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    rsvpEnabled: boolean;
    rsvpCount: number;
    going: boolean;
  } | null;
  linkedEvent: { id: string; name: string; startsAt: string; endsAt: string | null; location: string | null } | null;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface PostComment {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  author: { id: string | null; name: string; accountType: string; photoUrl: string | null; isPostAuthor: boolean };
  canDelete: boolean;
  replies?: PostComment[];
}

export interface Recommendation {
  mentor: PublicMember;
  reason: string | null;
  sharedTags: InterestTag[];
}

export interface ConversationSummary {
  id: string;
  other: PublicMember | null;
  lastMessage: { body: string; mine: boolean } | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  mine: boolean;
  body: string;
  kind: 'text' | 'meeting_request';
  clientKey: string;
  createdAt: string;
}

export interface AdminPost {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  imageUrl: string | null;
  eventId: string | null;
  eventName: string | null;
  eventStartsAt: string | null;
  eventCommunityVisible: boolean;
  isEvent: boolean;
  eventDetails: { startsAt: string; endsAt: string | null; location: string | null; rsvpEnabled: boolean } | null;
  status: 'draft' | 'pending' | 'published' | 'rejected' | 'archived';
  deleted: boolean;
  publishedAt: string | null;
  authorKind: 'member' | 'staff';
  authorId: string | null;
  authorName: string | null;
  authorAccountType: string;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  notifiedAt: string | null;
  likeCount: number;
  commentCount: number;
  rsvpCount: number;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PostRevision {
  id: string;
  postId: string;
  action: 'edit' | 'delete' | 'restore' | 'approve' | 'reject';
  previous: { title: string; body: string; linkUrl: string | null; status: string; eventStartsAt: string | null; eventLocation: string | null };
  currentTitle: string | null;
  currentStatus: string | null;
  postDeleted: boolean;
  changedByName: string | null;
  createdAt: string;
}

export interface RemovedComment {
  id: string;
  postId: string;
  postTitle: string;
  body: string;
  authorName: string | null;
  removedByName: string | null;
  createdAt: string;
  removedAt: string;
}

export type LinkState = 'pending' | 'linked' | 'conflict' | 'unlinked' | 'not_applicable';

export interface AdminCommunityAccount {
  userId: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  accountType: AccountType;
  status: AccountStatus;
  onboardingCompleted: boolean;
  linkState: LinkState;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  emailDiffersFromContact: boolean;
  hasResume: boolean;
  resumeName: string | null;
  resumePublic: boolean;
  postPermissionOverride: PostPermission | null;
  postPermission: PostPermission;
  createdAt: string;
  activatedAt: string | null;
  lastLoginAt: string | null;
  deactivatedAt: string | null;
  deactivatedByName: string | null;
  deactivationReason: string | null;
  profile: {
    bio: string | null;
    roleTitle: string | null;
    company: string | null;
    major: string | null;
    graduationYear: number | null;
    linkedinUrl: string | null;
    schedulingUrl: string | null;
  };
  interests?: InterestTag[];
  help?: InterestTag[];
}

export interface LinkCandidate {
  id: string;
  fullName: string;
  email: string;
  status: string;
  organizationName: string | null;
  createdAt: string;
  linkedToAnotherAccount: boolean;
}
