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
  test-only, NOT the Play Store key).
- Distribution: public Play Store first; later a company-specific APK downloadable from the
  dashboard. Test device: Redmi/Xiaomi.
- Web app domain: none yet; owner has thekumarvikas.com (subdomain possible).

## Build order
Phase 1: recording test (done on Redmi K20 Pro, MIUI dialer: works) → Supabase schema + RLS
→ web dashboard → Android app → lead integrations.
Then: recording upload/management → billing & licences → AI → Docs/WhatsApp → management
intelligence → Play Store launch.

## Supabase
- Project `closer-os`, ref `tdbqgoxxxfkfttdznzhb`, region ap-south-1 (Mumbai).
- `SUPABASE_ACCESS_TOKEN` env var holds the owner's personal access token (Management API).
- Migrations live in `supabase/migrations/` and are applied with `scripts/db-apply.sh`.

## Build notes
- Android SDK at /opt/android-sdk (set `sdk.dir` in local.properties).
- Maven Central rate-limits this sandbox; settings.gradle.kts uses Google's mirror
  `https://maven-central.storage-download.googleapis.com/maven2/` first.
- Built APKs for the owner go in `downloads/` (git-ignored) and are sent with SendUserFile.
