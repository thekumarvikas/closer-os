package com.closeros.app.data

import java.time.Instant

/**
 * Reminder or sales? Same rule as the server's lead_call_context(): a reminder call when the lead has a
 * reminder follow-up due within 24 h, or is registered (not in a test group) for a webinar/event that
 * starts within 24 h. Otherwise a sales call, tagged with the webinar of the last 30 days.
 * Used for every call that doesn't come from a webinar list (focus, follow-ups, pop-up, notifications…).
 */
object CallPurpose {
    data class Ctx(val purpose: String, val batchId: String?, val webinarAt: Instant?, val webinarName: String?)

    fun guess(lead: Lead?, followUps: List<FollowUp>): Ctx {
        if (lead == null) return Ctx("sales", null, null, null)
        lead.call_purpose?.let { p -> return Ctx(p, lead.call_batch_id, webinarOf(lead, lead.call_batch_id), null) }
        val now = Instant.now()
        fun t(s: String?) = s?.let { runCatching { parseInstant(it) }.getOrNull() }
        val links = lead.batch_leads.mapNotNull { l -> t(l.batch?.webinar_at)?.let { at -> Triple(l, at, l.batch?.name) } }
        val upcoming = links.filter { (l, at, _) -> !l.is_holdout && at.isAfter(now) && at.isBefore(now.plusSeconds(86_400)) }.minByOrNull { it.second }
        val reminderDue = followUps.any { it.lead_id == lead.id && it.status == "pending" && it.purpose == "reminder" &&
            (t(it.due_at)?.isBefore(now.plusSeconds(86_400)) == true) }
        if (upcoming != null || reminderDue) {
            val b = upcoming ?: links.filter { it.second.isAfter(now) }.minByOrNull { it.second }
            return Ctx("reminder", b?.first?.batch_id, b?.second, b?.third)
        }
        val past = links.filter { it.second <= now && it.second.isAfter(now.minusSeconds(30L * 86_400)) }.maxByOrNull { it.second }
        return Ctx("sales", past?.first?.batch_id, null, null)
    }

    /** Start time of the lead's webinar with this id (or its next upcoming one). */
    fun webinarOf(lead: Lead?, batchId: String?): Instant? {
        val now = Instant.now()
        val links = lead?.batch_leads.orEmpty().mapNotNull { l -> l.batch?.webinar_at?.let { runCatching { parseInstant(it) }.getOrNull() }?.let { l to it } }
        return (links.firstOrNull { batchId != null && it.first.batch_id == batchId } ?: links.filter { it.second.isAfter(now) }.minByOrNull { it.second })?.second
    }
}
