package com.closeros.app.data

import android.content.Context
import com.closeros.app.calls.LogCall
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.calls.WhatsAppCalls
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * "My" numbers worked out on the phone itself — from the phone's own call history, the outcomes saved
 * on this phone, the follow-ups and the lead copy. No internet needed, always up to the minute, and the
 * SAME counting rules as the dashboard (call_report, outcome_report, follow_up_report, target_progress,
 * lead_status_report), so the rep's phone and the manager's screen show the same numbers.
 */
object LocalReports {
    // ── Outcomes saved from this phone (call id → outcome id + lead id), kept 60 days ──
    private const val KEY = "my_outcomes"
    private val lock = Any()
    private val mapSer = MapSerializer(String.serializer(), String.serializer())

    private fun outcomesMap(ctx: Context): Map<String, String> =
        LocalDb.get(ctx).get(KEY)?.let { runCatching { json.decodeFromString(mapSer, it) }.getOrNull() } ?: emptyMap()

    /** Call id → outcome id, for outcomes saved from this phone (used by the Calls search). */
    fun outcomeOfCalls(ctx: Context): Map<String, String> = outcomesMap(ctx).mapValues { it.value.substringBefore('|') }

    /** Remember an outcome saved on this phone ("outcomeId|leadId|savedAtMs"). */
    fun recordOutcome(ctx: Context, payload: JsonObject) {
        val id = payload["id"]?.jsonPrimitive?.content ?: return
        val oc = payload["outcome_id"]?.jsonPrimitive?.content?.takeIf { it != "null" } ?: return
        val lead = payload["lead_id"]?.jsonPrimitive?.content?.takeIf { it != "null" }.orEmpty()
        merge(ctx, mapOf(id to "$oc|$lead|${System.currentTimeMillis()}"))
        // Sale amount (for the hourly check-in's "🎉 1 sale · ₹12,000").
        val od = payload["outcome_data"] as? JsonObject
        val amt = (od?.get("amount") ?: od?.get("deal_value"))?.jsonPrimitive?.content?.toLongOrNull()
        if (amt != null) synchronized(lock) {
            val m = LocalDb.get(ctx).get("my_sale_amounts")?.let { runCatching { json.decodeFromString(mapSer, it) }.getOrNull() }.orEmpty()
            LocalDb.get(ctx).put("my_sale_amounts", json.encodeToString(mapSer, (m + (id to amt.toString())).entries.toList().takeLast(500).associate { it.key to it.value }))
        }
    }

    /** My sales (won outcomes) among these call ids: (callId, leadId, amount ₹ or null). */
    fun sales(ctx: Context, callIds: Set<String>, outcomeList: List<Outcome>): List<Triple<String, String?, Long?>> {
        val won = outcomeList.filter { it.category == "won" }.map { it.id }.toSet()
        val amounts = LocalDb.get(ctx).get("my_sale_amounts")?.let { runCatching { json.decodeFromString(mapSer, it) }.getOrNull() }.orEmpty()
        return outcomes(ctx).filter { (k, v) -> k in callIds && v.outcome in won }.map { (k, v) -> Triple(k, v.lead, amounts[k]?.toLongOrNull()) }
    }

    /** Outcomes of my calls from the server (saved on the laptop or before this phone), merged in. */
    fun merge(ctx: Context, more: Map<String, String>) = synchronized(lock) {
        val cutoff = System.currentTimeMillis() - 60L * 86_400_000
        val all = (outcomesMap(ctx) + more).filterValues { v -> (v.substringAfterLast('|').toLongOrNull() ?: Long.MAX_VALUE) > cutoff }
        LocalDb.get(ctx).put(KEY, json.encodeToString(mapSer, all))
    }

    private data class Oc(val outcome: String, val lead: String?)
    private fun outcomes(ctx: Context): Map<String, Oc> = outcomesMap(ctx).mapValues { (_, v) ->
        val p = v.split('|'); Oc(p[0], p.getOrNull(1)?.takeIf { it.isNotBlank() })
    }

    // ── The calls ──
    private fun digits(s: String) = s.filter { it.isDigit() }.takeLast(10)

    /** Calls the server would count: real numbers (8+ digits) or WhatsApp calls with a saved name. */
    private fun counted(c: LogCall) = digits(c.phone).length >= 8 || (c.channel == "whatsapp" && !c.name.isNullOrBlank())

    private fun callsSince(ctx: Context, fromMs: Long): List<LogCall> =
        (PhoneCalls.readLog(ctx, fromMs - 1, 50_000) + WhatsAppCalls.asLog(ctx, fromMs - 1)).filter(::counted).sortedBy { it.startedAtMs }

    private fun range(from: LocalDate, to: LocalDate, zone: ZoneId) =
        from.atStartOfDay(zone).toInstant().toEpochMilli() to to.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

    private fun talk(c: LogCall) = if (c.direction == "incoming" || c.direction == "outgoing") c.durationSec else 0

    /** Same shape as the server's call_report "rows" (g 15 = total, 11 = by day, 13 = by hour). */
    fun callReport(ctx: Context, from: LocalDate, to: LocalDate, zone: ZoneId): JsonObject {
        val (a, b) = range(from, to, zone)
        val later = callsSince(ctx, a)                 // also calls after the period (for "never called back")
        val calls = later.filter { it.startedAtMs < b }
        fun neverAttended(c: LogCall): Boolean {
            if (c.direction != "missed" && c.direction != "rejected") return false
            val d = digits(c.phone)
            return later.none { r -> r.startedAtMs > c.startedAtMs && digits(r.phone) == d && (r.direction == "outgoing" || (r.direction == "incoming" && r.durationSec > 0)) }
        }
        fun row(g: Int, list: List<LogCall>, extra: JsonObject.() -> Unit = {}) = buildJsonObject {
            val conn = list.filter { talk(it) > 0 }
            put("g", g); put("calls", list.size)
            put("dur", list.sumOf { talk(it) })
            put("inc", list.count { it.direction == "incoming" }); put("out", list.count { it.direction == "outgoing" })
            put("inc_conn", list.count { it.direction == "incoming" && it.durationSec > 0 }); put("out_conn", list.count { it.direction == "outgoing" && it.durationSec > 0 })
            put("missed", list.count { it.direction == "missed" }); put("rejected", list.count { it.direction == "rejected" })
            put("conn", conn.size); put("conn_dur", conn.sumOf { talk(it) })
            put("not_picked", list.count { it.direction == "outgoing" && it.durationSec == 0 })
            put("never_attended", list.count(::neverAttended))
            put("uniq", list.map { digits(it.phone).ifEmpty { it.name.orEmpty() } }.toSet().size)
            put("uniq_conn", conn.map { digits(it.phone).ifEmpty { it.name.orEmpty() } }.toSet().size)
        }
        val rows = buildJsonArray {
            add(row(15, calls))
            calls.groupBy { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).toLocalDate() }.forEach { (d, l) ->
                add(JsonObject(row(11, l) + ("day" to JsonPrimitive(d.toString())))) }
            calls.groupBy { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).hour }.forEach { (h, l) ->
                add(JsonObject(row(13, l) + ("hr" to JsonPrimitive(h)))) }
        }
        return buildJsonObject { put("rows", rows) }
    }

    /** Same shape as outcome_report rows with g = 6 (by outcome): outcome_id, calls, leads. */
    fun outcomeReport(ctx: Context, from: LocalDate, to: LocalDate, zone: ZoneId): JsonObject {
        val (a, b) = range(from, to, zone)
        val ids = callsSince(ctx, a).filter { it.startedAtMs < b }.map { it.id }.toSet()
        val mine = outcomes(ctx).filterKeys { it in ids }.values
        val rows = buildJsonArray {
            mine.groupBy { it.outcome }.forEach { (o, l) ->
                add(buildJsonObject { put("g", 6); put("outcome_id", o); put("calls", l.size); put("leads", l.mapNotNull { it.lead }.toSet().size) })
            }
        }
        return buildJsonObject { put("rows", rows) }
    }

    /** Follow-ups due in the period (g = 1): due, on time (≤ 15 min after due), late, not called, still upcoming. */
    fun followUpReport(ctx: Context, orgId: String, from: LocalDate, to: LocalDate, zone: ZoneId): JsonArray {
        val (a, b) = range(from, to, zone)
        val db = LocalDb.get(ctx)
        val pending = db.get("followUps")?.let { runCatching { json.decodeFromString<List<FollowUp>>(it) }.getOrNull() }.orEmpty()
        val past = db.get("srv:pastfu:$orgId")?.let { runCatching { json.decodeFromString<List<FollowUp>>(it) }.getOrNull() }.orEmpty()
        val all = (pending + past).distinctBy { it.id }.mapNotNull { f -> runCatching { parseInstant(f.due_at).toEpochMilli() }.getOrNull()?.let { f to it } }
            .filter { (_, due) -> due in a until b }
        val log = callsSince(ctx, a - 15 * 60_000).filter { it.direction == "outgoing" }
        val now = System.currentTimeMillis()
        var onTime = 0; var late = 0; var missed = 0; var upcoming = 0
        for ((f, due) in all) {
            val ph = digits(f.lead?.phone.orEmpty())
            val dialled = f.dialled_at?.let { runCatching { parseInstant(it).toEpochMilli() }.getOrNull() }
                ?: log.firstOrNull { it.startedAtMs >= due - 10 * 60_000 && it.startedAtMs <= due + 2 * 86_400_000L && ph.isNotEmpty() && digits(it.phone) == ph }?.startedAtMs
            when {
                dialled != null && dialled <= due + 15 * 60_000 -> onTime++
                dialled != null -> late++
                now > due + 15 * 60_000 -> missed++
                else -> upcoming++
            }
        }
        return buildJsonArray { add(buildJsonObject { put("g", 1); put("due", all.size); put("on_time", onTime); put("late", late); put("missed", missed); put("upcoming", upcoming) }) }
    }

    /** My actual numbers for targets (same rules as target_progress): dialled, talked, talk minutes, sales. */
    fun actuals(ctx: Context, from: LocalDate, to: LocalDate, zone: ZoneId, outcomeList: List<Outcome>): Nums {
        val (a, b) = range(from, to, zone)
        val calls = callsSince(ctx, a).filter { it.startedAtMs < b }
        val won = outcomeList.filter { it.category == "won" }.map { it.id }.toSet()
        val oc = outcomes(ctx)
        return Nums(calls = calls.count { it.direction == "outgoing" }, conversations = calls.count { it.durationSec > 0 && talk(it) > 0 },
            talk_minutes = calls.sumOf { talk(it) } / 60, sales = calls.count { oc[it.id]?.outcome in won })
    }

    /** Targets from the manager (server, or its saved copy) with MY actual numbers worked out here. */
    fun withMyActuals(ctx: Context, p: Progress?, from: LocalDate, to: LocalDate, zone: ZoneId, outcomeList: List<Outcome>): Progress? =
        p?.copy(actual = actuals(ctx, from, to, zone, outcomeList).copy(focus = p.actual.focus))

    /** Same shape as lead_status_report for my own leads, from the lead copy on the phone. */
    fun leadStatus(ctx: Context, uid: String?, outcomeList: List<Outcome>, from: Instant?, to: Instant?): JsonObject {
        val cat = outcomeList.associate { it.id to it.category }
        val mine = LocalLeads.all(ctx).filter { (uid == null || it.assigned_to == uid) &&
            (from == null || it.assigned_at?.let { s -> runCatching { parseInstant(s) }.getOrNull() }?.let { t -> !t.isBefore(from) && (to == null || t.isBefore(to)) } == true) }
        return buildJsonObject {
            put("total", mine.size)
            put("called", mine.count { it.call_count > 0 || it.last_call_at != null })
            put("reached", mine.count { it.has_talked || it.conversation_count > 0 })
            put("never_called", mine.count { it.dial_count == 0 && it.last_call_at == null })
            put("by_outcome", buildJsonArray {
                mine.filter { it.last_outcome_id != null }.groupBy { it.last_outcome_id!! }.forEach { (o, l) ->
                    add(buildJsonObject { put("outcome_id", o); put("leads", l.size) }) }
            })
            put("by_category", buildJsonObject {
                mine.mapNotNull { l -> l.last_outcome_id?.let { cat[it] } }.groupingBy { it }.eachCount().forEach { (c, n) -> put(c, n) }
            })
            put("by_rep", JsonArray(emptyList()))
            put("note", JsonNull)
        }
    }

    /** Same shape as lead_work_report for MY leads, from the lead copy on the phone (period = when assigned). */
    fun leadWork(ctx: Context, uid: String?, outcomeList: List<Outcome>, from: java.time.LocalDate?, to: java.time.LocalDate?, zone: ZoneId): JsonObject {
        val cat = outcomeList.associate { it.id to it.category }
        val a = from?.atStartOfDay(zone)?.toInstant(); val b = to?.plusDays(1)?.atStartOfDay(zone)?.toInstant()
        val mine = LocalLeads.all(ctx).filter { l -> (uid == null || l.assigned_to == uid) &&
            (a == null && b == null || l.assigned_at?.let { s -> runCatching { parseInstant(s) }.getOrNull() }?.let { t -> (a == null || !t.isBefore(a)) && (b == null || t.isBefore(b)) } == true) }
        fun junk(l: Lead) = l.do_not_call || cat[l.last_outcome_id] == "invalid"
        fun avgTalkDial(ls: List<Lead>) = ls.mapNotNull { it.first_talk_dial }.takeIf { it.isNotEmpty() }?.average()?.let { kotlin.math.round(it * 10) / 10 }
        fun counts(ls: List<Lead>) = buildJsonObject {
            put("assigned", ls.size); put("dialled", ls.count { it.dial_count > 0 }); put("never", ls.count { it.dial_count == 0 })
            put("conversation", ls.count { it.has_talked }); put("not_reached", ls.count { it.dial_count > 0 && !it.has_talked && !junk(it) })
            put("junk", ls.count { junk(it) }); avgTalkDial(ls)?.let { put("avg_dials_to_talk", it) } ?: put("avg_dials_to_talk", JsonNull)
        }
        return buildJsonObject {
            put("totals", counts(mine))
            put("attempts", buildJsonArray {
                mine.groupBy { minOf(it.dial_count, 6) }.toSortedMap().forEach { (n, ls) -> add(buildJsonObject {
                    put("n", n); put("leads", ls.size)
                    put("talked_on", ls.count { it.first_talk_dial == n || (n == 6 && (it.first_talk_dial ?: 0) >= 6) })
                    put("talked", ls.count { it.has_talked }); put("not_talked", ls.count { !it.has_talked && !junk(it) }); put("junk", ls.count { junk(it) })
                }) }
            })
            put("people", buildJsonArray {
                if (mine.isNotEmpty()) add(buildJsonObject {
                    put("user_id", uid ?: ""); put("name", "Me")
                    counts(mine).forEach { (k, v) -> put(k, v) }
                })
            })
            put("counted_on_phone", true)
        }
    }
}
