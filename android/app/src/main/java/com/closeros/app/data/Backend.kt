package com.closeros.app.data

import android.content.Context
import com.closeros.app.BuildConfig
import io.github.jan.supabase.auth.Auth
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.postgrest.Postgrest
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import io.github.jan.supabase.postgrest.query.filter.FilterOperator
import io.github.jan.supabase.serializer.KotlinXSerializer
import io.github.jan.supabase.storage.storage
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.booleanOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

/** The one connection to the Closer OS backend (Supabase). */
object Backend {
    val client = createSupabaseClient(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY) {
        defaultSerializer = KotlinXSerializer(json)
        install(Auth)
        install(Postgrest)
        install(io.github.jan.supabase.storage.Storage)   // recordings + WhatsApp attachments / company files
    }
    val auth get() = client.auth
    val uid: String? get() = client.auth.currentUserOrNull()?.id

    /**
     * Background work (call sync, after-call pop-up) can run hours after the app was last open. Then the
     * saved login has expired and, if the internet wasn't ready at that moment, the library drops it and
     * would call the server WITHOUT the login ("JWT expired" / "permission denied"). So: load the saved
     * login ourselves and refresh it, retrying a few times. Returns true when a valid login is ready.
     */
    suspend fun ensureFreshSession(): Boolean {
        val a = client.auth
        runCatching { kotlinx.coroutines.withTimeoutOrNull(3_000) { a.awaitInitialization() } }
        val soon = kotlinx.datetime.Clock.System.now() + kotlin.time.Duration.parse("2m")
        for (attempt in 0 until 4) {
            val cur = a.currentSessionOrNull()
            if (cur != null && cur.expiresAt > soon) return true
            val saved = cur ?: runCatching { a.sessionManager.loadSession() }.getOrNull() ?: return false   // really signed out
            val ok = runCatching { a.importSession(a.refreshSession(saved.refreshToken)) }.isSuccess
            if (ok) return true
            kotlinx.coroutines.delay(1_500L * (attempt + 1))   // internet may still be waking up
        }
        return false
    }
}

@Serializable data class CompanyFile(val id: String, val name: String, val path: String, val mime_type: String? = null, val size_bytes: Long? = null)

@Serializable data class Org(
    val id: String, val name: String, val phone_prefix: String = "+91", val currency: String = "INR",
    val timezone: String = "Asia/Kolkata",
    val settings: JsonObject? = null,
) {
    val trackWhatsapp get() = settings?.get("track_whatsapp")?.jsonPrimitive?.booleanOrNull ?: true
    /** Tag groups (dashboard Settings → Note tags), e.g. Objection: Price · Time. Falls back to the flat tag list. */
    val tagGroups: List<TagGroup> get() = runCatching {
        settings?.get("tag_groups")?.jsonArray?.map { g -> val o = g.jsonObject
            TagGroup(o["name"]?.jsonPrimitive?.content ?: "", o["color"]?.jsonPrimitive?.contentOrNull ?: "#0E5E57", o["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()) }
    }.getOrNull()?.filter { it.tags.isNotEmpty() }?.ifEmpty { null } ?: listOf(TagGroup("Tags", "#0E5E57", noteTags))
    /** Facts the company wants captured on each lead (short pick-lists), saved in leads.custom. */
    val leadFacts: List<LeadFact> get() = runCatching {
        settings?.get("lead_facts")?.jsonArray?.map { f -> val o = f.jsonObject
            LeadFact(o["key"]!!.jsonPrimitive.content, o["label"]?.jsonPrimitive?.content ?: "", o["options"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()) }
    }.getOrNull().orEmpty().filter { it.key.isNotBlank() && it.options.isNotEmpty() }
    /** Quick note tags set by the company (Settings on the dashboard). */
    val noteTags: List<String> get() = runCatching { settings?.get("note_tags")?.jsonArray?.map { it.jsonPrimitive.content } }.getOrNull()
        ?: listOf("Price objection", "Wants EMI", "Needs to ask family", "Decision maker: spouse", "Busy — call in evening",
            "Asked for details on WhatsApp", "Comparing with others", "Very interested", "Already bought elsewhere")
}
data class TagGroup(val name: String, val color: String, val tags: List<String>)
data class LeadFact(val key: String, val label: String, val options: List<String>)
@Serializable data class Membership(val org_id: String, val role: String, val organization: Org)
@Serializable data class Profile(val id: String, val email: String? = null, val full_name: String? = null, val phone: String? = null)

@Serializable data class Lead(
    val id: String, val org_id: String, val name: String = "", val phone: String, val email: String? = null,
    val city: String? = null, val state: String? = null, val company: String? = null, val profession: String? = null,
    val source: String? = null, val campaign: String? = null, val assigned_to: String? = null,
    val stage_id: String? = null, val deal_value: Double? = null, val notes: String? = null,
    val last_call_at: String? = null, val last_outcome_id: String? = null, val next_follow_up_at: String? = null,
    val do_not_call: Boolean = false, val last_connected_at: String? = null, val key_facts: String? = null,
    val batch_leads: List<BatchLink> = emptyList(),
    // Effort so far (kept up to date by the server): talk time, dials, real pick-ups, WhatsApp sent, score.
    val total_talk_sec: Int = 0, val call_count: Int = 0, val dial_count: Int = 0, val pickup_count: Int = 0, val wa_count: Int = 0,
    val last_call_status: String? = null, val has_talked: Boolean = false, val score: Int = 0, val won_at: String? = null,
    val tags: List<String>? = null, val custom: JsonObject? = null, val created_at: String? = null, val best_hour: Int? = null,
    val conversation_count: Int = 0,
) {
    /** Latest webinar/event this lead registered for. */
    val latestBatch: BatchLink? get() = batch_leads.maxByOrNull { it.batch?.webinar_at ?: "" }
}

@Serializable data class BatchMini(val name: String = "", val webinar_at: String? = null)
@Serializable data class BatchLink(val watch_minutes: Int? = null, val attended: Boolean = false, val batch: BatchMini? = null)
@Serializable data class Template(val id: String, val name: String, val body: String, val position: Int = 0, val owner_id: String? = null,
    val media_path: String? = null, val media_type: String? = null, val media_name: String? = null)

@Serializable data class Outcome(
    val id: String, val code: String, val label: String, val category: String, val form: String? = null,
    val purpose: String = "sales", val position: Int = 0, val is_active: Boolean = true, val next_default: String? = null,
)

/** A webinar / event with how many leads I (or my team) have to call. */
@Serializable data class BatchSummary(
    val id: String, val name: String, val kind: String = "webinar", val webinar_at: String, val hot_minutes: Int = 60,
    val zoom_uploaded: Boolean = false, val reminder_mine: Int = 0, val sales_mine: Int = 0,
    val reminder_all: Int = 0, val sales_all: Int = 0, val attended: Int = 0,
)

/** One lead in a webinar's calling list, with what's needed to filter and sort. */
@Serializable data class BatchRow(
    val id: String, val org_id: String, val name: String = "", val phone: String, val email: String? = null,
    val city: String? = null, val state: String? = null, val company: String? = null, val profession: String? = null,
    val category_id: String? = null, val category: String? = null, val source: String? = null, val campaign: String? = null,
    val rep: String? = null, val assigned_to: String? = null, val do_not_call: Boolean = false,
    val watch_minutes: Int? = null, val attended: Boolean = false, val is_hot: Boolean = false, val is_repeat: Boolean = false,
    val registered_at: String? = null, val attempts: Int = 0, val talked: Boolean = false, val last_called_at: String? = null,
    val last_outcome_id: String? = null, val next_follow_up_at: String? = null, val bought: Boolean = false,
) {
    fun toLead(batchName: String, webinarAt: String) = Lead(
        id = id, org_id = org_id, name = name, phone = phone, email = email, city = city, state = state, company = company,
        profession = profession, source = source, campaign = campaign, assigned_to = assigned_to, last_call_at = last_called_at,
        last_outcome_id = last_outcome_id, next_follow_up_at = next_follow_up_at, do_not_call = do_not_call,
        batch_leads = listOf(BatchLink(watch_minutes, attended, BatchMini(batchName, webinarAt))),
    )
}
@Serializable data class BatchList(val hot_minutes: Int = 60, val webinar_at: String? = null, val leads: List<BatchRow> = emptyList())
@Serializable data class Category(val id: String, val name: String, val position: Int = 0)

/** One entry in a lead's notes history. */
@Serializable data class NoteEntry(
    val kind: String, val at: String, val text: String? = null, val tags: List<String> = emptyList(), val outcome: String? = null,
    val direction: String? = null, val duration_sec: Int? = null, val purpose: String? = null, val by: String? = null,
)

@Serializable data class Nums(val calls: Int? = null, val conversations: Int? = null, val talk_minutes: Int? = null, val sales: Int? = null, val focus: Int? = null)
@Serializable data class Progress(val user_id: String, val target: Nums = Nums(), val actual: Nums = Nums(), val daily: Nums = Nums(), val work_days: Int = 0)
@Serializable data class ProgressReport(val work_days: Int = 0, val rows: List<Progress> = emptyList())

@Serializable data class PlaybookItem(
    val id: String, val kind: String, val section: String? = null, val title: String, val body: String? = null, val url: String? = null,
    val purpose: String = "both", val position: Int = 0, val status: String = "published", val created_by: String? = null, val review_note: String? = null,
)

@Serializable data class Announcement(
    val id: String, val title: String, val body: String, val urgent: Boolean = false, val created_at: String,
    val reminded_at: String? = null, val from: String? = null,
)
@Serializable data class NewLeads(val count: Int = 0, val names: List<String> = emptyList(), val latest: String? = null)

@Serializable data class CallReview(
    val id: String, val call_id: String, val rep_id: String, val reviewer: String? = null, val scores: Map<String, Int> = emptyMap(),
    val score_pct: Int? = null, val went_well: String? = null, val improve: String? = null, val task: String? = null, val task_due: String? = null,
    val task_done_at: String? = null, val seen_at: String? = null, val created_at: String, val started_at: String? = null,
    val duration_sec: Int = 0, val lead_name: String? = null, val phone: String = "", val recording_status: String? = null, val recording_path: String? = null,
)

@Serializable data class OrgAccess(val state: String = "active", val ends_at: String? = null, val grace_ends_at: String? = null, val days_left: Int? = null)

@Serializable data class IdName(val id: String, val name: String)
@Serializable data class CustomFilter(val key: String, val label: String, val values: List<String> = emptyList())
@Serializable data class FilterOptions(
    val enabled: List<String>? = null, val stages: List<IdName> = emptyList(), val categories: List<IdName> = emptyList(),
    val sources: List<String> = emptyList(), val campaigns: List<String> = emptyList(), val cities: List<String> = emptyList(),
    val custom: List<CustomFilter> = emptyList(),
)
/** Filters chosen in the Leads tab. */
data class LeadFilters(
    val followup: String = "all", val stages: Set<String> = emptySet(), val outcomes: Set<String> = emptySet(), val sources: Set<String> = emptySet(),
    val campaigns: Set<String> = emptySet(), val cities: Set<String> = emptySet(), val categories: Set<String> = emptySet(),
    val neverCalled: Boolean = false, val custom: Map<String, Set<String>> = emptyMap(),
    /** any | talked | not_picked | missed | never | tried3 (3+ dials, never talked) */
    val lastCall: String = "any",
    /** any | yes | no — WhatsApp sent from Closer OS */
    val messaged: String = "any",
    val hot: Boolean = false, val tags: Set<String> = emptySet(),
) {
    val count get() = (if (followup != "all") 1 else 0) + listOf(stages, outcomes, sources, campaigns, cities, categories, tags).count { it.isNotEmpty() } +
        (if (neverCalled) 1 else 0) + custom.count { it.value.isNotEmpty() } + (if (lastCall != "any") 1 else 0) + (if (messaged != "any") 1 else 0) + (if (hot) 1 else 0)
}

@Serializable data class BoardRow(val user_id: String, val name: String = "", val calls: Int = 0, val conversations: Int = 0, val talk_sec: Int = 0, val sales: Int = 0)
@Serializable data class BestTime(val hour: Int? = null, val source: String, val picked: Int? = null, val tries: Int? = null, val rate: Int? = null,
    val total_picked: Int? = null, val total_tries: Int? = null)

@Serializable data class CallRequest(val id: String, val lead_id: String, val purpose: String = "sales", val batch_id: String? = null)

@Serializable data class LeadMini(val name: String = "", val phone: String = "", val dial_count: Int = 0, val conversation_count: Int = 0, val call_count: Int = 0,
    val last_outcome_id: String? = null, val key_facts: String? = null, val profession: String? = null, val city: String? = null, val total_talk_sec: Int = 0)
@Serializable data class FollowUp(
    val id: String, val lead_id: String, val due_at: String, val status: String, val reason: String? = null,
    val notes: String? = null, val purpose: String = "sales", val lead: LeadMini? = null,
    val dialled_at: String? = null, val completed_at: String? = null,
)
@Serializable data class CallRow(
    val id: String, val direction: String, val started_at: String, val duration_sec: Int = 0,
    val outcome_id: String? = null, val notes: String? = null,
    val recording_status: String? = null, val recording_path: String? = null, val sim_slot: Int? = null, val channel: String = "phone",
)

@Serializable data class TodayStats(val calls: Int = 0, val connected: Int = 0, val talkSec: Int = 0, val notPicked: Int = 0, val missed: Int = 0)

private const val LEAD_COLUMNS = "*, batch_leads(watch_minutes, attended, batch:batches(name, webinar_at))"

object Repo {
    private val db get() = Backend.client.postgrest

    suspend fun signIn(email: String, password: String) {
        Backend.auth.signInWith(Email) { this.email = email.trim(); this.password = password }
    }

    suspend fun signOut() = Backend.auth.signOut()

    /** Joins companies that invited this email, then returns the first active membership. */
    suspend fun membership(): Membership? {
        val uid = Backend.uid ?: return null
        runCatching { db.rpc("accept_my_invitations") }
        return Backend.client.from("org_members")
            .select(Columns.raw("org_id, role, organization:organizations(id, name, phone_prefix, currency, timezone, settings)")) {
                filter { eq("user_id", uid); eq("status", "active") }
            }.decodeList<Membership>().firstOrNull()
    }

    suspend fun profile(): Profile? {
        val uid = Backend.uid ?: return null
        return Backend.client.from("profiles").select { filter { eq("id", uid) } }.decodeSingleOrNull<Profile>()
    }

    suspend fun filterOptions(orgId: String): FilterOptions =
        json.decodeFromString(db.rpc("lead_filter_options", buildJsonObject { put("p_org", orgId) }).data)

    suspend fun leads(orgId: String, query: String, page: Int, mineOnly: Boolean, f: LeadFilters = LeadFilters()): List<Lead> {
        // Text search covers name, phone, email, company, profession, city, own fields, key facts and all notes.
        val ids: List<String>? = if (query.trim().length >= 2) runCatching {
            json.decodeFromString<List<String>>(db.rpc("search_leads", buildJsonObject { put("p_org", orgId); put("p_q", query.trim()) }).data)
        }.getOrNull() else null
        if (ids != null && ids.isEmpty()) return emptyList()
        fun inList(v: Collection<String>) = "(" + v.joinToString(",") { "\"" + it.replace("\"", "") + "\"" } + ")"
        val q = query.trim()
        val digits = q.filter { it.isDigit() }
        return Backend.client.from("leads").select(Columns.raw(LEAD_COLUMNS)) {
            filter {
                eq("org_id", orgId)
                filter("deleted_at", FilterOperator.IS, "null")
                if (mineOnly) Backend.uid?.let { eq("assigned_to", it) }
                when {
                    ids != null -> filter("id", FilterOperator.IN, inList(ids))
                    digits.length >= 4 -> ilike("phone", "%$digits%")
                    q.isNotEmpty() -> ilike("name", "%${q.replace("%", "")}%")
                }
                val now = Instant.now()
                val dayEnd = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant()
                when (f.followup) {
                    "overdue" -> lt("next_follow_up_at", now.toString())
                    "today" -> { gte("next_follow_up_at", LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toString()); lt("next_follow_up_at", dayEnd.toString()) }
                    "upcoming" -> gte("next_follow_up_at", dayEnd.toString())
                    "none" -> filter("next_follow_up_at", FilterOperator.IS, "null")
                }
                if (f.stages.isNotEmpty()) filter("stage_id", FilterOperator.IN, inList(f.stages))
                if (f.outcomes.isNotEmpty()) filter("last_outcome_id", FilterOperator.IN, inList(f.outcomes))
                if (f.sources.isNotEmpty()) filter("source", FilterOperator.IN, inList(f.sources))
                if (f.campaigns.isNotEmpty()) filter("campaign", FilterOperator.IN, inList(f.campaigns))
                if (f.categories.isNotEmpty()) filter("profession_category_id", FilterOperator.IN, inList(f.categories))
                if (f.cities.isNotEmpty()) or { f.cities.forEach { ilike("city", it.replace(",", "").trim()) } }
                if (f.neverCalled) filter("last_call_at", FilterOperator.IS, "null")
                f.custom.filterValues { it.isNotEmpty() }.forEach { (k, v) -> filter("custom->>$k", FilterOperator.IN, inList(v)) }
                when (f.lastCall) {
                    "talked" -> eq("has_talked", true)
                    "not_picked" -> eq("last_call_status", "not_picked")
                    "missed" -> eq("last_call_status", "missed")
                    "never" -> eq("dial_count", 0)
                    "tried3" -> { gte("dial_count", 3); eq("has_talked", false) }
                }
                when (f.messaged) { "yes" -> gt("wa_count", 0); "no" -> eq("wa_count", 0) }
                if (f.hot) gte("score", 40)
                if (f.tags.isNotEmpty()) filter("tags", FilterOperator.OV, "{" + f.tags.joinToString(",") { "\"" + it.replace("\"", "") + "\"" } + "}")
            }
            order("next_follow_up_at", Order.ASCENDING, nullsFirst = false)
            order("created_at", Order.DESCENDING)
            range((page * 50).toLong(), (page * 50 + 49).toLong())
        }.decodeList()
    }

    suspend fun lead(id: String): Lead? = Backend.client.from("leads").select(Columns.raw(LEAD_COLUMNS)) { filter { eq("id", id) } }.decodeSingleOrNull()

    suspend fun leadNotes(id: String): List<NoteEntry> =
        json.decodeFromString(db.rpc("lead_notes", buildJsonObject { put("p_lead", id) }).data)

    suspend fun addNote(leadId: String, text: String, tags: List<String>) {
        db.rpc("add_lead_note", buildJsonObject { put("p_lead", leadId); put("p_text", text); put("p_tags", buildJsonArray { tags.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) })
    }

    suspend fun setKeyFacts(leadId: String, text: String) {
        db.rpc("set_key_facts", buildJsonObject { put("p_lead", leadId); put("p_text", text) })
    }

    /** My targets vs what I've done today (null when no targets are set). */
    suspend fun myProgressToday(org: Org): Progress? {
        val uid = Backend.uid ?: return null
        val zone = runCatching { ZoneId.of(org.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
        val today = LocalDate.now(zone).toString()
        val r: ProgressReport = json.decodeFromString(db.rpc("target_progress", buildJsonObject {
            put("p_org", org.id); put("p_from", today); put("p_to", today)
            put("p_users", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive(uid)) })
        }).data)
        return r.rows.firstOrNull { it.user_id == uid }?.takeIf { p -> listOf(p.target.calls, p.target.conversations, p.target.talk_minutes, p.target.sales, p.daily.focus).any { (it ?: 0) > 0 } }
    }

    suspend fun playbook(orgId: String): List<PlaybookItem> = Backend.client.from("playbook_items").select {
        filter { eq("org_id", orgId); neq("status", "archived") }
        order("position", Order.ASCENDING)
    }.decodeList()

    /** A rep's suggestion: waits for a manager's approval. */
    suspend fun suggestPlaybook(orgId: String, kind: String, title: String, body: String, url: String?) {
        Backend.client.from("playbook_items").insert(buildJsonObject {
            put("org_id", orgId); put("kind", kind); put("title", title); put("body", body); url?.let { put("url", it) }
            put("status", "pending"); put("created_by", Backend.uid)
        })
    }

    suspend fun myAnnouncements(orgId: String): List<Announcement> =
        json.decodeFromString(db.rpc("my_announcements", buildJsonObject { put("p_org", orgId) }).data)

    suspend fun markAnnouncement(id: String, ack: Boolean) {
        db.rpc("mark_announcement", buildJsonObject { put("p_id", id); put("p_ack", ack) })
    }

    suspend fun myNewLeads(orgId: String, sinceIso: String): NewLeads =
        json.decodeFromString(db.rpc("my_new_leads", buildJsonObject { put("p_org", orgId); put("p_since", sinceIso) }).data)

    suspend fun myReviews(orgId: String): List<CallReview> {
        val uid = Backend.uid ?: return emptyList()
        val all: List<CallReview> = json.decodeFromString(db.rpc("review_list", buildJsonObject { put("p_org", orgId); put("p_limit", 100) }).data)
        return all.filter { it.rep_id == uid }
    }

    suspend fun markReview(id: String, taskDone: Boolean) {
        db.rpc("mark_review", buildJsonObject { put("p_id", id); put("p_task_done", taskDone) })
    }

    suspend fun orgAccess(orgId: String): OrgAccess =
        json.decodeFromString(db.rpc("org_access", buildJsonObject { put("p_org", orgId) }).data)

    /** A company message's photo/video/PDF, saved in the app's cache so it can be shared to WhatsApp. */
    suspend fun companyFiles(orgId: String): List<CompanyFile> =
        db.from("company_files").select(Columns.raw("id,name,path,mime_type,size_bytes")) {
            filter { eq("org_id", orgId) }; order("position", Order.ASCENDING); order("created_at", Order.ASCENDING)
        }.decodeList()

    suspend fun templateMediaFile(ctx: android.content.Context, path: String, name: String?): java.io.File {
        val dir = java.io.File(ctx.cacheDir, "shared").apply { mkdirs() }
        val f = java.io.File(dir, (name ?: path.substringAfterLast('/')).replace(Regex("[^A-Za-z0-9._ -]"), "_"))
        if (!f.exists() || f.length() == 0L) f.writeBytes(Backend.client.storage.from("template-media").downloadAuthenticated(path))
        return f
    }

    // ── Reports in the app (same functions as the dashboard) ──
    suspend fun report(name: String, orgId: String, from: Instant, to: Instant, users: List<String>?): JsonElement =
        json.parseToJsonElement(db.rpc(name, buildJsonObject {
            put("p_org", orgId); put("p_from", from.toString()); put("p_to", to.toString())
            put("p_users", users?.let { u -> buildJsonArray { u.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } } ?: kotlinx.serialization.json.JsonNull)
        }).data)

    suspend fun targetsFor(orgId: String, from: LocalDate, to: LocalDate, users: List<String>?): ProgressReport =
        json.decodeFromString(db.rpc("target_progress", buildJsonObject {
            put("p_org", orgId); put("p_from", from.toString()); put("p_to", to.toString())
            put("p_users", users?.let { u -> buildJsonArray { u.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } } ?: kotlinx.serialization.json.JsonNull)
        }).data)

    suspend fun leadStatus(orgId: String, users: List<String>?, from: Instant?, to: Instant?): JsonObject =
        json.parseToJsonElement(db.rpc("lead_status_report", buildJsonObject {
            put("p_org", orgId)
            put("p_users", users?.let { u -> buildJsonArray { u.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } } ?: kotlinx.serialization.json.JsonNull)
            put("p_from", from?.let { kotlinx.serialization.json.JsonPrimitive(it.toString()) } ?: kotlinx.serialization.json.JsonNull)
            put("p_to", to?.let { kotlinx.serialization.json.JsonPrimitive(it.toString()) } ?: kotlinx.serialization.json.JsonNull)
        }).data).jsonObject

    suspend fun leaderboard(org: Org, period: String): List<BoardRow> {
        val zone = runCatching { ZoneId.of(org.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
        val today = LocalDate.now(zone)
        val from = when (period) { "week" -> today.minusDays((today.dayOfWeek.value - 1).toLong()); "month" -> today.withDayOfMonth(1); else -> today }
        return json.decodeFromString(db.rpc("leaderboard", buildJsonObject {
            put("p_org", org.id); put("p_from", from.atStartOfDay(zone).toInstant().toString()); put("p_to", today.plusDays(1).atStartOfDay(zone).toInstant().toString())
        }).data)
    }

    suspend fun setDoNotCall(leadId: String, value: Boolean) {
        db.rpc("set_do_not_call", buildJsonObject { put("p_lead", leadId); put("p_value", value) })
    }

    suspend fun bestTime(leadId: String): BestTime? = runCatching {
        val d = db.rpc("best_time_to_call", buildJsonObject { put("p_lead", leadId) }).data
        if (d.isBlank() || d == "null") null else json.decodeFromString<BestTime>(d)
    }.getOrNull()

    // ── Desk mode (laptop ↔ phone) ──
    suspend fun claimCallRequest(): CallRequest? {
        val d = db.rpc("claim_call_request").data
        return if (d.isBlank() || d == "null") null else json.decodeFromString<CallRequest>(d)
    }
    suspend fun callRequestEnded(id: String, callId: String, startedMs: Long, durationSec: Int, phone: String) {
        db.rpc("call_request_ended", buildJsonObject {
            put("p_id", id); put("p_call", callId); put("p_started", Instant.ofEpochMilli(startedMs).toString()); put("p_duration", durationSec); put("p_phone", phone)
        })
    }
    suspend fun callsWithOutcome(ids: List<String>): Set<String> = if (ids.isEmpty()) emptySet() else
        json.decodeFromString<List<String>>(db.rpc("calls_with_outcome", buildJsonObject {
            put("p_ids", buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        }).data).toSet()

    suspend fun teamBrief(orgId: String): List<IdName> =
        json.parseToJsonElement(db.rpc("team_brief", buildJsonObject { put("p_org", orgId) }).data).jsonArray.map {
            IdName(it.jsonObject["user_id"]!!.jsonPrimitive.content, it.jsonObject["name"]?.jsonPrimitive?.content ?: "")
        }

    suspend fun myBatches(orgId: String): List<BatchSummary> =
        json.decodeFromString(db.rpc("my_batches", buildJsonObject { put("p_org", orgId) }).data)

    suspend fun batchCallList(batchId: String, purpose: String, everyone: Boolean): BatchList =
        json.decodeFromString(db.rpc("batch_call_list", buildJsonObject { put("p_batch", batchId); put("p_purpose", purpose); put("p_everyone", everyone) }).data)

    suspend fun categories(orgId: String): List<Category> = Backend.client.from("profession_categories").select {
        filter { eq("org_id", orgId) }; order("position", Order.ASCENDING)
    }.decodeList()

    suspend fun leadsByIds(ids: List<String>): List<Lead> = if (ids.isEmpty()) emptyList() else
        Backend.client.from("leads").select(Columns.raw(LEAD_COLUMNS)) { filter { isIn("id", ids.distinct()) } }.decodeList()

    /** Short-lived private link to play a recording; each play is written to the audit log. */
    /** Downloads a call recording to the phone's cache (once) and returns the file — playing a local file works on every phone. */
    suspend fun recordingFile(cacheDir: java.io.File, callId: String, path: String): java.io.File {
        runCatching { db.rpc("log_recording_access", buildJsonObject { put("p_call", callId); put("p_action", "play") }) }
        val dir = java.io.File(cacheDir, "recordings").apply { mkdirs() }
        val f = java.io.File(dir, path.substringAfterLast('/'))
        if (f.exists() && f.length() > 0) return f
        val bytes = Backend.client.storage.from("recordings").downloadAuthenticated(path)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val tmp = java.io.File(dir, f.name + ".part"); tmp.writeBytes(bytes); tmp.renameTo(f)
            // Keep the cache small: newest 30 recordings.
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(30)?.forEach { it.delete() }
        }
        return f
    }

    suspend fun recordingUrl(callId: String, path: String): String {
        runCatching { db.rpc("log_recording_access", buildJsonObject { put("p_call", callId); put("p_action", "play") }) }
        return Backend.client.storage.from("recordings").createSignedUrl(path, kotlin.time.Duration.parse("15m"))
    }

    suspend fun reportDevice(p: JsonObject) { db.rpc("report_device_status", buildJsonObject { put("p", p) }) }

    suspend fun saveMyTemplate(orgId: String, name: String, body: String) {
        Backend.client.from("message_templates").insert(buildJsonObject {
            put("org_id", orgId); put("name", name); put("body", body); put("owner_id", Backend.uid); put("position", 1000)
        })
    }

    suspend fun deleteTemplate(id: String) { Backend.client.from("message_templates").delete { filter { eq("id", id) } } }

    suspend fun templates(orgId: String): List<Template> = Backend.client.from("message_templates").select {
        filter { eq("org_id", orgId); eq("is_active", true) }
        order("position", Order.ASCENDING)
    }.decodeList()

    suspend fun leadCalls(id: String): List<CallRow> = Backend.client.from("calls")
        .select(Columns.raw("id, direction, started_at, duration_sec, outcome_id, notes, recording_status, recording_path, sim_slot, channel")) {
            filter { eq("lead_id", id) }
            order("started_at", Order.DESCENDING)
            limit(20)
        }.decodeList()

    // ── Round 9: WhatsApp sends, effort reports, focus list ──
    private fun rpcJson(name: String, body: JsonObject): suspend () -> JsonElement = { json.parseToJsonElement(db.rpc(name, body).data) }
    private fun uuids(v: Collection<String>) = buildJsonArray { v.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }

    /** Records a WhatsApp message sent from Closer OS (counts as an interaction). Returns its id (for Undo). */
    suspend fun logWa(orgId: String, leadId: String?, phone: String, templateId: String?, templateName: String?, source: String): String? = runCatching {
        Backend.client.from("wa_messages").insert(buildJsonObject {
            put("org_id", orgId); leadId?.takeIf { it.isNotBlank() }?.let { put("lead_id", it) }; put("phone", phone)
            templateId?.let { put("template_id", it) }; templateName?.let { put("template_name", it) }; put("source", source)
        }) { select(Columns.raw("id")) }.decodeSingle<JsonObject>()["id"]?.jsonPrimitive?.content
    }.getOrNull()

    suspend fun undoWa(id: String) {
        Backend.client.from("wa_messages").update(buildJsonObject { put("undone_at", Instant.now().toString()) }) { filter { eq("id", id) } }
    }

    suspend fun waSentToday(orgId: String, templateId: String, leadIds: List<String>): Set<String> =
        json.decodeFromString<List<String>>(db.rpc("wa_sent_today", buildJsonObject { put("p_org", orgId); put("p_template", templateId); put("p_leads", uuids(leadIds)) }).data).toSet()

    suspend fun myWaToday(orgId: String): JsonElement = rpcJson("my_wa_today", buildJsonObject { put("p_org", orgId) })()

    /** call id → recording path, for the calls among [ids] that have a playable recording. */
    suspend fun recordingPaths(ids: List<String>): Map<String, String> = if (ids.isEmpty()) emptyMap() else
        json.decodeFromString<Map<String, String>>(db.rpc("call_recording_paths", buildJsonObject { put("p_ids", uuids(ids)) }).data)

    suspend fun myProgress(org: Org, from: LocalDate, to: LocalDate): Progress? {
        val uid = Backend.uid ?: return null
        return targetsFor(org.id, from, to, listOf(uid)).rows.firstOrNull()
    }

    private fun period(orgId: String, users: List<String>?, from: LocalDate?, to: LocalDate?) = buildJsonObject {
        put("p_org", orgId); put("p_users", users?.let { uuids(it) } ?: kotlinx.serialization.json.JsonNull)
        put("p_from", from?.toString()?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
        put("p_to", to?.toString()?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
    }

    suspend fun leadWorkReport(orgId: String, users: List<String>?, from: LocalDate?, to: LocalDate?): JsonElement =
        json.parseToJsonElement(db.rpc("lead_work_report", period(orgId, users, from, to)).data)

    suspend fun leadWorkList(orgId: String, users: List<String>?, from: LocalDate?, to: LocalDate?, kind: String, attempts: Int?, user: String?): List<Lead> =
        json.decodeFromString(db.rpc("lead_work_list", JsonObject(period(orgId, users, from, to) + mapOf(
            "p_kind" to kotlinx.serialization.json.JsonPrimitive(kind),
            "p_attempts" to (attempts?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull),
            "p_user" to (user?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)))).data)

    suspend fun salesRecipe(orgId: String, users: List<String>?, from: LocalDate?, to: LocalDate?): JsonElement =
        json.parseToJsonElement(db.rpc("sales_recipe", period(orgId, users, from, to)).data)

    suspend fun leadPath(leadId: String): JsonElement = json.parseToJsonElement(db.rpc("lead_path", buildJsonObject { put("p_lead", leadId) }).data)

    suspend fun focusList(orgId: String, limit: Int, offset: Int): JsonElement =
        json.parseToJsonElement(db.rpc("my_focus_list", buildJsonObject { put("p_org", orgId); put("p_limit", limit); put("p_offset", offset) }).data)

    suspend fun outcomes(orgId: String): List<Outcome> = Backend.client.from("call_outcomes").select {
        filter { eq("org_id", orgId); eq("is_active", true) }
        order("position", Order.ASCENDING)
    }.decodeList()

    suspend fun followUps(orgId: String): List<FollowUp> {
        val uid = Backend.uid ?: return emptyList()
        return Backend.client.from("follow_ups").select(Columns.raw("*, lead:leads(name, phone, dial_count, conversation_count, call_count, last_outcome_id, key_facts, profession, city, total_talk_sec)")) {
            filter { eq("org_id", orgId); eq("assigned_to", uid); eq("status", "pending") }
            order("due_at", Order.ASCENDING)
            limit(200)
        }.decodeList()
    }

    /** Follow-ups of the last 7 days that are finished, to show on time / late / not called. */
    suspend fun pastFollowUps(orgId: String): List<FollowUp> {
        val uid = Backend.uid ?: return emptyList()
        return Backend.client.from("follow_ups").select(Columns.raw("*, lead:leads(name, phone, dial_count, conversation_count, call_count, last_outcome_id, key_facts, profession, city, total_talk_sec)")) {
            filter { eq("org_id", orgId); eq("assigned_to", uid); eq("status", "done"); gte("due_at", Instant.now().minusSeconds(7 * 86400).toString()) }
            order("due_at", Order.DESCENDING)
            limit(300)
        }.decodeList()
    }

    suspend fun setMyPhone(orgId: String, phone: String) {
        db.rpc("set_member_phone", buildJsonObject { put("p_org", orgId); put("p_user", Backend.uid); put("p_phone", phone) })
    }

    /** Leads (visible to me) for a list of numbers, keyed by the number as stored (+91…). */
    suspend fun leadsByPhones(orgId: String, phones: List<String>): Map<String, Lead> {
        if (phones.isEmpty()) return emptyMap()
        return phones.distinct().chunked(150).flatMap { chunk ->
            Backend.client.from("leads").select(Columns.raw(LEAD_COLUMNS)) {
                filter { eq("org_id", orgId); isIn("phone", chunk); filter("deleted_at", FilterOperator.IS, "null") }
            }.decodeList<Lead>()
        }.associateBy { it.phone }
    }

    /** Adds a lead from the phone (it is assigned to the rep who adds it). */
    suspend fun createLead(orgId: String, name: String, phone: String, profession: String?, notes: String?): Lead =
        Backend.client.from("leads").insert(buildJsonObject {
            put("org_id", orgId); put("name", name.trim()); put("phone", phone); put("source", "Phone call")
            profession?.takeIf { it.isNotBlank() }?.let { put("profession", it.trim()) }
            notes?.takeIf { it.isNotBlank() }?.let { put("notes", it.trim()) }
        }) { select() }.decodeSingle()

    /** Saves a call with its outcome (see log_call in the database). */
    suspend fun logCall(payload: JsonObject) {
        db.rpc("log_call", buildJsonObject { put("p", payload) })
    }

    /** Uploads call-log entries. Returns how many were stored. */
    suspend fun syncCalls(orgId: String, calls: JsonArray): Int {
        val res = db.rpc("sync_calls", buildJsonObject { put("p_org", orgId); put("p_calls", calls) })
        return json.parseToJsonElement(res.data).jsonObject["synced"]?.jsonPrimitive?.intOrNull ?: 0
    }

    /** Today's numbers for the signed-in rep, from the same report the dashboard uses. */
    suspend fun todayStats(org: Org): TodayStats {
        val uid = Backend.uid ?: return TodayStats()
        val zone = runCatching { ZoneId.of(org.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
        val start = LocalDate.now(zone).atStartOfDay(zone).toInstant()
        val res = db.rpc("call_report", buildJsonObject {
            put("p_org", org.id); put("p_from", start.toString()); put("p_to", start.plusSeconds(86400).toString())
            put("p_users", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive(uid)) })
        })
        val rows = json.parseToJsonElement(res.data).jsonObject["rows"]?.jsonArray ?: return TodayStats()
        val total = rows.map { it.jsonObject }.firstOrNull { it["g"]?.jsonPrimitive?.int == 15 } ?: return TodayStats()
        fun i(k: String) = total[k]?.jsonPrimitive?.intOrNull ?: 0
        return TodayStats(i("calls"), i("conn"), i("conn_dur"), i("not_picked"), i("missed"))
    }
}

fun JsonElement.str(k: String): String? = runCatching { jsonObject[k]?.jsonPrimitive?.content }.getOrNull()
fun nowIso(): String = Instant.now().toString()
