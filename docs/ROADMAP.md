# Closer OS — feature checklist

Everything from the original product prompt plus the owner's feedback, with status.
✅ done · 🟡 partly done · ⬜ not started · ⛔ not possible on normal Android (alternative noted)

## 1. Leads
- ✅ Lead database: name, phone, email, city/state, profession, company, source, campaign, deal value, notes, tags, custom fields
- ✅ CSV / Excel import with column matching, duplicate detection, invalid-number rejection
- ✅ Assignment: manual, round-robin, rule-based (source / campaign / city / state)
- ✅ Reps see only their own leads; managers their teams'; admins everything
- ✅ Activity timeline per lead
- ✅ Automatic lead capture: webhook, Zapier, Pabbly, Flexifunnels, Google Ads / YouTube lead forms, Google Sheets, website forms
- 🟡 Facebook / Instagram Ads — works through Pabbly/Zapier; direct "Connect Facebook Page" needs Meta approval
- ⬜ IndiaMART direct connection (CRM API key)
- ⬜ Notification to the rep when a new lead is assigned
- ⬜ Lead export (CSV) from the Leads page; bulk edit (stage, tags)
- ⬜ Per-company "Exclude numbers" list (keep personal numbers out of reports)

## 2. Calling (Android app)
- ✅ Tap-to-call through the phone's own dialer, SIM 1 / SIM 2 choice
- ✅ Mandatory outcome after every call, with next-call time or "No follow-up needed"
- ✅ Calling queue: auto-next with 3/5/10 s countdown, pause / skip / stop
- ✅ Automatic call-log sync (all calls), offline-safe
- ✅ Today's numbers with drill-down lists → queue
- ✅ Full phone call history with "Add as lead"
- ✅ Follow-up reminders: 5 min before, at time (Call button), 5 and 10 min after; late flag at 15 min
- ✅ WhatsApp: company + personal messages, filled in per lead
- 🟡 Pre-call summary — lead card / details show last outcome, notes, webinar, watch time; a dedicated 3-second "glance" screen before each queued call is still to do
- ✅ Webinar / event queues: reminder calls before, sales calls after (purpose + batch on every call, profession capture), with sort (watch time, profession priority, …) and filters
- ⬜ SIM licences (each SIM registered to a company, confirmed by the rep)
- ⬜ Offline lead cache (leads viewable without internet)
- ⬜ Best-time-to-call ordering of the queue
- ⛔ Who hung up — Android doesn't tell normal apps (dropped)
- ⛔ Voicemail drop / live objection prompts on normal SIM calls (need cloud calling)

- ✅ Phone setup checklist in the app (every permission/setting from one screen) + per-rep status on the dashboard
- ✅ WhatsApp call tracking (notification access; Phone / WhatsApp filters in app and reports)

## 3. Call recording
- ✅ Phone's own recorder files found and uploaded automatically (where the phone allows it)
- ✅ Play in the dashboard and in the app; private links; every play audited
- ✅ Missing recordings flagged
- ⬜ Recording policy page: who has recording on, requests to switch it off, approvals, expiry
- ✅ Recording setup status per device on the dashboard (Team → Phones & call recordings; app "Check now")
- ⬜ Retention (auto-delete after N days) and deletion requests
- ⛔ Phones with Google's Phone app keep recordings private → paid cloud-calling add-on later

## 4. Webinars, events & batches
- ✅ Batches with type (webinar / event / batch), repeats, Zoom attendance upload, new attendees
- ✅ Sales and reminder reports per batch (owner's Google-Sheet layout), click-through lists
- ✅ Show-up impact (per caller, per outcome, patterns, trend); optional test group (off)
- ✅ Profession groups (keyword grouping), buyers list (already enrolled / new enrolled)
- ✅ Compare batches side by side

## 5. Reports & dashboard
- ✅ Dashboard (today / yesterday / last 7 days), own wording, one-screen tables
- ✅ Reports: Overview, Outcomes, Team (+ comparison chart), Daily, By hour, Follow-ups, Call log; CSV everywhere
- ✅ All / Dialled / Incoming filter
- ✅ Follow-up discipline (on time / late / not called)
- ⬜ Targets per rep (daily calls, conversations, sales) and achievement %
- ⬜ Call auditing: score a call, feedback, coaching tasks
- ⬜ Leaderboard in the app

## 6. Docs (sales knowledge hub)
- 🟡 WhatsApp messages (company + personal)
- ⬜ Scripts, ad sections, important links — managed centrally, shown in the app
- ⬜ Team submissions with approval (submitted → approved → published)

## 7. AI
- ⬜ Transcription with a choice of provider (Sarvam, LemonFox, Gemini, OpenAI-compatible); own key or Closer OS credits
- ⬜ AI call analysis: summary, objections, buying signals, scorecard, coaching tips
- ⬜ AI insights dashboard (common objections, skill gaps)

## 8. Subscriptions & billing
- ⬜ Product catalogue (Call History per SIM, Power Dialer per seat, Recording per SIM, add-ons, bundles), monthly/annual, regional prices
- ⬜ Entitlement engine (features switched on/off by what's paid)
- ⬜ Razorpay checkout on the dashboard + Flexifunnels webhook for new customers; invoices
- ⬜ Trial (7/14 days configurable), grace period, suspension without deleting data
- ⬜ Super Admin area for Closer OS (all companies, pricing, coupons, revenue)

## 9. Platform & launch
- ✅ Secure login, roles, company data isolation, audit log
- ⬜ Google sign-in
- ⬜ Proper email sending (Resend) — needed before real customers
- ⬜ Custom domain (e.g. app.closeros.in)
- ⬜ Play Store: developer account, privacy policy, call-log permission declaration, 12-tester closed test
- ⬜ Company-specific APK download from the dashboard
