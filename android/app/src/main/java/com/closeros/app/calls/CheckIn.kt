package com.closeros.app.calls

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.closeros.app.MainActivity
import com.closeros.app.data.FollowUp
import com.closeros.app.data.LocalDb
import com.closeros.app.data.LocalLeads
import com.closeros.app.data.LocalReports
import com.closeros.app.data.Membership
import com.closeros.app.data.Net
import com.closeros.app.data.Nums
import com.closeros.app.data.Outcome
import com.closeros.app.data.Repo
import com.closeros.app.data.json
import com.closeros.app.data.parseInstant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Hourly check-in: at the top of every working hour each rep gets a short, encouraging progress note —
 * last hour, today, sales, their best hours (today + all-time), the one thing to do this hour, and for
 * reminder callers the maths to reach everyone before the webinar. Worked out on the phone (works
 * offline). The rep acknowledges it ("Got it — start calling"); the manager sees who did.
 */
object CheckIn {
    const val CHANNEL = "checkins"
    const val NOTIFY_ID = 7301

    @Serializable data class Reminder(
        val batchId: String, val name: String, val webinarAt: Long, val finishBy: Long, val left: Int, val minutesLeft: Int,
        val pickupPct: Int, val allPickSec: Int, val perAnsweredSec: Int, val canFinish: Int, val missed: Int, val usualTalkSec: Int,
    )

    @Serializable data class Summary(
        val slotMs: Long, val kind: String,              // morning | hourly | summary
        val status: String,                              // record | close | room | fresh | break | on_pace | behind | catchup
        val title: String, val lastLine: String, val todayLine: String, val bestLine: String, val goalLine: String,
        val actionLabel: String, val action: String,     // focus | followups | hot | reminder:<batchId>
        val lastDialled: Int = 0, val lastPicked: Int = 0, val lastTalk: Int = 0,
        val todayDialled: Int = 0, val todayConnected: Int = 0, val todayTalk: Int = 0,
        val sales: Int = 0, val salesAmount: Long = 0, val saleLines: List<String> = emptyList(),
        val bestTodaySec: Int = 0, val bestTodayHour: Int? = null, val bestEverSec: Int = 0, val bestEverLabel: String? = null,
        val top3: List<String> = emptyList(), val hours: Map<Int, Int> = emptyMap(), val streak: Int = 0,
        val target: Nums = Nums(), val needCallsThisHour: Int? = null,
        val reminders: List<Reminder> = emptyList(), val tip: String? = null,
    )

    // ── Scheduling: one alarm for the next working hour (10:00, 11:00 … end hour) ──
    private fun membership(ctx: Context) = LocalDb.get(ctx).get("membership")?.let { runCatching { json.decodeFromString<Membership>(it) }.getOrNull() }

    fun schedule(ctx: Context) {
        val m = membership(ctx) ?: return
        val o = m.organization
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val pi = PendingIntent.getBroadcast(ctx, NOTIFY_ID, Intent(ctx, CheckInReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (!o.checkinOn) { am.cancel(pi); return }
        val zone = runCatching { ZoneId.of(o.timezone) }.getOrDefault(ZoneId.systemDefault())
        var t = ZonedDateTime.now(zone).withMinute(0).withSecond(0).withNano(0).plusHours(1)
        repeat(24 * 8) {
            if (t.hour in o.checkinStart..o.checkinEnd && t.dayOfWeek.value in o.workDays) {
                val at = t.toInstant().toEpochMilli()
                if (FollowUpAlarms.canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi) else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                return
            }
            t = t.plusHours(1)
        }
    }

    // ── The numbers ──
    private const val RING_SEC = 35       // an unanswered call: ringing until it gives up
    private const val BETWEEN_SEC = 15    // saving the outcome + countdown to the next call

    private fun fmt(sec: Int): String = when { sec >= 3600 -> "${sec / 3600} h ${(sec % 3600) / 60} min"; sec >= 60 -> "${sec / 60} min"; else -> "${sec}s" }
    private fun fmtShort(sec: Int): String = if (sec >= 60) "${sec / 60} min${if (sec % 60 >= 10) " ${sec % 60} s" else ""}" else "$sec s"
    private fun hourLabel(h: Int) = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
    private fun digits(s: String) = s.filter { it.isDigit() }.takeLast(10)

    suspend fun compute(ctx: Context, nowMs: Long = System.currentTimeMillis()): Summary? {
        val m = membership(ctx) ?: return null
        val org = m.organization
        val zone = runCatching { ZoneId.of(org.timezone) }.getOrDefault(ZoneId.systemDefault())
        val db = LocalDb.get(ctx)
        val outcomes = db.get("outcomes")?.let { runCatching { json.decodeFromString<List<Outcome>>(it) }.getOrNull() }.orEmpty()
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        val slot = now.withMinute(0).withSecond(0).withNano(0)
        val dayStart = now.toLocalDate().atStartOfDay(zone)
        val kind = when (slot.hour) { org.checkinStart -> "morning"; org.checkinEnd -> "summary"; else -> "hourly" }

        val calls = PhoneCalls.readLog(ctx, dayStart.toInstant().toEpochMilli() - 1, 50_000).filter { digits(it.phone).length >= 8 } +
            WhatsAppCalls.asLog(ctx, dayStart.toInstant().toEpochMilli() - 1)
        fun talk(c: LogCall) = if (c.direction == "incoming" || c.direction == "outgoing") c.durationSec else 0
        val lastFrom = slot.minusHours(1).toInstant().toEpochMilli(); val lastTo = slot.toInstant().toEpochMilli()
        val last = calls.filter { it.startedAtMs in lastFrom until lastTo }
        val lastDialled = last.count { it.direction == "outgoing" }
        val lastPicked = last.count { talk(it) > 0 }
        val lastTalk = last.sumOf { talk(it) }
        val todayDialled = calls.count { it.direction == "outgoing" }
        val todayConnected = calls.count { talk(it) > 0 }
        val todayTalk = calls.sumOf { talk(it) }
        val hours = calls.groupBy { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).hour }.mapValues { (_, l) -> l.sumOf { talk(it) } }
        val doneHours = hours.filterKeys { it < slot.hour }
        val bestToday = doneHours.maxByOrNull { it.value }

        // All-time best talk hours (server records, saved on the phone; today's hours join in).
        val rec = runCatching { Repo.myTalkRecords(m.org_id) }.getOrNull()?.top.orEmpty()
        val recList = (rec.map { it.talk_sec to it.hour } + doneHours.map { (h, t) -> t to dayStart.toLocalDate().atTime(h, 0).toString() })
            .distinctBy { it.second.take(13) }.sortedByDescending { it.first }
        val bestEver = recList.firstOrNull()
        fun recLabel(h: String) = runCatching { java.time.LocalDateTime.parse(h.take(16)).let { d -> d.format(DateTimeFormatter.ofPattern("EEE d MMM, h a")) } }.getOrDefault(h)
        val bestEverSec = bestEver?.first ?: 0
        val bestTodaySec = bestToday?.value ?: 0
        val ref = max(bestEverSec, 15 * 60)   // a new rep with no history is measured against a 15-min hour

        // Streak: hours in a row (ending last hour) at 70%+ of the all-time best (min 15 min).
        var streak = 0
        var h = slot.hour - 1
        while (h >= 0 && (hours[h] ?: 0) >= max(15 * 60, (bestEverSec * 0.7).toInt())) { streak++; h-- }

        // Sales today.
        val sales = LocalReports.sales(ctx, calls.map { it.id }.toSet(), outcomes)
        val salesAmount = sales.sumOf { it.third ?: 0L }
        val saleLines = sales.map { (cid, lead, amt) ->
            val name = lead?.let { LocalLeads.byId(ctx, it)?.name }?.ifBlank { null } ?: "a lead"
            val at = calls.firstOrNull { it.id == cid }?.let { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).format(DateTimeFormatter.ofPattern("h:mm a")) }.orEmpty()
            "🎉 $name" + (amt?.let { " · ₹%,d".format(it) } ?: "") + (if (at.isNotEmpty()) " · $at" else "")
        }

        // Targets for today (manager's daily targets, saved when the app loaded them).
        val target = db.get("my_daily_targets")?.let { runCatching { json.decodeFromString<Nums>(it) }.getOrNull() } ?: Nums()
        val endAt = now.toLocalDate().atTime(org.checkinEnd, 0).atZone(zone)
        val hoursLeft = max(1.0, (endAt.toInstant().toEpochMilli() - nowMs) / 3_600_000.0)
        val startAt = now.toLocalDate().atTime(org.checkinStart, 0).atZone(zone)
        val elapsed = ((nowMs - startAt.toInstant().toEpochMilli()).toDouble() / (endAt.toInstant().toEpochMilli() - startAt.toInstant().toEpochMilli()).coerceAtLeast(1)).coerceIn(0.0, 1.0)
        val needCalls = target.calls?.let { t -> max(0, t - todayDialled) }
        val needCallsThisHour = needCalls?.let { ceil(it / hoursLeft).toInt() }
        val behindCalls = target.calls?.let { (it * elapsed).roundToInt() - todayDialled } ?: 0
        val bestDialHour = calls.filter { it.direction == "outgoing" }.groupBy { Instant.ofEpochMilli(it.startedAtMs).atZone(zone).hour }.filterKeys { it < slot.hour }.maxOfOrNull { it.value.size } ?: 0

        // Reminder calls for webinars starting later today (from the saved reminder lists).
        val outgoingToday = calls.filter { it.direction == "outgoing" }
        val picked = outgoingToday.count { it.durationSec >= 20 }
        val pickup = if (outgoingToday.size >= 10) picked.toDouble() / outgoingToday.size else 0.4
        val usualTalk = outgoingToday.filter { it.durationSec >= 20 }.map { it.durationSec }.takeIf { it.size >= 3 }?.average()?.toInt() ?: 90
        val reminders = runCatching {
            Repo.myBatches(m.org_id).filter { b -> b.webinar_at?.let { runCatching { parseInstant(it) }.getOrNull() }?.let { w ->
                w.isAfter(Instant.ofEpochMilli(nowMs)) && w.isBefore(Instant.ofEpochMilli(nowMs).plusSeconds(14 * 3600)) } == true }
                .mapNotNull { b ->
                    val w = parseInstant(b.webinar_at!!)
                    val finishBy = w.minusSeconds(org.reminderCutoffMin * 60L)
                    val rows = runCatching { Repo.batchCallList(b.id, "reminder", false).leads }.getOrNull() ?: return@mapNotNull null
                    val left = rows.count { !it.talked && !it.do_not_call }
                    if (left == 0) return@mapNotNull null
                    val secLeft = ((finishBy.toEpochMilli() - nowMs) / 1000).toInt().coerceAtLeast(0)
                    val allPick = (secLeft / left) - BETWEEN_SEC
                    val answered = (left * pickup).coerceAtLeast(1.0)
                    val perAnswered = ((secLeft - left * (1 - pickup) * (RING_SEC + BETWEEN_SEC)) / answered - BETWEEN_SEC).toInt()
                    val perCall = pickup * (usualTalk + BETWEEN_SEC) + (1 - pickup) * (RING_SEC + BETWEEN_SEC)
                    val canFinish = (secLeft / perCall).toInt().coerceAtMost(left)
                    Reminder(b.id, b.name, w.toEpochMilli(), finishBy.toEpochMilli(), left, secLeft / 60, (pickup * 100).roundToInt(),
                        allPick.coerceAtLeast(0), perAnswered.coerceAtLeast(0), canFinish, left - canFinish, usualTalk)
                }
        }.getOrDefault(emptyList())

        // What to do this hour → the button.
        val followUps = db.get("followUps")?.let { runCatching { json.decodeFromString<List<FollowUp>>(it) }.getOrNull() }.orEmpty()
        val dueNow = followUps.count { it.status == "pending" && runCatching { parseInstant(it.due_at).toEpochMilli() }.getOrDefault(Long.MAX_VALUE) < nowMs + 15 * 60_000 }
        val hot = runCatching { LocalLeads.focus(ctx, outcomes, org.timezone).count { it.score >= 40 || it.batch_leads.any { b -> (b.watch_minutes ?: 0) >= 60 } } }.getOrDefault(0)
        val firstRem = reminders.minByOrNull { it.finishBy }
        val (actionLabel, action) = when {
            firstRem != null && firstRem.finishBy > nowMs -> "📞 Start reminder calls (${firstRem.left})" to "reminder:${firstRem.batchId}"
            dueNow > 0 -> "📞 Call due follow-ups ($dueNow)" to "followups"
            hot > 0 && lastTalk < ref * 0.75 -> "📞 Call hot leads ($hot)" to "hot"
            needCallsThisHour != null && needCallsThisHour > 0 -> "📞 Start my $needCallsThisHour" to "focus"
            else -> "📞 Continue calling" to "focus"
        }

        // Tip: why talk time was short, and the quickest fix.
        val avgPicked = last.filter { talk(it) > 0 }.map { talk(it) }.average().takeIf { !it.isNaN() }?.toInt() ?: 0
        val tip = when {
            kind == "morning" -> null
            lastDialled == 0 -> null
            lastDialled >= 10 && lastPicked * 100 / lastDialled < 25 -> "Pick-ups are low right now — call due follow-ups and interested leads first; keep new leads for later."
            lastPicked >= 3 && avgPicked in 1..59 -> "Calls averaged ${avgPicked}s. Ask one more question before ending — sales come from longer calls."
            lastDialled < 10 && bestDialHour > lastDialled -> "Only $lastDialled dials last hour (your best today: $bestDialHour). The queue dials the next lead for you."
            hot > 0 -> "$hot hot leads are waiting — they usually talk longer."
            else -> null
        }

        // Wording: always measured against the rep's own best, never "low".
        val name = runCatching { LocalDb.get(ctx).get("profile")?.let { json.decodeFromString<com.closeros.app.data.Profile>(it) }?.full_name }.getOrNull()?.substringBefore(' ').orEmpty()
        val tLabel = slot.format(DateTimeFormatter.ofPattern("h a"))
        val salePrefix = if (sales.isNotEmpty()) "🎉 ${sales.size} sale${if (sales.size > 1) "s" else ""} today! · " else ""
        val (status, head) = when {
            kind == "morning" -> "fresh" to "☀️ Good morning${if (name.isNotEmpty()) ", $name" else ""} — today's plan"
            kind == "summary" -> "summary" to "🌙 Today's wrap-up"
            lastDialled == 0 && lastTalk == 0 -> "break" to "☕ Ready when you are"
            bestEverSec > 0 && lastTalk > bestEverSec -> "record" to "🏆 NEW ALL-TIME RECORD: ${fmt(lastTalk)} talk in one hour!"
            bestTodaySec > 0 && lastTalk >= bestTodaySec && doneHours.size > 1 -> "best_today" to "🔥 Your best hour today: ${fmt(lastTalk)} talk!"
            lastTalk >= ref * 0.75 -> "close" to "🔥 ${fmt(lastTalk)} talk — so close to your best (${fmt(ref)})"
            lastTalk >= ref * 0.4 -> "room" to "💪 ${fmt(lastTalk)} talk last hour · your best is ${fmt(ref)}"
            else -> "fresh" to "🚀 Fresh hour, fresh start"
        }
        val title = "$tLabel · " + (if (kind == "hourly") salePrefix else "") + head
        val lastLine = "Last hour: $lastDialled dialled · $lastPicked picked · ${fmt(lastTalk)} talk"
        val todayLine = "Today: $todayDialled dialled · $todayConnected connected · ${fmt(todayTalk)}" +
            (if (sales.isNotEmpty()) " · 🎉 ${sales.size} sale${if (sales.size > 1) "s" else ""}${if (salesAmount > 0) " ₹%,d".format(salesAmount) else ""}" else "")
        val bestLine = "Today's best: " + (bestToday?.let { "${fmt(it.value)} (${hourLabel(it.key)})" } ?: "—") +
            " · All-time best: " + (bestEver?.let { "${fmt(it.first)} (${recLabel(it.second)})" } ?: "—") +
            (if (streak >= 2) " · ${streak} strong hours in a row 🔥" else "")
        val stepTalk = when {
            lastTalk >= ref -> lastTalk + 60
            lastTalk < ref * 0.4 -> max(lastTalk + 10 * 60, (ref * 0.6).toInt())
            else -> ref + 60
        }
        val goalLine = when {
            kind == "morning" -> listOfNotNull(target.calls?.let { "$it calls" }, target.talk_minutes?.let { "$it min talk" }, target.sales?.takeIf { it > 0 }?.let { "$it sales" })
                .joinToString(" · ").ifEmpty { "Beat your best hour (${fmt(ref)} talk)" } + (if (dueNow > 0) " · $dueNow follow-ups due now" else "")
            kind == "summary" -> "Best hour today: ${bestToday?.let { "${fmt(it.value)} at ${hourLabel(it.key)}" } ?: "—"} · record ${fmt(bestEverSec)}. " +
                (if (sales.isNotEmpty()) "Great day — ${sales.size} sale${if (sales.size > 1) "s" else ""}! ✅" else "Rest well — tomorrow is a fresh start ✅")
            firstRem != null && firstRem.finishBy > nowMs -> "Reminders: ${firstRem.left} left by ${Instant.ofEpochMilli(firstRem.finishBy).atZone(zone).format(DateTimeFormatter.ofPattern("h:mm a"))} — " +
                if (firstRem.missed > 0 && firstRem.perAnsweredSec < 30) "short calls + WhatsApp the link to the hardest to reach" else "keep calls under ${fmtShort(firstRem.perAnsweredSec)}"
            needCallsThisHour != null && needCallsThisHour > 0 && behindCalls > 0 -> "This hour: $needCallsThisHour calls" + (if (bestDialHour > 0) " (your best hour today: $bestDialHour)" else "") + " · aim for ${fmt(stepTalk)} talk"
            else -> "This hour: aim for ${fmt(stepTalk)} talk" + (if (stepTalk > ref) " — a new record!" else "")
        }
        return Summary(slot.toInstant().toEpochMilli(), kind, status, title, lastLine, todayLine, bestLine, goalLine, actionLabel, action,
            lastDialled, lastPicked, lastTalk, todayDialled, todayConnected, todayTalk, sales.size, salesAmount, saleLines,
            bestTodaySec, bestToday?.key, bestEverSec, bestEver?.let { recLabel(it.second) }, recList.take(3).map { (t, hh) -> "${fmt(t)} · ${recLabel(hh)}" },
            hours, streak, target, needCallsThisHour, reminders, tip)
    }

    fun ensureChannel(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Hourly check-ins", NotificationManager.IMPORTANCE_HIGH).apply { description = "Your progress every working hour, with what to do next" })
    }

    fun post(ctx: Context, s: Summary) {
        ensureChannel(ctx)
        LocalDb.get(ctx).put("checkin_pending", json.encodeToString(Summary.serializer(), s))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(ctx, NOTIFY_ID, Intent(ctx, MainActivity::class.java).putExtra("checkin", "open")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), flags)
        val go = PendingIntent.getActivity(ctx, NOTIFY_ID + 1, Intent(ctx, MainActivity::class.java).putExtra("checkin", "go")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), flags)
        val body = listOfNotNull(s.lastLine.takeIf { s.kind != "morning" }, s.todayLine.takeIf { s.kind != "morning" }, s.bestLine,
            s.reminders.firstOrNull()?.takeIf { s.kind != "summary" }?.let { r -> "🎓 ${r.name}: ${r.left} left · pick-up ${r.pickupPct}%" + (if (r.missed > 0) " · ~${r.missed} may be missed at your usual pace" else "") },
            s.goalLine).joinToString("\n")
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle(s.title).setContentText(if (s.kind == "morning") s.goalLine else s.lastLine)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setColor(0xFF0E5E57.toInt())
            .setOngoing(s.kind != "summary")               // stays until the rep opens it and taps "Got it"
            .setAutoCancel(s.kind == "summary")
            .setContentIntent(open)
            .addAction(android.R.drawable.sym_action_call, if (s.kind == "summary") "Open" else s.actionLabel.removePrefix("📞 "), if (s.kind == "summary") open else go)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(NOTIFY_ID, n) }
    }

    /** The check-in on screen / in the notification that hasn't been acknowledged yet. */
    fun pending(ctx: Context): Summary? = LocalDb.get(ctx).get("checkin_pending")?.let { runCatching { json.decodeFromString<Summary>(it) }.getOrNull() }

    fun toJson(s: Summary): JsonObject = buildJsonObject {
        put("status", s.status); put("title", s.title); put("kind", s.kind)
        put("last_dialled", s.lastDialled); put("last_picked", s.lastPicked); put("last_talk", s.lastTalk)
        put("today_dialled", s.todayDialled); put("today_connected", s.todayConnected); put("today_talk", s.todayTalk)
        put("sales", s.sales); put("best_today", s.bestTodaySec); put("best_ever", s.bestEverSec)
        s.reminders.firstOrNull()?.let { put("reminders_left", it.left); put("reminders_missed", it.missed) }
    }

    /** "Got it": tells the manager it was seen, and clears the notification. */
    suspend fun acknowledge(ctx: Context) {
        val s = pending(ctx) ?: return
        LocalDb.get(ctx).put("checkin_pending", "")
        NotificationManagerCompat.from(ctx).cancel(NOTIFY_ID)
        val orgId = membership(ctx)?.org_id ?: return
        runCatching { Repo.saveCheckin(orgId, Instant.ofEpochMilli(s.slotMs), toJson(s), true) }
    }

    /** Called by the alarm: work out, post, tell the server it was shown, schedule the next one. */
    suspend fun run(ctx: Context) {
        try {
            val m = membership(ctx) ?: return
            val s = compute(ctx) ?: return
            post(ctx, s)
            if (Net.isOnline) runCatching { Repo.saveCheckin(m.org_id, Instant.ofEpochMilli(s.slotMs), toJson(s), false) }
        } catch (e: Exception) { com.closeros.app.data.AppLog.error(ctx, "checkin", e) }
        finally { schedule(ctx) }
    }
}

class CheckInReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val app = ctx.applicationContext
        val done = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try { withTimeoutOrNull(25_000) { CheckIn.run(app) } } finally { done.finish() }
        }
    }
}
