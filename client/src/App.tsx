import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { CommunityShell } from './components/CommunityShell.tsx';
import { LoadingBlock } from './components/ui.tsx';
import { useAuth } from './state/AuthContext.tsx';

/**
 * Each page is its own download, so nobody loads the CRM to read the feed. If a
 * page's file has been replaced by a newer deploy, reloading picks up the new one.
 */
function page<M>(load: () => Promise<M>, name: keyof M) {
  return lazy(async () => {
    try {
      const loaded = await load();
      sessionStorage.removeItem('ecenter-reloaded');
      return { default: loaded[name] as ComponentType };
    } catch (error) {
      if (!sessionStorage.getItem('ecenter-reloaded')) {
        sessionStorage.setItem('ecenter-reloaded', '1');
        window.location.reload();
        return new Promise<{ default: ComponentType }>(() => undefined);
      }
      throw error;
    }
  });
}

const ContactsPage = page(() => import('./pages/ContactsPage.tsx'), 'ContactsPage');
const DashboardPage = page(() => import('./pages/DashboardPage.tsx'), 'DashboardPage');
const EventsPage = page(() => import('./pages/EventsPage.tsx'), 'EventsPage');
const LoginPage = page(() => import('./pages/LoginPage.tsx'), 'LoginPage');
const NotesPage = page(() => import('./pages/NotesPage.tsx'), 'NotesPage');
const OrganizationsPage = page(() => import('./pages/OrganizationsPage.tsx'), 'OrganizationsPage');
const SettingsPage = page(() => import('./pages/SettingsPage.tsx'), 'SettingsPage');
const TasksPage = page(() => import('./pages/TasksPage.tsx'), 'TasksPage');
const MembersAdminPage = page(() => import('./pages/admin/MembersAdminPage.tsx'), 'MembersAdminPage');
const PostsAdminPage = page(() => import('./pages/admin/PostsAdminPage.tsx'), 'PostsAdminPage');
const EventDetailPage = page(() => import('./pages/community/EventDetailPage.tsx'), 'EventDetailPage');
const FeedPage = page(() => import('./pages/community/FeedPage.tsx'), 'FeedPage');
const MyPostsPage = page(() => import('./pages/community/MyPostsPage.tsx'), 'MyPostsPage');
const PostDetailPage = page(() => import('./pages/community/PostDetailPage.tsx'), 'PostDetailPage');
const UnsubscribePage = page(() => import('./pages/community/UnsubscribePage.tsx'), 'UnsubscribePage');
const ForgotPasswordPage = page(() => import('./pages/community/PasswordPages.tsx'), 'ForgotPasswordPage');
const ResetPasswordPage = page(() => import('./pages/community/PasswordPages.tsx'), 'ResetPasswordPage');
const LandingPage = page(() => import('./pages/community/LandingPage.tsx'), 'LandingPage');
const MemberProfilePage = page(() => import('./pages/community/MemberProfilePage.tsx'), 'MemberProfilePage');
const MentorshipPage = page(() => import('./pages/community/MentorshipPage.tsx'), 'MentorshipPage');
const MessagesPage = page(() => import('./pages/community/MessagesPage.tsx'), 'MessagesPage');
const NetworkPage = page(() => import('./pages/community/NetworkPage.tsx'), 'NetworkPage');
const ProfilePage = page(() => import('./pages/community/ProfilePage.tsx'), 'ProfilePage');
const SignupPage = page(() => import('./pages/community/SignupPage.tsx'), 'SignupPage');
const VerifyEmailPage = page(() => import('./pages/community/VerifyEmailPage.tsx'), 'VerifyEmailPage');
const BusinessDetailPage = page(() => import('./pages/community/BusinessesPage.tsx'), 'BusinessDetailPage');
const BusinessesPage = page(() => import('./pages/community/BusinessesPage.tsx'), 'BusinessesPage');
const CompetitionDetailPage = page(() => import('./pages/community/CompetitionsPage.tsx'), 'CompetitionDetailPage');
const CompetitionsPage = page(() => import('./pages/community/CompetitionsPage.tsx'), 'CompetitionsPage');
const GroupDetailPage = page(() => import('./pages/community/GroupsPage.tsx'), 'GroupDetailPage');
const GroupsPage = page(() => import('./pages/community/GroupsPage.tsx'), 'GroupsPage');
const CompetitionsAdminPage = page(() => import('./pages/admin/CompetitionsAdminPage.tsx'), 'CompetitionsAdminPage');
const GroupsAdminPage = page(() => import('./pages/admin/GroupsAdminPage.tsx'), 'GroupsAdminPage');

/** Old CRM paths (before the move under /admin) keep working: bookmarks, emails, muscle memory. */
const LEGACY_ADMIN_PATHS = ['contacts', 'notes', 'tasks', 'organizations', 'events', 'settings'];

function LegacyRedirect({ section }: { section: string }) {
  const { search } = useLocation();
  return <Navigate to={`/admin/${section}${search}`} replace />;
}

/** Signed-out visitors go to sign-in and come back afterwards. */
function RequireSignedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Community pages need an active community account, or staff access. A member
 * still onboarding (or waiting to verify their email) is sent back to /signup.
 * The server enforces the same rule on every request; this only routes.
 */
function RequireCommunity({ children }: { children: ReactNode }) {
  const { community, isStaff } = useAuth();
  if (!isStaff && community?.status !== 'active') return <Navigate to="/signup" replace />;
  return <>{children}</>;
}

function StaffOnly() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-bold text-navy-800">This area is for ECenter staff</h1>
      <p className="mt-2 text-sm text-slate-500">
        Your community account does not include access to the ECenter's administrative tools.
      </p>
      <Link to="/" className="btn-primary mt-6">
        Back to the community
      </Link>
    </div>
  );
}

function AdminArea() {
  const { isStaff } = useAuth();
  if (!isStaff) {
    return (
      <CommunityShell>
        <StaffOnly />
      </CommunityShell>
    );
  }
  return (
    <AppShell>
      <Routes>
        <Route index element={<DashboardPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="organizations" element={<OrganizationsPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="posts" element={<PostsAdminPage />} />
        <Route path="members" element={<MembersAdminPage />} />
        <Route path="groups" element={<GroupsAdminPage />} />
        <Route path="competitions" element={<CompetitionsAdminPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AppShell>
  );
}

function community(page: ReactNode) {
  return (
    <RequireSignedIn>
      <RequireCommunity>
        <CommunityShell>{page}</CommunityShell>
      </RequireCommunity>
    </RequireSignedIn>
  );
}

/** Pages guests may read: signed-in people get the full community view, guests a read-only one. */
function GuestReadable({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user) return community(children);
  return <CommunityShell>{children}</CommunityShell>;
}

export function App() {
  const { user, ready, isGuest } = useAuth();

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <LoadingBlock label="Loading" />
      </div>
    );
  }

  const pageFallback = (
    <div className="grid min-h-screen place-items-center">
      <LoadingBlock label="Loading" />
    </div>
  );

  return (
    <Suspense fallback={pageFallback}>
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/unsubscribe" element={<UnsubscribePage />} />

      {/* Administrative CRM (staff only) */}
      <Route
        path="/admin/*"
        element={
          <RequireSignedIn>
            <AdminArea />
          </RequireSignedIn>
        }
      />
      {LEGACY_ADMIN_PATHS.map((section) => (
        <Route key={section} path={`/${section}`} element={<LegacyRedirect section={section} />} />
      ))}

      {/* Community portal */}
      <Route
        path="/"
        element={user ? community(<FeedPage />) : isGuest ? <CommunityShell><FeedPage /></CommunityShell> : <LandingPage />}
      />
      <Route path="/groups" element={community(<GroupsPage />)} />
      <Route path="/groups/:id" element={community(<GroupDetailPage />)} />
      <Route path="/businesses" element={community(<BusinessesPage />)} />
      <Route path="/businesses/:id" element={community(<BusinessDetailPage />)} />
      <Route path="/competitions" element={<GuestReadable><CompetitionsPage /></GuestReadable>} />
      <Route path="/competitions/:id" element={<GuestReadable><CompetitionDetailPage /></GuestReadable>} />
      <Route path="/mentorship" element={community(<MentorshipPage />)} />
      <Route path="/network" element={community(<NetworkPage />)} />
      <Route path="/messages" element={community(<MessagesPage />)} />
      <Route path="/members/:id" element={community(<MemberProfilePage />)} />
      <Route path="/posts/:id" element={<GuestReadable><PostDetailPage /></GuestReadable>} />
      <Route path="/events/:id" element={<GuestReadable><EventDetailPage /></GuestReadable>} />
      <Route path="/my-posts" element={community(<MyPostsPage />)} />
      <Route
        path="/profile"
        element={
          <RequireSignedIn>
            <CommunityShell>
              <ProfilePage />
            </CommunityShell>
          </RequireSignedIn>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
