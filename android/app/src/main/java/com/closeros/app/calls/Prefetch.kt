package com.closeros.app.calls

import android.content.Context
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalDb
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Membership
import com.closeros.app.data.Net
import com.closeros.app.data.Repo
import com.closeros.app.data.json
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.ZoneId

/**
 * While the phone is online, quietly saves a copy of the screens a rep opens most (reports, lead work,
 * playbook, follow-ups, focus, webinars, messages) and the newest call recordings — so all of them
 * open with no internet later, even if the rep never opened them before. At most every 30 minutes.
 */
object Prefetch {
    @Serializable private data class Rec(val id: String, val recording_path: String? = null)
    @Serializable private data class OcRow(val id: String, val outcome_id: String? = null, val lead_id: String? = null, val started_at: String)

    suspend fun run(ctx: Context, force: Boolean = false) {
        if (!Net.isOnline) return
        val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - p.getLong("prefetch_ms", 0) < 30 * 60_000) return
        p.edit().putLong("prefetch_ms", now).apply()
        val m = LocalDb.get(ctx).get("membership")?.let { runCatching { json.decodeFromString<Membership>(it) }.getOrNull() } ?: return
        val org = m.org_id
        val uid = Backend.uid ?: return
        val manager = m.role in setOf("owner", "admin", "manager")
        suspend fun t(block: suspend () -> Unit) { runCatching { block() } }

        t { Repo.playbook(org) }; t { Repo.templates(org) }; t { Repo.companyFiles(org) }; t { Repo.categories(org) }; t { Repo.outcomes(org) }
        t { Repo.pastFollowUps(org) }; t { Repo.myBatches(org) }; t { Repo.focusList(org, 1000, 0) }
        t { Repo.leaderboard(m.organization, "today") }

        // Reports: Today, Yesterday, Last 7 days, This month — for me, and for everyone if a manager.
        val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
        val today = LocalDate.now(zone)
        val periods = listOf(today to today, today.minusDays(1) to today.minusDays(1), today.minusDays(6) to today, today.withDayOfMonth(1) to today)
        val whos: List<List<String>?> = if (manager) listOf(null, listOf(uid)) else listOf(listOf(uid))
        for (users in whos) {
            for ((from, to) in periods) {
                val a = from.atStartOfDay(zone).toInstant(); val b = to.plusDays(1).atStartOfDay(zone).toInstant()
                t { Repo.report("call_report", org, a, b, users) }
                t { Repo.report("outcome_report", org, a, b, users) }
                t { Repo.report("follow_up_report", org, a, b, users) }
                t { Repo.targetsFor(org, from, to, users) }
            }
            t { Repo.leadStatus(org, users, null, null) }
            for (k in listOf("today", "week", "month", "all")) { val (f, to) = com.closeros.app.ui.range(k); t { Repo.leadWorkReport(org, users, f, to) } }
        }

        // Outcomes of my calls saved anywhere (laptop desk, earlier app versions) → my phone reports count them.
        t {
            val rows = Backend.client.from("calls").select(Columns.raw("id,outcome_id,lead_id,started_at")) {
                filter { eq("org_id", org); eq("user_id", uid); gte("started_at", java.time.Instant.now().minusSeconds(45L * 86400).toString()); neq("outcome_id", "00000000-0000-0000-0000-000000000000") }
                order("started_at", Order.DESCENDING); limit(5000)
            }.decodeList<OcRow>()
            com.closeros.app.data.LocalReports.merge(ctx, rows.filter { it.outcome_id != null }.associate { r ->
                r.id to "${r.outcome_id}|${r.lead_id.orEmpty()}|${runCatching { com.closeros.app.data.parseInstant(r.started_at).toEpochMilli() }.getOrDefault(now)}" })
        }

        // The newest recordings of my calls, so they play with no internet too.
        t {
            val recs = Backend.client.from("calls").select(Columns.raw("id,recording_path")) {
                filter { eq("org_id", org); eq("user_id", uid); eq("recording_status", "uploaded") }
                order("started_at", Order.DESCENDING); limit(30)
            }.decodeList<Rec>()
            recs.forEach { r -> r.recording_path?.let { path -> t { Repo.recordingFile(ctx.cacheDir, r.id, path, audit = false) } } }
        }
    }
}
