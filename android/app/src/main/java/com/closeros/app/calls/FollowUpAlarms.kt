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
                putExtra("due", it.due_at); putExtra("reason", it.reason ?: "")
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
            val due = runCatching { Instant.parse(f.due_at).toEpochMilli() }.getOrNull() ?: return@mapNotNull null
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
        val due = runCatching { Instant.parse(i.getStringExtra("due")).toEpochMilli() }.getOrDefault(System.currentTimeMillis())

        // Already called this lead around the follow-up time? Then no reminder.
        if (phone.isNotEmpty() && PhoneCalls.has(ctx, android.Manifest.permission.READ_CALL_LOG)) {
            val last10 = phone.filter { it.isDigit() }.takeLast(10)
            val called = PhoneCalls.readLog(ctx, due - 10 * 60_000).any { it.direction == "outgoing" && it.phone.filter { c -> c.isDigit() }.endsWith(last10) }
            if (called) { FollowUpAlarms.cancel(ctx, fu); return }
        }
        FollowUpAlarms.ensureChannel(ctx)
        val title = when (offset) {
            -5 -> "Follow-up in 5 minutes: $name"
            0 -> "Call $name now"
            5 -> "Follow-up 5 minutes overdue: $name"
            else -> "Follow-up 10 minutes overdue: $name"
        }
        val text = when (offset) {
            10 -> "Call within 5 minutes or it will be marked as a late follow-up."
            else -> i.getStringExtra("reason").orEmpty().ifBlank { "Scheduled follow-up call" }
        }
        val open = PendingIntent.getActivity(ctx, fu.hashCode(),
            Intent(ctx, MainActivity::class.java).putExtra("open_lead", lead).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val call = PendingIntent.getActivity(ctx, fu.hashCode() + 1,
            Intent(ctx, MainActivity::class.java).putExtra("call_lead", lead).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, FollowUpAlarms.CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setColor(0xFF0E5E57.toInt())
            .setContentIntent(open).setAutoCancel(true)
            .addAction(android.R.drawable.sym_action_call, "Call", call)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(fu.hashCode(), n) }
    }
}

/** Alarms are cleared when the phone restarts: sync again to put them back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED) CallSync.syncNow(ctx)
    }
}
