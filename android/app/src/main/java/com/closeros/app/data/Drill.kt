package com.closeros.app.data

import com.closeros.app.calls.LogCall
import java.time.Instant
import java.time.ZoneId

/**
 * "What's behind this number?" — the calls behind a report tile, with exactly the rules the report used to count them,
 * so a tile showing 12 always opens 12 calls. Used for my own numbers (worked out on the phone) and for team
 * numbers (calls from the server) alike.
 *
 * Keys: all · dialled · received · conversations · noanswer · missed · never · uniq · reached · won ·
 *       outcome:<id> · hour:<0-23> · day:<yyyy-mm-dd>
 */
object Drill {
    private fun digits(s: String) = s.filter { it.isDigit() }.takeLast(10)
    private fun talk(c: LogCall) = if (c.direction == "incoming" || c.direction == "outgoing") c.durationSec else 0
    private fun who(c: LogCall) = digits(c.phone).ifEmpty { c.name.orEmpty() }

    /** [calls] = the period; [later] = the period plus everything after it (to tell "never called back"). Newest first. */
    fun filterCalls(calls: List<LogCall>, later: List<LogCall>, key: String, zone: ZoneId,
                    outcomeOf: (LogCall) -> String?, won: Set<String>): List<LogCall> {
        fun neverCalledBack(c: LogCall): Boolean {
            if (c.direction != "missed" && c.direction != "rejected") return false
            val d = digits(c.phone)
            return later.none { r -> r.startedAtMs > c.startedAtMs && digits(r.phone) == d &&
                (r.direction == "outgoing" || (r.direction == "incoming" && r.durationSec > 0)) }
        }
        val kind = key.substringBefore(':'); val arg = key.substringAfter(':', "")
        val newest = calls.sortedByDescending { it.startedAtMs }
        return when (kind) {
            "dialled" -> newest.filter { it.direction == "outgoing" }
            "received" -> newest.filter { it.direction == "incoming" }
            "conversations" -> newest.filter { talk(it) > 0 }
            "noanswer" -> newest.filter { it.direction == "outgoing" && it.durationSec == 0 }
            "missed" -> newest.filter { it.direction == "missed" || it.direction == "rejected" }
            "never" -> newest.filter(::neverCalledBack)
            "uniq" -> newest.distinctBy(::who)
            "reached" -> newest.filter { talk(it) > 0 }.distinctBy(::who)
            "won" -> newest.filter { outcomeOf(it) in won }
            "outcome" -> newest.filter { outcomeOf(it) == arg }
            "hour" -> newest.filter { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).hour == arg.toIntOrNull() }
            "day" -> newest.filter { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).toLocalDate().toString() == arg }
            else -> newest
        }
    }

    /** Leads behind a "where they stand" bar: total · called · reached · never · interested · won · outcome:<id>. */
    fun filterLeads(leads: List<Lead>, kind: String, categoryOf: (String?) -> String?): List<Lead> = when (kind.substringBefore(':')) {
        "called" -> leads.filter { it.call_count > 0 || it.last_call_at != null }
        "reached" -> leads.filter { it.has_talked || it.conversation_count > 0 }
        "never" -> leads.filter { it.dial_count == 0 && it.last_call_at == null }
        "interested" -> leads.filter { categoryOf(it.last_outcome_id) == "positive" }
        "won" -> leads.filter { categoryOf(it.last_outcome_id) == "won" }
        "outcome" -> leads.filter { it.last_outcome_id == kind.substringAfter(':') }
        else -> leads
    }
}
