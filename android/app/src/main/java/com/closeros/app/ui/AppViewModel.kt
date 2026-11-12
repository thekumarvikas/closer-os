package com.closeros.app.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.closeros.app.calls.CallSync
import com.closeros.app.calls.FollowUpAlarms
import com.closeros.app.calls.LogCall
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.calls.Sim
import com.closeros.app.data.Backend
import com.closeros.app.data.BatchRow
import com.closeros.app.data.BatchSummary
import com.closeros.app.data.Category
import com.closeros.app.data.FollowUp
import com.closeros.app.data.Lead
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Membership
import com.closeros.app.data.Outcome
import com.closeros.app.data.Profile
import com.closeros.app.data.Repo
import com.closeros.app.data.TodayStats
import com.closeros.app.data.Template
import io.github.jan.supabase.auth.status.SessionStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.UUID

enum class Tab { Home, Leads, Calls, FollowUps, Profile }

data class HistoryItem(val log: LogCall, val phone: String, val lead: Lead?)

/** +91 98765 43210 / 098765… / 98765… → +919876543210 (same rule as the server). */
fun normalizePhone(raw: String, prefix: String = "+91"): String {
    val d = raw.filter { it.isDigit() }
    val p = prefix.filter { it.isDigit() }
    return when {
        raw.trim().startsWith("+") -> "+$d"
        d.startsWith("00") -> "+" + d.drop(2)
        d.length == 11 && d.startsWith("0") -> "+$p" + d.drop(1)
        d.length == 10 -> "+$p$d"
        else -> "+$d"
    }
}

open class AppViewModel(app: Application) : AndroidViewModel(app) {
    /** True in the after-call pop-up: only what the outcome form needs is loaded. */
    open val lite: Boolean get() = false

    private val ctx get() = getApplication<Application>()
    val store = LocalStore(app)

    var status by mutableStateOf<SessionStatus>(SessionStatus.Initializing)
    var membership by mutableStateOf<Membership?>(null)
    var profile by mutableStateOf<Profile?>(null)
    var loadingOrg by mutableStateOf(true)
    var outcomes by mutableStateOf<List<Outcome>>(emptyList())
    var stats by mutableStateOf(TodayStats())
    var followUps by mutableStateOf<List<FollowUp>>(emptyList())
    var pastFollowUps by mutableStateOf<List<FollowUp>>(emptyList())
    var progress by mutableStateOf<com.closeros.app.data.Progress?>(null)
    val leads = mutableStateListOf<Lead>()
    var leadsQuery by mutableStateOf("")
    var leadsEnd by mutableStateOf(false)
    var leadFilters by mutableStateOf(com.closeros.app.data.LeadFilters())
    var filterOptions by mutableStateOf<com.closeros.app.data.FilterOptions?>(null)
    var selectMode by mutableStateOf(false)
    val selected = androidx.compose.runtime.mutableStateMapOf<String, Lead>()
    fun loadFilterOptions() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.filterOptions(m.org_id) }.onSuccess { filterOptions = it }
    }
    fun applyFilters(f: com.closeros.app.data.LeadFilters) { leadFilters = f; reloadLeads() }
    fun toggleSelect(l: Lead) { if (selected.containsKey(l.id)) selected.remove(l.id) else selected[l.id] = l }
    fun callSelected() {
        val list = selected.values.toList(); selected.clear(); selectMode = false
        startQueue(list)
    }
    var leadsLoading by mutableStateOf(false)
    var tab by mutableStateOf(runCatching { Tab.valueOf(LocalStore(app).startTab) }.getOrDefault(Tab.Home))
    var openLeadId by mutableStateOf<String?>(null)
    var message by mutableStateOf<String?>(null)
    /** Bumped when phone setup changed outside the setup screen (e.g. the recordings folder was saved). */
    var setupTick by mutableStateOf(0)
    fun onRecordingsFolderPicked(uri: android.net.Uri?) = viewModelScope.launch {
        if (uri != null) message = "Checking the folder…"
        message = com.closeros.app.calls.PhoneSetup.saveRecordingsFolder(ctx, uri)
        setupTick++
        if (uri != null) com.closeros.app.calls.CallSync.syncNow(ctx)   // look for recordings straight away
    }

    /** The call waiting for its outcome, and what the call log says about it. */
    var needsSetup by mutableStateOf(!store.setupDone)
    var callRequest by mutableStateOf<Lead?>(null)
    var showSetup by mutableStateOf(false)
    /** True while the app is on screen. */
    var foreground = false
    /** False while the phone has no internet (the app keeps working from its own copy). */
    var online by mutableStateOf(com.closeros.app.data.Net.isOnline)
    var leaderboard by mutableStateOf<List<com.closeros.app.data.BoardRow>>(emptyList())
    var showLeaderboard by mutableStateOf(false)
    var showDialer by mutableStateOf(false)
    var showReports by mutableStateOf(false)
    var access by mutableStateOf<com.closeros.app.data.OrgAccess?>(null)
    var showFeedback by mutableStateOf(false)

    // ── Hourly check-in card ──
    var checkIn by mutableStateOf<com.closeros.app.calls.CheckIn.Summary?>(null)
    private var checkInSeenSlot = 0L
    /** From the notification: the check-in it showed (or a fresh one). */
    fun openCheckIn() = viewModelScope.launch {
        checkIn = com.closeros.app.calls.CheckIn.pending(ctx) ?: kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.closeros.app.calls.CheckIn.compute(ctx) }
    }
    /** Back in the app with an unacknowledged check-in from the last 2 hours: show it once. */
    fun maybeShowCheckIn() {
        val p = com.closeros.app.calls.CheckIn.pending(ctx) ?: return
        if (p.slotMs != checkInSeenSlot && System.currentTimeMillis() - p.slotMs < 2 * 3_600_000L) { checkInSeenSlot = p.slotMs; checkIn = p }
    }
    /** "Got it — start calling": acknowledge, then go straight to the right list. */
    fun checkInGo() = viewModelScope.launch {
        val s = checkIn ?: com.closeros.app.calls.CheckIn.pending(ctx)
        com.closeros.app.calls.CheckIn.acknowledge(ctx); checkIn = null
        val a = s?.action ?: "focus"
        val m = membership ?: return@launch
        when {
            a.startsWith("reminder:") -> { loadBatches(quiet = true).join(); batches?.firstOrNull { it.id == a.removePrefix("reminder:") }?.let { openBatchList(it, "reminder") } ?: openFocusList() }
            a == "followups" -> { tab = Tab.FollowUps }
            a == "hot" -> genericList = "🔥 Hot leads" to kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                com.closeros.app.data.LocalLeads.focus(ctx, outcomes, m.organization.timezone).filter { it.score >= 40 || it.batch_leads.any { b -> (b.watch_minutes ?: 0) >= 60 } } }
            else -> openFocusList()
        }
    }
    fun checkInLater() { checkIn = null }
    var reviews by mutableStateOf<List<com.closeros.app.data.CallReview>>(emptyList())
    fun loadReviews() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.myReviews(m.org_id) }.onSuccess { reviews = it }
    }
    fun markReview(r: com.closeros.app.data.CallReview, taskDone: Boolean) = viewModelScope.launch {
        runCatching { Repo.markReview(r.id, taskDone) }.onSuccess { loadReviews() }.onFailure { if (taskDone) message = "No internet — try again" }
    }
    var announcements by mutableStateOf<List<com.closeros.app.data.Announcement>>(emptyList())
    fun checkAlerts() = viewModelScope.launch {
        val m = membership ?: return@launch
        announcements = com.closeros.app.calls.TeamAlerts.check(ctx, m.org_id)
    }
    fun acknowledge(a: com.closeros.app.data.Announcement, ack: Boolean) = viewModelScope.launch {
        runCatching { Repo.markAnnouncement(a.id, ack) }
            .onSuccess { if (ack) { com.closeros.app.calls.TeamAlerts.clearAnnouncement(ctx, a.id); announcements = announcements.filter { it.id != a.id } } }
            .onFailure { if (ack) message = "No internet — couldn't acknowledge yet" }
    }
    var showPlaybook by mutableStateOf(false)
    /** The lead the playbook was opened for (fills {{leadName}} etc.). */
    var playbookLead by mutableStateOf<Lead?>(null)
    var playbook by mutableStateOf<List<com.closeros.app.data.PlaybookItem>?>(null)
    fun openPlaybook(lead: Lead?) { playbookLead = lead; showPlaybook = true; loadPlaybook() }
    fun loadPlaybook() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.playbook(m.org_id) }.onSuccess { playbook = it }.onFailure { if (playbook == null) playbook = emptyList(); message = "Couldn't load the playbook" }
    }
    var history by mutableStateOf<List<HistoryItem>?>(null)
    var historyLimit by mutableStateOf(300)
    var historyHasMore by mutableStateOf(false)
    var templates by mutableStateOf<List<Template>>(emptyList())

    /** Today's calls from the phone's call log (instant, works offline), with lead names. */
    var today by mutableStateOf<List<HistoryItem>>(emptyList())
    var todayFilter by mutableStateOf<String?>(null)

    // ───────────── Webinar / event lists ─────────────
    var categories by mutableStateOf<List<Category>>(emptyList())
    var showBatches by mutableStateOf(false)
    var batches by mutableStateOf<List<BatchSummary>?>(null)
    var openList by mutableStateOf<Pair<BatchSummary, String>?>(null)   // batch + "reminder" | "sales"
    var listRows by mutableStateOf<List<BatchRow>?>(null)
    var listEveryone by mutableStateOf(false)
    /** Profession group of leads in the open list, so the outcome screen can show it. */
    private var rowCategory: Map<String, String?> = emptyMap()

    val isManager get() = membership?.role in setOf("owner", "admin", "manager")
    /** Individual (Play Store) app or a one-person account: no team features. */
    val isSolo get() = com.closeros.app.BuildConfig.SOLO || membership?.organization?.is_individual == true

    // ───── Individual app: "watch a short ad to unlock" ─────
    /** Feature waiting for the rep's choice (ad / remove ads / not now) and what to do once open. */
    var gate by mutableStateOf<Pair<com.closeros.app.data.Feature, () -> Unit>?>(null)
    var showRemoveAds by mutableStateOf(false)
    fun require(f: com.closeros.app.data.Feature, then: () -> Unit) {
        val U = com.closeros.app.data.Unlocks
        if (U.open(ctx, f)) { then(); return }
        if (U.takeFreeToday(ctx)) { U.grant(ctx, f); message = "Today's first unlock is free 🎁"; then(); return }
        // No internet (no ad possible) or an ad was asked less than 10 minutes ago: just open it.
        if (!com.closeros.app.data.Net.isOnline || U.askedRecently(ctx)) { U.grant(ctx, f); then(); return }
        gate = f to then
    }
    /** The ad was watched (or none was available): open the feature. */
    fun gateGranted() {
        val (f, then) = gate ?: return
        gate = null
        com.closeros.app.data.Unlocks.markAsked(ctx); com.closeros.app.data.Unlocks.grant(ctx, f); then()
    }

    fun loadBatches(quiet: Boolean = false) = viewModelScope.launch {
        val m = membership ?: return@launch
        batches = runCatching { Repo.myBatches(m.org_id).also { save("batches", it) } }
            .getOrElse { e -> cached<List<BatchSummary>>("batches") ?: run { if (!quiet) message = "Couldn't load webinars: ${e.message}"; emptyList() } }
    }

    fun openBatchList(b: BatchSummary, purpose: String) { openList = b to purpose; loadList() }

    fun loadList() = viewModelScope.launch {
        val (b, purpose) = openList ?: return@launch
        listRows = null
        val key = "bl_${b.id}_${purpose}_${listEveryone && isManager}"
        runCatching { Repo.batchCallList(b.id, purpose, listEveryone && isManager).also { save(key, it) } }
            .recoverCatching { e -> cached<com.closeros.app.data.BatchList>(key)?.also { message = "No internet — showing the list saved on this phone" } ?: throw e }
            .onSuccess { r -> listRows = r.leads; rowCategory = r.leads.associate { it.id to it.category_id } }
            .onFailure { message = "Couldn't load the list: ${it.message}"; listRows = emptyList() }
    }

    /** Call the filtered, sorted list one after another; every call is tagged with this webinar. */
    fun waList(rows: List<BatchRow>) {
        val (b, _) = openList ?: return
        waChooseFor = rows.map { it.toLead(b.name, b.webinar_at) }
    }

    fun callList(rows: List<BatchRow>) {
        val (b, purpose) = openList ?: return
        startQueue(rows.map { it.toLead(b.name, b.webinar_at) }, purpose, b.id)
    }

    /** Call one lead from a webinar list (tagged with the webinar). */
    fun callFromList(row: BatchRow) {
        val (b, purpose) = openList ?: return
        if (pending != null) { message = "Save the outcome of your last call first"; return }
        callContext = purpose to b.id
        callRequest = row.toLead(b.name, b.webinar_at)
    }

    private var callContext: Pair<String, String?>? = null
    private var queuePurpose = "sales"
    private var queueBatchId: String? = null

    // ───────────── Calling queue ─────────────
    var queue by mutableStateOf<List<Lead>>(emptyList())
    var queuePos by mutableStateOf(0)
    var queueActive by mutableStateOf(false)
    var queuePaused by mutableStateOf(false)
    var countdown by mutableStateOf<Int?>(null)
    var queueDone by mutableStateOf(0)

    var pending by mutableStateOf(store.pendingCall)
    var pendingLog by mutableStateOf<LogCall?>(null)

    private var page = 0
    private var searchJob: Job? = null


    private fun isRep() = membership?.role == "rep"

    // ── Saved copies on the phone: screens show these instantly, then refresh from the internet ──
    private val cache = com.closeros.app.data.LocalDb.get(ctx)
    private inline fun <reified T> cached(key: String): T? =
        cache.get(key)?.let { runCatching { com.closeros.app.data.json.decodeFromString<T>(it) }.getOrNull() }
    private inline fun <reified T> save(key: String, value: T) {
        runCatching { cache.put(key, com.closeros.app.data.json.encodeToString(kotlinx.serialization.serializer<T>(), value)) }
    }
    /** When Home was last refreshed from the internet (to avoid reloading on every return to the app). */
    private var lastRefreshMs = 0L

    fun loadOrg() = viewModelScope.launch {
        // Show what we saved last time straight away (works with no internet).
        if (membership == null) cached<Membership>("membership")?.let { m ->
            membership = m; profile = cached("profile"); outcomes = cached("outcomes") ?: emptyList()
            categories = cached("categories") ?: emptyList(); templates = cached("templates") ?: emptyList()
            followUps = cached("followUps") ?: emptyList(); stats = cached("stats") ?: TodayStats()
            cached<List<Lead>>("leads0")?.let { if (leads.isEmpty()) leads.addAll(it) }
        }
        loadingOrg = membership == null
        runCatching {
            membership = Repo.membership()
            // Individual app: the first sign-in creates the person's own free account (their country, currency, time zone).
            if (membership == null && com.closeros.app.BuildConfig.SOLO) {
                val c = com.closeros.app.data.Country.detect(ctx)
                val name = runCatching { Repo.profile()?.full_name }.getOrNull().orEmpty()
                Repo.createIndividualAccount(name, c.code, c.prefix, c.currency, c.timezone)
                membership = Repo.membership()
            }
            save("membership", membership)
            membership?.let { store.trackWhatsapp = it.organization.trackWhatsapp }
            profile = Repo.profile().also { save("profile", it) }
            membership?.let { m ->
                store.orgId = m.org_id
                outcomes = Repo.outcomes(m.org_id).also { save("outcomes", it) }
                runCatching { categories = Repo.categories(m.org_id).also { save("categories", it) } }
                runCatching { templates = Repo.templates(m.org_id).also { save("templates", it) } }
                if (!lite) { refreshHome(); reloadLeads(); CallSync.schedule(ctx); CallSync.syncNow(ctx); com.closeros.app.calls.CheckIn.schedule(ctx) }
            }
        }.onFailure {
            if (membership == null) { message = "Couldn't load your company: ${it.message}"; com.closeros.app.data.AppLog.error(ctx, "load company", it) }
            else if (com.closeros.app.data.Net.isOnline) message = "Couldn't refresh — showing saved data"
        }
        launch { com.closeros.app.data.AppLog.flush(ctx) }
        loadingOrg = false
    }

    fun refreshHome() = viewModelScope.launch {
        val m = membership ?: return@launch
        lastRefreshMs = System.currentTimeMillis()
        // Load everything Home needs at the same time (faster than one after another).
        kotlinx.coroutines.coroutineScope {
            launch { runCatching { stats = Repo.todayStats(m.organization).also { save("stats", it) } } }
            launch { runCatching { followUps = Repo.followUps(m.org_id).also { save("followUps", it) }; FollowUpAlarms.scheduleAll(ctx, followUps) } }
            launch { runCatching { pastFollowUps = Repo.pastFollowUps(m.org_id) } }
            launch { runCatching { val d = java.time.LocalDate.now(java.time.ZoneId.of(m.organization.timezone)); progress = mine(Repo.myProgressToday(m.organization), d, d)
                progress?.daily?.let { save("my_daily_targets", it) } } }   // the hourly check-in uses today's targets (also offline)
            launch { runCatching { access = Repo.orgAccess(m.org_id) } }
            launch { runCatching { leaderboard = Repo.leaderboard(m.organization, "today") } }
            launch { runCatching { val d = java.time.LocalDate.now(java.time.ZoneId.of(m.organization.timezone)); response = Repo.responseReport(m.org_id, d.minusDays(6), d) } }
        }
        loadReviews()
        checkAlerts()
        loadToday()
        loadBatches(quiet = true)
        loadRound9()
    }

    fun loadToday() = viewModelScope.launch {
        val m = membership ?: return@launch
        val start = java.time.LocalDate.now(java.time.ZoneId.of(m.organization.timezone)).atStartOfDay(java.time.ZoneId.of(m.organization.timezone)).toInstant().toEpochMilli()
        val logs = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { PhoneCalls.readAll(ctx, start).reversed() }
        val phones = logs.map { normalizePhone(it.phone, prefix) }
        val byPhone = runCatching { Repo.leadsByPhones(m.org_id, phones) }.getOrDefault(emptyMap())
        today = logs.mapIndexed { i, l -> HistoryItem(l, phones[i], byPhone[phones[i]]) }
    }

    /** Queue of leads whose follow-ups are due within 24 hours (overdue first). */
    fun startFollowUpQueue() = viewModelScope.launch {
        val soon = System.currentTimeMillis() + 86_400_000
        val due = followUps.filter { runCatching { com.closeros.app.data.parseInstant(it.due_at).toEpochMilli() }.getOrDefault(0) < soon }.sortedBy { it.due_at }
        val leads = runCatching { Repo.leadsByIds(due.map { it.lead_id }) }.getOrDefault(emptyList()).associateBy { it.id }
        startQueue(due.mapNotNull { leads[it.lead_id] })
    }

    /** Starts calling the given leads one after another. */
    /** purpose "auto" = each lead's own (reminder before its webinar, else sales) — see CallPurpose. */
    fun startQueue(leads: List<Lead>, purpose: String = "auto", batchId: String? = null) {
        queuePurpose = purpose; queueBatchId = batchId
        var list = leads.filter { !it.do_not_call }.distinctBy { it.id }
        // Settings → "Best time to call first": after due follow-ups, leads whose best pick-up hour is now go next.
        if (store.queueBestTimeFirst) {
            val now = java.time.Instant.now(); val hour = java.time.LocalTime.now().hour
            fun due(l: Lead) = l.next_follow_up_at?.let { runCatching { com.closeros.app.data.parseInstant(it) }.getOrNull() }?.isBefore(now.plusSeconds(7200)) == true
            list = list.sortedBy { if (due(it)) 0 else if (it.best_hour == hour) 1 else 2 }
        }
        if (list.isEmpty()) { message = "No leads to call"; return }
        queue = list; queuePos = 0; queueDone = 0; queueActive = true; queuePaused = false; countdown = null
        todayFilter = null; openLeadId = null
        dialQueued(list.first())
    }

    /** Next call of the queue; in the individual app every 25 calls ask for a short ad first. */
    private fun dialQueued(l: Lead) {
        val q = com.closeros.app.data.Feature.QUEUE
        if (com.closeros.app.data.Unlocks.open(ctx, q)) { com.closeros.app.data.Unlocks.use(ctx, q); callRequest = l; return }
        queuePaused = true; countdown = null
        require(q) { queuePaused = false; com.closeros.app.data.Unlocks.use(ctx, q); callRequest = l }
    }

    /** After an outcome is saved: count down, then call the next lead (unless paused). */
    private fun queueAfterOutcome() {
        if (!queueActive) return
        queueDone++
        queuePos++
        if (queuePos >= queue.size) { queueActive = false; message = "Queue finished — $queueDone calls"; return }
        countdown = if (queuePaused) null else store.countdownSec
    }

    fun queueTick() {
        val c = countdown ?: return
        if (queuePaused) { countdown = null; return }
        // Never dial the next lead while the rep isn't looking at Closer OS or is still filling the after-call card.
        if (!foreground || com.closeros.app.calls.AfterCall.Overlay.isShowing || AfterCallActivity.open) {
            countdown = null; queuePaused = true; return
        }
        if (c <= 1) { countdown = null; queue.getOrNull(queuePos)?.let { dialQueued(it) } } else countdown = c - 1
    }

    fun queueCallNow() { countdown = null; queue.getOrNull(queuePos)?.let { dialQueued(it) } }
    fun queueSkip() {
        countdown = null; queuePos++
        if (queuePos >= queue.size) { queueActive = false; message = "Queue finished" } else if (!queuePaused) countdown = store.countdownSec
    }
    fun queuePause() { queuePaused = true; countdown = null }
    fun queueResume() { queuePaused = false; countdown = store.countdownSec }
    fun queueStop() { queueActive = false; countdown = null; queue = emptyList() }

    /** "Check now" in Profile: upload recordings straight away and show what happened. */
    fun checkRecordingsNow() = viewModelScope.launch {
        val m = membership ?: return@launch
        message = "Checking recordings…"
        val r = CallSync.checkRecordings(ctx, m.org_id)
        message = r.error?.let { "Recordings: $it" } ?: "Recordings: ${r.uploaded} uploaded (${r.matched} of ${r.callsChecked} calls matched)"
    }

    fun saveMyTemplate(name: String, body: String) = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.saveMyTemplate(m.org_id, name.ifBlank { "My message" }, body) }
            .onSuccess { templates = Repo.templates(m.org_id); message = "Saved to My messages" }
            .onFailure { message = "Couldn't save the message" }
    }

    fun deleteMyTemplate(id: String) = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.deleteTemplate(id) }; runCatching { templates = Repo.templates(m.org_id) }
    }

    /** Fills a WhatsApp template for one lead. */
    fun fillTemplate(body: String, lead: Lead): String =
        fillTemplateText(body, lead, membership?.organization?.name.orEmpty(), membership?.organization?.timezone ?: "Asia/Kolkata", profile?.full_name.orEmpty())


    private val prefix get() = membership?.organization?.phone_prefix ?: "+91"

    /** Phone call history, with lead names where the number is a lead. */
    fun loadHistory() = viewModelScope.launch {
        val m = membership ?: return@launch
        searchPool = null
        val all = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { PhoneCalls.history(ctx, historyLimit + 1) }
        historyHasMore = all.size > historyLimit
        val logs = all.take(historyLimit)
        val phones = logs.map { normalizePhone(it.phone, prefix) }
        // Instantly from the phone's own copy of the leads, then confirmed by the server.
        val local = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { phones.distinct().mapNotNull { p -> com.closeros.app.data.LeadIndex.find(ctx, p)?.let { p to it } }.toMap() }
        history = logs.mapIndexed { i, l -> HistoryItem(l, phones[i], local[phones[i]]) }
        loadRecordings(logs.filter { it.durationSec > 0 }.map { it.id })
        runCatching { Repo.leadsByPhones(m.org_id, phones) }.onSuccess { server ->
            com.closeros.app.data.LeadIndex.remember(ctx, server.values)
            history = logs.mapIndexed { i, l -> HistoryItem(l, phones[i], server[phones[i]]) }
        }
    }

    /** Calls search: the phone's last 3,000 calls, matched on number, saved name, the lead's details
     *  (company, profession, city, source, key facts, tags, own fields), notes (server search), the lead's
     *  last outcome and the outcome saved for that call — e.g. "interested" lists every such call. */
    private var searchPool: List<HistoryItem>? = null
    suspend fun searchCalls(query: String): List<HistoryItem> {
        val m = membership ?: return emptyList()
        val q = query.trim().lowercase()
        if (q.length < 2) return emptyList()
        val pool = searchPool ?: kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val logs = PhoneCalls.history(ctx, 3000)
            val phones = logs.map { normalizePhone(it.phone, prefix) }
            val local = phones.distinct().mapNotNull { p -> com.closeros.app.data.LeadIndex.find(ctx, p)?.let { p to it } }.toMap()
            logs.mapIndexed { i, l -> HistoryItem(l, phones[i], local[phones[i]]) }
        }.also { searchPool = it }
        val digits = q.filter { it.isDigit() }
        val label = outcomes.associate { it.id to it.label.lowercase() }
        val ofCall = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.closeros.app.data.LocalReports.outcomeOfCalls(ctx) }
        val ids = runCatching { Repo.searchLeadIds(m.org_id, query) }.getOrDefault(emptySet())
        return pool.filter { h ->
            val l = h.lead
            (digits.length >= 3 && h.phone.contains(digits)) ||
                h.log.name?.lowercase()?.contains(q) == true ||
                label[ofCall[h.log.id]]?.contains(q) == true ||
                CallColors.label(h.log.direction, h.log.durationSec).lowercase().contains(q) ||
                (l != null && (l.id in ids || label[l.last_outcome_id]?.contains(q) == true ||
                    listOfNotNull(l.name, l.company, l.profession, l.city, l.state, l.email, l.source, l.campaign, l.key_facts, l.notes,
                        l.tags?.joinToString(" "), l.custom?.toString()).any { it.lowercase().contains(q) }))
        }
    }

    private var addingLead = false
    fun addLeadFromCall(phone: String, name: String, profession: String, notes: String, onDone: () -> Unit) = viewModelScope.launch {
        val m = membership ?: return@launch
        if (addingLead) return@launch   // ignore a quick second tap
        addingLead = true
        if (!com.closeros.app.data.Net.isOnline) {
            com.closeros.app.data.Ops.lead(ctx, m.org_id, name, normalizePhone(phone, prefix), profession.ifBlank { null }, notes.ifBlank { null })
            addingLead = false; message = "No internet — the lead will be added when you're back online"; onDone(); return@launch
        }
        runCatching { Repo.createLead(m.org_id, name, phone, profession, notes) }
            .also { addingLead = false }
            .onSuccess { message = "Lead added"; onDone(); loadHistory(); reloadLeads(); CallSync.syncNow(ctx) }
            .onFailure { message = if (it.message?.contains("leads_org_phone_uq") == true) "This number is already a lead" else "Couldn't add the lead: ${it.message?.take(80)}" }
    }

    /** Calls tab "Select": call or WhatsApp the chosen numbers in a queue. Numbers not in the lead list
     *  are added as leads first (named as saved in the phone's contacts). */
    fun queueFromCalls(items: List<HistoryItem>, whatsapp: Boolean) = viewModelScope.launch {
        val m = membership ?: return@launch
        val picked = items.filter { it.phone.isNotBlank() }.distinctBy { it.phone }
        val known = picked.mapNotNull { it.lead }
        val newOnes = picked.filter { it.lead == null }
        val added = if (newOnes.isEmpty()) emptyList() else if (!com.closeros.app.data.Net.isOnline) {
            message = "No internet — ${newOnes.size} number${if (newOnes.size > 1) "s" else ""} not in your lead list were left out"; emptyList()
        } else {
            newOnes.forEach { h -> runCatching { Repo.createLead(m.org_id, h.log.name.orEmpty(), h.phone, null, null) } }
            runCatching { Repo.leadsByPhones(m.org_id, newOnes.map { it.phone }).values.toList() }.getOrDefault(emptyList())
                .also { if (it.isNotEmpty()) { message = "${it.size} added to your leads"; reloadLeads(); loadHistory() } }
        }
        val list = (known + added).distinctBy { it.id }
        if (list.isEmpty()) { message = "Nothing to ${if (whatsapp) "message" else "call"}"; return@launch }
        if (whatsapp) waChooseFor = list else startQueue(list)
    }

    /** From a notification's Call button. */
    fun callLeadById(id: String, purpose: String? = null) = viewModelScope.launch {
        runCatching { Repo.lead(id) }.getOrNull()?.let { l ->
            if (purpose == "reminder") callContext = "reminder" to com.closeros.app.data.CallPurpose.guess(l, followUps).let { g -> if (g.purpose == "reminder") g.batchId else null }
            callRequest = l } ?: run { message = "Lead not found" }
    }

    fun saveSetup(myPhone: String, sims: Map<Int, String>, onError: (String) -> Unit) = viewModelScope.launch {
        val m = membership ?: return@launch
        val ok = runCatching { if (myPhone.isNotBlank()) Repo.setMyPhone(m.org_id, myPhone) }.isSuccess
        if (!ok) { onError("Couldn't save your number. Check your internet."); return@launch }
        sims.forEach { (slot, n) -> if (n.isNotBlank()) store.setSimNumber(slot, normalizePhone(n, prefix)) }
        store.setupDone = true; needsSetup = false
        profile = runCatching { Repo.profile() }.getOrNull() ?: profile
        CallSync.syncNow(ctx)
    }

    private var leadsGen = 0
    fun reloadLeads() { leadsGen++; page = 0; leadsEnd = false; leadsLoading = false; loadMoreLeads() }

    fun loadMoreLeads() {
        val m = membership ?: return
        if (leadsLoading || leadsEnd) return
        leadsLoading = true
        val gen = leadsGen
        viewModelScope.launch {
            val first = page == 0
            runCatching { Repo.leads(m.org_id, leadsQuery, page, mineOnly = isRep(), f = leadFilters) }
                .onSuccess {
                    if (gen != leadsGen) return@onSuccess   // an older search finished late: ignore it
                    if (first) leads.clear()   // replaces the saved copy shown meanwhile
                    com.closeros.app.data.LeadIndex.remember(ctx, it)
                    val have = leads.mapTo(HashSet()) { l -> l.id }; leads.addAll(it.filter { l -> l.id !in have }); if (it.size < 50) leadsEnd = true; page++
                    if (first && leadsQuery.isBlank() && leadFilters.count == 0) save("leads0", it)
                }
                .onFailure { if (leads.isEmpty()) message = "Couldn't load leads. Check your internet." }
            if (gen == leadsGen) leadsLoading = false
        }
    }

    fun search(q: String) {
        leadsQuery = q
        searchJob?.cancel()
        searchJob = viewModelScope.launch { delay(350); reloadLeads() }
    }

    /** Individual app: create a login. onDone(null) = signed in; otherwise a message to show. */
    fun signUp(name: String, email: String, password: String, onDone: (String?) -> Unit) = viewModelScope.launch {
        runCatching { Repo.signUp(name, email, password) }.onSuccess { signedIn ->
            if (signedIn) { com.closeros.app.calls.DeviceGuard.claim(ctx); onDone(null) }
            else onDone("✉ Almost done — open the email we sent to $email, tap the link, then sign in here.")
        }.onFailure {
            val m = it.message.orEmpty()
            onDone(when {
                m.contains("already", true) -> "This email already has an account — sign in instead."
                m.contains("password", true) -> "Choose a password with at least 6 characters."
                m.contains("email", true) && m.contains("invalid", true) -> "Check the email address."
                else -> "Couldn't create the account. Check your internet."
            })
        }
    }

    /** Settings → Delete my account: removes the account, its leads, calls and notes, then signs out. */
    fun deleteAccount(onError: (String) -> Unit) = viewModelScope.launch {
        runCatching { Repo.deleteMyAccount() }.onSuccess {
            runCatching { Backend.auth.signOut(io.github.jan.supabase.auth.SignOutScope.LOCAL) }
            FollowUpAlarms.scheduleAll(ctx, emptyList()); store.clear(); cache.clearCache(); leads.clear(); pending = null; needsSetup = true
            membership = null; message = "Your account and all its data were deleted"
        }.onFailure { onError(it.message?.substringAfter("ERROR:")?.substringBefore("\n")?.substringAfter(":")?.trim()?.take(160) ?: "Couldn't delete — check your internet") }
    }

    fun signInWithGoogle(activity: android.app.Activity, onError: (String) -> Unit) = viewModelScope.launch {
        runCatching { Repo.signInWithGoogle(activity) }.onSuccess { com.closeros.app.calls.DeviceGuard.claim(ctx) }.onFailure {
            if (it is androidx.credentials.exceptions.GetCredentialCancellationException) return@onFailure onError("")
            com.closeros.app.data.AppLog.error(ctx, "google sign-in", it)
            onError(if (it is androidx.credentials.exceptions.NoCredentialException) "No Google account found on this phone — add one in Settings → Accounts"
                    else "Couldn't sign in with Google. Check your internet and try again.")
        }
    }

    fun resetPassword(email: String) = viewModelScope.launch {
        runCatching { Backend.auth.resetPasswordForEmail(email.trim()) }
            .onSuccess { message = "Email sent — open the link to choose a new password" }
            .onFailure { message = "Couldn't send the email. Check the address and your internet." }
    }

    fun signIn(email: String, password: String, onError: (String) -> Unit) = viewModelScope.launch {
        runCatching { Repo.signIn(email, password) }.onSuccess { com.closeros.app.calls.DeviceGuard.claim(ctx) }.onFailure {
            onError(if (it.message?.contains("Invalid login", true) == true) "Wrong email or password"
                    else if (it.message?.contains("not confirmed", true) == true) "Please confirm your email first (check your inbox)"
                    else "Couldn't sign in. Check your internet.")
        }
    }

    // ───────────── Round 9: lists, WhatsApp queue, focus, month targets, recordings ─────────────
    /** A list of leads opened from a report number or "Today's focus" (title + leads). */
    var genericList by mutableStateOf<Pair<String, List<Lead>>?>(null)
    var showWaToday by mutableStateOf(false)
    var showLeadWork by mutableStateOf(false)
    var showRecipe by mutableStateOf(false)
    /** WhatsApp messages I sent from the app today. */
    var waToday by mutableStateOf<List<kotlinx.serialization.json.JsonObject>>(emptyList())
    var focusTotal by mutableStateOf(0)
    var focusDone by mutableStateOf(0)
    /** This month: whole-month target and target/actual up to today (talk time "on pace"). */
    var monthFull by mutableStateOf<com.closeros.app.data.Progress?>(null)
    var monthToDate by mutableStateOf<com.closeros.app.data.Progress?>(null)
    /** My usual effort per sale (for the effort bar on leads). */
    var recipe by mutableStateOf<kotlinx.serialization.json.JsonObject?>(null)
    /** call id → recording path for the calls shown in the Calls tab. */
    var recordingPaths by mutableStateOf<Map<String, String>>(emptyMap())

    /** Manager's targets with my own actual numbers counted on the phone. */
    private suspend fun mine(p: com.closeros.app.data.Progress?, from: java.time.LocalDate, to: java.time.LocalDate) =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val zone = runCatching { java.time.ZoneId.of(membership?.organization?.timezone ?: "Asia/Kolkata") }.getOrDefault(java.time.ZoneId.systemDefault())
            runCatching { com.closeros.app.data.LocalReports.withMyActuals(ctx, p, from, to, zone, outcomes) }.getOrDefault(p)
        }

    fun loadRound9() = viewModelScope.launch {
        val m = membership ?: return@launch
        val zone = runCatching { java.time.ZoneId.of(m.organization.timezone) }.getOrDefault(java.time.ZoneId.systemDefault())
        val today = java.time.LocalDate.now(zone)
        kotlinx.coroutines.coroutineScope {
            launch { runCatching { waToday = Repo.myWaToday(m.org_id).let { it as kotlinx.serialization.json.JsonArray }.map { it as kotlinx.serialization.json.JsonObject } } }
            launch { runCatching { val f = Repo.focusList(m.org_id, 1, 0) as kotlinx.serialization.json.JsonObject
                focusTotal = f["total"]?.toString()?.toIntOrNull() ?: 0; focusDone = f["done_today"]?.toString()?.toIntOrNull() ?: 0 } }
            // Targets come from the manager; MY numbers are worked out on this phone (offline too, up to the minute).
            launch { runCatching { monthFull = mine(Repo.myProgress(m.organization, today.withDayOfMonth(1), today.withDayOfMonth(today.lengthOfMonth())), today.withDayOfMonth(1), today) } }
            launch { runCatching { monthToDate = mine(Repo.myProgress(m.organization, today.withDayOfMonth(1), today), today.withDayOfMonth(1), today) } }
            launch { runCatching { recipe = (Repo.salesRecipe(m.org_id, listOfNotNull(Backend.uid), null, null) as kotlinx.serialization.json.JsonObject).let { r ->
                (r["mine"] as? kotlinx.serialization.json.JsonObject) ?: (r["team"] as? kotlinx.serialization.json.JsonObject) } } }
        }
    }

    fun loadRecordings(ids: List<String>) = viewModelScope.launch {
        // Recordings found on this phone (the individual app only has these) + those uploaded to Closer OS.
        val local = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.closeros.app.calls.LocalRecordings.known(ctx) }
        val onPhone = ids.filter { it in local }.associateWith { "phone:$it" }
        recordingPaths = onPhone
        if (!com.closeros.app.BuildConfig.SOLO) runCatching { recordingPaths = onPhone + Repo.recordingPaths(ids.take(500)) }
    }

    /** Today's focus: every lead needing attention today, most important first, as a calling queue. */
    fun startFocusQueue() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.focusList(m.org_id, 1000, 0) as kotlinx.serialization.json.JsonObject }
            .onSuccess { f -> val rows = (f["rows"] as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { runCatching { com.closeros.app.data.json.decodeFromJsonElement(Lead.serializer(), it) }.getOrNull() }
                if (rows.isEmpty()) message = "Nothing left in today's focus 👍" else startQueue(rows) }
            .onFailure { offlineFocus()?.let { rows -> if (rows.isEmpty()) message = "Nothing left in today's focus 👍" else startQueue(rows) } ?: run { message = "Couldn't load today's focus" } }
    }

    /** Today's focus from the phone's copy of the leads (no internet). */
    private suspend fun offlineFocus(): List<Lead>? {
        val m = membership ?: return null
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching { com.closeros.app.data.LocalLeads.focus(ctx, outcomes, m.organization.timezone) }.getOrNull()
        }
    }

    fun openFocusList() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.focusList(m.org_id, 1000, 0) as kotlinx.serialization.json.JsonObject }
            .onSuccess { f -> genericList = "Today's focus" to (f["rows"] as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { runCatching { com.closeros.app.data.json.decodeFromJsonElement(Lead.serializer(), it) }.getOrNull() } }
            .onFailure { offlineFocus()?.let { genericList = "Today's focus (saved on phone)" to it } ?: run { message = "Couldn't load the list" } }
    }

    // WhatsApp queue: one message to many leads. The rep taps Send in WhatsApp; Closer OS marks it and opens the next.
    var waQueue by mutableStateOf<List<Lead>>(emptyList())
    var waPos by mutableStateOf(0)
    var waTemplate by mutableStateOf<Template?>(null)
    var waActive by mutableStateOf(false)
    var waPaused by mutableStateOf(false)
    var waCountdown by mutableStateOf<Int?>(null)
    var waSent by mutableStateOf(0)
    var waChooseFor by mutableStateOf<List<Lead>?>(null)   // leads waiting for the message choice
    private var waAwaiting = false
    private var waLastId: String? = null
    var waCanUndo by mutableStateOf(false)

    fun startWaQueue(leads: List<Lead>, t: Template) = viewModelScope.launch {
        val m = membership ?: return@launch
        var list = leads.filter { it.phone.isNotBlank() }.distinctBy { it.id }
        val already = runCatching { Repo.waSentToday(m.org_id, t.id, list.map { it.id }) }.getOrDefault(emptySet())
        if (already.isNotEmpty()) { list = list.filter { it.id !in already }; message = "${already.size} already got this message today — skipped" }
        if (list.isEmpty()) { message = "Everyone in this list already got this message today"; return@launch }
        require(com.closeros.app.data.Feature.WA_QUEUE) {
            waQueue = list; waPos = 0; waTemplate = t; waSent = 0; waPaused = false; waCountdown = null; waCanUndo = false; waActive = true
            genericList = null; selectMode = false
        }
    }

    /** Opens WhatsApp for the current lead with the message (and the message's file) ready. */
    fun waOpenCurrent(): kotlinx.coroutines.Job = viewModelScope.launch {
        val l = waQueue.getOrNull(waPos) ?: return@launch
        val t = waTemplate ?: return@launch
        val wq = com.closeros.app.data.Feature.WA_QUEUE
        if (!com.closeros.app.data.Unlocks.open(ctx, wq)) { waPaused = true; waCountdown = null; require(wq) { waPaused = false; waOpenCurrent() }; return@launch }
        com.closeros.app.data.Unlocks.use(ctx, wq)
        val text = fillTemplate(t.body, l)
        waCountdown = null; waAwaiting = true
        val path = t.media_path
        if (path == null) PhoneCalls.whatsapp(ctx, l.phone, text)
        else runCatching {
            val f = Repo.templateMediaFile(ctx, path, t.media_name)
            PhoneCalls.whatsappMedia(ctx, l.phone, androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f), t.media_type ?: "*/*", text)
        }.onFailure { message = "Couldn't get the attachment — sending the text only"; PhoneCalls.whatsapp(ctx, l.phone, text) }
    }

    /** Back from WhatsApp: mark it sent, then count down to the next lead. */
    /** Back from WhatsApp in the queue: ask "Did it go?" — only a confirmed message is counted. */
    var waAskSent by mutableStateOf(false)
    private fun waBackFromWhatsApp() { if (waAwaiting) { waAwaiting = false; waAskSent = true } }

    fun waConfirmSent(sent: Boolean) = viewModelScope.launch {
        waAskSent = false
        if (!sent) { message = "Not counted — tap Send on WhatsApp to try again, or Skip"; return@launch }
        val m = membership ?: return@launch
        val l = waQueue.getOrNull(waPos) ?: return@launch
        waLastId = Repo.logWa(m.org_id, l.id, l.phone, waTemplate?.id, waTemplate?.name, "queue")
        waCanUndo = true; waSent++
        waPos++
        if (waPos >= waQueue.size) { waActive = false; message = "WhatsApp queue finished — $waSent sent"; com.closeros.app.data.AppEvents.bumpLeads(); return@launch }
        if (!waPaused) waCountdown = 3
    }

    fun waUndo() = viewModelScope.launch {
        val id = waLastId ?: return@launch
        runCatching { Repo.undoWa(id) }.onSuccess { waLastId = null; waCanUndo = false; waSent = (waSent - 1).coerceAtLeast(0); waPos = (waPos - 1).coerceAtLeast(0); waCountdown = null; message = "Undone — not counted as sent" }
    }
    fun waSkip() { waCountdown = null; waCanUndo = false; waPos++; if (waPos >= waQueue.size) { waActive = false; message = "WhatsApp queue finished — $waSent sent" } }
    fun waStop() { waActive = false; waCountdown = null; waAwaiting = false; message = "Stopped — $waSent sent"; com.closeros.app.data.AppEvents.bumpLeads() }

    /** A single WhatsApp sent from a lead / call row / pop-up: counted as an interaction. */
    /** A single WhatsApp opened from Closer OS: counted only after the rep confirms it went (back in the app). */
    fun logWaSend(lead: Lead, t: Template?, source: String = "single") {
        store.addWaPending(LocalStore.WaPending(java.util.UUID.randomUUID().toString(), lead.id.ifBlank { null }, lead.phone,
            lead.name, t?.id, t?.name ?: "Own message", source, System.currentTimeMillis()))
    }

    /** Messages waiting for "Did it go?" (shown when the rep is back in Closer OS). */
    var waToConfirm by mutableStateOf<List<LocalStore.WaPending>>(emptyList())
    fun loadWaToConfirm() { waToConfirm = store.waPending }
    fun confirmWa(w: LocalStore.WaPending, sent: Boolean) = viewModelScope.launch {
        store.removeWaPending(w.id); waToConfirm = store.waPending
        if (!sent) return@launch
        val m = membership ?: return@launch
        Repo.logWa(m.org_id, w.leadId, w.phone, w.templateId, w.templateName, w.source)
        com.closeros.app.data.AppEvents.bumpLeads(); loadRound9()
    }

    fun openLeadsById(title: String, ids: List<String>) = viewModelScope.launch {
        runCatching { Repo.leadsByIds(ids) }.onSuccess { genericList = title to it }.onFailure { message = "Couldn't load — check internet" }
    }
    fun openHotList() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.leads(m.org_id, "", 0, isRep(), com.closeros.app.data.LeadFilters(hot = true)) }
            .onSuccess { genericList = "🔥 Close to converting" to it.sortedByDescending { l -> l.score } }
    }

    /** Back closes the screen on top (so Back never leaves the app from an inner screen). Returns false on the main tabs. */
    fun closeTop(): Boolean {
        when {
            showWaToday -> showWaToday = false
            showLeadWork && genericList == null && openLeadId == null -> showLeadWork = false
            showRecipe && genericList == null && openLeadId == null -> showRecipe = false
            showPlaybook -> showPlaybook = false
            checkIn != null -> checkIn = null
            showFeedback -> showFeedback = false
            showDialer -> showDialer = false
            showReports && openLeadId == null && genericList == null && !showLeadWork && !showRecipe -> showReports = false
            showLeaderboard -> showLeaderboard = false
            openLeadId != null -> openLeadId = null
            genericList != null -> genericList = null
            showLeadWork -> showLeadWork = false
            showRecipe -> showRecipe = false
            showReports -> showReports = false
            openList != null -> openList = null
            showBatches -> showBatches = false
            todayFilter != null -> todayFilter = null
            else -> return false
        }
        return true
    }

    /** A lead marked Do not call that the rep tried to call: asks before removing the mark. */
    var dncAsk by mutableStateOf<Lead?>(null)

    /** Sets / removes "Do not call" (audit-logged on the server), updates the lists, then runs [then]. */
    fun setDoNotCall(lead: Lead, value: Boolean, then: (Lead) -> Unit = {}) = viewModelScope.launch {
        runCatching { Repo.setDoNotCall(lead.id, value) }
            .onSuccess {
                val updated = lead.copy(do_not_call = value)
                val i = leads.indexOfFirst { it.id == lead.id }; if (i >= 0) leads[i] = updated
                com.closeros.app.data.LeadIndex.remember(ctx, listOf(updated))
                message = if (value) "Marked Do not call" else "Removed from Do not call"
                then(updated)
            }
            .onFailure { message = "Couldn't change it — check internet" }
    }

    /** Lead to offer a WhatsApp message to, right after its outcome was saved. */
    var whatsappNext by mutableStateOf<Lead?>(null)
    /** Speed to lead, last 7 days (mine; managers: team). */
    var response by mutableStateOf<kotlinx.serialization.json.JsonObject?>(null)

    /** Outcomes still waiting for internet when the rep tried to sign out (asks before they are lost). */
    var signOutWaiting by mutableStateOf<Int?>(null)

    fun signOut(force: Boolean = false) = viewModelScope.launch {
        if (!force && store.outbox.isNotEmpty()) {
            message = "Uploading saved outcomes first…"
            CallSync.run(ctx)
            val left = store.outbox.size
            if (left > 0) { signOutWaiting = left; return@launch }
        }
        signOutWaiting = null
        runCatching { Repo.signOut() }; FollowUpAlarms.scheduleAll(ctx, emptyList()); store.clear(); cache.clearCache(); leads.clear(); pending = null; needsSetup = true }

    // ───────────── Calling ─────────────

    fun sims(): List<Sim> = PhoneCalls.sims(ctx)

    /** Starts a call and remembers it, so the outcome form appears when the rep comes back. */
    fun startCall(lead: Lead, sim: Sim?) {
        if (pending != null) { message = "Save the outcome of your last call first"; return }
        // Tag the call with its webinar when it comes from a webinar list or queue.
        val ctxPair = callContext ?: if (queueActive && queuePurpose != "auto" && queue.any { it.id == lead.id }) queuePurpose to queueBatchId
            else openList?.takeIf { o -> listRows?.any { it.id == lead.id } == true }?.let { (b, purpose) -> purpose to b.id }
        callContext = null
        // Not from a webinar list: reminder if their webinar is within 24 h (or a reminder follow-up is due), else sales.
        val auto = if (ctxPair == null) com.closeros.app.data.CallPurpose.guess(lead, followUps) else null
        val p = LocalStore.PendingCall(lead.id, lead.name, lead.phone, System.currentTimeMillis(),
            ctxPair?.first ?: auto?.purpose ?: "sales", ctxPair?.second ?: auto?.batchId, lead.profession, rowCategory[lead.id], requestId = remoteRequestId)
        remoteRequestId = null; remoteCall = false
        store.pendingCall = p; pending = p; pendingLog = null
        sim?.let { store.preferredSim = it.slot }
        PhoneCalls.call(ctx, lead.phone, sim)
    }

    /** Called when the app comes back to the front: look up the finished call in the call log. */
    fun onResume() {
        viewModelScope.launch { com.closeros.app.calls.DeviceGuard.check(ctx) }   // signed in on another phone? (one login, one phone)
        maybeShowCheckIn()
        loadWaToConfirm()
        if (waActive && waAwaiting) waBackFromWhatsApp()
        // Saved in the after-call pop-up while the app was in the background: move on.
        if (pending != null && store.pendingCall == null) {
            pending = null; pendingLog = null; endedReported = null
            queueAfterOutcome(); refreshHome()
            // Saved in the pop-up: the queue waits for the rep to tap Continue (no surprise dialling).
            if (queueActive) { countdown = null; queuePaused = true }
        }
        val p = pending
        if (p == null) {
            checkUnloggedCalls()
            // Coming back to the app: refresh Home only if it's older than a minute.
            if (System.currentTimeMillis() - lastRefreshMs > 60_000) refreshHome()
            return
        }
        viewModelScope.launch {
            pendingLog = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                if (p.logId != null) PhoneCalls.readLog(ctx, p.startedAtMs - 60_000).firstOrNull { it.id == p.logId }
                else PhoneCalls.findCall(ctx, p.phone, p.startedAtMs)
            }
            reportCallEnded()
            refreshHome()
        }
    }

    private var checking = false
    /**
     * Calls with leads that happened outside Closer OS (incoming calls, or dialled from the phone app):
     * their outcome is mandatory too, so the outcome screen opens for each one, oldest first.
     */
    fun checkUnloggedCalls() = viewModelScope.launch {
        val m = membership ?: return@launch
        if (pending != null || checking) return@launch
        checking = true
        try {
            val now = System.currentTimeMillis()
            if (store.outcomeCheckFromMs == 0L) { store.outcomeCheckFromMs = now; return@launch }   // start from now, never ask about old calls
            val since = maxOf(store.outcomeCheckFromMs, now - 2 * 86_400_000L)
            val logged = store.loggedCalls
            val calls = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { PhoneCalls.readLog(ctx, since) }.filter {
                it.id !in logged && ((it.direction == "incoming" && it.durationSec > 0) || it.direction == "outgoing")
            }
            if (calls.isEmpty()) return@launch
            // Outcome already saved on the laptop? Don't ask again here.
            runCatching { Repo.callsWithOutcome(calls.map { it.id }) }.getOrNull().also { done ->
                done?.forEach { store.markLogged(it) }
            }.let { done -> checkUnloggedCallsWith(if (done.isNullOrEmpty()) calls else calls.filter { it.id !in done }.ifEmpty { return@launch }) }
        } finally { checking = false }
    }

    private suspend fun checkUnloggedCallsWith(calls: List<com.closeros.app.calls.LogCall>) {
        val m = membership ?: return
        val phones = calls.map { normalizePhone(it.phone, prefix) }
        val leads = runCatching { Repo.leadsByPhones(m.org_id, phones) }.getOrNull() ?: return
        val first = calls.indices.firstOrNull { leads[phones[it]] != null } ?: run {
            calls.forEach { store.markLogged(it.id) }   // not leads: nothing to ask
            return
        }
        calls.take(first).forEach { store.markLogged(it.id) }
        val c = calls[first]; val lead = leads[phones[first]]!!
        if (pending != null) return
        val g = com.closeros.app.data.CallPurpose.guess(lead, followUps)
        val pc = LocalStore.PendingCall(lead.id, lead.name, lead.phone, c.startedAtMs, g.purpose, g.batchId, lead.profession, null, logId = c.id)
        store.pendingCall = pc; pending = pc; pendingLog = c
    }

    /** In the after-call pop-up: true when this call is the one the app itself started (then the app's copy is cleared too). */
    var popupOwnsAppCall = false

    fun discardPending() {
        if (!lite || popupOwnsAppCall) store.pendingCall = null
        pending = null; pendingLog = null; endedReported = null
    }

    // ───────────── Desk mode: the laptop asks this phone to dial ─────────────
    /** True while a call asked for by the laptop is being started (so no SIM question if one was used before). */
    var remoteCall by mutableStateOf(false)
    private var remoteRequestId: String? = null
    private var endedReported: String? = null
    private var checkingRequests = false

    /** Called every few seconds while the app is on screen. */
    fun checkCallRequests() = viewModelScope.launch {
        if (pending != null || checkingRequests || callRequest != null) return@launch
        checkingRequests = true
        try {
            val r = runCatching { Repo.claimCallRequest() }.getOrNull() ?: return@launch
            val lead = runCatching { Repo.lead(r.lead_id) }.getOrNull() ?: return@launch
            remoteRequestId = r.id; remoteCall = true
            callContext = r.purpose to r.batch_id
            message = "Calling ${lead.name.ifBlank { lead.phone }} (from your laptop)"
            callRequest = lead
        } finally { checkingRequests = false }
    }

    /** Tells the laptop the call is over, so it can show the outcome form too. */
    fun reportCallEnded() = viewModelScope.launch {
        val p = pending ?: return@launch; val log = pendingLog ?: return@launch
        val rid = p.requestId ?: return@launch
        if (endedReported == rid) return@launch
        runCatching { Repo.callRequestEnded(rid, log.id, log.startedAtMs, log.durationSec, log.phone) }.onSuccess { endedReported = rid }
    }

    /** While the outcome screen is open: was it saved on the laptop? Then close it here. */
    fun checkOutcomeSavedElsewhere() = viewModelScope.launch {
        val p = pending ?: return@launch
        if (pendingLog == null) {
            pendingLog = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                if (p.logId != null) PhoneCalls.readLog(ctx, p.startedAtMs - 60_000).firstOrNull { it.id == p.logId } else PhoneCalls.findCall(ctx, p.phone, p.startedAtMs)
            }
        }
        val log = pendingLog ?: return@launch
        reportCallEnded()
        val done = runCatching { Repo.callsWithOutcome(listOf(log.id)) }.getOrNull() ?: return@launch
        if (log.id in done && pending == p) {
            store.markLogged(log.id)
            pending?.let { FollowUpAlarms.cancelForLead(ctx, it.leadId, followUps) }
            // Saved in the after-call pop-up or on the laptop — the WhatsApp step was offered there, not again here.
            discardPending()
            message = "Outcome already saved ✓"
            queueAfterOutcome()
            refreshHome(); checkUnloggedCalls()
        }
    }

    /** "The call didn't happen" while in a queue: go on with the next lead. */
    fun discardAndContinue() { discardPending(); if (queueActive) { queuePos++; if (queuePos >= queue.size) queueActive = false else countdown = store.countdownSec } }

    /** Saves the outcome. If there is no internet it is kept on the phone and sent later. */
    fun saveOutcome(payload: JsonObject, onDone: () -> Unit) = viewModelScope.launch {
        com.closeros.app.data.LocalReports.recordOutcome(ctx, payload)   // my reports count it right away, even offline
        val sent = runCatching { Repo.logCall(payload) }
        if (sent.isFailure) {
            val err = sent.exceptionOrNull()?.message.orEmpty()
            if (!err.contains("Unable to resolve host") && !err.contains("timeout", true)) com.closeros.app.data.AppLog.error(ctx, "save outcome", sent.exceptionOrNull())
            if (err.contains("next call time") || err.contains("Unknown outcome") || err.contains("Lead not found")) {
                message = err.substringAfter("ERROR:").trim().ifEmpty { err }; onDone(); return@launch
            }
            store.addToOutbox(payload)
            com.closeros.app.data.LocalFollowUps.apply(ctx, payload)   // next call shows in Follow-ups + reminder alarm set now
            followUps = cached("followUps") ?: followUps
            message = "No internet — saved on the phone, will send automatically"
        } else message = "Saved"
        pending?.let { FollowUpAlarms.cancelForLead(ctx, it.leadId, followUps) }
        pendingLog?.id?.let { store.markLogged(it) }
        com.closeros.app.calls.AfterCall.cancelNotification(ctx)   // outcome saved here → remove the "Save the outcome" reminder
        // Saved here in the app: offer the WhatsApp message once (not in the calling queue — it moves on by itself).
        if (!lite && !queueActive) pending?.let { p -> membership?.let { m ->
            if (p.phone.isNotBlank()) whatsappNext = Lead(id = p.leadId, org_id = m.org_id, name = p.leadName, phone = p.phone, profession = p.profession) } }
        discardPending()
        onDone()
        CallSync.syncNow(ctx)
        if (lite) { com.closeros.app.data.AppEvents.bumpLeads(); return@launch }
        checkUnloggedCalls()
        queueAfterOutcome()
        refreshHome(); reloadLeads()
        if (openList != null) loadList()
    }

    /** The after-call pop-up's full form: this call, without touching the app's own pending call. */
    fun openAfterCall(p: LocalStore.PendingCall, log: LogCall?) { pending = p; pendingLog = log }

    fun newCallId(): String = pendingLog?.id ?: UUID.randomUUID().toString()

    // Runs last, after every property above exists (the after-call screen starts already signed in).
    init {
        // A lead was added or a call saved in the after-call pop-up: refresh the lists straight away.
        // Internet back: refresh everything from the server.
        viewModelScope.launch {
            com.closeros.app.data.Net.online.collect { on ->
                val was = online; online = on
                if (on && !was && membership != null && !lite) { loadOrg() }
            }
        }
        viewModelScope.launch { com.closeros.app.data.AppEvents.leadsChanged.collect { if (it > 0 && !lite) { reloadLeads(); loadHistory(); refreshHome() } } }
        viewModelScope.launch {
            Backend.auth.sessionStatus.collectLatest { s ->
                status = s
                // No internet when the login needed renewing: stay signed in and work from the phone's copy.
                if (s is SessionStatus.Authenticated || (s is SessionStatus.RefreshFailure && membership == null)) loadOrg()
                if (s is SessionStatus.NotAuthenticated) { membership = null; loadingOrg = false }
            }
        }
    }
}

/** Fills a WhatsApp message's {{variables}} for one lead (used in the app and in the after-call pop-up). */
fun fillTemplateText(body: String, lead: Lead, companyName: String, timezone: String, repName: String): String {
    val b = lead.latestBatch?.batch
    val tz = runCatching { java.time.ZoneId.of(timezone) }.getOrDefault(java.time.ZoneId.systemDefault())
    val df = java.time.format.DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(tz)
    fun t(iso: String?) = iso?.let { runCatching { df.format(com.closeros.app.data.parseInstant(it)) }.getOrNull() } ?: ""
    return body
        .replace("{{leadName}}", lead.name.substringBefore(' ').ifBlank { "there" })
        .replace("{{leadFullName}}", lead.name.ifBlank { "there" })
        .replace("{{repName}}", repName.substringBefore(' '))
        .replace("{{companyName}}", companyName)
        .replace("{{batchName}}", b?.name ?: "the session")
        .replace("{{batchDate}}", t(b?.webinar_at))
        .replace("{{followUpTime}}", t(lead.next_follow_up_at).ifBlank { "a convenient time" })
        .replace("{{city}}", lead.city ?: "")
        .replace("{{profession}}", lead.profession ?: "")
}
