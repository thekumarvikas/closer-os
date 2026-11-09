package com.closeros.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Closer OS works with no internet at all (no mobile data, no Wi-Fi):
 *  - [Net] knows whether the phone is online, so screens go straight to the phone's own copy.
 *  - [LocalLeads] searches / filters the copy of the leads kept on the phone (LeadIndex).
 *  - [Ops] keeps notes, key facts, WhatsApp "sent" marks and new leads until the internet is back.
 *  - [LocalFollowUps] updates follow-ups + reminder alarms right away when an outcome is saved offline.
 * Call outcomes themselves already wait in LocalStore.outbox. CallSync sends everything when online.
 */
/** The app's context, for code that runs without a screen (set in CloserApp). */
object AppCtx { lateinit var ctx: Context }

object Net {
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online
    val isOnline get() = _online.value

    fun init(ctx: Context) {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
        fun check() = cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        _online.value = check()
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val was = _online.value
                    _online.value = true
                    if (!was) com.closeros.app.calls.CallSync.syncNow(ctx)   // back online: send everything saved meanwhile
                }
                override fun onLost(network: Network) { _online.value = check() }
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    _online.value = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                }
            })
        }
    }

    /** True when an error means "couldn't reach the server" (not "the server said no"). */
    fun isNetworkError(t: Throwable?): Boolean {
        var e = t
        repeat(6) {
            if (e == null) return false
            // A stopped background job counts as "try again later" too (never as the server saying no).
            if (e is java.io.IOException || e is java.net.UnknownHostException || e is kotlinx.coroutines.CancellationException) return true
            val n = e!!::class.java.name
            if ("HttpRequestException" in n || "Timeout" in n || "ConnectException" in n) return true
            val m = e!!.message.orEmpty()
            if ("Unable to resolve host" in m || "timeout" in m.lowercase() || "failed to connect" in m.lowercase()) return true
            e = e!!.cause
        }
        return false
    }
}

/** Searches the leads saved on the phone (used when there is no internet). */
object LocalLeads {
    @Volatile private var cache: Pair<Long, List<Lead>>? = null

    fun all(ctx: Context): List<Lead> {
        val db = LocalDb.get(ctx)
        cache?.takeIf { it.first == db.leadsVersion }?.let { return it.second }
        val list = db.allLeadJson().mapNotNull { runCatching { json.decodeFromString<Lead>(it) }.getOrNull() }
        cache = db.leadsVersion to list
        return list
    }

    fun byId(ctx: Context, id: String): Lead? =
        runCatching { LocalDb.get(ctx).leadJsonById(id)?.let { json.decodeFromString<Lead>(it) } }.getOrNull()

    /** Same rules as the server search (Repo.leads), on the phone's copy. */
    fun search(ctx: Context, query: String, page: Int, mineOnly: Boolean, f: LeadFilters): List<Lead> {
        val q = query.trim().lowercase()
        val digits = q.filter { it.isDigit() }
        val uid = Backend.uid
        val now = Instant.now()
        val dayStart = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant()
        val dayEnd = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant()
        fun t(s: String?) = s?.let { runCatching { parseInstant(it) }.getOrNull() }
        return all(ctx).asSequence().filter { l ->
            (!mineOnly || uid == null || l.assigned_to == uid || uid in l.shared_with) &&
            (q.isEmpty() || (digits.length >= 4 && l.phone.contains(digits)) ||
                listOfNotNull(l.name, l.city, l.profession, l.company, l.email, l.source, l.campaign, l.key_facts, l.state)
                    .any { it.lowercase().contains(q) }) &&
            when (f.followup) {
                "overdue" -> t(l.next_follow_up_at)?.isBefore(now) == true
                "today" -> t(l.next_follow_up_at)?.let { !it.isBefore(dayStart) && it.isBefore(dayEnd) } == true
                "upcoming" -> t(l.next_follow_up_at)?.let { !it.isBefore(dayEnd) } == true
                "none" -> l.next_follow_up_at == null
                else -> true
            } &&
            (f.stages.isEmpty() || l.stage_id in f.stages) &&
            (f.outcomes.isEmpty() || l.last_outcome_id in f.outcomes) &&
            (f.sources.isEmpty() || l.source in f.sources) &&
            (f.campaigns.isEmpty() || l.campaign in f.campaigns) &&
            (f.categories.isEmpty() || l.profession_category_id in f.categories) &&
            (f.cities.isEmpty() || f.cities.any { c -> l.city.equals(c.trim(), ignoreCase = true) }) &&
            (!f.neverCalled || l.last_call_at == null) &&
            f.custom.filterValues { it.isNotEmpty() }.all { (k, v) -> (l.custom?.get(k) as? JsonPrimitive)?.content in v } &&
            when (f.lastCall) {
                "talked" -> l.has_talked
                "not_picked" -> l.last_call_status == "not_picked"
                "missed" -> l.last_call_status == "missed"
                "never" -> l.dial_count == 0
                "tried3" -> l.dial_count >= 3 && !l.has_talked
                else -> true
            } &&
            when (f.messaged) { "yes" -> l.wa_count > 0; "no" -> l.wa_count == 0; else -> true } &&
            (!f.hot || l.score >= 40) &&
            (f.talk.isEmpty() || TalkBands.of(l.total_talk_sec) in f.talk) &&
            (f.tags.isEmpty() || l.tags.orEmpty().any { it in f.tags })
        }.sortedWith(compareBy<Lead> { t(it.next_follow_up_at) ?: Instant.MAX }.thenByDescending { it.created_at ?: "" })
            .drop(page * 50).take(50).toList()
    }

    /** Today's focus from the phone's copy — same order as the server (my_focus_list). */
    fun focus(ctx: Context, outcomes: List<Outcome>, tz: String): List<Lead> {
        val zone = runCatching { ZoneId.of(tz) }.getOrDefault(ZoneId.systemDefault())
        val now = Instant.now()
        val dayStart = LocalDate.now(zone).atStartOfDay(zone).toInstant()
        val dayEnd = dayStart.plusSeconds(86_400)
        val hour = java.time.LocalTime.now(zone).hour
        val closed = outcomes.filter { it.category in setOf("won", "lost", "invalid") }.map { it.id }.toSet()
        val uid = Backend.uid
        fun t(s: String?) = s?.let { runCatching { parseInstant(it) }.getOrNull() }
        return all(ctx).filter { l ->
            (uid == null || l.assigned_to == uid || uid in l.shared_with) && !l.do_not_call && l.last_outcome_id !in closed &&
                (t(l.next_follow_up_at)?.isBefore(dayEnd) ?: true) &&
                ((t(l.last_call_at)?.isBefore(dayStart) ?: true) || t(l.next_follow_up_at)?.isBefore(now.plusSeconds(7200)) == true)
        }.map { l ->
            // Same order as the server: late → tonight's webinar (reminder) → due in 2 h → hot watchers → new (newest first) → best time → close → rest.
            val fu = t(l.next_follow_up_at)
            val up = l.batch_leads.filter { !it.is_holdout }.mapNotNull { b -> t(b.batch?.webinar_at)?.takeIf { it.isAfter(now) && it.isBefore(now.plusSeconds(18 * 3600)) } }.minOrNull()
            val hot = l.batch_leads.any { b -> (b.warmth >= 40 || (b.watch_minutes ?: 0) >= 60) && t(b.batch?.webinar_at)?.let { it.isAfter(now.minusSeconds(14L * 86_400)) && !it.isAfter(now) } == true }
            // A new lead that arrived on its own in the last 24 h and was never called: speed to lead.
            val newLive = l.dial_count == 0 && l.source != "Phone call" && t(l.created_at)?.isAfter(now.minusSeconds(86_400)) == true
            val bucket = when {
                fu != null && fu.isBefore(now) -> 1
                up != null -> 2
                newLive -> 3
                fu != null && fu.isBefore(now.plusSeconds(7200)) -> 4
                hot -> 5
                l.dial_count == 0 -> 6
                l.best_hour == hour -> 7
                l.score >= 40 -> 8
                else -> 9
            }
            Triple(l, bucket, up)
        }.sortedWith(compareBy<Triple<Lead, Int, Instant?>>({ it.second }, { it.third ?: Instant.MAX }, { t(it.first.next_follow_up_at) ?: Instant.MAX },
            { if (it.second == 5) -(it.first.batch_leads.maxOfOrNull { b -> b.warmth } ?: 0).toLong() else 0L },
            { when (it.second) { 6 -> -(t(it.first.created_at)?.toEpochMilli() ?: 0L); 3 -> t(it.first.created_at)?.toEpochMilli() ?: 0L; else -> 0L } },
            { -it.first.score }))
            .map { it.first }   // reminder vs sales is worked out per lead when calling (CallPurpose)
    }
}

/** Work done with no internet that isn't a call outcome: sent in order when the phone is online again. */
object Ops {
    private val lock = Any()
    private fun read(ctx: Context): List<JsonObject> =
        LocalDb.get(ctx).get("ops")?.let { runCatching { json.decodeFromString<List<JsonObject>>(it) }.getOrNull() } ?: emptyList()
    private fun write(ctx: Context, v: List<JsonObject>) = LocalDb.get(ctx).put("ops", json.encodeToString(kotlinx.serialization.builtins.ListSerializer(JsonObject.serializer()), v))

    fun add(ctx: Context, op: String, args: JsonObject) = synchronized(lock) {
        write(ctx, read(ctx) + buildJsonObject { put("op", op); put("args", args); put("id", java.util.UUID.randomUUID().toString()) })
    }
    fun count(ctx: Context) = read(ctx).size

    /** Sends everything waiting. A server "no" (not a network problem) drops that item so the rest can go. */
    suspend fun flush(ctx: Context) {
        val list = synchronized(lock) { read(ctx) }
        if (list.isEmpty()) return
        val done = mutableListOf<String>()
        for (o in list) {
            val a = o["args"] as? JsonObject ?: continue
            fun s(k: String) = a[k]?.jsonPrimitive?.content?.takeIf { it != "null" }
            val r = runCatching {
                when (o["op"]?.jsonPrimitive?.content) {
                    "note" -> Repo.addNoteNow(s("lead")!!, s("text")!!, a["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty())
                    "facts" -> Repo.setKeyFactsNow(s("lead")!!, s("text").orEmpty())
                    "edit" -> Repo.updateLeadDetailsNow(s("lead")!!, a["p"] as JsonObject)
                    "wa" -> Repo.logWaOrThrow(s("org")!!, s("lead"), s("phone")!!, s("template_id"), s("template_name"), s("source") ?: "single")
                    "lead" -> runCatching { Repo.createLead(s("org")!!, s("name").orEmpty(), s("phone")!!, s("profession"), s("notes")) }
                        .onFailure { if (it.message?.contains("leads_org_phone_uq") != true) throw it }   // already a lead: fine
                    else -> Unit
                }
            }
            if (r.isSuccess || !Net.isNetworkError(r.exceptionOrNull())) {
                r.exceptionOrNull()?.let { AppLog.error(ctx, "offline item", it) }
                o["id"]?.jsonPrimitive?.content?.let { done += it }
            } else break   // still offline: keep the rest, in order
        }
        synchronized(lock) { write(ctx, read(ctx).filter { it["id"]?.jsonPrimitive?.content !in done }) }
    }

    fun note(ctx: Context, leadId: String, text: String, tags: List<String>) =
        add(ctx, "note", buildJsonObject { put("lead", leadId); put("text", text); put("tags", buildJsonArray { tags.forEach { add(JsonPrimitive(it)) } }) })
    fun facts(ctx: Context, leadId: String, text: String) = add(ctx, "facts", buildJsonObject { put("lead", leadId); put("text", text) })
    fun wa(ctx: Context, orgId: String, leadId: String?, phone: String, templateId: String?, templateName: String?, source: String) =
        add(ctx, "wa", buildJsonObject {
            put("org", orgId); leadId?.let { put("lead", it) }; put("phone", phone)
            templateId?.let { put("template_id", it) }; templateName?.let { put("template_name", it) }; put("source", source)
        })
    fun lead(ctx: Context, orgId: String, name: String, phone: String, profession: String?, notes: String?) =
        add(ctx, "lead", buildJsonObject { put("org", orgId); put("name", name); put("phone", phone); profession?.let { put("profession", it) }; notes?.let { put("notes", it) } })
}

/** When an outcome is saved with no internet: the lead's next call appears in Follow-ups and its reminder alarm is set now. */
object LocalFollowUps {
    fun apply(ctx: Context, payload: JsonObject) {
        val leadId = payload["lead_id"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() && it != "null" } ?: return
        if (payload["outcome_id"] == null) return
        val purpose = payload["purpose"]?.jsonPrimitive?.content ?: "sales"
        val at = payload["follow_up_at"]?.jsonPrimitive?.content?.takeIf { it != "null" }
        val db = LocalDb.get(ctx)
        val list = db.get("followUps")?.let { runCatching { json.decodeFromString<List<FollowUp>>(it) }.getOrNull() }.orEmpty()
        val lead = LocalLeads.byId(ctx, leadId)
        val kept = list.filterNot { it.lead_id == leadId && it.status == "pending" && it.purpose == purpose }
        val updated = if (at == null) kept else kept + FollowUp(
            id = "local-" + (payload["id"]?.jsonPrimitive?.content ?: java.util.UUID.randomUUID().toString()),
            lead_id = leadId, due_at = at, status = "pending", purpose = purpose,
            lead = lead?.let { LeadMini(it.name, it.phone, it.dial_count, it.conversation_count, it.call_count, payload["outcome_id"]?.jsonPrimitive?.content, it.key_facts, it.profession, it.city, it.total_talk_sec) })
        db.put("followUps", json.encodeToString(kotlinx.serialization.builtins.ListSerializer(FollowUp.serializer()), updated.sortedBy { it.due_at }))
        com.closeros.app.calls.FollowUpAlarms.scheduleAll(ctx, updated)
        // The lead copy shows the new outcome / next call too.
        lead?.let { l ->
            val nu = l.copy(last_outcome_id = payload["outcome_id"]?.jsonPrimitive?.content, next_follow_up_at = at,
                last_call_at = payload["started_at"]?.jsonPrimitive?.content ?: l.last_call_at, call_count = l.call_count + 1,
                dial_count = l.dial_count + if (payload["direction"]?.jsonPrimitive?.content == "outgoing") 1 else 0)
            LeadIndex.remember(ctx, listOf(nu))
        }
    }
}
