import { badRequest } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';

/**
 * Per-event options shared by event posts and CRM events: the icon palette and
 * registration questions. Both are stored as JSON on the event; answers are
 * stored as JSON on the RSVP, keyed by question id.
 */

/** Keep in step with client/src/lib/eventIcons.ts, which holds the artwork and labels. */
export const EVENT_ICON_KEYS = [
  'food', 'pizza', 'snacks', 'coffee', 'drinks', 'alcohol', 'vegetarian',
  'cash-prize', 'trophy', 'giveaways', 'swag', 'free', 'ticket', 'certificate', 'funding', 'grants',
  'networking', 'speaker', 'panel', 'workshop', 'pitch', 'demo', 'hackathon', 'startup', 'ideas',
  'mentors', 'recruiting', 'resume', 'investors', 'students', 'alumni', 'class-credit',
  'virtual', 'hybrid', 'in-person', 'outdoors', 'parking', 'shuttle', 'accessible', 'family', 'pets',
  'music', 'social', 'games', 'photos', 'recording', 'wifi', 'laptop', 'limited-seats', 'rsvp-required', 'drop-in', 'attire',
  'technology', 'ai', 'marketing', 'finance', 'legal', 'health', 'sustainability', 'global', 'nonprofit',
] as const;

/** RSVPs from members plus guests. `idExpr` is the SQL for the target's id. */
export function rsvpCountSql(targetType: 'post' | 'event', idExpr: string): string {
  return `((SELECT COUNT(*) FROM event_rsvps r WHERE r.target_type = '${targetType}' AND r.target_id = ${idExpr})
         + (SELECT COUNT(*) FROM event_guest_rsvps gr WHERE gr.target_type = '${targetType}' AND gr.target_id = ${idExpr}))`;
}

const ICON_SET = new Set<string>(EVENT_ICON_KEYS);
const MAX_ICONS = 8;

export function parseIcons(raw: unknown): string {
  if (raw === undefined || raw === null) return '[]';
  if (!Array.isArray(raw)) throw badRequest('Icons must be a list.', 'Icons');
  const keys = [...new Set(raw)].filter((key): key is string => typeof key === 'string');
  if (keys.some((key) => !ICON_SET.has(key))) throw badRequest('One of those icons is not available.', 'Icons');
  if (keys.length > MAX_ICONS) throw badRequest(`Choose up to ${MAX_ICONS} icons.`, 'Icons');
  return JSON.stringify(keys);
}

export function readIcons(value: unknown): string[] {
  return readArray(value).filter((key): key is string => typeof key === 'string' && ICON_SET.has(key));
}

function readArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------- registration questions -- */

export const QUESTION_TYPES = ['yesno', 'text', 'choice', 'checkboxes'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface RegistrationQuestion {
  id: string;
  type: QuestionType;
  label: string;
  required: boolean;
  options: string[];
}

export type Answers = Record<string, string | string[]>;

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const LABEL_MAX = 200;
const OPTION_MAX = 100;
const ANSWER_MAX = 1000;
const YES_NO = ['Yes', 'No'];

/** Validates the questions an organiser wrote, and returns them as stored JSON. */
export function parseQuestions(raw: unknown): string {
  if (raw === undefined || raw === null) return '[]';
  if (!Array.isArray(raw)) throw badRequest('Registration questions must be a list.', 'Questions');
  if (raw.length > MAX_QUESTIONS) throw badRequest(`Add up to ${MAX_QUESTIONS} questions.`, 'Questions');
  const questions: RegistrationQuestion[] = raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label) throw badRequest('Every registration question needs text.', 'Questions');
    if (label.length > LABEL_MAX) throw badRequest(`Questions must be ${LABEL_MAX} characters or fewer.`, 'Questions');
    const type = item.type as QuestionType;
    if (!QUESTION_TYPES.includes(type)) throw badRequest('Choose a type for every question.', 'Questions');
    let options: string[] = [];
    if (type === 'choice' || type === 'checkboxes') {
      const list = Array.isArray(item.options) ? item.options : [];
      options = [...new Set(list.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter(Boolean))];
      if (options.length < 2) throw badRequest(`"${label}" needs at least two answer choices.`, 'Questions');
      if (options.length > MAX_OPTIONS) throw badRequest(`"${label}" can have up to ${MAX_OPTIONS} choices.`, 'Questions');
      if (options.some((o) => o.length > OPTION_MAX)) throw badRequest(`Answer choices must be ${OPTION_MAX} characters or fewer.`, 'Questions');
    }
    // Ids stay stable across edits so answers already given keep their question.
    const id = typeof item.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(item.id) ? item.id : newId();
    return { id, type, label, required: item.required !== false, options };
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length) {
    throw badRequest('Two registration questions are the same.', 'Questions');
  }
  return JSON.stringify(questions);
}

export function readQuestions(value: unknown): RegistrationQuestion[] {
  return readArray(value) as RegistrationQuestion[];
}

/** Checks an RSVP's answers against the event's questions, and returns what to store. */
export function parseAnswers(questions: RegistrationQuestion[], raw: unknown): string {
  const given = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const answers: Answers = {};
  for (const question of questions) {
    const value = given[question.id];
    if (question.type === 'checkboxes') {
      const picked = Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];
      if (picked.some((v) => !question.options.includes(v))) throw badRequest(`Choose from the listed answers for "${question.label}".`, 'Answers');
      if (question.required && picked.length === 0) throw badRequest(`Please answer "${question.label}".`, 'Answers');
      if (picked.length) answers[question.id] = picked;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      if (question.required) throw badRequest(`Please answer "${question.label}".`, 'Answers');
      continue;
    }
    if (text.length > ANSWER_MAX) throw badRequest(`Answers must be ${ANSWER_MAX} characters or fewer.`, 'Answers');
    const allowed = question.type === 'yesno' ? YES_NO : question.type === 'choice' ? question.options : null;
    if (allowed && !allowed.includes(text)) throw badRequest(`Choose from the listed answers for "${question.label}".`, 'Answers');
    answers[question.id] = text;
  }
  return JSON.stringify(answers);
}

export function readAnswers(value: unknown): Answers {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Answers) : {};
  } catch {
    return {};
  }
}
