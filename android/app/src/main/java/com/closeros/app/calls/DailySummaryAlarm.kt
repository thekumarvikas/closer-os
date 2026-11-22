package com.closeros.app.calls

// Morning summary at 8:00 AM and evening summary at 9:30 PM (company time zone). The notification carries one
// line of numbers; tapping it opens the summary screen (copy as text · image · PDF). Holidays: sent only when
// follow-ups are lined up (morning) or there was any calling / something lined up (evening).

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.closeros.app.MainActivity
import com.closeros.app.data.LocalDb
import com.closeros.app.data.Membership
import com.closeros.app.data.Repo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.ZoneId
import java.time.ZonedDateTime

object DailySummaryAlarm {
    private const val CHANNEL = "daily_summary"
    private val json = Json { ignoreUnknownKeys = true }
    private fun membership(ctx: Context) = LocalDb.get(ctx).get("membership")?.let { runCatching { json.decodeFromString<Membership>(it) }.getOrNull() }

    private fun pi(ctx: Context, kind: String) = PendingIntent.getBroadcast(ctx, if (kind == "morning") 7401 else 7402,
        Intent(ctx, DailySummaryReceiver::class.java).putExtra("kind", kind), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun schedule(ctx: Context) {
        val m = membership(ctx) ?: return
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val zone = runCatching { ZoneId.of(m.organization.timezone) }.getOrDefault(ZoneId.systemDefault())
        for ((kind, h, min) in listOf(Triple("morning", 8, 0), Triple("evening", 21, 30))) {
            var t = ZonedDateTime.now(zone).withHour(h).withMinute(min).withSecond(0).withNano(0)
            if (!t.isAfter(ZonedDateTime.now(zone))) t = t.plusDays(1)
            val at = t.toInstant().toEpochMilli()
            if (FollowUpAlarms.canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi(ctx, kind))
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi(ctx, kind))
        }
    }

    suspend fun run(ctx: Context, kind: String) {
        try {
            val m = membership(ctx) ?: return
            com.closeros.app.data.Backend.ensureFreshSession()
            val s = Repo.dailySummary(m.org_id, kind, null)
            val st = s["stats"]!!.jsonObject; val pl = s["plan"]!!.jsonObject
            fun n(o: kotlinx.serialization.json.JsonObject, k: String) = o[k]?.jsonPrimitive?.doubleOrNull?.toInt() ?: 0
            val working = s["working_day"]?.jsonPrimitive?.booleanOrNull != false
            val anything = n(st, "dialled") + n(st, "received") > 0 || n(pl, "follow_ups") > 0
            if (!working && (if (kind == "morning") n(pl, "follow_ups") == 0 else !anything)) return
            val talk = n(st, "talk"); val t = if (talk >= 3600) "${talk / 3600}h ${talk % 3600 / 60}m" else "${talk / 60}m"
            val line = "${n(st, "dialled")} dialled · ${n(st, "connected")} connected · $t talk" + (if (n(st, "sales") > 0) " · ${n(st, "sales")} sale${if (n(st, "sales") > 1) "s" else ""}" else "") +
                "\n${if (kind == "morning") "Today" else "Tomorrow"}: ${n(pl, "follow_ups")} follow-ups · ${(pl["hot"] as? kotlinx.serialization.json.JsonObject)?.let { n(it, "total") } ?: 0} hot leads"
            // The person's own summary picture goes in the notification (expand to see it; tap to open / send).
            val pic = runCatching {
                val big = com.closeros.app.ui.summaryBitmap(com.closeros.app.ui.buildSummary(s, m.organization.currency))
                android.graphics.Bitmap.createScaledBitmap(big, 1080, big.height * 1080 / big.width, true)
            }.getOrNull()
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Daily summary", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Morning (8 AM) and evening (9:30 PM) summary" })
            val open = PendingIntent.getActivity(ctx, if (kind == "morning") 7403 else 7404, Intent(ctx, MainActivity::class.java).putExtra("summary", kind)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val title = if (kind == "morning") "☀️ Your morning summary" else "🌙 Your evening summary"
            val note = NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(com.closeros.app.R.drawable.ic_notif).setColor(0xFF0E5E57.toInt())
                .setContentTitle(title).setContentText(line.substringBefore('\n')).setStyle(pic?.let { NotificationCompat.BigPictureStyle().bigPicture(it).setSummaryText(line.substringBefore('\n')) }
                    ?: NotificationCompat.BigTextStyle().bigText(line))
                .setAutoCancel(true).setContentIntent(open).build()
            runCatching { nm.notify(if (kind == "morning") 7401 else 7402, note) }
        } catch (e: Exception) { com.closeros.app.data.AppLog.error(ctx, "daily-summary", e) }
        finally { schedule(ctx) }
    }
}

class DailySummaryReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val app = ctx.applicationContext; val kind = intent.getStringExtra("kind") ?: "evening"
        val done = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { try { withTimeoutOrNull(25_000) { DailySummaryAlarm.run(app, kind) } } finally { done.finish() } }
    }
}
