# Closer OS — project notes for Claude

The owner (Vikas, GitHub `thekumarvikas`) is non-technical. Explain things in plain language,
give step-by-step instructions, and never ask for secrets to be pasted in chat.

## Product
Sales operating system: Android app for sales reps + web dashboard for management +
subscription/licensing backend, all on one backend. India first (INR, +91, Asia/Kolkata,
DD/MM/YYYY), but nothing India-specific hardcoded.

## Decisions made (Oct 2026)
- Start fresh. Stack: Supabase (Mumbai region, data stays in India) + Android (Kotlin,
  Jetpack Compose, Room, WorkManager, minSdk 26) + one React/TypeScript web app.
- Repo layout: `android/`, `web/`, `supabase/`. `android-poc/` is the recording test app.
- Closer OS works ALONGSIDE the normal phone app (not the default dialer), because the
  phone's built-in recorder only runs in the phone maker's dialer.
- Recording: phone's built-in auto-recorder; Closer OS finds the file and uploads it.
  On Xiaomi, MediaStore did NOT index `MIUI/sound_recorder/call_rec`; the rep must pick the
  folder once via the system folder picker (Storage Access Framework). Matching by number in
  file name + timestamp worked. Missing recordings are flagged to managers.
- Dropped: who-hung-up detection, live objection prompts, voicemail drop.
- Call log: track only numbers in the lead list (incoming, outgoing, missed). Unknown numbers
  stay on the phone in a "Not in leads" tray; rep can add as lead / referral / alternate number.
  Personal calls are never uploaded. MIUI logs ring time as duration on missed calls.
- SIM identification: rep confirms SIM + confirms a few recent calls (Callyzer-style).
- Outcome form is mandatory after every call, incl. next-call time or "No follow-up needed".
  Queue auto-advances with a 3/5/10 s countdown (rep's choice).
- Leads: CSV/XLSX import; per-org webhook (Zapier, Pabbly, Flexifunnels, forms), Google Sheets,
  Facebook Lead Ads, IndiaMART. Distribution: manual, round-robin, rule-based. Reps see only
  their assigned leads. Per-org custom fields, stages and outcomes.
- Scale target: 50 reps per org, 2,500–3,000 new leads per rep per month.
- Super Admin (Closer OS company) may access customer recordings; always audit-logged.
- Teams: a rep can be in several teams; a team can have several managers.
- Login: Google sign-in or email + password (no OTP, to avoid SMS cost).
- AI: no provider accounts yet. Support both "Closer OS credits" and "bring your own key".
- Billing: Razorpay (owner has an account). Not GST registered yet. Payments happen on the web
  dashboard and via Flexifunnels landing page + Razorpay (webhook creates/renews the account).
  Never sell inside the Android app. Trial length configurable by Super Admin (7/14 days).
- English only at launch. Owner designs nothing; Claude proposes branding.
- Target devices: ALL Android brands (Xiaomi, Realme, Oppo, Vivo, Samsung, OnePlus, Motorola…),
  not only Xiaomi. Recording test v1 passed on Redmi K20 Pro (both voices audible).
  Xiaomi 11T Pro said "package invalid" on v2; v3 adds a fixed test signing key (android-poc/keystore,
  test-only, NOT the Play Store key). v3 installed on Xiaomi 11T Pro (Android 14, HyperOS 1): call log
  and both SIMs read fine, but 0 recordings because the default dialer was a third-party app
  (com.hb.dialer.free) with no recorder. => Onboarding must check the default phone app and guide
  the rep to the phone maker's dialer with auto-record on; dashboard shows per-device recording setup.
  The 11T Pro's built-in dialer is Google's Phone app (screenshot confirmed): it records, but keeps
  files private, so Closer OS cannot pick them up automatically. Recording strategy (proposed):
  A) auto-pickup where the maker's dialer saves accessible files (Samsung, Vivo, older MIUI…);
  B) free fallback: rep shares the recording from Google Phone to Closer OS, matched by time;
  C) paid cloud-calling add-on (virtual number, recorded on the server) for guaranteed recording
  on any phone. App detects which case applies per device and tells rep + manager.
  DECIDED: owner rejected B (too much hassle per call). Go with A, plus Closer OS recording itself
  if possible. v4 test app has a mic-recording experiment (MIC / VOICE_RECOGNITION /
  VOICE_COMMUNICATION during a cellular call). RESULT on 11T Pro (Android 14): audio stops the
  moment the call starts (Android silences other apps' mic during calls). In-app recording is NOT
  possible. FINAL: A (auto pickup) now + C (cloud-calling add-on) later.
- Distribution: public Play Store first; later a company-specific APK downloadable from the
  dashboard. Test device: Redmi/Xiaomi.
- Web app domain: none yet; owner has thekumarvikas.com (subdomain possible).

## Build order
Phase 1: recording test (done) → Supabase schema + RLS (done) → web dashboard (done, needs
hosting) → Android app → lead integrations.
Then: recording upload/management → billing & licences → AI → Docs/WhatsApp → management
intelligence → Play Store launch.

## Supabase
- Project `closer-os`, ref `tdbqgoxxxfkfttdznzhb`, region ap-south-1 (Mumbai).
- `SUPABASE_ACCESS_TOKEN` env var holds the owner's personal access token (Management API).
- Migrations live in `supabase/migrations/` and are applied with `scripts/db-apply.sh`.

## Web dashboard (`web/`)
- Vite + React 18 + TypeScript + Tailwind. Public Supabase URL + publishable key live in
  `web/.env.production` (safe to commit). Pages: Dashboard (Callyzer-style Today / Yesterday /
  Last 7 days tiles), Reports (Summary, Outcomes [outcome_report() SQL; click an outcome → call history filtered], Employees, Day-wise, Hourly, Call history; CSV export;
  backed by `call_report()` SQL function with Total vs Lead split), Overview→Dashboard, Leads (import CSV/XLSX, assign,
  detail drawer), Calls, Follow-ups, Team (invites, teams, roles), Settings (company, outcomes,
  stages, distribution rules). Invites work by email: the person signs up with that email.
- End-to-end test: `web/tests/e2e.cjs` (see its README). Node needs NODE_USE_ENV_PROXY=1 and
  NODE_EXTRA_CA_CERTS; Chromium needs the proxy CA in ~/.pki/nssdb (certutil) + launch proxy.
- Status: built and tested end to end; NOT yet hosted (plan: Vercel, root dir `web`).
- Supabase auth still uses the built-in email sender (2 emails/hour) and Site URL localhost:3000;
  set Site URL/redirects once hosted, and add SMTP (e.g. Resend) before real users.

## Webinars (batches) — Nov 2026
- Owner's workflow: webinar businesses. Leads register for a webinar (batch); reminder calls happen
  before it, sales calls after. Zoom attendee report gives watch minutes ("hot" = 60+ min, per batch).
- Tables: batches, batch_leads (watch_minutes, attended, is_repeat, reminder_by), calls.purpose
  ('sales'|'reminder') + calls.batch_id, call_outcomes.purpose, follow_ups.purpose,
  profession_categories (keyword grouping, seeded 15 groups), customers (buyers list).
- Import into a batch: existing numbers JOIN the batch as "Repeated" (not skipped).
- Zoom upload (web): finds "Attendee Details" table, sums multiple joins, matches by email then
  phone; unknown attendees can be added as new leads. apply_zoom_report() sets 0 for no-shows.
- Reports: batch_report(batch, purpose) + batch_report_leads() for click-through. % style toggle:
  "like my sheet" (each row's own base, as in owner's Google Sheet) or "% of assigned".
- Reminder caller may differ from sales rep (separate reminder team) — lead_visible() includes
  reminder_by. "Previous batch enrolled"/"New enrolled" come from the buyers list (+ won outcome).
- Android app must send purpose + batch_id with every call, and offer profession + category.

## Open question for owner
- Owner's Callyzer reference tracks ALL calls (Total vs Lead). Earlier decision was "only lead
  numbers are uploaded". Reports support both (calls.lead_id null = unknown number). Need a
  company setting: "Track all calls on work SIMs" vs "Lead calls only" (default TBD).

## Build notes
- Android SDK at /opt/android-sdk (set `sdk.dir` in local.properties).
- Maven Central rate-limits this sandbox; settings.gradle.kts uses Google's mirror
  `https://maven-central.storage-download.googleapis.com/maven2/` first.
- Built APKs for the owner go in `downloads/` (git-ignored) and are sent with SendUserFile.
