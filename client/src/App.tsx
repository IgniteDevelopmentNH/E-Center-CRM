import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { CommunityShell } from './components/CommunityShell.tsx';
import { LoadingBlock } from './components/ui.tsx';
import { ContactsPage } from './pages/ContactsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotesPage } from './pages/NotesPage.tsx';
import { OrganizationsPage } from './pages/OrganizationsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TasksPage } from './pages/TasksPage.tsx';
import { MembersAdminPage } from './pages/admin/MembersAdminPage.tsx';
import { PostsAdminPage } from './pages/admin/PostsAdminPage.tsx';
import { FeedPage } from './pages/community/FeedPage.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/community/PasswordPages.tsx';
import { LandingPage } from './pages/community/LandingPage.tsx';
import { MemberProfilePage } from './pages/community/MemberProfilePage.tsx';
import { MentorshipPage } from './pages/community/MentorshipPage.tsx';
import { MessagesPage } from './pages/community/MessagesPage.tsx';
import { NetworkPage } from './pages/community/NetworkPage.tsx';
import { ProfilePage } from './pages/community/ProfilePage.tsx';
import { SignupPage } from './pages/community/SignupPage.tsx';
import { VerifyEmailPage } from './pages/community/VerifyEmailPage.tsx';
import { useAuth } from './state/AuthContext.tsx';

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

export function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <LoadingBlock label="Loading" />
      </div>
    );
  }

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

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
      <Route path="/" element={user ? community(<FeedPage />) : <LandingPage />} />
      <Route path="/mentorship" element={community(<MentorshipPage />)} />
      <Route path="/network" element={community(<NetworkPage />)} />
      <Route path="/messages" element={community(<MessagesPage />)} />
      <Route path="/members/:id" element={community(<MemberProfilePage />)} />
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
  );
}
