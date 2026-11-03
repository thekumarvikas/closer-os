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

class AppViewModel(app: Application) : AndroidViewModel(app) {
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
    var tab by mutableStateOf(Tab.Home)
    var openLeadId by mutableStateOf<String?>(null)
    var message by mutableStateOf<String?>(null)

    /** The call waiting for its outcome, and what the call log says about it. */
    var needsSetup by mutableStateOf(!store.setupDone)
    var callRequest by mutableStateOf<Lead?>(null)
    var showSetup by mutableStateOf(false)
    /** True while the app is on screen. */
    var foreground = false
    var leaderboard by mutableStateOf<List<com.closeros.app.data.BoardRow>>(emptyList())
    var showLeaderboard by mutableStateOf(false)
    var showDialer by mutableStateOf(false)
    var showReports by mutableStateOf(false)
    var access by mutableStateOf<com.closeros.app.data.OrgAccess?>(null)
    var showFeedback by mutableStateOf(false)
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

    fun loadBatches() = viewModelScope.launch {
        val m = membership ?: return@launch
        batches = runCatching { Repo.myBatches(m.org_id) }.onFailure { message = "Couldn't load webinars: ${it.message}" }.getOrDefault(emptyList())
    }

    fun openBatchList(b: BatchSummary, purpose: String) { openList = b to purpose; loadList() }

    fun loadList() = viewModelScope.launch {
        val (b, purpose) = openList ?: return@launch
        listRows = null
        runCatching { Repo.batchCallList(b.id, purpose, listEveryone && isManager) }
            .onSuccess { r -> listRows = r.leads; rowCategory = r.leads.associate { it.id to it.category_id } }
            .onFailure { message = "Couldn't load the list: ${it.message}"; listRows = emptyList() }
    }

    /** Call the filtered, sorted list one after another; every call is tagged with this webinar. */
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

    init {
        viewModelScope.launch {
            Backend.auth.sessionStatus.collectLatest { s ->
                status = s
                if (s is SessionStatus.Authenticated) loadOrg()
                if (s is SessionStatus.NotAuthenticated) { membership = null; loadingOrg = false }
            }
        }
    }

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
            membership = Repo.membership().also { save("membership", it) }
            membership?.let { store.trackWhatsapp = it.organization.trackWhatsapp }
            profile = Repo.profile().also { save("profile", it) }
            membership?.let { m ->
                store.orgId = m.org_id
                outcomes = Repo.outcomes(m.org_id).also { save("outcomes", it) }
                runCatching { categories = Repo.categories(m.org_id).also { save("categories", it) } }
                runCatching { templates = Repo.templates(m.org_id).also { save("templates", it) } }
                refreshHome()
                reloadLeads()
                CallSync.schedule(ctx); CallSync.syncNow(ctx)
            }
        }.onFailure {
            if (membership == null) { message = "Couldn't load your company: ${it.message}"; com.closeros.app.data.AppLog.error(ctx, "load company", it) }
            else message = "Offline — showing saved data"
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
            launch { runCatching { progress = Repo.myProgressToday(m.organization) } }
            launch { runCatching { access = Repo.orgAccess(m.org_id) } }
            launch { runCatching { leaderboard = Repo.leaderboard(m.organization, "today") } }
        }
        loadReviews()
        checkAlerts()
        loadToday()
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
        val due = followUps.filter { runCatching { java.time.Instant.parse(it.due_at).toEpochMilli() }.getOrDefault(0) < soon }.sortedBy { it.due_at }
        val leads = runCatching { Repo.leadsByIds(due.map { it.lead_id }) }.getOrDefault(emptyList()).associateBy { it.id }
        startQueue(due.mapNotNull { leads[it.lead_id] })
    }

    /** Starts calling the given leads one after another. */
    fun startQueue(leads: List<Lead>, purpose: String = "sales", batchId: String? = null) {
        queuePurpose = purpose; queueBatchId = batchId
        val list = leads.filter { !it.do_not_call }.distinctBy { it.id }
        if (list.isEmpty()) { message = "No leads to call"; return }
        queue = list; queuePos = 0; queueDone = 0; queueActive = true; queuePaused = false; countdown = null
        todayFilter = null; openLeadId = null
        callRequest = list.first()
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
        if (c <= 1) { countdown = null; queue.getOrNull(queuePos)?.let { callRequest = it } } else countdown = c - 1
    }

    fun queueCallNow() { countdown = null; queue.getOrNull(queuePos)?.let { callRequest = it } }
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
    fun fillTemplate(body: String, lead: Lead): String {
        val b = lead.latestBatch?.batch
        val tz = java.time.ZoneId.of(membership?.organization?.timezone ?: "Asia/Kolkata")
        val df = java.time.format.DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(tz)
        fun t(iso: String?) = iso?.let { runCatching { df.format(java.time.Instant.parse(it)) }.getOrNull() } ?: ""
        return body
            .replace("{{leadName}}", lead.name.substringBefore(' ').ifBlank { "there" })
            .replace("{{leadFullName}}", lead.name.ifBlank { "there" })
            .replace("{{repName}}", profile?.full_name?.substringBefore(' ') ?: "")
            .replace("{{companyName}}", membership?.organization?.name ?: "")
            .replace("{{batchName}}", b?.name ?: "the session")
            .replace("{{batchDate}}", t(b?.webinar_at))
            .replace("{{followUpTime}}", t(lead.next_follow_up_at).ifBlank { "a convenient time" })
            .replace("{{city}}", lead.city ?: "")
            .replace("{{profession}}", lead.profession ?: "")
    }

    private val prefix get() = membership?.organization?.phone_prefix ?: "+91"

    /** Phone call history, with lead names where the number is a lead. */
    fun loadHistory() = viewModelScope.launch {
        val m = membership ?: return@launch
        val all = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { PhoneCalls.history(ctx, historyLimit + 1) }
        historyHasMore = all.size > historyLimit
        val logs = all.take(historyLimit)
        val phones = logs.map { normalizePhone(it.phone, prefix) }
        val leadsByPhone = runCatching { Repo.leadsByPhones(m.org_id, phones) }.getOrDefault(emptyMap())
        history = logs.mapIndexed { i, l -> HistoryItem(l, phones[i], leadsByPhone[phones[i]]) }
    }

    private var addingLead = false
    fun addLeadFromCall(phone: String, name: String, profession: String, notes: String, onDone: () -> Unit) = viewModelScope.launch {
        val m = membership ?: return@launch
        if (addingLead) return@launch   // ignore a quick second tap
        addingLead = true
        runCatching { Repo.createLead(m.org_id, name, phone, profession, notes) }
            .also { addingLead = false }
            .onSuccess { message = "Lead added"; onDone(); loadHistory(); reloadLeads(); CallSync.syncNow(ctx) }
            .onFailure { message = if (it.message?.contains("leads_org_phone_uq") == true) "This number is already a lead" else "Couldn't add the lead: ${it.message?.take(80)}" }
    }

    /** From a notification's Call button. */
    fun callLeadById(id: String) = viewModelScope.launch {
        runCatching { Repo.lead(id) }.getOrNull()?.let { callRequest = it } ?: run { message = "Lead not found" }
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

    fun signIn(email: String, password: String, onError: (String) -> Unit) = viewModelScope.launch {
        runCatching { Repo.signIn(email, password) }.onFailure {
            onError(if (it.message?.contains("Invalid login", true) == true) "Wrong email or password"
                    else if (it.message?.contains("not confirmed", true) == true) "Please confirm your email first (check your inbox)"
                    else "Couldn't sign in. Check your internet.")
        }
    }

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
        val ctxPair = callContext ?: if (queueActive && queue.any { it.id == lead.id }) queuePurpose to queueBatchId
            else openList?.takeIf { o -> listRows?.any { it.id == lead.id } == true }?.let { (b, purpose) -> purpose to b.id }
        callContext = null
        val p = LocalStore.PendingCall(lead.id, lead.name, lead.phone, System.currentTimeMillis(),
            ctxPair?.first ?: "sales", ctxPair?.second, lead.profession, rowCategory[lead.id], requestId = remoteRequestId)
        remoteRequestId = null; remoteCall = false
        store.pendingCall = p; pending = p; pendingLog = null
        sim?.let { store.preferredSim = it.slot }
        PhoneCalls.call(ctx, lead.phone, sim)
    }

    /** Called when the app comes back to the front: look up the finished call in the call log. */
    fun onResume() {
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
        val pc = LocalStore.PendingCall(lead.id, lead.name, lead.phone, c.startedAtMs, "sales", null, lead.profession, null, logId = c.id)
        store.pendingCall = pc; pending = pc; pendingLog = c
    }

    fun discardPending() { store.pendingCall = null; pending = null; pendingLog = null; endedReported = null }

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
            discardPending()
            message = "Outcome saved on your laptop ✓"
            queueAfterOutcome()
            refreshHome(); checkUnloggedCalls()
        }
    }

    /** "The call didn't happen" while in a queue: go on with the next lead. */
    fun discardAndContinue() { discardPending(); if (queueActive) { queuePos++; if (queuePos >= queue.size) queueActive = false else countdown = store.countdownSec } }

    /** Saves the outcome. If there is no internet it is kept on the phone and sent later. */
    fun saveOutcome(payload: JsonObject, onDone: () -> Unit) = viewModelScope.launch {
        val sent = runCatching { Repo.logCall(payload) }
        if (sent.isFailure) {
            val err = sent.exceptionOrNull()?.message.orEmpty()
            if (!err.contains("Unable to resolve host") && !err.contains("timeout", true)) com.closeros.app.data.AppLog.error(ctx, "save outcome", sent.exceptionOrNull())
            if (err.contains("next call time") || err.contains("Unknown outcome") || err.contains("Lead not found")) {
                message = err.substringAfter("ERROR:").trim().ifEmpty { err }; onDone(); return@launch
            }
            store.addToOutbox(payload)
            message = "No internet — saved on the phone, will send automatically"
        } else message = "Saved"
        pending?.let { FollowUpAlarms.cancelForLead(ctx, it.leadId, followUps) }
        pendingLog?.id?.let { store.markLogged(it) }
        discardPending()
        checkUnloggedCalls()
        onDone()
        queueAfterOutcome()
        refreshHome(); reloadLeads(); CallSync.syncNow(ctx)
        if (openList != null) loadList()
    }

    fun newCallId(): String = pendingLog?.id ?: UUID.randomUUID().toString()
}
