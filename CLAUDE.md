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
  Private/blank numbers are skipped. Exclude list = excluded_numbers (Settings → Numbers not to track).

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
- Not yet: direct Facebook. (IndiaMART + new-lead alerts done in v0.9.1, see below.)

## Android app (`android/`) — v0.13.0
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

## App Follow-ups tab (v0.7.2, Nov 2026)
- Owner: follow-ups tab had no categories, no clear time, nothing marked late. Rebuilt
  (ui/FollowUpsScreen.kt) with the dashboard's rule (on time ≤ 15 min after due via dialled_at;
  late > 15; not called = 15 min passed, no call). Tabs: Today · Not called · Upcoming · Called late ·
  On time (last 7 days, Repo.pastFollowUps = status done). Card: big time + day, name + number,
  coloured badge (In 2h / Due now / Not called · 1h late / Called 20 min late / Called on time),
  reminder vs sales, reason/notes, Call button; 7-day summary line; "Call due follow-ups in a queue".

## Owner feedback round 4 (v0.8.0, Nov 2026)
- Mandatory outcome for ALL lead calls, not only those started in the app: vm.checkUnloggedCalls()
  (on resume + after each save) finds call-log entries since outcomeCheckFromMs (= first run of
  0.8.0, max 2 days back) — answered incoming or any outgoing — whose number is a lead and whose id
  isn't in LocalStore.loggedCalls, and opens the Outcome screen (PendingCall.logId). Non-lead calls
  are just marked. log_call gets the real direction. CallEndReceiver (PHONE_STATE → IDLE) + worker
  posts "Save the outcome: <name>" notification.
- Next-call picker = two taps: day (In 1 hour · Today · Tomorrow · day after · Other date · No
  follow-up) then a horizontal row of 30-minute slots 9:00 AM–9:30 PM (+ Other time); summary line.
- Notes (migration 0022): leads.key_facts (📌 Key facts card, editable, voice typing; app lead detail +
  outcome screen + dashboard drawer), add_lead_note (notes without a call, with tags), lead_notes()
  timeline (call notes + notes, newest first), quick note tags = organizations.settings.note_tags
  (Settings → Quick note tags; call tags saved in calls.outcome_data.note_tags). Voice typing via
  RecognizerIntent (en-IN).
- Recordings folder on Redmi K20 Pro (MIUI 12 / Android 11) was never saved (device_status said
  "Recordings folder not chosen"). PhoneSetup.saveRecordingsFolder() now always saves, ignores
  takePersistable errors, counts audio files and tells the rep ("12 recordings found"); no starting
  folder hint on Android < 12.

## Targets + pre-call glance (v0.8.1, Nov 2026)
- rep_targets (migration 0023): per working day calls / conversations / talk_minutes / sales; user_id
  null = company default, a person's row overrides. set_rep_target(org, user|null, jsonb) managers
  only. target_progress(org, from date, to date, users) = target × working days
  (organizations.settings.work_days, default Mon–Sat) vs actual (calls = outgoing, conversations =
  talk > 0, talk minutes, sales = won outcome).
- Dashboard Reports → Targets tab (bars, % colours ≥100 green / ≥70 amber / red, overall = average
  capped 150%, CSV, "Set targets" modal). App Home "Today's targets" card (Repo.myProgressToday).
- Queue shows GlanceCard for the next lead: name, phone, profession/company/city, tags, latest
  webinar watch time, 📌 key facts, last call (time + outcome) and the latest note with tags.

## Playbook (v0.9.0, Nov 2026)
- playbook_items (migration 0024): kind script|objection|link|doc, section, title, body (variables
  {{leadName}} etc.), url, purpose sales|reminder|both, status published|pending|rejected|archived.
  RLS: members read published + own; managers write all; reps insert only status pending.
  review_playbook_item(id, approve, note). seed_playbook() starter content (3 scripts, 3 objection
  answers) + trigger for new companies.
- Dashboard page "Playbook" (nav, all roles): tabs by type, sections, add/edit modal, approvals box
  for managers; reps' "Suggest" goes to approval.
- App: Home "📖 Playbook" card, lead detail and queue ("Script & answers for this call") open
  PlaybookScreen; with a lead it fills variables; search; Copy / Open / Send on WhatsApp; Suggest
  dialog (with voice typing) → pending.

## Announcements + lead tools (v0.9.1, Nov 2026)
- Owner's idea: management sends a message every rep MUST acknowledge. announcements +
  announcement_acks (migration 0025); send_announcement(org, {title, body, urgent, audience
  all|teams|people, team_ids, user_ids}) creates an ack row per recipient; my_announcements,
  mark_announcement(id, ack) (seen/acked), announcement_report, remind_announcement(id, close).
  Dashboard page "Announcements" (managers): compose, progress "12 of 15 acknowledged", who
  hasn't, Remind, Close. App: calls/TeamAlerts.kt pins an ongoing (non-swipeable) notification per
  unacknowledged announcement (re-alerts after Remind); AnnouncementScreen blocks the app (after the
  outcome screen) until "I have read and understood" + Acknowledge. Checked on sync (15 min), app
  open and every minute while open. No Firebase push yet (owner would need a Firebase project) —
  delivery is by polling.
- New-lead alert: my_new_leads(org, since) → notification "3 new leads assigned to you" (opens Leads).
- Lead export: Leads page "Export" (managers) = all leads matching filters, pages of 1,000, CSV.
- excluded_numbers + set_excluded_number (admins; removes earlier non-lead calls with that number);
  sync_calls skips them.
- IndiaMART (migration 0026): lead_sources kind 'indiamart' + api_key, pulled_until, last_pull_at,
  last_pull_error. pg_cron job 'indiamart-pull' every 10 min → pg_net POST to edge function
  indiamart-pull (verify_jwt=false) with x-cron-secret from Vault (check_cron_secret()); manager
  "Check IndiaMART now" calls it with ?source=<id> + user JWT. Calls IndiaMART CRM API v2
  (crmListing, IST times, max 7-day window) → ingest_lead (default field_map sender_city/state,
  query_product_name). Not tested against a real key yet.

## Call reviews / coaching (v0.9.2, Nov 2026)
- call_reviews (migration 0027): one per call; scores jsonb {checklist item: 1–5}, score_pct (avg×20),
  went_well, improve, task + task_due, task_done_at, seen_at. Checklist =
  organizations.settings.review_criteria (6 defaults; Settings → Call review checklist).
  save_call_review (managers, not own calls), calls_to_review (recorded first, min length, not yet
  reviewed), review_list, mark_review (rep: seen / task done), review_scores (avg per rep per item).
- Dashboard "Call reviews" page (managers): filters, To review (+ random call), Reviewed (score,
  task status, seen), Team scores (per item, red < 3, CSV); review modal plays the recording
  (PlayButton exported from CallLog), 1–5 buttons per item, feedback, coaching task.
- App: Home "🎯 New feedback from your manager" card → FeedbackScreen (stars per item, 👍/🎯 text,
  coaching task with "Mark as done", play the call); opening marks it seen.

## Billing & subscriptions (v0.9.3, Nov 2026)
- Migration 0028: plans (per-user price_month / price_year in ₹, features jsonb, min_seats,
  is_public; example plans Starter 399/3990, Growth 699/6990, Pro 999/9990 — PLACEHOLDERS, owner sets
  real prices in Super Admin), platform_settings (trial_days 14, grace_days 7, razorpay_key_id,
  seller name/address), subscriptions (one per org: trialing|active|cancelled|complimentary, seats,
  cycle, trial_ends_at, current_period_end, note), payments (Razorpay order/payment ids, period,
  receipt_no from receipt_no_seq starting 1001). Trigger start_trial on new org (Growth trial).
  Owner's org "Vikas Kumar Consulting" = complimentary; its owner (thesaleskumar@gmail.com — the
  login email, not the account email) is profiles.is_super_admin.
- org_access(org) → state trial|active|grace|expired (+ days_left, seats, seats_used, features).
  price_quote (owner/admin), apply_payment (service role, idempotent, extends from current end).
  Super Admin RPCs sa_companies, sa_update_subscription (audit-logged), sa_save_plan,
  sa_save_settings (Razorpay key secret + webhook secret → Vault, never returned),
  sa_secrets_status, sa_revenue; billing_secret(kind) service-role only.
- Migration 0029: seat limit trigger on org_members for paid (active) subscriptions.
- Edge function `billing` (verify_jwt=false): action order (price_quote as user → Razorpay Orders
  API → payments row), action verify (HMAC order|payment with key secret → apply_payment),
  /billing/webhook (X-Razorpay-Signature with webhook secret; payment.captured / order.paid).
- Dashboard: "Plan & billing" (owner/admin): plan cards, monthly/yearly, users, total, Razorpay
  Checkout (checkout.js), payments + printable receipt (no GST — not registered). "Super Admin"
  (is_super_admin): companies (status, users, calls 7d, paid; edit: trial +7/+14, paid until,
  complimentary, note), plans & prices, payments setup (trial/grace, receipts, Razorpay keys,
  webhook URL), revenue by month. Banner for trial / grace; lock screen when expired (except
  /billing and /admin). App: grace warning card; PlanEndedScreen when expired (never sells in app).
- Not yet: Flexifunnels landing page → Razorpay → auto-create company; recurring auto-debit
  (Razorpay Subscriptions); coupons; feature-by-plan gating (features stored, not enforced).

## Owner feedback round 5 (v0.9.4, Nov 2026)
- Leads tab (ui/LeadsTab.kt): "Select to call" mode (checkboxes, All, "Call N" → queue); Home "Pick
  leads to call" opens it. Filter sheet; filters shown = organizations.settings.app_lead_filters
  (dashboard Settings → Lead filters in the app; default followup, outcome, stage, source, category,
  city, never_called + company's own fields). lead_filter_options(org) (migration 0030) returns
  stages, categories, sources, campaigns, cities, custom keys from leads.custom with top values.
  Repo.leads applies LeadFilters via PostgREST (in, ilike, custom->>key in).
- Calls tab rows: Call / WhatsApp / SMS buttons for every number (non-leads call directly, no
  outcome), "+ Add lead".
- Home always shows a Today's targets card (explains when none are set).
- Follow-up reminders use a custom large-text layout (res/layout/notif_followup.xml: 20sp title,
  due time, 16sp text).
- WhatsApp messages with media: message_templates.media_path/type/name + private bucket
  template-media (<org>/<file>, managers upload). Dashboard Settings → attach photo/video/PDF ≤16 MB.
  App picker downloads to cache/shared, shares via FileProvider (${applicationId}.files) with
  ACTION_SEND + jid extra to WhatsApp; reps can also attach from their phone.
- Old dashboard notes ("dd/mm hh:mm: text" lines in leads.notes) converted to note activities;
  label now "Notes from the imported file". Dashboard adds notes with add_lead_note.
- WhatsApp calls not tracked on owner's phone because he installs the `direct` build (no
  notification access); full build sent as CloserOS-<ver>-with-WhatsApp-calls.apk (needs Play
  Protect scanning off while installing).

## Owner feedback round 6 (v0.9.5, Nov 2026)
- Back on main tabs: non-Home tab → Home; on Home 3 presses within 2 s exit (toasts count down).
- SIM labels ("SIM 1 · …") on call-history rows, dialer history and lead-detail calls (CallRow.sim_slot).
- search_leads(org, q, limit) (migration 0031): name, phone digits, email, company, profession,
  city, state, source, campaign, key facts, imported notes, custom fields (custom::text), note
  activities and call notes; reps only their own (assigned / reminder_by). Used by app Repo.leads
  and dashboard Leads (search + export). pg_trgm installed (no indexes yet — add if slow).
- In-app dial pad (ui/DialerScreen.kt; Home "☎ Dial a number", Calls tab "Dial pad"): keypad (long
  press 0 = +), live matches (leads + phone call history containing the digits), WhatsApp / SMS /
  Add lead, one Call button per SIM; exact lead match goes through the normal lead call flow.
- App Reports screen (ui/ReportsScreen.kt; Home "📊 My reports"/"Reports — me & my team"): presets
  Today / Yesterday / Last 7 days / This month / Last month / Pick dates; managers choose Everyone /
  Me / a person (team_brief RPC). Tiles (call_report g=15), targets (target_progress), outcomes
  (outcome_report g=6), follow-ups (follow_up_report g=1), team by talk time (g=7), day by day
  (g=11), by hour (g=13).

## Owner feedback round 7 (v0.9.6, Nov 2026)
- Owner confirmed: triple-back exit and search work.
- Floating green ☎ dial-pad button on every main tab (except Profile / select mode).
- lead_status_report(org, users, from?, to?) (migration 0032): total leads, called, reached,
  never called, latest outcome per lead (by_outcome / by_category), per rep (total, called,
  reached, interested, won, lost). Optional period = leads ASSIGNED in it. Shown in app Reports
  ("Leads — where they stand", All leads / Assigned in this period) and dashboard Reports →
  Outcomes (components/LeadStatus.tsx, per-person conversion table).
- Android 13+ "Restricted setting" when enabling notification access for a sideloaded app: fix is
  App info → ⋮ → "Allow restricted settings". Phone setup WhatsApp item explains it + "Open app
  info" button.

## Speed + tools (v0.9.7, Nov 2026)
- Migration 0033: trigram GIN indexes (lead_search_text(leads) immutable fn, phone, note text, call
  notes) + btree (leads org/created, org/assigned/assigned_at, org/last_outcome; follow_ups org/due;
  announcement_acks open; calls with recordings). search_leads rewritten as UNION of indexed
  lookups. recording_status gains 'expired' (enum value must be added in its own statement).
- bulk_update_leads(org, ids, {stage_id|assigned_to|do_not_call|add_tag|remove_tag|delete}) —
  managers, audit-logged; dashboard Leads selected-bar: Assign, Move to stage, + Tag, Do not call,
  Delete (soft).
- leaderboard(org, from, to): talk_sec, conversations, calls, sales for active reps/managers (+
  anyone with calls); hidden from reps if settings.show_leaderboard = false. App Home card
  "🏆 Leaderboard today" + LeaderboardScreen (today/week/month × metric).
- best_time_to_call(lead): lead's most frequent pick-up hour, else team's best connect-rate hour
  (30 days, ≥20 calls). Shown in GlanceCard and lead detail (BestTimeLine).
- Recording retention: settings.recording_retention_days (Settings → Recordings & team); pg_cron
  'recording-cleanup' daily → edge function recording-cleanup (cron secret) deletes files via
  Storage API and marks calls 'expired'.
- App Home refresh loads its RPCs in parallel.

## Performance round (v0.9.8, Nov 2026)
- R8 on for release (isMinifyEnabled + isShrinkResources, app/proguard-rules.pro: -dontobfuscate,
  keep com.closeros.app.data.**, supabase, ktor, kotlinx.serialization, workers). APK 9.6 MB → 3.2 MB.
  No emulator here: verify with dexdump that MainActivity/CloserApp/workers/serializers/OkHttp
  engine and META-INF/services survive.
- data/LocalDb.kt (SQLiteOpenHelper, no new library): cache (k,v) for instant screens/offline
  (membership, profile, outcomes, categories, templates, followUps, stats, first leads page "leads0"),
  marks (logged calls, uploaded recordings; pruned after 60 days), wa_calls. One-time migration from
  SharedPreferences (db_migrated). Sign-out clears the cache.
- PhoneCalls: query() with CallLog LIMIT_PARAM_KEY + DESC for history (no more reading 100k rows),
  SIM/subscription lookups cached 30 s, deviceId cached. VM call-log reads on Dispatchers.IO.
  reloadLeads keeps the old list until new results; leadsGen ignores late results. Lead detail opens
  from the in-memory lead.
- RecordingSync: folder listing via DocumentsContract child query (one query per folder); upload
  streamed with HttpURLConnection (fixed-length/chunked) to /storage/v1/object/recordings/<path>.
- Crash/error reports (migration 0034): app_errors + report_app_errors(jsonb array; anon allowed,
  capped) + sa_app_errors(days); 60-day cleanup cron. data/AppLog.kt writes errors.jsonl, flushes on
  sync/app open; uncaught handler sends crashes immediately (anon REST). Super Admin → App errors.
- Home: SyncStatusLine ("✓ All synced · 2 min ago" / "⏳ N waiting to upload" / "⚠ last synced …")
  with Sync now. Refresh on resume only if > 60 s old; announcements polled every 2 min and only in
  the foreground (vm.foreground from onResume/onPause).

## Desk mode — reps on the laptop (v0.9.9, Nov 2026)
- Owner: reps should also work from the laptop (hands free, easier typing). Cost impact ≈ 0 (same
  site + DB); note Vercel Hobby is non-commercial → Vercel Pro (~$20/mo) needed before selling anyway.
- Migration 0035: call_requests (pending → dialing → ended → logged | cancelled; call_id = the
  phone's stable call id). request_call(lead) (laptop; cancels older pending), claim_call_request()
  (phone; expires after 2 min), call_request_ended(id, call_id, started, duration, phone),
  cancel_call_request, trigger on calls.outcome_id → request 'logged', calls_with_outcome(ids),
  my_calls_needing_outcome(org) (last 24 h).
- Web: page "My desk" (/desk, first in the menu; index route for reps): tabs Needs outcome /
  Follow-ups / My leads (search_leads), lead panel (key facts, notes + add note, Call on my phone,
  WhatsApp Web with company templates, Full details = LeadDrawer), call status bar (polls the
  request every 2 s; "open Closer OS on your phone" after 9 s), OutcomePanel = same rules as the
  app (outcome, amount for sale, next call day + 30-min slot in company time zone or no follow-up,
  notes + quick tags) → log_call with the phone's call id.
- App: polls claim_call_request every 4 s while in the foreground and nothing pending → dials (SIM
  picker skipped if a SIM was used before), PendingCall.requestId; reportCallEnded() when the
  call-log entry is found; OutcomeScreen checks every 4 s whether the outcome was saved elsewhere
  (calls_with_outcome) and closes itself; checkUnloggedCalls skips calls logged on the laptop.
- Limits: background phone can't receive requests until Firebase push is added (planned before launch).

## Play Protect block (Nov 2026)
- 0.5.0+ was blocked on the owner's Xiaomi: "App blocked to protect your device" (Google Play Protect
  enhanced fraud protection, India): apps installed from outside the Play Store (WhatsApp, browser,
  file manager) are blocked if they use notification access (also SMS / accessibility).
- Two builds now (product flavors, dimension "dist"): `full` (WhatsApp-call tracking, for the Play
  Store) and `direct` (no NotificationListenerService; BuildConfig.WA_TRACKING=false hides WhatsApp
  setup). Build with ./gradlew assembleDirectRelease / assembleFullRelease; outputs in
  app/build/outputs/apk/<flavor>/release/. Owner gets the direct APK for testing.
- Owner (Nov 2026): testing WITHOUT WhatsApp calls for now → send only the `direct` APK
  (CloserOS-<ver>.apk) unless he asks for the full one.
- Company-specific APK downloads must use `direct` (or the rep turns off Play Protect scanning).
  WhatsApp-call tracking only via the Play Store build.

## Build notes
- Android SDK at /opt/android-sdk (set `sdk.dir` in local.properties).
- Maven Central rate-limits this sandbox; settings.gradle.kts uses Google's mirror
  `https://maven-central.storage-download.googleapis.com/maven2/` first.
- Built APKs for the owner go in `downloads/` (git-ignored) and are sent with SendUserFile.
- Owner's Mac (Nov 2026): Homebrew openjdk@17 + android-commandlinetools. Build with
  JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools. The sandbox blocks Java from downloading
  the Gradle zip → fetch it with curl into ~/.gradle/wrapper/dists/gradle-8.14.3-bin/<hash>/.
  Redmi K20 Pro over USB = adb serial 2da6b6e9; install with `adb install -r` (keeps data).
- v0.13.1: saving an outcome in the app now also clears the "Save the outcome" notification (it was
  only cleared by the pop-up); direct build no longer mentions WhatsApp calls in setup texts.

## Quality pass (v0.9.10, Nov 2026)
- Owner: "Launch should wait. Make the app perfect." Crash/robustness fixes, no new features:
  safeStart() (calls/PhoneCalls.kt) for every intent to another app (toast instead of crash);
  lists de-duplicate before keyed LazyColumn (duplicate key = crash) + leads paging skips ids already
  shown; outbox add/remove under a lock and only sent items removed (an outcome saved during a sync
  was lost before); sign-out uploads the outbox first and warns "N outcomes not uploaded" (vm.signOutWaiting);
  Save button no longer stuck on "Saving…" after a server rejection; outcome save guards missing
  membership; WhatsApp picker "Back" during attachment download no longer crashes; recordings-folder
  count runs on IO (ANR on big folders); dial pad reads call history once; double-tap guards on
  note / key facts / add lead; CallEndReceiver checks the action; telephony uses-feature not required.

## Swipe tabs + after-call pop-up (v0.9.11, Nov 2026)
- Owner: swipe left/right between Home / Leads / Calls / Follow-ups / Profile → HorizontalPager in
  MainActivity (mainTabs; synced with vm.tab both ways; swipe off in leads select mode).
- Owner: Truecaller-style card after every call, even when the app is closed. calls/AfterCall.kt:
  CallEndReceiver (PHONE_STATE → IDLE, goAsync, up to 45 s) → AfterCall.handle: polls the call log
  (~10 s), dedupes (store.lastAfterCallId; Android sends IDLE twice), skips calls started in the app,
  looks up the lead, posts the "Save the outcome" notification (backup), and shows an OVERLAY window
  (TYPE_APPLICATION_OVERLAY + ComposeView with its own lifecycle owner; SYSTEM_ALERT_WINDOW) unless
  Closer OS is on screen (MainActivity.visible). Overlay, not an activity, because Android 15 lets
  apps start activities from the background only while their overlay is visible.
- ui/AfterCallCard.kt: header (name, number, Received/Talked/Not answered/Missed, SIM, profession,
  📌 key facts), quick outcome chips + quick next-call (In 1 hour, Today 6 PM, Tomorrow 11 AM/6 PM,
  day-after 11 AM, No follow-up) + Save (log_call, outbox if offline, markLogged); "Other time…" /
  "More options" / sale outcome → ui/AfterCallActivity (translucent sheet, AfterCallViewModel with
  lite = true, same OutcomeScreen(popup = true)); unknown numbers → "+ Add as a lead" (then asks the
  outcome if the call needs one). Actions: Call (same SIM), WhatsApp, SMS, Open lead.
- Profile → "After-call pop-up": Leads only (default) / All calls / Off (store.afterCallMode).
  Phone setup: "After-call pop-up" (ACTION_MANAGE_OVERLAY_PERMISSION) + on Xiaomi/Redmi/POCO
  "Pop-ups in the background" (MIUI permission editor, rep taps Done).
- Closing the card without saving is fine: the app's mandatory outcome check asks on next open.

## Password reset (Nov 2026)
- Web "Forgot password?" sent the email but there was no page to choose a new password. Added
  pages/SetPassword.tsx (useRecoveryMode: PASSWORD_RECOVERY event or #type=recovery, kept in
  sessionStorage) → supabase.auth.updateUser({password}). App.tsx shows it before everything else.
- Owner's login = thesaleskumar@gmail.com (email + password). Never set passwords for him in chat.

## After-call pop-up fixes + WhatsApp step + company files (v0.9.12, Nov 2026)
- Owner (11T Pro, third-party dialer com.hb.dialer.free): no pop-up after calls. Causes: (1) calls
  started from Closer OS were skipped; (2) background "JWT expired" (app_errors) → lead lookup and
  sync_calls failed when the app hadn't been open for an hour. Fixes: Backend.ensureFreshSession()
  (awaitInitialization + refreshCurrentSession if < 2 min left) at the start of CallSync.run and
  AfterCall.handle; pop-up shows after EVERY call unless Closer OS is on screen; app-started calls
  keep purpose/batch (AfterCall.Info.appCall) and saving in the pop-up clears store.pendingCall;
  MainActivity vm.onResume drops its pending call (and advances the queue) when it was cleared
  there. Lookup failure → card says "Couldn't reach Closer OS" + Open app. Default mode now "all".
- Owner's flow: outcome + next call → then WhatsApp message. Pop-up Save → AfterCallActivity
  mode "whatsapp" (WhatsAppPicker); full form saved → whatsapp step too; card's WhatsApp button
  opens the picker. In the app: vm.whatsappNext after saveOutcome (not in the calling queue).
- Company file library (migration 0036 company_files: org, name, path in bucket template-media at
  <org>/files/…, mime, size; members read, managers write). Dashboard Settings → "Company files for
  WhatsApp" (multi-upload ≤16 MB, rename, delete). App WhatsAppPicker → "📁 Company files"
  (CompanyFilesDialog, Repo.companyFiles) → downloaded and shared to WhatsApp with the text.

## Pop-up login fix + trace (v0.9.13, Nov 2026)
- Owner: pop-up still not working on 0.9.12. app_errors showed the after-call lead lookup sent with
  the publishable key only (no user JWT → "permission denied for table leads"): in a background
  wake-up the library had dropped the expired session (refresh failed while the network was waking),
  and ensureFreshSession returned early when currentSessionOrNull() was null. Now it loads the saved
  session from sessionManager, refreshSession(refreshToken) + importSession, 4 tries with backoff;
  no lookup is sent without a login (card shows "couldn't check").
- AfterCall trace: every call end writes store.lastAfterCallTrace + AppLog kind "info" place
  "after-call" ("pop-up shown (lead)", "no pop-up: Closer OS was on screen", "call not found…",
  "\"Display over other apps\" is off", …) and flushes right away → read app_errors to debug.
  Profile → After-call pop-up: "Test the pop-up" (AfterCall.test: card for the latest call now) +
  "Last call: …" line. When Closer OS itself is on screen after a call, the app's own outcome
  screen is used instead of the pop-up.

## Instant after-call pop-up (v0.9.14, Nov 2026)
- Owner: pop-up works but appears late (traces: 14–34 s after the call; Truecaller < 1 s). Old order
  was login refresh (awaitInitialization up to 8 s + retries) → call-log poll (1 s steps) → server
  lead lookup → show. Now AfterCall.run shows FIRST and fills in: number from the PHONE_STATE extra
  (EXTRA_INCOMING_NUMBER; Android sends IDLE twice, the 2nd copy's number goes to lateNumber) +
  data/LeadIndex (LocalDb v2 table lead_index phone→slim Lead json; synced incrementally by
  updated_at in CallSync.run, max 30k/run; VM lead pages + server lookups are remembered) → card in
  ~0.3 s; call log polled every 0.15 s via PhoneCalls.latest(); server lookup confirms afterwards
  (Overlay.update keeps the rep's taps). Info.call / phone nullable, checking flag ("Checking if this
  number is a lead…"); Save waits for the call-log entry. Trace says "pop-up shown after X s".

## Two-step pop-up (v0.9.15, Nov 2026)
- Owner saw "Lead not found" on Save although the outcome WAS saved: `lead?.let { saveQuick() } ?:
  "Lead not found"` turned saveQuick's null (= success) into that text. Fixed.
- Crash opening AfterCallActivity (app_errors "LocalDb.get on a null object" in AppViewModel.loadOrg):
  the init block ran before `cache` existed (Main.immediate + already signed in). init now sits at the
  END of AppViewModel — keep it last.
- Owner: two steps on the SAME card: 1) outcome + next call → Save; 2) "✓ Saved: … · next call …" +
  "Send a WhatsApp message?" with company / my messages (filled via fillTemplateText(), shared with
  vm.fillTemplate; attached file downloaded + shared), "Write / edit · files" (→ AfterCallActivity
  whatsapp mode) and Close (dial the next). Card's WhatsApp button opens step 2 too. Company now
  carries name, repName and templates from the cache.

## Every call treated alike (v0.9.16, Nov 2026)
- Owner: don't split calls into lead / not-lead sections; treat all calls the same and just tag
  "Not in lead list" (category used later for filters/reports).
- Migration 0037: log_call accepts create_lead = true (+ lead_name): finds the org's lead by
  normalised phone or inserts one (source 'Phone call', assigned to the caller) before saving —
  works from the offline outbox too.
- Pop-up: same outcome + next-call + WhatsApp steps for every call; header shows the phone contact
  name (PhoneCalls.contactName, PhoneLookup) and a "Not in lead list" pill; saving adds the lead.
  Non-lead extras: "Personal call — skip" (close) and "Never ask for this number"
  (store.personalNumbers, normalised, this phone only → run() skips them); "Add with name & details"
  (AfterCallActivity add mode). Outcome stays OPTIONAL for numbers not in the list (closing is fine);
  the app's mandatory check still applies to leads only.
- Calls tab rows: grey "Not in lead list" tag; filter chip renamed "Not in lead list".

## Contact names, lead tags, instant refresh (v0.9.17, Nov 2026)
- Owner: lead added by the pop-up showed up in the Leads tab only much later → data/AppEvents
  (leadsChanged StateFlow, bumpLeads() after a pop-up / full-form save) → main VM reloadLeads +
  loadHistory + refreshHome at once.
- Owner: Calls tab showed only Closer OS lead names, not phone contacts → PhoneCalls.query reads
  CallLog.CACHED_NAME, else PhoneCalls.contactNames() (all contacts by last 10 digits, cached 60 s)
  into LogCall.name for phone calls (not uploaded). Rows: lead name > contact name > number;
  "saved as …" when they differ.
- Tags: leadTags adds amber "Added from a call" for source 'Phone call'. loadHistory marks leads from LeadIndex first, then the server.

## Tag rule (owner decision, Nov 2026 — v0.9.18)
- The app is for calling leads, so leads are the normal case and get NO "Lead" tag anywhere.
  Only numbers not in the lead list get the grey "Not in lead list" tag (Calls tab, pop-up).

## Round 8: DNC, pick-ups, call-type outcomes, Home + Calls redesign (v0.9.19, Nov 2026)
- Owner priority: minimalist, best use of space, fewest scrolls/taps to the goal.
- Do not call: every call path goes through Root.call() → if lead.do_not_call, dialog "Remove and
  call" (vm.dncAsk / vm.setDoNotCall → RPC set_do_not_call, audit lead_dnc_removed/_set). Lead
  detail shows "⛔ Marked Do not call · Remove". Call buttons are no longer disabled.
- Real pick-up (migration 0038 is_real_pickup): DIALLED call where the person talked = outcome
  category connected/positive/won/lost, or (no outcome) talk ≥ 20 s; not_connected/invalid never
  (operator "switched off" messages connect for a few seconds). best_time_to_call uses it, needs ≥ 2
  pick-ups in an hour for the lead's own best time (else team hour), returns total_picked/total_tries
  ("Picked up 8 of 38 calls").
- outcomesFor() (OutcomeScreen.kt; same rule in web Desk): incoming answered → no not_connected;
  dialled 0 s → only not_connected + invalid; dialled < 20 s → all, not_connected first; ≥ 20 s →
  conversation types first. Pop-up drops a picked outcome that no longer fits once the call arrives.
- Home (CallingScreens.HomeScreen): greeting; alerts only when they apply (plan, setup, sync problem,
  new feedback); green hero card with ONE big adaptive button (continue queue > overdue follow-ups
  (red) > webinar reminder calls in next 18 h > due follow-ups > pick leads) + links Pick leads /
  Follow-ups / Webinars; "Today" card with 4 tiles (Dialled, Talked, Talk time, Leads) + target bars,
  "More ›" for all 10; one-line leaderboard; tools row (Playbook, Reports, Feedback); tiny sync line.
- Calls tab: slim rows (↗/↙/✕, name > contact > number, "Not in lead list" pill, one detail line,
  SIM only with 2 SIMs), WhatsApp + Call icons on the row, tap row → SMS / Open lead / + Add lead;
  day headers; repeat calls folded "(2)" (groupCalls); chips All / Missed / Not in lead list
  (+ WhatsApp in full build); no "Dial pad" button (FAB). HistoryRow is shared with Today lists.
- Profile → "Open the app on": Home / Leads / Calls / Follow-ups (store.startTab).

## Round 9: effort, WhatsApp queue, outcomes v2, calendar, sales insights (v0.10.0, Nov 2026)
- Owner rules: no "stop-loss"/give-up warnings (people convert after 4× effort) — effort bars stay
  neutral; focus list has NO limit; WhatsApp automation = option A only (assisted queue, 1 tap per
  lead; no Accessibility auto-send: Play Protect/Play Store block + WhatsApp bans numbers; Business
  API = future paid add-on).
- Migration 0039: wa_messages (sent from the app; source single|queue|popup; undone_at for Undo;
  my_wa_today, wa_sent_today), lead stats on leads kept by triggers on calls/wa_messages
  (refresh_lead_stats: total_talk_sec, dial_count, pickup_count, wa_count, first_dialled_at,
  first_talk_dial, last_call_status talked|not_picked|missed, won_at, score 0–100 "close to
  converting" = pick-ups, talk vs 30 min, last outcome, webinar watch, recency; 0 for won/lost/invalid/DNC),
  call_outcomes.next_default (30m 1h 2h 3h today tomorrow 2d 30d pick none) + apply_outcome_set_v2()
  (new sales + reminder list, old outcomes hidden not deleted; applied to every org; create_organization
  calls it — migration 0040), org_holidays + member_leave (managers write) + working_days(org,user,from,to);
  target_progress now per-person working days (rows carry work_days).
- Migration 0040: log_call stores p.lead_custom (facts → leads.custom) and p.lead_tags (→ leads.tags).
- Migration 0041: leads.has_talked (trigger), work_leads/lead_work_report/lead_work_list (assigned →
  dialled → conversation/not reached/junk, attempts 0–5/6+, per person; junk = invalid outcome or DNC),
  lead_effort/lead_path (path to sale: talk, calls, picked, received, WA, follow-ups made + on time,
  days, first talk dial, category, source, watch), sales_recipe (avg per sale mine vs team, converted
  list, per person), conversion_insights (by source/category/watch band/city/speed-to-first-call + speed
  per rep; managers), my_focus_list (overdue → due in 2 h → never dialled → score ≥ 40 → rest; skips
  DNC/won/lost/invalid and leads planned for a later day). Migration 0042: call_recording_paths(ids).
- A "follow-up" in reports = a planned next call (follow_ups row) that was actually dialled.
- App: Settings tab (was Profile, gear icon); Back always closes the top screen (vm.closeTop +
  root BackHandler); teal dot-keypad FAB; bold arrows; Calls chips All/Dialled/Received/Missed/Not
  picked up (< 20 s)/Not in lead list + ▶ on rows with recordings (vm.recordingPaths);
  LeadFilters lastCall/messaged/hot/tags (+ webinar list "Tried 3+, no talk"); lead card one-line
  effort "Talked 12m · 5 calls (3 picked) · 9 WA" + "⚡ Close to converting" tag; lead page
  Call · WhatsApp · SMS + EffortCard (interactions, path to sale when won, neutral bar vs my usual sale);
  OutcomeScreen + pop-up + web Desk: quick picks In 30 min/1/2/3 hours · Today▸ · Tomorrow▸ · Day after▸
  · Other · No follow-up, outcome.next_default preselected; tag groups (settings.tag_groups) + facts
  (settings.lead_facts) on the outcome screen. Home: Interactions tile (calls + WA, tap → WaTodayScreen),
  month talk-time line "x of y · day d of n · on pace ✓ / behind", hero "Start today's focus · N"
  (vm.startFocusQueue, sub-line opens the list), tools Lead work / What works. WhatsApp queue:
  vm.waChooseFor → WaChooseDialog → startWaQueue (skips leads that got it today) → WaQueueScreen
  (open WhatsApp, back = logged + 3 s countdown → next; Pause/Skip/Undo/Stop); entry points Leads
  select bar "WA N", webinar list "WhatsApp N", any LeadListScreen "WhatsApp all". All WhatsApp
  sends (picker, pop-up, queue) are logged. Screens: ui/Round9Screens.kt.
- Dashboard: Settings → Next step after each outcome, Note tags in groups, Facts to capture,
  Working calendar (days, holidays, leave) (pages/SettingsRound9.tsx); Reports tabs Lead work /
  What works / Insights with clickable numbers → lead list modal → LeadDrawer
  (components/Round9Reports.tsx); LeadDrawer EffortSummary.
- v0.10.1 (migration 0043): leads.best_hour (hour with ≥ 2 real pick-ups, company time zone, kept by
  refresh_lead_stats); my_focus_list bucket "⏰ Best time to call now" (after new leads, before score);
  rep_targets.focus_leads (dashboard Set targets "Focus leads / day"; target_progress daily.focus) →
  Home hero "Today's focus target: x of y" bar. App lead tags "🆕 New · 12 min waiting" (dial_count 0,
  < 7 days; blue ≤ 30 min, red after) and "⏰ Best time now"; neutral talk bar on lead cards vs my
  usual talk per sale; Settings → Calling queue "Best time to call first" (store.queueBestTimeFirst,
  default on: due follow-ups, then best-hour-now leads, then the rest).

## Outcomes from the owner's sheet (migration 0044, Nov 2026)
- Owner's Google Sheet reminder outcomes are the reference: apply_outcome_set_v2 now lists, in the
  sheet's order and names: Guided, Didn't pick, Switched off, Wrong number, Incoming calls not
  available, Someone else picked, Out of service, Repeated, Not reachable, Disconnected after intro,
  Team, Asked to call later, Busy on another call, Invalid number, Not interested (+ Will try / maybe,
  Can't attend — wants next batch, Asked to send the link). "Confirmed — will join" hidden (= Guided).
  Sales also gained Incoming calls not available, Invalid number, Disconnected after intro.

## Owner feedback round 10 (v0.10.2, Nov 2026)
- Outcomes (migration 0045): busy ≠ cut → Busy, asked to call later (call_back / r_call_later) ·
  Busy on another call (busy / r_busy) · Cut the call without picking (cut_call / r_cut_call) ·
  Disconnected after introduction (disconnected / r_disconnected), sales + reminder.
- "Start today's focus" opens the list first (vm.openFocusList → LeadListScreen with Call all /
  WhatsApp all), never dials straight away.
- No surprise dialling: queueTick pauses the queue when the app isn't in front or the after-call card
  (AfterCall.Overlay.isShowing) / full form (AfterCallActivity.open) is up; after a pop-up save the
  queue waits for "Continue".
- Conversations per lead (migration 0046 leads.conversation_count = real dialled pick-ups + incoming
  talks); callsLine() "5 calls · 3 conversations" on lead cards, lead page, queue glance card,
  follow-up cards (LeadMini carries counts), dialer matches, pop-up header, call rows of leads;
  dashboard Leads "Calls" column + report lists. LeadIndex cursor bumped (lead_index_cursor2) so
  phones re-download leads with counts.
- WhatsApp counted only when confirmed: queue asks "Did the message go? ✓ Sent — next / ✗ Not sent";
  single sends (picker, pop-up, full form) go to LocalStore.waPending and WaConfirmDialog asks
  "Did these WhatsApp messages go?" when the rep is back in Closer OS (✓ Sent / ✗ No / All sent).
- Leads tab chip "Select to call / WhatsApp".
- Dashboard on phones (checked with a temporary test user at 390 px, then deleted): index.css makes
  tables scroll sideways inside their card on < 768 px; Leads page has a card list on phones.

## Pop-up Save fix (v0.10.3, Nov 2026)
- Owner: pop-up Save stayed grey after picking outcome + time. Cause: Android's second "call ended"
  message (> 5 s after the first) opened a NEW blank card (call = null) over the finished one, then
  returned at lastAfterCallId without filling it. Now run() adopts a card already showing for the same
  number (Overlay.current), and continues when shown; the card self-repairs (AfterCall.findRecentCall
  every 1 s, 2 min) and Save is never disabled for a missing call (looks it up on tap).

## Complete call counts (v0.10.4, migration 0047, Nov 2026)
- Owner: "N calls" on lead cards was lower than the phone's history. Causes: server only had calls since
  each phone's first sync (2 days back), and the number counted dialled calls only.
- leads.call_count = ALL calls with the lead (dialled, received, missed, WhatsApp), kept by
  refresh_lead_stats; callsLine()/dashboard Leads use it ("17 calls · 1 conversation"); lead page
  says "17 calls (13 dialled, 1 picked up)".
- CallSync step 2a: once per phone (store.leadHistoryDone, needs LeadIndex filled) uploads every
  call in the WHOLE phone call history whose number is a lead; afterwards LeadIndex.sync returns
  numbers new on this phone and only their older calls are uploaded. Personal (non-lead) history is
  never backfilled. Stable ids → no duplicates. Old calls can't mark follow-ups dialled (2-day window).

## Android 11 times + recordings folder (v0.10.5, Nov 2026)
- Owner (Redmi K20 Pro, Android 11): follow-up cards had no time/day and all said "Due now". Cause:
  Instant.parse can't read "+00:00" offsets (server format) on Android ≤ 11. ALWAYS use
  data/Time.kt parseInstant() (OffsetDateTime first) — never Instant.parse for server times.
  Also fixes follow-up alarms on old Androids.
- Owner: recordings folder picked but still "pending" (device_status rec_folder_set false). The
  picker result was registered inside the Phone setup composable and got lost when another screen
  (outcome) opened first or the app was recreated. Now MainActivity.pickRecordingsFolder
  (registerForActivityResult) → vm.onRecordingsFolderPicked (save, setupTick++, sync now);
  PhoneSetup.pickRecordingsFolder(ctx) opens it; PhoneSetup.recordingsFolder(ctx) also adopts a
  folder Android still remembers (persistedUriPermissions) → auto-detected tick.

## Recording uploads + received-call outcomes (v0.10.6, migration 0048, Nov 2026)
- Owner: no Play button although calls were recorded. device_status: folder OK, 6 files, 5 matched,
  0 uploaded — "Upload refused (400) … new row violates row-level security policy". Cause: upload
  uses x-upsert, which needs SELECT on the object; recordings_select only allowed files already set
  as calls.recording_path (set AFTER upload). Migration 0048 recordings_select_own: a rep reads
  <org>/<own uid>/… . Server-side fix, works with any app version.
- Received calls: outcomesFor (app OutcomeScreen.kt DIALLED_ONLY + web Desk) hides not_connected AND
  dialled-only codes (not_in_service, invalid_number, r_invalid, r_out_of_service, someone_else,
  r_someone_else); invalid-category (wrong number, not the right person, DNC) go last.
- v0.10.7: uploads now arrive (5 mp3s, valid 32 kbps), but in-app play said "Couldn't play the
  recording" (no error logged). RecordingPlayer now downloads via Repo.recordingFile
  (storage downloadAuthenticated → cacheDir/recordings, newest 30 kept, audit log_recording_access)
  and plays the local file; player/download errors go to AppLog "play recording"; "Try again" button.
- v0.10.8: real cause of "Couldn't play" (app_errors): "Plugin storage not installed" — Backend.client
  only installed Auth + Postgrest, so EVERY storage call failed (recording play, WhatsApp template
  attachments, company files). Now install(Storage). Uploads were fine (raw HttpURLConnection).

## One-glance follow-up reminders (v0.10.9, Nov 2026)
- Owner: reminder had to be expanded to see the Call action and gave no context. Now custom
  RemoteViews: closed/heads-up = layout/notif_fu_small (title "Name · 5 min late" red when late,
  line "last outcome · 62 calls · 7 conv.", green 📞 Call button via setOnClickPendingIntent);
  expanded = notif_fu_big (kind + due + phone, Last outcome/counts/talk, profession · city, 📌 key
  facts, reason/notes, buttons Call · WhatsApp (wa.me) · Open). VISIBILITY_PUBLIC for the lock screen.
  FollowUp.lead (LeadMini) now also carries last_outcome_id, key_facts, profession, city, total_talk_sec
  (alarm extras; outcome label from the cached outcomes). Call → MainActivity call_lead + fu_id
  (cancels that reminder) + purpose (reminder follow-ups call with purpose "reminder").
- v0.10.10: scheduled time shown in both views ("⏰ 3:49 PM · …" closed; "⏰ Scheduled for 3:49 PM · Follow-up · number" opened).

## Works with no internet (v0.11.0, Nov 2026)
- Owner: app must work with NO network (no mobile data, no Wi-Fi). data/Offline.kt:
  AppCtx (app context, set in CloserApp), Net (ConnectivityManager default-network callback →
  online StateFlow; back online → CallSync.syncNow; isNetworkError(t)), LocalLeads (search/filters/
  sort on the phone's lead copy = Repo.leads rules; byId; focus() = my_focus_list buckets), Ops
  (queue in LocalDb cache "ops": note, facts, wa, lead → flushed in CallSync after the outbox, in
  order; server rejections dropped + logged), LocalFollowUps.apply(ctx, payload) (outcome saved
  offline → replaces the lead's pending follow-up of that purpose in cache "followUps", schedules
  alarms, updates the lead copy).
- LeadIndex now stores FULL lead rows (* + batch_leads) — cursor lead_index_cursor4; LocalDb
  leadJsonById / allLeadJson / leadsVersion. Lead gained profession_category_id.
- Repo.leads / Repo.lead fall back to the phone copy (offline or network error); addNote,
  setKeyFacts, logWa queue offline (…Now / logWaOrThrow are the raw calls Ops uses).
- Login: SessionStatus.RefreshFailure (no internet when the token needed renewing) keeps the rep
  signed in (MainActivity routing + VM loadOrg from cache). CallSync returns early when offline.
- VM: online state; focus list/queue fall back to LocalLeads.focus; webinar lists + my_batches cached
  (bl_<batch>_<purpose>_<everyone>, "batches"); addLeadFromCall → Ops.lead offline; lead page shows
  the number's calls from the phone call log offline; pop-up skips the server lookup offline.
  MainActivity OfflineBar: "📴 No internet — keep working. N saved on this phone…".
- v0.11.1 (owner: "nothing is available offline"): Reports / Lead work / Playbook had no copy;
  Follow-ups showed 0 because Backend.uid was null offline and Repo.followUps returned [] → cache
  overwritten. Now Backend.uid falls back to LocalStore.lastUid; followUps/pastFollowUps throw instead
  of returning []. Repo saved-copy layer: savedText(key){fetch} / saved<T>(key){…} (LocalDb cache
  "srv:…"; offline or network error → saved copy, else friendly "No internet — and no saved copy…");
  rpcR() for all read RPCs (key = name + params with times cut to the day) incl. Repo.report;
  playbook, templates, companyFiles, categories, outcomes, leadCalls, pastFollowUps wrapped.
  calls/Prefetch.kt (end of CallSync, online, every 30 min): playbook, templates, files, categories,
  outcomes, past follow-ups, batches, focus, leaderboard, reports (today/yesterday/7d/month × me
  [+ everyone for managers]: call/outcome/follow-up reports, targets, lead status, lead work
  today/week/month/all) and my newest 30 recordings (Repo.recordingFile audit=false; cache keeps 60).
  Net.isNetworkError treats CancellationException as retry-later (Ops never dropped). LeadIndex pages
  of 250 (weak-internet timeouts seen in app_errors).

## My numbers counted on the phone (v0.11.2, Nov 2026)
- Owner: the data is on the phone → compute there. data/LocalReports.kt mirrors the server rules:
  callReport (call_report rows g15 total / g11 day / g13 hour: calls, out, inc, conn = talk > 0,
  conn_dur, not_picked, missed, rejected, never_attended, uniq…), outcomeReport (g6 outcome_id/calls/
  leads), followUpReport (g1; on time ≤ 15 min after due via dialled_at or the phone log), actuals /
  withMyActuals (target_progress actuals: dialled, talk > 0, talk min, won), leadStatus (lead copy;
  Lead gained assigned_at). Outcomes saved on this phone are remembered (cache "my_outcomes",
  callId → "outcome|lead|ms", 60 days; recordOutcome in vm.saveOutcome + pop-up saveQuick);
  Prefetch merges my server-side outcomes (45 days).
- Reports "Me" (every rep) = phone-computed ("📱 Counted on this phone"); Everyone / a person =
  server (saved copy offline, "📴 … as last saved"). Home today/month target bars: manager's targets +
  phone actuals (vm.mine()). Lead work / What works stay server-side (saved copies).
- Caveat: phone numbers only include THIS phone's calls (one login on two phones → each shows its own).

## Outcomes per call type + one login = one phone (v0.11.3, migrations 0049–0050, Nov 2026)
- call_outcomes.shown_on both|outgoing|incoming (default via outcome_default_shown_on(code, category):
  not_connected + dialled-only codes incl. call_back / r_call_later / disconnected / busy → outgoing;
  insert trigger t_outcome_shown_on for new orgs/outcomes). App outcomesFor + web Desk honour it;
  dashboard Settings "Each outcome: which calls it shows on, and the next step" has a Shows-on select.
- profiles.active_device / _name / _at; claim_device(device, name) on app sign-in; device_check →
  {active, other}; first phone to check claims when null. calls/DeviceGuard.kt: check() in CallSync
  (after outbox + Ops flush) and on app resume (30 s throttle); if not active → uploads everything,
  signs out ONLY locally (SignOutScope.LOCAL), clears local data, LocalStore.kickedReason shown on the
  sign-in screen. Stays signed in while anything is still waiting to upload. Dashboard unaffected.
  Later: Super Admin "allow 2 phones" per user (paid add-on).

## Reminder vs sales everywhere + smarter focus (v0.12.0, migration 0051, Nov 2026)
- lead_call_context(lead) → {purpose, batch_id}: reminder if a pending reminder follow-up is due within
  24 h or the lead is registered (not holdout) for a batch starting within 24 h; else sales + batch of the
  last 30 days. App mirror data/CallPurpose.kt (guess(lead, followUps), webinarOf()); Lead.batch_leads
  now carries batch_id + is_holdout (LEAD_COLUMNS, LeadIndex cursor v5); Lead.call_purpose/call_batch_id
  come with focus rows. Used by: startQueue default "auto", single calls, notification Call, unlogged
  calls (checkUnloggedCalls), pop-up (Info.purpose/batchId; Company carries cached followUps), desk
  (request_call(p_lead) with null purpose → lead_call_context).
- Outcome form + pop-up: "Call type: Sales | Reminder" switch (shown when the lead is in a batch);
  reminder call-backs only before the webinar start (quick picks filtered, "30 min before start",
  later days hidden; next_default after start → 30 min before start); dialled 0 s → "Didn't pick"
  (no_answer / r_didnt_pick) preselected.
- Trigger t_fu_sync_lead keeps leads.next_follow_up_at = min(pending follow_ups) on any change
  (dashboard "done" now clears focus). close_stale_reminders() (pg_cron 'close-stale-reminders' every
  15 min) cancels pending reminder follow-ups once a batch created after them has started and none is
  upcoming ("Closed: the webinar started").
- my_focus_list buckets: 1 overdue · 2 webinar within 18 h ("🎓 Reminder · <batch> at <time>"; also
  leads where I'm reminder_by) · 3 due in 2 h · 4 hot watchers (≥ hot_minutes in last 14 days, "🔥 Watched
  N min") · 5 new never dialled (NEWEST first) · 6 best hour · 7 score ≥ 40 · 8 rest; rows include
  call_purpose / call_batch_id. LocalLeads.focus mirrors it offline. Tested on a temporary org (deleted).

## Hourly check-ins (v0.13.0, migration 0052, Nov 2026)
- Owner: every working hour, an encouraging progress note every rep must acknowledge (sales-only,
  reminder-only or both — same layout, adapts automatically). Rules: never negative; compare with the
  rep's OWN best hour (today + all-time); goal = this hour only (reachable step when far behind); a
  sale always in the title; first slot = morning plan, last = wrap-up.
- calls/CheckIn.kt: schedule() = exact alarm for the next top-of-hour in [checkinStart..checkinEnd] on
  work days (Org.checkinOn/Start/End/reminderCutoffMin/workDays from settings.checkin + work_days;
  scheduled from loadOrg, CallSync, boot). compute() on the phone: last clock hour + today from the call
  log (dialled = outgoing, picked/connected = talk > 0), hours map, best hour today, all-time best (server
  my_talk_records top 3 + today), streak (hours ≥ 70% of best, min 15 min), sales (LocalReports.sales;
  amounts in cache "my_sale_amounts"), daily targets (cache "my_daily_targets" saved from progress.daily),
  reminder maths per batch starting within 14 h (saved batch_call_list: left = not talked; finish =
  webinar − cutoff; pickup = today's dials ≥ 20 s (default 40% under 10 dials); ring 35 s + 15 s between
  calls; allPick = time/left − 15; perAnswered; canFinish at usual talk; missed), tip, action
  (reminder:<batch> > due follow-ups > hot leads > focus). post() = ongoing BigText notification (title ·
  last hour · today · best line · reminder line · goal) + action button; pending in cache
  "checkin_pending"; save_checkin(shown) / acknowledge() (save_checkin acked, cancel notification).
- ui/CheckInScreen.kt card (sales, last hour, today, talk vs your best bars, top 3 hours, streak, hour by
  hour, targets, reminder maths, tip, goal) → "Got it — <action>" (vm.checkInGo: acknowledge + open the
  right list) / Later. Opens from the notification (MainActivity extra checkin=open|go) and once per slot
  on app resume when unacknowledged (< 2 h). Settings → "Show my check-in now".
- Server: checkin_acks (user, slot, summary, shown_at, acked_at), save_checkin, my_talk_records,
  team_checkins (managers: last hour, today, sales, best today / all-time, latest check-in + acks).
  Dashboard: Settings → Hourly check-ins (on/off, from/to hour, reminder finish minutes before start);
  Team page → "Hourly check-ins — today" (refreshes every minute).

## Dark mode + talk-time bands (v0.13.2, migration 0053, Nov 2026)
- Owner: follow-up reminder text invisible in dark mode (custom RemoteViews had hard-coded dark text).
  res/values/colors.xml + values-night/colors.xml (n_title, n_text, n_muted, n_accent, n_late, n_btn_*,
  n_wa, n_open) used by notif_fu_small/big + notif_btn_plain; late colour via ctx.getColor(R.color.n_late).
  App screens stay light: values-v29/themes.xml forceDarkAllowed=false (MIUI force dark) + the
  after-call overlay ComposeView isForceDarkAllowed=false.
- "Duration-wise" lead groups = total talk time with the lead (leads.total_talk_sec): none · < 1 min ·
  1–5 · 5–15 · 15–30 · 30+ (TalkBands in Backend.kt; LeadFilters.talk set; server or/and ranges +
  LocalLeads offline). App filter sheet "Total talk time with the lead" with counts from the phone's
  lead copy. Dashboard Leads: chip row with counts (lead_talk_bands(org, assignee), security invoker)
  filters the list + export.

## Webinar watch-time groups + pitch (v0.13.3, migration 0054, Nov 2026)
- Owner: group webinar attendees by watch time in 10-minute steps and split "saw the pitch" vs
  "left before the pitch". batches.pitch_minute (dashboard batch form "Pitch / payment link shown at
  (minute)"). Owner's rule: watch_minutes >= pitch_minute = saw the pitch; 1..pitch-1 = left before.
- batch_watch_bands(batch) (security invoker): bands k = (w-1)/10 (−1 didn't join, −2 no Zoom data)
  with leads/called/talked/won + pitch split saw|before|absent. my_batches now returns pitch_minute.
- Dashboard BatchDetail (sales tab) → components/WatchBands.tsx: 3 pitch tiles + 10-min bars (▲ = pitch
  band), click → lead list (batch_leads join leads, CSV, LeadDrawer).
- App webinar list Sort & filter: attendance "🎯 Saw the pitch (N+ min)" / "Left before the pitch"
  (when pitch set) + multi-select "Watched — 10-minute groups" (ListPrefs.bands, watchBand()); row
  badge 🎯 for leads who saw the pitch.

## Webinar engagement: exact pitch, chat, polls, warmth (v0.14.0, migrations 0055–0056, Nov 2026)
- Owner: "saw the pitch" must be exact (present at the pitch moment), plus Zoom chat + poll reports
  uploaded by management, shown in the rep's lead profile, and a warmth score that pushes leads up
  the priority (focus) calling list.
- batches: started_at (actual start from the Zoom report; pitch moment = started_at + pitch_minute),
  chat_uploaded_at, polls_uploaded_at, poll_questions. batch_leads: sessions [{join, leave}] (UTC),
  zoom_name, at_pitch (exact, null without join/leave times), saw_pitch (final: at_pitch else
  minutes ≥ pitch), chat_count, poll_answered, warmth 0–100, warm_reason. Tables batch_chat,
  batch_poll_answers (RLS read: managers or lead_visible; writes only via RPCs).
- batch_recompute(batch) (definer, not callable by users; trigger on batches pitch/start/hot change)
  sets counts, at_pitch, saw_pitch, warmth = watch/ref×40 (ref = pitch or hot minutes) + 25 saw pitch
  + chat 10/15 + polls 10 + 2.5 per answer (max 4) ; labels 🔥 Hot ≥ 70, Warm 40–69, Cold 1–39; bumps
  leads.updated_at so phones re-download. apply_zoom_report(batch, rows, p_started_at) (old 2-arg
  dropped) stores sessions + zoom_name. apply_zoom_chat / apply_zoom_polls replace the batch's data;
  batch_match_person(batch, name, email): email → zoom_name → unique lead name among batch leads.
  lead_webinars(lead) for profiles. batch_watch_bands adds exact + warmth {hot,warm,cold}.
- my_focus_list bucket 4 = warmth ≥ 40 or hot minutes (last 14 days), ordered by warmth, reason
  "🎥 🔥 Hot · 82 · watched … · saw the pitch · 2 chats · answered 3 polls". LocalLeads.focus mirrors.
  batch_call_list rows carry saw_pitch, warmth, warm_reason, chat_count, poll_answered.
- Web: lib/zoom.ts (parseWall MM/DD vs DD/MM detection, wallToUtc(tz), cellText for xlsx Dates,
  parseChat for both Zoom chat formats — times < 03:00 on a later-starting webinar = elapsed time —,
  parsePolls wide or Question/Answer tables). ZoomUpload reads Join/Leave Time + "Actual Start Time"
  (editable). BatchDetail buttons 💬 Upload chat / 📊 Upload polls. WatchBands: Saw / Missed the pitch
  (left early or joined late), warmth chips, warmth column. components/LeadWebinars.tsx in LeadDrawer.
- App: LeadWebinarsCard (ui/WebinarCard.kt) on the lead page (Repo.leadWebinars, saved copy; offline
  falls back to batch_leads). Webinar list: sort "Webinar warmth: hottest first" (sales default),
  filters Saw/Missed the pitch + Hot/Warm, warm_reason line on rows; glance + lead cards show it.
  BatchLink gains warmth/warm_reason/saw_pitch (LEAD_COLUMNS, LeadIndex cursor v6).

## Delete a team member (migration 0057, Nov 2026)
- Owner: managers need a permanent delete, not only Deactivate. remove_member(org, user, reassign_to?)
  (owner/admin; not self; only owners remove owners; last owner stays): moves leads (assigned_to),
  batch_leads.reminder_by and pending follow-ups to reassign_to — or unassigns leads + cancels
  follow-ups —, deletes team_members, rep_targets, their personal templates, announcement acks, call
  requests, device_status and the org_members row; keeps the name in org_former_members (members read)
  so the dashboard directory shows "Name (removed)" on old calls; audit member.removed.
- Team page: red "Delete" next to Deactivate → modal (who gets the leads, type DELETE).

## Lead utilisation + reassign with full history (migration 0058, Nov 2026)
- Owner: Leads assigned / utilised / not utilised, and reassigning must keep call history, notes and
  outcomes visible to the next person. Before: calls_select only let reps see their OWN calls, so a
  new assignee couldn't see earlier calls/outcomes/recordings (notes were already lead-visible).
- calls_select and storage recordings_select now also allow anyone who can see the lead
  (lead_visible(lead_id)). after_lead_update (assignment logged as 'assigned' activity; pending
  follow-ups move) also moves batch_leads.reminder_by for UPCOMING webinars from the old to the new rep.
- lead_utilisation(org, from?, to?) (period = assigned_at): per person assigned, utilised (dial_count
  > 0 — called at least once by anyone), not_utilised (never called), talked, oldest_waiting; total
  incl. unassigned. Managers see visible users (+ unassigned); reps themselves.
- reassign_leads(org, from|null=unassigned, scope not_utilised|not_reached|all, to[] round-robin,
  limit?) managers only, oldest assigned first, audit leads.reassigned.
- Dashboard Leads page (managers): components/LeadUtilisation.tsx card (period All / 30 days / this
  month, clickable numbers → list filtered by person + utilisation, Reassign per row + "Reassign
  leads" modal); new list filter "Called or not".

## Strict outcomes by call (v0.14.1, Nov 2026)
- Owner: a dialled call with 2m29s talk still offered Didn't pick / Invalid number / Incoming not
  available / Disconnected after intro. outcomesFor (app OutcomeScreen.kt, used by the outcome form +
  pop-up) and web Desk now FILTER, not just sort: dialled 0 s → not_connected + DEAD_NUMBER only;
  1–19 s → all (not_connected first; operator messages / quick hang-ups); ≥ 20 s → no not_connected,
  no DEAD_NUMBER (not_in_service, invalid_number, r_invalid, r_out_of_service, incoming_na,
  r_incoming_na); ≥ 60 s → also no SHORT_TALK_ONLY (disconnected, r_disconnected). Received calls
  unchanged (no not_connected / dialled-only / shown_on outgoing).
- v0.14.2: received calls never offer dialled-only / "couldn't reach" outcomes, even in the pop-up's
  first moments: calls/CallEndReceiver.kt CallKind notes RINGING / OFFHOOK (prefs "call_kind") and at
  IDLE decides incoming (rang + answered) | missed (rang, never answered) | outgoing; the 2nd IDLE copy
  (< 60 s) reuses the answer. AfterCall.dirHint → Info.dirHint → AfterCallCard uses it until the
  call-log entry arrives (missed → no outcome step). outcomesFor: missed/declined calls are treated
  like received ones (no not_connected / DIALLED_ONLY / shown_on outgoing); web Desk same.

## Pending owner ideas (not built yet — owner said "don't build it now")
- Outcome order (Nov 2026): positive outcomes first, negative after; "Language barrier", wrong number,
  disqualified kinds must not sit in the first rows. Proposed order: won → positive → connected
  (objections / call later) → lost → invalid / disqualified; not_connected first only on 0 s dialled calls.
- Later: per-rep automatic order by usage (most-used outcomes rise to the top, unused sink), on top of
  the existing call-type rules (outcomesFor). Count use per rep from their saved outcomes (phone
  cache my_outcomes + server), recent weeks weighted more.
- v0.14.3: WhatsApp step was offered twice (pop-up step 2, then again when the app opened: the app's
  checkOutcomeSavedElsewhere saw the pop-up's saved outcome and set vm.whatsappNext). Now that path only
  closes the outcome screen ("Outcome already saved ✓"); vm.whatsappNext is set only by vm.saveOutcome
  (outcome saved in the app itself, not lite, not in the queue).

## Shared leads + speed to lead (v0.15.0, migrations 0059–0060, Nov 2026)
- Shared leads (owner: a rep shares a lead with another for follow-up; both log outcomes, see each
  other's notes and cloud recordings): lead_shares (lead, user, shared_by) → trigger keeps
  leads.shared_with uuid[]. lead_visible + leads_select include auth.uid() = any(shared_with) (and
  their managers) → calls/notes/recordings/webinars follow. share_lead(lead, user, on) — owner, a sharer
  or a manager; unshare returns that person's pending follow-ups to the owner; activities shared/
  unshared. org_people(org) = active teammates' names. log_call on a SHARED lead: only the caller's
  pending follow-ups close and the new one is the caller's (each keeps their own next call); sharers'
  reminder purpose unchanged. after_lead_update moves only the old owner's follow-ups. search_leads,
  my_focus_list, app Repo.leads (or assigned_to / shared_with cs) and LocalLeads include shared leads.
  App lead page LeadShareCard (ui/ShareCard.kt); dashboard LeadDrawer components/LeadShares.tsx.
  LeadIndex cursor v7 (Lead.shared_with, response_sec).
- Speed to lead: leads.response_sec = work_seconds(org, lead_start_at, first_dialled_at) set by trigger
  when first_dialled_at is first set (backfilled). lead_start_at = assigned_at if after arrival and
  before the first call, else created_at. work_seconds counts only working time: settings.work_days
  (holidays skipped) × settings.response.start_hour–end_hour (default 9–21), company tz. lead_is_live
  = not source 'Phone call' and < 5 leads with the same created_at (bulk imports share one timestamp).
  response_report(org, from, to): target (settings.response.target_min, default 15), median/avg,
  within target, buckets 5/15/60/240/more/waiting, per person, per day, waiting_list, slowest.
  my_focus_list bucket 3 = new live lead (< 24 h, never called), longest waiting first, reason
  "🆕 New lead · waiting N min" (buckets after it shifted +1; LocalLeads.focus mirrors).
- Dashboard Reports → "Response time" tab (components/ResponseTime.tsx: target + working hours editor,
  tiles, buckets, waiting now, by person, day by day, slowest). LeadDrawer "⚡ First call N working
  min after it came in". App Home ResponseLine (vm.response = last 7 days; red when leads are waiting,
  tap → focus list) + lead page response line.
