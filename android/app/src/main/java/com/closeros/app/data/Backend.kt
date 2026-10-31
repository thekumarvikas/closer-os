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
import kotlinx.serialization.json.put
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
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
    }
    val auth get() = client.auth
    val uid: String? get() = client.auth.currentUserOrNull()?.id
}

@Serializable data class Org(
    val id: String, val name: String, val phone_prefix: String = "+91", val currency: String = "INR",
    val timezone: String = "Asia/Kolkata",
)
@Serializable data class Membership(val org_id: String, val role: String, val organization: Org)
@Serializable data class Profile(val id: String, val email: String? = null, val full_name: String? = null)

@Serializable data class Lead(
    val id: String, val org_id: String, val name: String = "", val phone: String, val email: String? = null,
    val city: String? = null, val state: String? = null, val company: String? = null, val profession: String? = null,
    val source: String? = null, val campaign: String? = null, val assigned_to: String? = null,
    val stage_id: String? = null, val deal_value: Double? = null, val notes: String? = null,
    val last_call_at: String? = null, val last_outcome_id: String? = null, val next_follow_up_at: String? = null,
    val do_not_call: Boolean = false,
)

@Serializable data class Outcome(
    val id: String, val code: String, val label: String, val category: String, val form: String? = null,
    val purpose: String = "sales", val position: Int = 0, val is_active: Boolean = true,
)

@Serializable data class LeadMini(val name: String = "", val phone: String = "")
@Serializable data class FollowUp(
    val id: String, val lead_id: String, val due_at: String, val status: String, val reason: String? = null,
    val notes: String? = null, val purpose: String = "sales", val lead: LeadMini? = null,
)
@Serializable data class CallRow(
    val id: String, val direction: String, val started_at: String, val duration_sec: Int = 0,
    val outcome_id: String? = null, val notes: String? = null,
)

data class TodayStats(val calls: Int = 0, val connected: Int = 0, val talkSec: Int = 0, val notPicked: Int = 0, val missed: Int = 0)

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
            .select(Columns.raw("org_id, role, organization:organizations(id, name, phone_prefix, currency, timezone)")) {
                filter { eq("user_id", uid); eq("status", "active") }
            }.decodeList<Membership>().firstOrNull()
    }

    suspend fun profile(): Profile? {
        val uid = Backend.uid ?: return null
        return Backend.client.from("profiles").select { filter { eq("id", uid) } }.decodeSingleOrNull<Profile>()
    }

    suspend fun leads(orgId: String, query: String, page: Int, mineOnly: Boolean): List<Lead> {
        val q = query.trim()
        val digits = q.filter { it.isDigit() }
        return Backend.client.from("leads").select {
            filter {
                eq("org_id", orgId)
                filter("deleted_at", FilterOperator.IS, "null")
                if (mineOnly) Backend.uid?.let { eq("assigned_to", it) }
                when {
                    digits.length >= 4 -> ilike("phone", "%$digits%")
                    q.isNotEmpty() -> ilike("name", "%${q.replace("%", "")}%")
                }
            }
            order("next_follow_up_at", Order.ASCENDING, nullsFirst = false)
            order("created_at", Order.DESCENDING)
            range((page * 50).toLong(), (page * 50 + 49).toLong())
        }.decodeList()
    }

    suspend fun lead(id: String): Lead? = Backend.client.from("leads").select { filter { eq("id", id) } }.decodeSingleOrNull()

    suspend fun leadCalls(id: String): List<CallRow> = Backend.client.from("calls")
        .select(Columns.raw("id, direction, started_at, duration_sec, outcome_id, notes")) {
            filter { eq("lead_id", id) }
            order("started_at", Order.DESCENDING)
            limit(20)
        }.decodeList()

    suspend fun outcomes(orgId: String): List<Outcome> = Backend.client.from("call_outcomes").select {
        filter { eq("org_id", orgId); eq("is_active", true) }
        order("position", Order.ASCENDING)
    }.decodeList()

    suspend fun followUps(orgId: String): List<FollowUp> {
        val uid = Backend.uid ?: return emptyList()
        return Backend.client.from("follow_ups").select(Columns.raw("*, lead:leads(name, phone)")) {
            filter { eq("org_id", orgId); eq("assigned_to", uid); eq("status", "pending") }
            order("due_at", Order.ASCENDING)
            limit(200)
        }.decodeList()
    }

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
