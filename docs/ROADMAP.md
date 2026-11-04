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
- ✅ IndiaMART direct connection (CRM key, every 10 minutes) — needs the owner's key to test
- ✅ Notification to the rep when a new lead is assigned
- ✅ Lead export (CSV) and bulk actions (assign, stage, tag, do-not-call, delete)
- ✅ Per-company "Numbers not to track" list

## 2. Calling (Android app)
- ✅ Tap-to-call through the phone's own dialer, SIM 1 / SIM 2 choice
- ✅ Mandatory outcome after every call, with next-call time or "No follow-up needed"
- ✅ Calling queue: auto-next with 3/5/10 s countdown, pause / skip / stop
- ✅ Automatic call-log sync (all calls), offline-safe
- ✅ Today's numbers with drill-down lists → queue
- ✅ Full phone call history with "Add as lead"
- ✅ Follow-up reminders: 5 min before, at time (Call button), 5 and 10 min after; late flag at 15 min
- ✅ WhatsApp: company + personal messages, filled in per lead
- ✅ Pre-call glance card in the queue (key facts, last call + note, webinar watch time)
- ✅ Webinar / event queues: reminder calls before, sales calls after (purpose + batch on every call, profession capture), with sort (watch time, profession priority, …) and filters
- ⬜ SIM licences (each SIM registered to a company, confirmed by the rep)
- ⬜ Offline lead cache (leads viewable without internet)
- 🟡 Best time to call shown per lead ✅; ordering the queue by it still to do
- ⛔ Who hung up — Android doesn't tell normal apps (dropped)
- ⛔ Voicemail drop / live objection prompts on normal SIM calls (need cloud calling)

- ✅ Phone setup checklist in the app (every permission/setting from one screen) + per-rep status on the dashboard
- ✅ WhatsApp call tracking (notification access; Phone / WhatsApp filters in app and reports)

- ✅ Mandatory outcome after incoming calls and calls dialled outside the app (with a reminder notification)
- ✅ Two-tap next-call picker (day, then 30-minute slot)
- ✅ Notes: key facts, quick tags, voice typing, notes history, notes without a call

- ✅ Announcements from management that each rep must acknowledge (pinned notification + blocking screen; dashboard shows who acknowledged)

- ✅ Desk mode: reps work from the laptop (My desk), click-to-call rings their phone, outcome on either screen

## 3. Call recording
- ✅ Phone's own recorder files found and uploaded automatically (where the phone allows it)
- ✅ Play in the dashboard and in the app; private links; every play audited
- ✅ Missing recordings flagged
- ⬜ Recording policy page: who has recording on, requests to switch it off, approvals, expiry
- ✅ Recording setup status per device on the dashboard (Team → Phones & call recordings; app "Check now")
- 🟡 Retention: auto-delete recordings after N days ✅; deletion requests still to do
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
- ✅ Targets per rep (daily calls, conversations, talk time, sales) and achievement % — dashboard Reports → Targets, app Home
- ✅ Call reviews: score a call on the company checklist, feedback, coaching tasks; reps see it in the app; team scores
- ✅ Leaderboard in the app (today / week / month)

## 6. Docs (sales knowledge hub)
- 🟡 WhatsApp messages (company + personal)
- ✅ Playbook: scripts, objection answers, links, documents/ad copy — managed on the dashboard, shown in the app (personalised per lead)
- ✅ Team suggestions with manager approval

## 7. AI
- ⬜ Transcription with a choice of provider (Sarvam, LemonFox, Gemini, OpenAI-compatible); own key or Closer OS credits
- ⬜ AI call analysis: summary, objections, buying signals, scorecard, coaching tips
- ⬜ AI insights dashboard (common objections, skill gaps)

## 8. Subscriptions & billing
- 🟡 Plans per user, monthly/yearly, set by Super Admin ✅; per-SIM add-ons, bundles, regional prices still to do
- 🟡 Entitlements: trial/active/grace/expired + seat limit ✅; switching features off by plan still to do
- 🟡 Razorpay checkout on the dashboard + receipts ✅; Flexifunnels new-customer signup still to do
- ✅ Trial (7/14/21/30 days, set by Super Admin), grace period, pause without deleting data
- 🟡 Super Admin area (companies, plans & prices, payment setup, revenue) ✅; coupons still to do

## 9. Platform & launch
- ✅ Secure login, roles, company data isolation, audit log
- ⬜ Google sign-in
- ⬜ Proper email sending (Resend) — needed before real customers
- ⬜ Custom domain (e.g. app.closeros.in)
- ⬜ Play Store: developer account, privacy policy, call-log permission declaration, 12-tester closed test
- ⬜ Company-specific APK download from the dashboard
- ✅ Stability pass (v0.9.10): crash guards, no lost offline outcomes, no freezes on big recording folders
- ✅ Swipe between the app's main tabs (v0.9.11)
- ✅ After-call pop-up over any app with quick outcome + next call (v0.9.11)
- ✅ WhatsApp step right after the outcome (pop-up and app) (v0.9.12)
- ✅ Company file library for WhatsApp (dashboard upload, app send) (v0.9.12)
- ✅ All calls treated alike, "Not in lead list" tag; outcome on a new number adds the lead (v0.9.16)
- ✅ Round 8: DNC remove with warning, real pick-up counting, outcomes by call type, minimalist Home + Calls, start tab (v0.9.19)
- ✅ Round 9 (v0.10.0): WhatsApp assisted queue + send log, interactions, talk time per lead, path to sale,
  what works (me/team/company), insights (what converts, speed to first call), lead work / dial-attempts
  report, today's focus (unlimited), outcomes v2 with next steps, quick picks 30 min–3 h, tag groups +
  facts, working calendar + monthly talk-time pace, recordings on call rows, Settings tab, Back fix
- ⬜ "New · waiting" timer on lead cards, best-time-now queue order, per-rep daily focus target
