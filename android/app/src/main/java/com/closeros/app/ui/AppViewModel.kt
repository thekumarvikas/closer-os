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
import com.closeros.app.data.FollowUp
import com.closeros.app.data.Lead
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Membership
import com.closeros.app.data.Outcome
import com.closeros.app.data.Profile
import com.closeros.app.data.Repo
import com.closeros.app.data.TodayStats
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
    val leads = mutableStateListOf<Lead>()
    var leadsQuery by mutableStateOf("")
    var leadsEnd by mutableStateOf(false)
    var leadsLoading by mutableStateOf(false)
    var tab by mutableStateOf(Tab.Home)
    var openLeadId by mutableStateOf<String?>(null)
    var message by mutableStateOf<String?>(null)

    /** The call waiting for its outcome, and what the call log says about it. */
    var needsSetup by mutableStateOf(!store.setupDone)
    var callRequest by mutableStateOf<Lead?>(null)
    var history by mutableStateOf<List<HistoryItem>?>(null)

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

    fun loadOrg() = viewModelScope.launch {
        loadingOrg = true
        runCatching {
            membership = Repo.membership()
            profile = Repo.profile()
            membership?.let { m ->
                store.orgId = m.org_id
                outcomes = Repo.outcomes(m.org_id)
                refreshHome()
                reloadLeads()
                CallSync.schedule(ctx); CallSync.syncNow(ctx)
            }
        }.onFailure { message = "Couldn't load your company: ${it.message}" }
        loadingOrg = false
    }

    fun refreshHome() = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { stats = Repo.todayStats(m.organization) }
        runCatching { followUps = Repo.followUps(m.org_id); FollowUpAlarms.scheduleAll(ctx, followUps) }
    }

    private val prefix get() = membership?.organization?.phone_prefix ?: "+91"

    /** Phone call history, with lead names where the number is a lead. */
    fun loadHistory() = viewModelScope.launch {
        val m = membership ?: return@launch
        val logs = PhoneCalls.history(ctx, 300)
        val phones = logs.map { normalizePhone(it.phone, prefix) }
        val leadsByPhone = runCatching { Repo.leadsByPhones(m.org_id, phones) }.getOrDefault(emptyMap())
        history = logs.mapIndexed { i, l -> HistoryItem(l, phones[i], leadsByPhone[phones[i]]) }
    }

    fun addLeadFromCall(phone: String, name: String, profession: String, notes: String, onDone: () -> Unit) = viewModelScope.launch {
        val m = membership ?: return@launch
        runCatching { Repo.createLead(m.org_id, name, phone, profession, notes) }
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

    fun reloadLeads() { page = 0; leadsEnd = false; leads.clear(); loadMoreLeads() }

    fun loadMoreLeads() {
        val m = membership ?: return
        if (leadsLoading || leadsEnd) return
        leadsLoading = true
        viewModelScope.launch {
            runCatching { Repo.leads(m.org_id, leadsQuery, page, mineOnly = isRep()) }
                .onSuccess { leads.addAll(it); if (it.size < 50) leadsEnd = true; page++ }
                .onFailure { message = "Couldn't load leads. Check your internet." }
            leadsLoading = false
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

    fun signOut() = viewModelScope.launch { runCatching { Repo.signOut() }; FollowUpAlarms.scheduleAll(ctx, emptyList()); store.clear(); leads.clear(); pending = null; needsSetup = true }

    // ───────────── Calling ─────────────

    fun sims(): List<Sim> = PhoneCalls.sims(ctx)

    /** Starts a call and remembers it, so the outcome form appears when the rep comes back. */
    fun startCall(lead: Lead, sim: Sim?, purpose: String = "sales", batchId: String? = null) {
        if (pending != null) { message = "Save the outcome of your last call first"; return }
        val p = LocalStore.PendingCall(lead.id, lead.name, lead.phone, System.currentTimeMillis(), purpose, batchId)
        store.pendingCall = p; pending = p; pendingLog = null
        sim?.let { store.preferredSim = it.slot }
        PhoneCalls.call(ctx, lead.phone, sim)
    }

    /** Called when the app comes back to the front: look up the finished call in the call log. */
    fun onResume() {
        val p = pending ?: return
        pendingLog = PhoneCalls.findCall(ctx, p.phone, p.startedAtMs)
        refreshHome()
    }

    fun discardPending() { store.pendingCall = null; pending = null; pendingLog = null }

    /** Saves the outcome. If there is no internet it is kept on the phone and sent later. */
    fun saveOutcome(payload: JsonObject, onDone: () -> Unit) = viewModelScope.launch {
        val sent = runCatching { Repo.logCall(payload) }
        if (sent.isFailure) {
            val err = sent.exceptionOrNull()?.message.orEmpty()
            if (err.contains("next call time") || err.contains("Unknown outcome") || err.contains("Lead not found")) {
                message = err.substringAfter("ERROR:").trim().ifEmpty { err }; return@launch
            }
            store.addToOutbox(payload)
            message = "No internet — saved on the phone, will send automatically"
        } else message = "Saved"
        pending?.let { FollowUpAlarms.cancelForLead(ctx, it.leadId, followUps) }
        discardPending()
        onDone()
        refreshHome(); reloadLeads(); CallSync.syncNow(ctx)
    }

    fun newCallId(): String = pendingLog?.id ?: UUID.randomUUID().toString()
}
