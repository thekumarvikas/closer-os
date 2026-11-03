package com.closeros.app.calls

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

/** A WhatsApp call seen on this phone. */
@Serializable
data class WaCall(val id: String, val phone: String, val name: String?, val direction: String, val startedAtMs: Long, val durationSec: Int)

/**
 * WhatsApp calls don't appear in the phone's call log. With the rep's permission ("notification
 * access"), Closer OS watches WhatsApp's call notifications — incoming/ringing, calling, ongoing —
 * and writes down who, when, which way and how long. Nothing else from notifications is read or kept.
 * WhatsApp calls can't be recorded.
 */
object WhatsAppCalls {
    private val packages = setOf("com.whatsapp", "com.whatsapp.w4b")
    private val json = Json { ignoreUnknownKeys = true }
    private const val MAX = 3000

    fun isPackage(p: String) = p in packages

    fun accessGranted(ctx: Context) = ctx.packageName in NotificationManagerCompat.getEnabledListenerPackages(ctx)

    fun allowedByCompany(ctx: Context) = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE).getBoolean("track_whatsapp", true)

    private fun db(ctx: Context) = com.closeros.app.data.LocalDb.get(ctx)

    fun count(ctx: Context) = db(ctx).waCount()

    fun since(ctx: Context, ms: Long): List<WaCall> = db(ctx).waSince(ms).map {
        WaCall(it[0] as String, it[1] as String, it[2] as String?, it[3] as String, it[4] as Long, it[5] as Int)
    }

    fun add(ctx: Context, c: WaCall) = db(ctx).addWa(c.id, c.phone, c.name, c.direction, c.startedAtMs, c.durationSec)

    /** As call-log entries, so the app can show WhatsApp and phone calls together. */
    fun asLog(ctx: Context, sinceMs: Long): List<LogCall> = since(ctx, sinceMs).map {
        LogCall(it.id, it.phone, it.direction, it.startedAtMs, it.durationSec, null, null, null, channel = "whatsapp", name = it.name)
    }

    /** Works out the number for the name WhatsApp shows (a saved contact) — needs contacts permission. */
    fun resolvePhone(ctx: Context, title: String, n: Notification): String? {
        val digits = title.filter { it.isDigit() }
        if (digits.length >= 8 && title.all { it.isDigit() || it in "+-() \u202A\u202C\u200E" })
            return (if (title.contains('+')) "+" else "") + digits
        if (!PhoneCalls.has(ctx, android.Manifest.permission.READ_CONTACTS)) return null
        // The person attached to the notification (newer WhatsApp versions).
        if (Build.VERSION.SDK_INT >= 28) {
            val people = n.extras.getParcelableArrayList<android.app.Person>(Notification.EXTRA_PEOPLE_LIST)
            people?.mapNotNull { it.uri }?.forEach { u ->
                if (u.startsWith("tel:")) return u.removePrefix("tel:")
                if (u.startsWith("content://")) phoneForContact(ctx, Uri.parse(u))?.let { return it }
            }
        }
        return runCatching {
            ctx.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} = ?", arrayOf(title.trim()), null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull()
    }

    private fun phoneForContact(ctx: Context, uri: Uri): String? = runCatching {
        val id = ctx.contentResolver.query(uri, arrayOf(ContactsContract.Contacts._ID), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else null } ?: return null
        ctx.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?", arrayOf(id.toString()), null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    fun listenerComponent(ctx: Context) = ComponentName(ctx, WhatsAppCallListener::class.java)
}

/** Watches WhatsApp call notifications only. */
class WhatsAppCallListener : NotificationListenerService() {
    private data class Live(var key: String, val title: String, val phone: String?, var direction: String, val startedAtMs: Long, var connectedAtMs: Long?)

    private var live: Live? = null
    private val handler = Handler(Looper.getMainLooper())
    private val finish = Runnable { finishCall() }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!WhatsAppCalls.isPackage(sbn.packageName) || !WhatsAppCalls.allowedByCompany(this)) return
        val n = sbn.notification
        val e = n.extras
        val title = e.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = e.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val lower = text.lowercase()
        val isCall = n.category == Notification.CATEGORY_CALL || Regex("(voice|video) call|calling|ringing").containsMatchIn(lower)
        if (!isCall || lower.contains("missed") || title.isBlank()) return

        val actions = n.actions.orEmpty().map { it.title?.toString()?.lowercase().orEmpty() }
        val callType = if (Build.VERSION.SDK_INT >= 31) e.getInt("android.callType", 0) else 0 // 1 incoming, 2 ongoing
        val ringingIn = callType == 1 || lower.contains("incoming") || actions.any { it.contains("answer") || it.contains("accept") }
        val dialling = lower.contains("calling") || lower.contains("ringing")
        val connected = !ringingIn && !dialling &&
            (e.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER) || callType == 2 || lower.contains("ongoing") || Regex("\\d+:\\d\\d").containsMatchIn(text))

        handler.removeCallbacks(finish)
        val now = System.currentTimeMillis()
        val cur = live
        if (cur == null || (cur.title != title && cur.connectedAtMs == null && !ringingIn)) {
            if (cur != null) finishCall()
            live = Live(sbn.key, title, WhatsAppCalls.resolvePhone(this, title, n),
                if (ringingIn) "incoming" else "outgoing", now, null)
        }
        live?.let { l ->
            l.key = sbn.key
            if (connected && l.connectedAtMs == null) {
                l.connectedAtMs = if (e.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER) && n.`when` in (now - 3_600_000)..now) n.`when` else now
            }
        }
    }

    /** If Android restarted the watcher during a call, pick the call up again (its start time is in the notification). */
    override fun onListenerConnected() {
        runCatching { activeNotifications?.filter { WhatsAppCalls.isPackage(it.packageName) }?.forEach { onNotificationPosted(it) } }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val l = live ?: return
        if (sbn.key != l.key) return
        // WhatsApp swaps the "ringing" notification for an "ongoing" one; wait a moment before ending the call.
        handler.removeCallbacks(finish)
        handler.postDelayed(finish, 3000)
    }

    private fun finishCall() {
        val l = live ?: return
        live = null
        val end = System.currentTimeMillis() - 3000
        val talk = l.connectedAtMs?.let { ((end - it) / 1000).toInt().coerceAtLeast(1) } ?: 0
        val dir = if (l.connectedAtMs == null && l.direction == "incoming") "missed" else l.direction
        val id = UUID.nameUUIDFromBytes("wa|${PhoneCalls.deviceId(this)}|${l.startedAtMs}".toByteArray()).toString()
        WhatsAppCalls.add(this, WaCall(id, l.phone.orEmpty(), l.title, dir, l.startedAtMs, talk))
        CallSync.syncNow(this)
    }
}
