import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionProvider } from './lib/session'
import App from './App'
import Legal, { LEGAL_PATHS } from './pages/Legal'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Privacy, terms and account deletion are public pages: no login needed. */}
    {LEGAL_PATHS.includes(window.location.pathname.replace(/\/+$/, '')) ? <Legal /> : (
      <BrowserRouter>
        <SessionProvider><App /></SessionProvider>
      </BrowserRouter>
    )}
  </StrictMode>,
)
