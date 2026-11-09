import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './lib/session'
import { Spinner } from './components/ui'
import Layout from './components/Layout'
import AuthPage from './pages/AuthPage'
import Onboarding from './pages/Onboarding'
const Overview = lazy(() => import('./pages/Overview'))
const Leads = lazy(() => import('./pages/Leads'))
const Reports = lazy(() => import('./pages/Reports'))
const Batches = lazy(() => import('./pages/Batches'))
const LeadSources = lazy(() => import('./pages/LeadSources'))
const Playbook = lazy(() => import('./pages/Playbook'))
const Announcements = lazy(() => import('./pages/Announcements'))
const Reviews = lazy(() => import('./pages/Reviews'))
const Desk = lazy(() => import('./pages/Desk'))
const Billing = lazy(() => import('./pages/Billing'))
const SuperAdmin = lazy(() => import('./pages/SuperAdmin'))
const BatchDetail = lazy(() => import('./pages/BatchDetail'))
const Calls = lazy(() => import('./pages/Calls'))
const FollowUps = lazy(() => import('./pages/FollowUps'))
const Team = lazy(() => import('./pages/Team'))
const Settings = lazy(() => import('./pages/Settings'))
import SetPassword, { useRecoveryMode } from './pages/SetPassword'

export default function App() {
  const { session, loading, org, isAdmin, isManager, profile, role } = useSession()
  const [recovery, recoveryDone] = useRecoveryMode()
  if (loading) return <Spinner />
  if (!session) return <AuthPage />
  if (recovery) return <SetPassword email={session.user.email} onDone={recoveryDone} />
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
