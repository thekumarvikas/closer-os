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
import BatchDetail from './pages/BatchDetail'
import Calls from './pages/Calls'
import FollowUps from './pages/FollowUps'
import Team from './pages/Team'
import Settings from './pages/Settings'

export default function App() {
  const { session, loading, org, isAdmin, isManager } = useSession()
  if (loading) return <Spinner />
  if (!session) return <AuthPage />
  if (!org) return <Onboarding />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="reports" element={<Reports />} />
        <Route path="webinars" element={<Batches />} />
        <Route path="webinars/:id" element={<BatchDetail />} />
        <Route path="leads" element={<Leads />} />
        <Route path="calls" element={<Calls />} />
        <Route path="follow-ups" element={<FollowUps />} />
        {isManager && <Route path="team" element={<Team />} />}
        {isAdmin && <Route path="settings" element={<Settings />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
