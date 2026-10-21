import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { UNREAD_REFRESH_EVENT } from '../../components/CommunityShell.tsx';
import { MemberAvatar, accountTypeLabel } from '../../components/community.tsx';
import { Modal } from '../../components/overlays.tsx';
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from '../../components/ui.tsx';
import { ApiError, api, buildQuery } from '../../lib/api.ts';
import { formatDate, formatRelative, formatTime } from '../../lib/format.ts';
import { useApi, useDebounced } from '../../lib/hooks.ts';
import type { ChatMessage, ConversationSummary, MembersResponse, PublicMember } from '../../lib/types.ts';
import { useAuth } from '../../state/AuthContext.tsx';

/** Polling intervals: the Worker has no realtime channel, so the page refreshes lightly while visible. */
const THREAD_POLL_MS = 8_000;
const LIST_POLL_MS = 20_000;
const MAX_LENGTH = 4000;

type LocalMessage = ChatMessage & { state?: 'sending' | 'failed' };

function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') saved.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
}

function sortMessages(list: LocalMessage[]): LocalMessage[] {
  return [...list].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
}

export function MessagesPage() {
  const [params, setParams] = useSearchParams();
  const { isActiveMember, isStaff } = useAuth();
  const selectedId = params.get('c');
  const recipientId = params.get('to');
  const wantsMeeting = params.get('meeting') === '1';
  const [startError, setStartError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const list = useApi<{ conversations: ConversationSummary[] }>(isActiveMember ? '/community/conversations' : null);
  usePolling(list.reload, LIST_POLL_MS, isActiveMember);

  // `?to=<userId>` (from a profile or mentor card) finds or starts the conversation.
  useEffect(() => {
    if (!recipientId || !isActiveMember) return;
    let cancelled = false;
    setStartError(null);
    api
      .post<{ conversationId: string }>('/community/conversations', { recipientId })
      .then((response) => {
        if (cancelled) return;
        const next: Record<string, string> = { c: response.conversationId };
        if (wantsMeeting) next.meeting = '1';
        setParams(next, { replace: true });
        list.reload();
      })
      .catch((caught) => !cancelled && setStartError(caught instanceof ApiError ? caught.message : 'Could not start that conversation.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientId, isActiveMember]);

  if (!isActiveMember) {
    return (
      <EmptyState
        title="Messaging needs a community profile"
        message={
          isStaff
            ? 'Your admin access does not include members’ conversations. Create your own community profile to message members as ECenter staff.'
            : 'Finish setting up your account to message members.'
        }
        action={<Link to="/profile" className="btn-primary">Go to my profile</Link>}
        icon="✉"
      />
    );
  }

  const conversations = list.data?.conversations ?? [];
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const markedRead = (id: string) => {
    list.setData((previous) =>
      previous ? { conversations: previous.conversations.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) } : previous,
    );
    window.dispatchEvent(new Event(UNREAD_REFRESH_EVENT));
  };

  return (
    <div className="space-y-4">
      <div className={`flex items-center justify-between gap-3 ${selectedId ? 'hidden md:flex' : ''}`}>
        <h1 className="text-2xl font-bold text-navy-800">Messages</h1>
        <button type="button" className="btn-secondary" onClick={() => setPickerOpen(true)}>
          New message
        </button>
      </div>

      {startError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-urgent" role="alert">{startError}</p>
      )}

      <div
        className={`card grid overflow-hidden md:h-[calc(100vh-15rem)] md:grid-cols-[320px_minmax(0,1fr)] ${
          selectedId ? 'h-[calc(100dvh-8.5rem)]' : 'min-h-[60vh]'
        }`}
      >
        {/* Conversation list: always on desktop; on mobile only when no conversation is open. */}
        <section className={`min-h-0 border-slate-200 md:flex md:flex-col md:border-r ${selectedId ? 'hidden' : 'flex flex-col'}`} aria-label="Conversations">
          {list.loading && !list.data && <LoadingBlock label="Loading conversations" />}
          {list.error && !list.data && <div className="p-4"><ErrorBlock message={list.error} onRetry={list.reload} /></div>}
          {list.data && conversations.length === 0 && (
            <div className="p-6 text-center">
              <p className="font-semibold text-navy-800">No conversations yet</p>
              <p className="mt-1 text-sm text-slate-500">Message someone from the Network or Mentorship pages, or start one here.</p>
            </div>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => setParams({ c: conversation.id })}
                  aria-current={conversation.id === selectedId ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50 ${
                    conversation.id === selectedId ? 'bg-teal-50' : ''
                  }`}
                >
                  <MemberAvatar name={conversation.other?.fullName ?? '?'} photoUrl={conversation.other?.photoUrl ?? null} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm ${conversation.unreadCount ? 'font-bold' : 'font-semibold'} text-navy-800`}>
                        {conversation.other?.fullName ?? 'Unavailable member'}
                      </span>
                      {conversation.lastMessageAt && (
                        <span className="shrink-0 text-[11px] text-slate-400">{formatRelative(conversation.lastMessageAt)}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-xs ${conversation.unreadCount ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>
                        {conversation.other && !conversation.other.available
                          ? 'No longer active'
                          : conversation.lastMessage
                            ? `${conversation.lastMessage.mine ? 'You: ' : ''}${conversation.lastMessage.body}`
                            : 'No messages yet'}
                      </span>
                      {conversation.unreadCount > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-teal px-1.5 text-[11px] font-bold text-white">
                          {conversation.unreadCount}
                          <span className="sr-only"> unread</span>
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Thread */}
        <section className={`min-h-0 flex-col ${selectedId ? 'flex' : 'hidden md:flex'}`} aria-label="Conversation">
          {selectedId ? (
            <Thread
              key={selectedId}
              conversationId={selectedId}
              summary={selected}
              meeting={wantsMeeting}
              onBack={() => setParams({})}
              onActivity={list.reload}
              onRead={() => markedRead(selectedId)}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-sm text-slate-500">
              Select a conversation, or start a new one.
            </div>
          )}
        </section>
      </div>

      <RecipientPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

function meetingTemplate(other: PublicMember | null, myName: string): string {
  const first = other?.firstName ?? 'there';
  return `Hi ${first}, I'm ${myName}. I'd love to set up a short meeting to get your advice. Here are a few times that work for me:\n\n- \n- \n\nLet me know what suits you, or suggest another time. Thank you!`;
}

function Thread({
  conversationId,
  summary,
  meeting,
  onBack,
  onActivity,
  onRead,
}: {
  conversationId: string;
  summary: ConversationSummary | null;
  meeting: boolean;
  onBack: () => void;
  onActivity: () => void;
  onRead: () => void;
}) {
  const { community, user } = useAuth();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [other, setOther] = useState<PublicMember | null>(summary?.other ?? null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myName = community ? `${community.profile.firstName} ${community.profile.lastName}` : (user?.name ?? '');
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<'text' | 'meeting_request'>('text');
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prefilled = useRef(false);
  const lastSeenTheirs = useRef('');

  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byKey = new Map<string, LocalMessage>();
      for (const message of current) byKey.set(message.clientKey, message);
      for (const message of incoming) byKey.set(message.clientKey, message);
      return sortMessages([...byKey.values()]);
    });
  }, []);

  const fetchLatest = useCallback(
    async (initial = false) => {
      const response = await api.get<{ messages: ChatMessage[]; other: PublicMember | null; olderCursor: string | null }>(
        `/community/conversations/${conversationId}/messages?limit=30`,
      );
      merge(response.messages);
      setOther(response.other);
      if (initial) setOlderCursor(response.olderCursor);
      // Mark read only when something new from the other person has arrived.
      const newestTheirs = response.messages.filter((m) => !m.mine).reduce((max, m) => (m.createdAt > max ? m.createdAt : max), '');
      if (initial || newestTheirs > lastSeenTheirs.current) {
        lastSeenTheirs.current = newestTheirs;
        await api.post(`/community/conversations/${conversationId}/read`).catch(() => undefined);
        onRead();
      }
      return response;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, merge],
  );

  useEffect(() => {
    setLoading(true);
    fetchLatest(true)
      .then(() => setError(null))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'This conversation could not be loaded.'))
      .finally(() => setLoading(false));
  }, [fetchLatest]);

  usePolling(() => void fetchLatest().catch(() => undefined), THREAD_POLL_MS, !loading && !error);

  // Prefill an editable meeting request when arriving via "Request a meeting".
  useEffect(() => {
    if (meeting && other && !prefilled.current) {
      prefilled.current = true;
      setDraft(meetingTemplate(other, myName));
      setKind('meeting_request');
    }
  }, [meeting, other, myName]);

  const lastId = messages[messages.length - 1]?.clientKey;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  async function loadOlder() {
    if (!olderCursor) return;
    setLoadingOlder(true);
    try {
      const response = await api.get<{ messages: ChatMessage[]; olderCursor: string | null }>(
        `/community/conversations/${conversationId}/messages?limit=30&before=${encodeURIComponent(olderCursor)}`,
      );
      merge(response.messages);
      setOlderCursor(response.olderCursor);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function deliver(message: LocalMessage) {
    setMessages((current) => current.map((m) => (m.clientKey === message.clientKey ? { ...m, state: 'sending' } : m)));
    try {
      const response = await api.post<{ message: ChatMessage }>(`/community/conversations/${conversationId}/messages`, {
        body: message.body,
        kind: message.kind,
        clientKey: message.clientKey,
      });
      merge([response.message]);
      onActivity();
    } catch (caught) {
      setMessages((current) => current.map((m) => (m.clientKey === message.clientKey ? { ...m, state: 'failed' } : m)));
      setSendError(caught instanceof ApiError ? caught.message : 'Message not sent. Check your connection and retry.');
    }
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || body.length > MAX_LENGTH) return;
    setSendError(null);
    const clientKey = crypto.randomUUID();
    const pending: LocalMessage = {
      id: `pending-${clientKey}`,
      conversationId,
      senderId: user?.id ?? '',
      mine: true,
      body,
      kind,
      clientKey,
      createdAt: new Date().toISOString(),
      state: 'sending',
    };
    setMessages((current) => sortMessages([...current, pending]));
    setDraft('');
    setKind('text');
    void deliver(pending);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const unavailable = other ? !other.available : false;
  const grouped = useMemo(() => {
    const groups: { day: string; items: LocalMessage[] }[] = [];
    for (const message of messages) {
      const day = formatDate(message.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(message);
      else groups.push({ day, items: [message] });
    }
    return groups;
  }, [messages]);

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button type="button" className="btn-quiet md:hidden" onClick={onBack} aria-label="Back to conversations">
          <span aria-hidden="true">←</span> Back
        </button>
        {other ? (
          <Link to={`/members/${other.id}`} className="flex min-w-0 items-center gap-3 rounded-lg hover:underline">
            <MemberAvatar name={other.fullName} photoUrl={other.photoUrl} size="sm" />
            <span className="min-w-0">
              <span className="block truncate font-semibold text-navy-800">{other.fullName}</span>
              <span className="block text-xs text-slate-500">{accountTypeLabel(other.accountType)}</span>
            </span>
          </Link>
        ) : (
          <span className="text-sm text-slate-500">{loading ? 'Loading...' : 'Unavailable member'}</span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-4" aria-live="polite" aria-relevant="additions">
        {loading && <LoadingBlock label="Loading messages" />}
        {error && <ErrorBlock message={error} />}
        {olderCursor && (
          <div className="mb-3 flex justify-center">
            <button type="button" className="btn-quiet text-xs" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading...' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {!loading && !error && messages.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">No messages yet. Say hello!</p>
        )}
        {grouped.map((group) => (
          <div key={group.day} className="space-y-2">
            <p className="py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.day}</p>
            {group.items.map((message) => (
              <div key={message.clientKey} className={`flex ${message.mine ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[85%] sm:max-w-[70%]">
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      message.mine ? 'rounded-br-md bg-teal text-white' : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'
                    } ${message.state === 'failed' ? 'opacity-60' : ''}`}
                  >
                    {message.kind === 'meeting_request' && (
                      <p className={`mb-1 text-[11px] font-bold uppercase tracking-wide ${message.mine ? 'text-teal-100' : 'text-teal-700'}`}>
                        Meeting request
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  </div>
                  <p className={`mt-0.5 text-[11px] text-slate-400 ${message.mine ? 'text-right' : ''}`}>
                    {message.state === 'sending' ? (
                      'Sending...'
                    ) : message.state === 'failed' ? (
                      <span className="text-urgent">
                        Not sent.{' '}
                        <button type="button" className="font-semibold underline" onClick={() => deliver(message)}>
                          Retry
                        </button>{' '}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setMessages((current) => current.filter((m) => m.clientKey !== message.clientKey))}
                        >
                          Discard
                        </button>
                      </span>
                    ) : (
                      <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {unavailable ? (
        <p className="border-t border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
          This member is no longer active in the community, so new messages can't be sent. Your conversation history is kept.
        </p>
      ) : (
        <form onSubmit={send} className="border-t border-slate-200 bg-white p-3">
          {kind === 'meeting_request' && (
            <p className="mb-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-800">
              This sends a meeting request. Nothing is scheduled until you both agree on a time. Edit the message as you like.
            </p>
          )}
          {sendError && <p className="mb-2 text-xs font-semibold text-urgent" role="alert">{sendError}</p>}
          <div className="flex items-end gap-2">
            <label htmlFor="composer" className="sr-only">Write a message</label>
            <textarea
              id="composer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={kind === 'meeting_request' ? 6 : 2}
              maxLength={MAX_LENGTH}
              placeholder="Write a message"
              className="input min-h-[44px] flex-1 resize-y"
            />
            <button type="submit" className="btn-secondary" disabled={!draft.trim() || loading}>
              Send
            </button>
          </div>
          <p className="mt-1 flex justify-between text-[11px] text-slate-400">
            <span>Enter to send · Shift+Enter for a new line</span>
            {draft.length > MAX_LENGTH - 500 && <span>{draft.length}/{MAX_LENGTH}</span>}
          </p>
        </form>
      )}
    </>
  );
}

function RecipientPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const { data, loading } = useApi<MembersResponse>(open ? `/community/members${buildQuery({ q: debounced, limit: 20 })}` : null);

  return (
    <Modal open={open} title="New message" onClose={onClose}>
      <label htmlFor="recipient-search" className="label">To</label>
      <input
        id="recipient-search"
        type="search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Search members by name"
        className="input"
        autoFocus
      />
      <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto" aria-label="Members">
        {loading && <li className="p-2"><Spinner label="Searching" /></li>}
        {!loading && data?.members.length === 0 && <li className="p-2 text-sm text-slate-500">No members match that.</li>}
        {data?.members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-50"
              onClick={() => {
                onClose();
                navigate(`/messages?to=${member.id}`);
              }}
            >
              <MemberAvatar name={member.fullName} photoUrl={member.photoUrl} size="sm" />
              <span>
                <span className="block text-sm font-semibold text-navy-800">{member.fullName}</span>
                <span className="block text-xs text-slate-500">{accountTypeLabel(member.accountType)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
