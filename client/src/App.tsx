import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { LoadingBlock } from './components/ui.tsx';
import { ContactsPage } from './pages/ContactsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotesPage } from './pages/NotesPage.tsx';
import { OrganizationsPage } from './pages/OrganizationsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TasksPage } from './pages/TasksPage.tsx';
import { useAuth } from './state/AuthContext.tsx';

export function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <LoadingBlock label="Loading your workspace" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/organizations" element={<OrganizationsPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
