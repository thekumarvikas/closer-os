package com.closeros.app.calls

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.closeros.app.MainActivity
import com.closeros.app.data.FollowUp
import com.closeros.app.data.LocalStore
import java.time.Instant

/**
 * Follow-up reminders on the rep's phone:
 *   5 min before · at the time (with a Call button) · 5 min after · 10 min after.
 * After 15 minutes without a call the follow-up counts as late on the dashboard.
 * A reminder is skipped if the rep has already called that number.
 */
object FollowUpAlarms {
    const val CHANNEL = "follow_ups"
    private val offsets = listOf(-5, 0, 5, 10)

    fun canExact(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 31 || ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Follow-up reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Reminders before, at and after each scheduled follow-up call"
        })
    }

    private fun code(fuId: String, offset: Int) = (fuId + offset).hashCode()

    private fun intent(ctx: Context, f: FollowUp?, fuId: String, offset: Int): PendingIntent {
        val i = Intent(ctx, FollowUpReceiver::class.java).apply {
            putExtra("fu", fuId); putExtra("offset", offset)
            f?.let {
                putExtra("lead", it.lead_id); putExtra("name", it.lead?.name ?: ""); putExtra("phone", it.lead?.phone ?: "")
                putExtra("due", it.due_at); putExtra("reason", it.reason ?: ""); putExtra("notes", it.notes ?: ""); putExtra("purpose", it.purpose)
                it.lead?.let { l ->
                    putExtra("calls", l.call_count); putExtra("convs", l.conversation_count); putExtra("talk", l.total_talk_sec)
                    putExtra("outcome", l.last_outcome_id); putExtra("facts", l.key_facts); putExtra("about", listOfNotNull(l.profession, l.city).filter { s -> s.isNotBlank() }.joinToString(" · "))
                }
            }
        }
        return PendingIntent.getBroadcast(ctx, code(fuId, offset), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Replaces all reminders with ones for the current pending follow-ups. */
    fun scheduleAll(ctx: Context, followUps: List<FollowUp>) {
        val store = LocalStore(ctx)
        val am = ctx.getSystemService(AlarmManager::class.java)
        val now = System.currentTimeMillis()
        val wanted = followUps.filter { it.status == "pending" }.mapNotNull { f ->
            val due = runCatching { com.closeros.app.data.parseInstant(f.due_at).toEpochMilli() }.getOrNull() ?: return@mapNotNull null
            if (due < now - 15 * 60_000 || due > now + 3 * 86_400_000L) null else f to due
        }
        val keep = wanted.map { it.first.id }.toSet()
        store.scheduledFollowUps.filter { it !in keep }.forEach { cancel(ctx, it) }
        for ((f, due) in wanted) for (o in offsets) {
            val at = due + o * 60_000L
            if (at <= now) continue
            val pi = intent(ctx, f, f.id, o)
            if (canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        store.scheduledFollowUps = keep
    }

    fun cancel(ctx: Context, fuId: String) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        offsets.forEach { am.cancel(intent(ctx, null, fuId, it)) }
        NotificationManagerCompat.from(ctx).cancel(fuId.hashCode())
    }

    /** Called when the rep saves an outcome for this lead: its reminders are no longer needed. */
    fun cancelForLead(ctx: Context, leadId: String, followUps: List<FollowUp>) {
        followUps.filter { it.lead_id == leadId }.forEach { cancel(ctx, it.id) }
    }
}

class FollowUpReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val fu = i.getStringExtra("fu") ?: return
        val offset = i.getIntExtra("offset", 0)
        val lead = i.getStringExtra("lead") ?: return
        val name = i.getStringExtra("name").orEmpty().ifBlank { i.getStringExtra("phone").orEmpty() }
        val phone = i.getStringExtra("phone").orEmpty()
        val due = runCatching { com.closeros.app.data.parseInstant(i.getStringExtra("due")).toEpochMilli() }.getOrDefault(System.currentTimeMillis())

        // Already called this lead around the follow-up time? Then no reminder.
        if (phone.isNotEmpty() && PhoneCalls.has(ctx, android.Manifest.permission.READ_CALL_LOG)) {
            val last10 = phone.filter { it.isDigit() }.takeLast(10)
            val called = PhoneCalls.readLog(ctx, due - 10 * 60_000).any { it.direction == "outgoing" && it.phone.filter { c -> c.isDigit() }.endsWith(last10) }
            if (called) { FollowUpAlarms.cancel(ctx, fu); return }
        }
        FollowUpAlarms.ensureChannel(ctx)
        val purpose = i.getStringExtra("purpose").orEmpty().ifBlank { "sales" }
        val mins = ((System.currentTimeMillis() - due) / 60_000).toInt()
        val status = when {
            offset < 0 -> "in ${-offset} min"
            mins <= 1 -> "due now"
            else -> "$mins min late"
        }
        val dueText = java.time.format.DateTimeFormatter.ofPattern("h:mm a").withZone(java.time.ZoneId.systemDefault()).format(Instant.ofEpochMilli(due))
        val outcome = i.getStringExtra("outcome")?.let { id -> AfterCall.company(ctx)?.outcomes?.firstOrNull { it.id == id }?.label }
        val calls = i.getIntExtra("calls", 0); val convs = i.getIntExtra("convs", 0); val talk = i.getIntExtra("talk", 0)
        val countLine = if (calls == 0) "Not called yet" else "$calls calls · $convs conv." + (if (talk >= 60) " · talked ${talk / 60}m" else "")
        val kind = if (purpose == "reminder") "Reminder call" else "Follow-up"
        // One glance: who, how late, what happened last time.
        val title = "$name · $status"
        val line = "⏰ $dueText · " + listOfNotNull(outcome, countLine).joinToString(" · ")
        val about = i.getStringExtra("about").orEmpty()
        val facts = i.getStringExtra("facts").orEmpty()
        val why = listOf(i.getStringExtra("reason").orEmpty(), i.getStringExtra("notes").orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")
        val detail = listOfNotNull(
            "Last: " + (outcome ?: "—") + " · " + countLine,
            about.takeIf { it.isNotBlank() },
            facts.takeIf { it.isNotBlank() }?.let { "📌 $it" },
            why.takeIf { it.isNotBlank() },
            if (offset >= 10) "Call within 5 minutes or it counts as late." else null,
        ).joinToString("\n")
        val timeLine = "⏰ Scheduled for $dueText · $kind" + (if (phone.isNotEmpty()) " · $phone" else "")

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(ctx, fu.hashCode(),
            Intent(ctx, MainActivity::class.java).putExtra("open_lead", lead).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), flags)
        val call = PendingIntent.getActivity(ctx, fu.hashCode() + 1,
            Intent(ctx, MainActivity::class.java).putExtra("call_lead", lead).putExtra("fu_id", fu).putExtra("purpose", purpose)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), flags)
        val wa = PendingIntent.getActivity(ctx, fu.hashCode() + 2,
            Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://wa.me/" + phone.filter { it.isDigit() })).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags)
        val late = offset > 0
        val small = android.widget.RemoteViews(ctx.packageName, com.closeros.app.R.layout.notif_fu_small).apply {
            setTextViewText(com.closeros.app.R.id.n_title, title)
            setTextViewText(com.closeros.app.R.id.n_line, line)
            if (late) setTextColor(com.closeros.app.R.id.n_title, ctx.getColor(com.closeros.app.R.color.n_late))
            setOnClickPendingIntent(com.closeros.app.R.id.n_call, call)
        }
        val big = android.widget.RemoteViews(ctx.packageName, com.closeros.app.R.layout.notif_fu_big).apply {
            setTextViewText(com.closeros.app.R.id.n_title, title)
            setTextViewText(com.closeros.app.R.id.n_time, timeLine)
            setTextViewText(com.closeros.app.R.id.n_text, detail)
            if (late) setTextColor(com.closeros.app.R.id.n_title, ctx.getColor(com.closeros.app.R.color.n_late))
            setOnClickPendingIntent(com.closeros.app.R.id.n_call, call)
            setOnClickPendingIntent(com.closeros.app.R.id.n_wa, wa)
            setOnClickPendingIntent(com.closeros.app.R.id.n_open, open)
        }
        val n = NotificationCompat.Builder(ctx, FollowUpAlarms.CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(title).setContentText(line)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(small).setCustomBigContentView(big).setCustomHeadsUpContentView(small)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)   // readable + callable on the lock screen
            .setColor(0xFF0E5E57.toInt())
            .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(false)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(fu.hashCode(), n) }
    }
}

/** Alarms are cleared when the phone restarts: sync again to put them back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED) { CallSync.syncNow(ctx); CheckIn.schedule(ctx) }
    }
}
