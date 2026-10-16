/**
 * Deterministic mentor matching -- no AI, no randomness, fully explainable.
 *
 * A student's "help wanted" topics count double, their general interests
 * count once; each is matched against everything the mentor lists (expertise
 * and "can help with"). Ties break on more shared topics, then last name,
 * first name and finally user id, so the same inputs always give the same order.
 */

export interface TagRef {
  slug: string;
  label: string;
}

export interface MatchInput {
  id: string;
  firstName: string;
  lastName: string;
  interests: TagRef[];
  help: TagRef[];
}

export interface MatchResult {
  id: string;
  score: number;
  helpMatches: TagRef[];
  interestMatches: TagRef[];
  reason: string | null;
}

/** "Legal & IP" -> "legal & IP"; "Marketing" -> "marketing". */
function inSentence(label: string): string {
  return label.length > 1 && label[1] === label[1]!.toLowerCase() ? label[0]!.toLowerCase() + label.slice(1) : label;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function explainMatch(helpMatches: TagRef[], interestMatches: TagRef[]): string | null {
  const parts: string[] = [];
  if (helpMatches.length) parts.push(`Can help with ${joinList(helpMatches.map((t) => inSentence(t.label)))}`);
  if (interestMatches.length) {
    parts.push(`${parts.length ? 'Also matches' : 'Matches'} your interests in ${joinList(interestMatches.map((t) => inSentence(t.label)))}`);
  }
  return parts.length ? `${parts.join('. ')}.` : null;
}

export function scoreMentor(viewer: { interests: TagRef[]; help: TagRef[] }, mentor: MatchInput): MatchResult {
  const offered = new Map<string, TagRef>();
  for (const tag of [...mentor.interests, ...mentor.help]) offered.set(tag.slug, tag);

  const helpMatches = viewer.help.filter((tag) => offered.has(tag.slug));
  const helpSlugs = new Set(helpMatches.map((t) => t.slug));
  const interestMatches = viewer.interests.filter((tag) => offered.has(tag.slug) && !helpSlugs.has(tag.slug));

  const sortByLabel = (a: TagRef, b: TagRef) => a.label.localeCompare(b.label);
  helpMatches.sort(sortByLabel);
  interestMatches.sort(sortByLabel);

  return {
    id: mentor.id,
    score: helpMatches.length * 2 + interestMatches.length,
    helpMatches,
    interestMatches,
    reason: explainMatch(helpMatches, interestMatches),
  };
}

export function recommendMentors(
  viewer: { id: string; interests: TagRef[]; help: TagRef[] },
  mentors: MatchInput[],
  limit = 6,
): MatchResult[] {
  const byId = new Map(mentors.map((m) => [m.id, m]));
  return mentors
    .filter((mentor) => mentor.id !== viewer.id)
    .map((mentor) => scoreMentor(viewer, mentor))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const sharedA = a.helpMatches.length + a.interestMatches.length;
      const sharedB = b.helpMatches.length + b.interestMatches.length;
      if (sharedB !== sharedA) return sharedB - sharedA;
      const ma = byId.get(a.id)!;
      const mb = byId.get(b.id)!;
      return (
        ma.lastName.localeCompare(mb.lastName) ||
        ma.firstName.localeCompare(mb.firstName) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
    })
    .slice(0, limit);
}
