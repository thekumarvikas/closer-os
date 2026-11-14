package com.closeros.app.calls

import android.content.Context
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalDb
import com.closeros.app.data.Membership
import com.closeros.app.data.Net
import com.closeros.app.data.Repo
import com.closeros.app.data.json
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.time.LocalDate
import java.time.ZoneId

/**
 * Keeps the phone's copies fresh with as little server work as possible:
 *  - Management content (playbook, scripts, templates, company files, outcomes, profession groups,
 *    webinars, targets) is downloaded only when management changed it — one tiny "what changed?"
 *    call (content_versions) — or once a day as a safety net.
 *  - My own numbers (calls, outcomes, follow-ups, lead status, lead work, focus list) are NOT
 *    downloaded: the phone counts them itself from its call log and lead copy.
 *  - Outcomes of my calls saved somewhere else (laptop, a teammate on a shared lead) arrive as
 *    "only what changed since last time".
 *  - Recordings are played from the phone's own recordings folder; nothing is pre-downloaded.
 * Manager team reports are fetched when opened (their last copy stays for offline).
 */
object Prefetch {
    @Serializable private data class OcRow(val id: String, val outcome_id: String? = null, val lead_id: String? = null,
                                           val started_at: String, val updated_at: String? = null)
    private val vSer = MapSerializer(String.serializer(), Long.serializer())

    suspend fun run(ctx: Context, force: Boolean = false) {
        if (!Net.isOnline) return
        val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - p.getLong("prefetch_ms", 0) < 15 * 60_000) return
        p.edit().putLong("prefetch_ms", now).apply()
        val db = LocalDb.get(ctx)
        val m = db.get("membership")?.let { runCatching { json.decodeFromString<Membership>(it) }.getOrNull() } ?: return
        val org = m.org_id
        val uid = Backend.uid ?: return
        suspend fun t(block: suspend () -> Unit) = runCatching { block() }.isSuccess

        // 1) Management content: only the parts that changed (or everything once a day).
        val seen = db.get("content_v")?.let { runCatching { json.decodeFromString(vSer, it) }.getOrNull() } ?: emptyMap()
        val current = runCatching { Repo.contentVersions(org) }.getOrNull()
        val daily = now - p.getLong("content_full_ms", 0) > 24 * 3_600_000L
        if (current != null || daily) {
            fun changed(k: String) = daily || current?.get(k) != seen[k]
            val ok = mutableMapOf<String, Long>()
            fun keep(k: String, success: Boolean) { if (success) current?.get(k)?.let { ok[k] = it } else seen[k]?.let { ok[k] = it } }
            for ((k, fetch) in listOf<Pair<String, suspend () -> Unit>>(
                "playbook" to { Repo.playbook(org); com.closeros.app.data.Notes.objections(org) }, "templates" to { Repo.templates(org) }, "files" to { Repo.companyFiles(org) },
                "categories" to { Repo.categories(org) }, "outcomes" to { Repo.outcomes(org) }, "batches" to { Repo.myBatches(org) })) {
                if (changed(k)) keep(k, t(fetch)) else seen[k]?.let { ok[k] = it }
            }
            // Targets for my report periods: when the manager changes them, and once a new day starts.
            val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
            val today = LocalDate.now(zone)
            if (changed("targets") || p.getString("targets_day", null) != today.toString()) {
                val periods = listOf(today to today, today.minusDays(1) to today.minusDays(1), today.minusDays(6) to today, today.withDayOfMonth(1) to today)
                val all = periods.all { (f, to) -> t { Repo.targetsFor(org, f, to, listOf(uid)) } }
                if (all) p.edit().putString("targets_day", today.toString()).apply()
                keep("targets", all)
            } else seen["targets"]?.let { ok["targets"] = it }
            current?.get("settings")?.let { ok["settings"] = it }
            db.put("content_v", json.encodeToString(vSer, ok))
            if (daily) p.edit().putLong("content_full_ms", now).apply()
        }

        // 2) Outcomes of my calls saved elsewhere (laptop desk, a teammate on a shared lead): only what changed.
        t {
            val since = p.getString("oc_since", null) ?: java.time.Instant.now().minusSeconds(45L * 86400).toString()
            val rows = Backend.client.from("calls").select(Columns.raw("id,outcome_id,lead_id,started_at,updated_at")) {
                filter { eq("org_id", org); eq("user_id", uid); gt("updated_at", since); neq("outcome_id", "00000000-0000-0000-0000-000000000000") }
                order("updated_at", Order.ASCENDING); limit(2000)
            }.decodeList<OcRow>()
            val withOutcome = rows.filter { it.outcome_id != null }
            if (withOutcome.isNotEmpty()) com.closeros.app.data.LocalReports.merge(ctx, withOutcome.associate { r ->
                r.id to "${r.outcome_id}|${r.lead_id.orEmpty()}|${runCatching { com.closeros.app.data.parseInstant(r.started_at).toEpochMilli() }.getOrDefault(now)}" })
            rows.lastOrNull()?.updated_at?.let { p.edit().putString("oc_since", it).apply() }
        }
    }
}
