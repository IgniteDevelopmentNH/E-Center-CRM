import { Link, useParams } from 'react-router-dom';
import { MemberActions, MemberAvatar, TopicChips, TypeBadge, subtitleFor } from '../../components/community.tsx';
import { ErrorBlock, LoadingBlock } from '../../components/ui.tsx';
import { api, openSignedUrl } from '../../lib/api.ts';
import { useApi } from '../../lib/hooks.ts';
import type { PublicMember } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

/** A member's community profile: public fields only, as returned by the server. */
export function MemberProfilePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<{ member: PublicMember }>(id ? `/community/members/${id}` : null);

  if (loading) return <LoadingBlock label="Loading profile" />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <ErrorBlock message={error ?? 'That profile is not available.'} onRetry={reload} />
        <Link to="/network" className="btn-ghost">Back to the network</Link>
      </div>
    );
  }

  const member = data.member;
  const subtitle = subtitleFor(member);
  const isMe = member.id === user?.id;
  const isStudent = member.accountType === 'student';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/network" className="text-sm font-semibold text-teal-700 hover:underline">
        <span aria-hidden="true">←</span> Network
      </Link>

      <section className="card overflow-hidden">
        <div className="h-24 bg-gradient-to-r from-navy to-teal-700" aria-hidden="true" />
        <div className="-mt-12 px-6 pb-6">
          <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} size="xl" />
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-navy-800">{member.fullName}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <TypeBadge type={member.accountType} />
                {subtitle && <span className="text-sm text-slate-500">{subtitle}</span>}
              </div>
              {member.hasPublicResume && (
                <button
                  type="button"
                  className="mr-4 mt-2 inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline"
                  onClick={async () => {
                    try {
                      openSignedUrl((await api.get<{ url: string }>(`/community/members/${member.id}/resume`)).url);
                    } catch {
                      window.alert('That resume is no longer available.');
                    }
                  }}
                >
                  View resume
                </button>
              )}
              {member.linkedinUrl && (
                <a
                  href={member.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline"
                >
                  LinkedIn profile <span aria-hidden="true">↗</span>
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </div>
            {isMe ? (
              <Link to="/profile" className="btn-ghost">Edit my profile</Link>
            ) : (
              <MemberActions member={member} />
            )}
          </div>
          {!member.available && (
            <p className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">This member is no longer active in the community.</p>
          )}
        </div>
      </section>

      {member.bio && (
        <section className="card p-6" aria-labelledby="about">
          <h2 id="about" className="text-sm font-bold uppercase tracking-wide text-navy-800">About</h2>
          <p className="mt-2 whitespace-pre-line text-slate-700">{member.bio}</p>
        </section>
      )}

      {(member.interests.length > 0 || member.help.length > 0) && (
        <section className="card space-y-5 p-6">
          {member.interests.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-navy-800">
                {isStudent ? 'Interests' : 'Expertise'}
              </h2>
              <TopicChips tags={member.interests} />
            </div>
          )}
          {member.help.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-navy-800">
                {isStudent ? 'Looking for help with' : 'Can help with'}
              </h2>
              <TopicChips tags={member.help} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
