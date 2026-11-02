package com.closeros.app.calls

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.closeros.app.MainActivity
import com.closeros.app.data.Announcement
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Repo
import java.time.Instant

/** Announcements from management (can't be swiped away until acknowledged) and new-lead alerts. */
object TeamAlerts {
    private const val ANN = "announcements"
    private const val LEADS = "new_leads"

    private fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(ANN, "Announcements from management", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Messages you must read and acknowledge"
        })
        nm.createNotificationChannel(NotificationChannel(LEADS, "New leads", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "When new leads are assigned to you"
        })
    }

    private fun openApp(ctx: Context, code: Int, extra: String? = null) = PendingIntent.getActivity(ctx, code,
        Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).apply { extra?.let { putExtra("open_tab", it) } },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun notifId(id: String) = 9000 + (id.hashCode() and 0xFFFF)

    /** Shows a pinned notification for every announcement I haven't acknowledged; removes the rest. */
    fun showAnnouncements(ctx: Context, list: List<Announcement>) {
        channels(ctx)
        val store = LocalStore(ctx)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val shown = store.shownAnnouncements
        val now = list.map { it.id + "|" + (it.reminded_at ?: "") }.toSet()
        shown.map { it.substringBefore('|') }.filter { id -> list.none { it.id == id } }.forEach { nm.cancel(notifId(it)) }
        list.forEach { a ->
            val key = a.id + "|" + (a.reminded_at ?: "")
            val n = NotificationCompat.Builder(ctx, ANN)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle((if (a.urgent) "🔴 " else "📢 ") + a.title)
                .setContentText(a.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(a.body + "\n\nOpen Closer OS to acknowledge."))
                .setOngoing(true).setAutoCancel(false)
                .setOnlyAlertOnce(key in shown)
                .setPriority(NotificationCompat.PRIORITY_MAX).setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(openApp(ctx, notifId(a.id)))
                .build()
            runCatching { nm.notify(notifId(a.id), n) }
        }
        store.setShownAnnouncements(now)
    }

    fun clearAnnouncement(ctx: Context, id: String) = ctx.getSystemService(NotificationManager::class.java).cancel(notifId(id))

    /** Checks the server: announcements + newly assigned leads. Called by sync and while the app is open. */
    suspend fun check(ctx: Context, orgId: String): List<Announcement> {
        val store = LocalStore(ctx)
        val anns = runCatching { Repo.myAnnouncements(orgId) }.getOrNull()
        anns?.let { showAnnouncements(ctx, it) }
        val since = store.newLeadsSince
        if (since == null) store.newLeadsSince = Instant.now().toString()
        else runCatching { Repo.myNewLeads(orgId, since) }.getOrNull()?.takeIf { it.count > 0 }?.let { nl ->
            channels(ctx)
            val more = if (nl.count > nl.names.size) " and ${nl.count - nl.names.size} more" else ""
            val n = NotificationCompat.Builder(ctx, LEADS)
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .setContentTitle(if (nl.count == 1) "New lead assigned to you" else "${nl.count} new leads assigned to you")
                .setContentText(nl.names.joinToString(", ") + more)
                .setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openApp(ctx, 8800, "leads")).build()
            runCatching { ctx.getSystemService(NotificationManager::class.java).notify(8800, n) }
            store.newLeadsSince = nl.latest ?: Instant.now().toString()
        }
        return anns ?: emptyList()
    }
}
