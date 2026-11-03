import { Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './lib/session'
import { Spinner } from './components/ui'
import Layout from './components/Layout'
import AuthPage from './pages/AuthPage'
import Onboarding from './pages/Onboarding'
import Overview from './pages/Overview'
import Leads from './pages/Leads'
import Reports from './pages/Reports'
import Batches from './pages/Batches'
import LeadSources from './pages/LeadSources'
import Playbook from './pages/Playbook'
import Announcements from './pages/Announcements'
import Reviews from './pages/Reviews'
import Desk from './pages/Desk'
import Billing from './pages/Billing'
import SuperAdmin from './pages/SuperAdmin'
import BatchDetail from './pages/BatchDetail'
import Calls from './pages/Calls'
import FollowUps from './pages/FollowUps'
import Team from './pages/Team'
import Settings from './pages/Settings'

export default function App() {
  const { session, loading, org, isAdmin, isManager, profile, role } = useSession()
  if (loading) return <Spinner />
  if (!session) return <AuthPage />
  if (!org) return <Onboarding />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={role === 'rep' ? <Desk /> : <Overview />} />
        <Route path="desk" element={<Desk />} />
        <Route path="reports" element={<Reports />} />
        <Route path="webinars" element={<Batches />} />
        <Route path="webinars/:id" element={<BatchDetail />} />
        <Route path="leads" element={<Leads />} />
        <Route path="calls" element={<Calls />} />
        <Route path="follow-ups" element={<FollowUps />} />
        <Route path="playbook" element={<Playbook />} />
        {isManager && <Route path="team" element={<Team />} />}
        {isManager && <Route path="announcements" element={<Announcements />} />}
        {isManager && <Route path="reviews" element={<Reviews />} />}
        {isManager && <Route path="lead-sources" element={<LeadSources />} />}
        {isAdmin && <Route path="settings" element={<Settings />} />}
        {isAdmin && <Route path="billing" element={<Billing />} />}
        {profile?.is_super_admin && <Route path="admin" element={<SuperAdmin />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
