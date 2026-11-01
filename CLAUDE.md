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
- LIVE at https://closer-os-liard.vercel.app (Vercel, root dir `web`, auto-deploys on push to main).
  This sandbox cannot reach vercel.app (network policy), so verify there via the owner.
- Supabase auth: Site URL = the Vercel URL; redirect allow-list has it + localhost:4173/5173 +
  closeros:// (Android). Still the built-in email sender (2 emails/hour): add SMTP (Resend) before
  real users.

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
- Show-up impact tab (show_up_report, show_up_trend): "joined" = ANY minutes > 0 (owner's rule:
  the caller's job is to get them in; staying is the webinar's job); "stayed" = hot_minutes+.
  Only reminder calls before webinar_at count. Compares called vs not-called (or test group),
  per caller, per last reminder outcome, and pattern factors (call timing, attempts, talk time,
  hour, registration lead time, repeat, profession, source). Groups < 20 leads are greyed out.
- Optional test group: batches.holdout_pct (0 = OFF, the default; owner wants it off). Held-out
  leads have batch_leads.is_holdout and are skipped by assign_reminders; the Android reminder
  queue must skip them too.
- Android app must send purpose + batch_id with every call, and offer profession + category.

## Owner feedback round 1 (Nov 2026) — decisions
- Own wording, not Callyzer's: terms live in web/src/components/terms.tsx (All calls, Dialled,
  Received, Missed (in), Declined, No answer, Never called back, Conversations, Conversation rate,
  Talk time, Unique contacts, Active time, Gap time). Owner's own Google-Sheet terms may be copied.
- Treat all calls as lead calls in the UI: no "Total vs Lead" split anywhere.
- Reports must fit one screen (no sideways scroll): table-fixed, two-line cells, CSV has detail.
  Report tabs: Overview, Outcomes, Team, Daily, By hour, Follow-ups, Call log.
- Team member phone = profiles.phone (set_member_phone; admins or self). Shown next to names.
- Calls page = complete history (all time by default) with filters; shows "Dialled from" =
  calls.sim_number (rep confirms each SIM's number once in the app setup).
- "Webinars" renamed "Events & Batches"; batches.kind webinar|event|batch; Compare view
  (batch_compare()).
- Follow-up discipline: follow_ups.dialled_at set by trigger on outgoing calls (from 10 min before
  due). On time ≤ 15 min after due; Late > 15 min; Not called = 15 min passed, no call.
  follow_up_report() per rep; Follow-ups page has Timing column, Late tab, CSV export.
- App v0.2: follow-up notifications at −5, 0 (with Call button), +5, +10 min (AlarmManager exact
  when allowed; skipped if the number was already called); Calls tab = phone call history with
  "Add lead"; one-time setup of own number + SIM numbers; a lead created later links its
  earlier calls (trigger link_calls_to_new_lead).

## Owner feedback round 2 (Nov 2026)
- App Home: 10 tiles from the phone's own call log for today (All calls, Dialled, Received,
  Conversations, No answer, Missed/declined, Talk time, Avg, Unique contacts, Leads called); each
  opens a list; leads in a list can go straight into the calling queue.
- Calling queue (app): startQueue(leads); after each saved outcome a 3/5/10 s countdown (Profile
  setting) then the next call; Pause / Skip / Stop / Call now; same SIM reused within a queue;
  "Call due follow-ups" and "Call these N leads" entry points.
- Lead cards: company/profession/city, latest batch + watch minutes, last talked / last outcome,
  next call, colour tags (Interested/Won green, 🔥 Hot = watched 60+ min orange, DNC red).
- WhatsApp templates: table message_templates (5 seeded per org), edited in dashboard Settings;
  app picker fills {{leadName}} {{repName}} {{companyName}} {{batchName}} {{batchDate}}
  {{followUpTime}} {{city}} {{profession}}, editable before opening WhatsApp.
- Calls tab shows the phone's ENTIRE call log ("Load older calls" pages of 500).
- leads.last_connected_at (trigger on calls with talk time).
- Recordings: private storage bucket `recordings` at <org>/<user>/<call_id>.<ext>; storage RLS:
  rep uploads to own folder; anyone who can see the call can sign a URL. App RecordingSync (in
  SyncWorker) matches files in the SAF folder the rep picks (Profile → Call recordings) to answered
  calls of the last 7 days by number + time, uploads, then set_call_recording(). Google Phone app
  phones are detected and told it's not possible. Dashboard call log has a Play button
  (createSignedUrl 15 min, log_recording_access → audit). mark_missing_recordings() flags calls
  with talk time but no recording after 6 h (only for reps who do upload recordings).
- Reports → Team has "Compare the team" bars (metric switch, team-average line, ranking).

## Owner feedback round 3 (Nov 2026)
- message_templates.owner_id: null = company message (managers edit, everyone sees); set = a rep's
  personal message (only they see/edit). App picker shows both; "Save as my message" stores the
  text with the lead's first name replaced by {{leadName}}. {{leadFullName}} also supported.
- App plays recordings in lead details (Repo.recordingUrl → signed URL + audit; MediaPlayer).
- call_report / outcome_report take p_dirs text[] (null = all); Reports has All / Dialled /
  Incoming switch (incoming = incoming + missed + rejected); Call log follows it.
- docs/ROADMAP.md = the full feature checklist (status of everything from the original prompt).
  Keep it updated after every round.

## Call tracking (decided Nov 2026)
- Owner chose B: upload ALL calls (like Callyzer). Company setting organizations.settings
  .call_tracking = 'all' (default) | 'leads' (Settings → Company). sync_calls() enforces it.
  Private/blank numbers are skipped. TODO: per-company "Exclude numbers" list (like Callyzer).

## Lead sources (automatic lead capture) — Nov 2026
- Owner wants ALL: Facebook Ads, Flexifunnels, YouTube (Google Ads lead forms), Pabbly, Zapier,
  Google Sheets, generic webhook. Tables lead_sources (secret token, kind, source_label, campaign,
  batch_id, assign_mode rules|user|none, field_map, google_key) + lead_source_events (log).
- Public URL: <SUPABASE_URL>/functions/v1/lead-webhook/<token> — edge function
  supabase/functions/lead-webhook (verify_jwt=false), deploy with scripts/deploy-function.sh
  lead-webhook --no-verify-jwt. It calls ingest_lead() (service role only), which flattens JSON /
  form posts / Google Ads user_column_data / Facebook field_data, auto-guesses fields (or uses
  field_map), creates the lead or joins its batch as Repeated, and logs the event.
- Facebook: via Pabbly/Zapier today. Direct "Connect Facebook Page" needs a Meta app + App
  Review (leads_retrieval, pages permissions) + Business Verification — owner must do the Meta
  side; the function already answers Facebook's hub.challenge verification.
- Dashboard page "Lead sources": cards, add-source wizard, private link + copy, Send test,
  step-by-step guides per tool (Pabbly, Zapier, Flexifunnels, Google Ads, Sheets Apps Script,
  website form), field matching from the last payload, last 25 events.
- Not yet: IndiaMART pull (CRM key), direct Facebook, push notification to rep on new lead.

## Android app (`android/`) — v0.7.1
- Kotlin + Compose + supabase-kt 3.0.3 (Kotlin 2.1.0, Ktor okhttp 3.0.2), WorkManager. Same
  test signing key as android-poc (keystore/dev-test.jks). APKs → downloads/CloserOS-<ver>.apk.
- Screens: Login (email/password; sign-up happens on the web), Permissions, Home (today's stats
  via call_report for the rep), My Leads (search, paging; reps see assigned only), Lead detail
  (Call with SIM choice via TelecomManager.placeCall + PhoneAccountHandle, WhatsApp), mandatory
  Outcome screen after every call started from the app (outcome + next-call quick picks /
  date-time picker or "No follow-up needed"), Follow-ups, Profile (SIMs, sync now, sign out).
- Calls: the phone's own dialer makes the call. On return, the call-log entry is found and its
  stable id (UUID from device id + call-log _ID + date) is used for log_call, so sync_calls of
  the same entry never duplicates. Outcomes saved offline go to an outbox flushed by SyncWorker
  (every 15 min + on app open). First sync uploads the last 2 days of call log.
- NOT yet: calling queue + countdown, webinar reminder/sales queues (purpose + batch_id),
  recording upload, Room offline lead cache, notifications for follow-ups, device/SIM licences.

## Recording diagnostics (v0.4.1, Nov 2026)
- Owner saw no recordings on the dashboard: DB had 0 uploads (play button only shows when uploaded).
- Table device_status + report_device_status(p jsonb): each phone reports model, Android, app version,
  default dialer, folder set, files found, calls matched, uploaded total, last error (after every sync).
  Dashboard Team page → "Phones & call recordings" shows it. App Profile → Call recordings has
  "Check now" + last-check line. Matcher picks the closest file by time (name time = LAST date-time
  in the name; Samsung yyMMdd_HHmmss too), number in the name boosts the match.

## WhatsApp calls (v0.5.0, Nov 2026)
- Owner: never show the name "Callyzer" anywhere in the product (UI text, hints). Removed.
- Reps make many sales calls on WhatsApp → tracked too. calls.channel 'phone'|'whatsapp' +
  calls.contact_name. Company setting organizations.settings.track_whatsapp (default true;
  Settings → Company "Call history to track"). sync_calls accepts channel/contact_name and skips
  WhatsApp calls when the company turned it off. call_report/outcome_report take p_channels text[].
- Web: Reports "Via: Both / Phone / WhatsApp" switch; Call log has a channel filter, "WA" badge,
  "Dialled from" = WhatsApp, CSV column "Via".
- App: WhatsAppCallListener (NotificationListenerService) watches only com.whatsapp / w4b call
  notifications (ringing / calling / ongoing with chronometer); 3 s grace on removal because WhatsApp
  swaps notifications; missed = incoming never connected. Number = title if digits, else contacts
  lookup (READ_CONTACTS) by Person uri or display name; calls without a number stay on the phone.
  Stored in prefs "wa_calls" (max 3000), uploaded by SyncWorker (cursor wa_cursor). Shown in Home
  tiles + Calls tab (Phone / WhatsApp chips). Home + Profile card asks for notification access +
  contacts. WhatsApp calls can't be recorded. Needs real-phone testing (notification texts vary).
- Owner's goal for WhatsApp: only call history + duration, so the rep's real talk time counts.
  v0.5.1 / migration 0018: a WhatsApp call with only a saved name (no number) is still uploaded
  (phone = '', contact_name set) so its talk time counts; watcher re-reads active notifications on
  reconnect (resumes a call in progress); Profile tells reps to set battery "No restrictions".

## Phone setup checklist (v0.6.0, Nov 2026)
- Owner: reps aren't technical → every permission/setting must be turned on from inside Closer OS.
- calls/PhoneSetup.kt lists items with status + most direct route: runtime perms (calls/call log/
  phone/SIM, notifications, contacts) = in-app pop-up; exact alarms, WhatsApp notification access
  (detail page for our listener on Android 11+), battery "no restrictions" (one-tap system dialog,
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS), brand Autostart screen (Xiaomi/Oppo/Vivo/… — can't be
  read, rep taps Done), default Phone app check, auto-recording (opens Phone app + brand steps, rep
  taps Done), recordings folder (picker opens at MIUI/sound_recorder/call_rec or Recordings/Call).
- ui/SetupChecklist.kt: "Phone setup" screen (Profile → Open phone setup), Home banner while
  essentials are missing; status refreshes when the rep returns from Android settings.
- device_status.setup jsonb (migration 0019) → dashboard Team → "Phone setup" column lists what's off.
- Android limits: special switches can't be flipped by any app; we open the exact screen.

## Webinar calling in the app (v0.7.0, Nov 2026)
- my_batches(org) → webinars/events of the last 120 days with counts (mine / whole team for managers).
  batch_call_list(batch, purpose, everyone) → each lead's watch minutes, hot, attended, profession
  group, source, repeat, registered_at, attempts/talked/last outcome for THIS purpose, next follow-up,
  bought (buyers list or won). Reminder lists skip test-group (holdout) leads.
- App: Home → "Webinars & events" → Reminder calls / Sales calls → list with "Sort & filter":
  search (profession/company/city/name), Sort by + Then by (watch time ↑↓, profession group in MY
  tap order, registered, fewest calls, not called longest, follow-up due, name, city), filters
  (attendance hot/attended/low/absent, calling status, profession groups, last outcome, source,
  new/repeat, hide bought). Choices saved per list type (LocalStore list_prefs_<purpose>).
  "Call these N in order" = queue tagged purpose + batch_id; single calls and lead details opened
  from the list are tagged too. Outcome screen asks profession + group for webinar calls (or when
  the lead has none) → log_call updates the lead.
- Profession groups: new "Engineering" group (migration 0021); IT & Software only for software/IT
  engineers.

## Play Protect block (Nov 2026)
- 0.5.0+ was blocked on the owner's Xiaomi: "App blocked to protect your device" (Google Play Protect
  enhanced fraud protection, India): apps installed from outside the Play Store (WhatsApp, browser,
  file manager) are blocked if they use notification access (also SMS / accessibility).
- Two builds now (product flavors, dimension "dist"): `full` (WhatsApp-call tracking, for the Play
  Store) and `direct` (no NotificationListenerService; BuildConfig.WA_TRACKING=false hides WhatsApp
  setup). Build with ./gradlew assembleDirectRelease / assembleFullRelease; outputs in
  app/build/outputs/apk/<flavor>/release/. Owner gets the direct APK for testing.
- Company-specific APK downloads must use `direct` (or the rep turns off Play Protect scanning).
  WhatsApp-call tracking only via the Play Store build.

## Build notes
- Android SDK at /opt/android-sdk (set `sdk.dir` in local.properties).
- Maven Central rate-limits this sandbox; settings.gradle.kts uses Google's mirror
  `https://maven-central.storage-download.googleapis.com/maven2/` first.
- Built APKs for the owner go in `downloads/` (git-ignored) and are sent with SendUserFile.
