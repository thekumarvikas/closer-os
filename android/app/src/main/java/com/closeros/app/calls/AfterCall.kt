package com.closeros.app.calls

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import androidx.compose.ui.platform.ComposeView
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.closeros.app.MainActivity
import com.closeros.app.data.Lead
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Membership
import com.closeros.app.data.Outcome
import com.closeros.app.data.Repo
import com.closeros.app.ui.AfterCallCard
import com.closeros.app.ui.CloserTheme
import com.closeros.app.ui.normalizePhone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * When a call ends: find it in the call log, check whether the number is a lead, then
 *  - show the after-call pop-up over any app (like caller-ID apps do), and
 *  - post the "Save the outcome" notification as a backup.
 * The pop-up needs "Display over other apps". Closing it without saving is fine: the app asks
 * for the outcome the next time it opens, as before.
 */
object AfterCall {
    private val lock = Mutex()
    const val NOTIFY_ID = 7001

    fun allowed(ctx: Context) = Settings.canDrawOverlays(ctx)

    /** Everything the card needs about the company, from the copy saved on the phone (works offline). */
    data class Company(val orgId: String, val prefix: String, val timezone: String, val outcomes: List<Outcome>)

    fun company(ctx: Context): Company? {
        val db = com.closeros.app.data.LocalDb.get(ctx)
        val m = db.get("membership")?.let { runCatching { com.closeros.app.data.json.decodeFromString<Membership>(it) }.getOrNull() } ?: return null
        val outcomes = db.get("outcomes")?.let { runCatching { com.closeros.app.data.json.decodeFromString<List<Outcome>>(it) }.getOrNull() }.orEmpty()
        return Company(m.org_id, m.organization.phone_prefix, m.organization.timezone, outcomes)
    }

    /** Everything the pop-up shows for one call. */
    data class Info(val call: LogCall, val lead: Lead?, val co: Company, val appCall: LocalStore.PendingCall?, val lookupFailed: Boolean) {
        val purpose get() = appCall?.purpose ?: "sales"
    }

    /** Does this call need an outcome? (answered incoming, or any outgoing — same rule as the app) */
    fun needsOutcome(c: LogCall) = (c.direction == "incoming" && c.durationSec > 0) || c.direction == "outgoing"

    suspend fun handle(ctx: Context, endedAtMs: Long) = lock.withLock {
        val store = LocalStore(ctx)
        if (store.orgId == null) return@withLock
        val co = company(ctx) ?: return@withLock
        com.closeros.app.data.Backend.ensureFreshSession()

        // The phone writes the call log a moment after the call ends: look for it for up to ~10 s.
        var call: LogCall? = null
        for (i in 0 until 10) {
            delay(if (i == 0) 800 else 1000)
            call = runCatching { PhoneCalls.readLog(ctx, endedAtMs - 3 * 3_600_000L).lastOrNull() }.getOrNull()
                ?.takeIf { it.startedAtMs + it.durationSec * 1000L >= endedAtMs - 150_000 && it.channel == "phone" }
            if (call != null) break
        }
        val c = call ?: return@withLock
        if (c.id == store.lastAfterCallId || c.id in store.loggedCalls) return@withLock
        store.lastAfterCallId = c.id

        val phone = normalizePhone(c.phone, co.prefix)
        // A call started from Closer OS (lead list, queue, webinar list): keep its purpose / webinar.
        val appCall = store.pendingCall?.takeIf { p -> p.logId == c.id || (p.logId == null && normalizePhone(p.phone, co.prefix) == phone) }
        var lookupFailed = false
        val lead = runCatching { Repo.leadsByPhones(co.orgId, listOf(phone))[phone] }
            .onFailure { lookupFailed = true; com.closeros.app.data.AppLog.error(ctx, "after-call lead lookup", it) }.getOrNull()
        if (lead != null && needsOutcome(c)) notifySaveOutcome(ctx, lead, c)

        val mode = store.afterCallMode
        val show = mode != "off" && allowed(ctx) && !MainActivity.visible &&
            c.phone.isNotBlank() && (lead != null || mode == "all" || lookupFailed)
        if (show) withContext(Dispatchers.Main) { Overlay.show(ctx.applicationContext, Info(c, lead, co, appCall, lookupFailed)) }
    }

    private fun notifySaveOutcome(ctx: Context, lead: Lead, c: LogCall) {
        FollowUpAlarms.ensureChannel(ctx)
        val open = PendingIntent.getActivity(ctx, NOTIFY_ID, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, FollowUpAlarms.CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_outgoing)
            .setContentTitle("Save the outcome: ${lead.name.ifBlank { c.phone }}")
            .setContentText(if (c.direction == "incoming") "Received call — add the outcome and next call time" else "Add the outcome and next call time")
            .setContentIntent(open).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(NOTIFY_ID, n) }
    }

    fun cancelNotification(ctx: Context) = runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(NOTIFY_ID) }

    /** The floating card itself: a small window drawn over other apps. */
    object Overlay {
        private var view: View? = null
        private var owner: Owner? = null

        fun show(ctx: Context, info: Info) {
            hide(ctx)
            val wm = ctx.getSystemService(WindowManager::class.java) ?: return
            val o = Owner().also { it.start() }
            val v = ComposeView(ctx).apply {
                setViewTreeLifecycleOwner(o); setViewTreeSavedStateRegistryOwner(o); setViewTreeViewModelStoreOwner(o)
                setContent { CloserTheme { AfterCallCard(info, onClose = { hide(ctx) }) } }
            }
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT,
            ).apply { gravity = Gravity.CENTER }
            runCatching { wm.addView(v, lp); view = v; owner = o }
                .onFailure { o.stop(); com.closeros.app.data.AppLog.error(ctx, "after-call pop-up", it) }
        }

        fun hide(ctx: Context) {
            val v = view ?: return
            runCatching { ctx.getSystemService(WindowManager::class.java)?.removeViewImmediate(v) }
            owner?.stop(); view = null; owner = null
        }
    }

    /** Compose needs a lifecycle even outside a screen of the app. */
    private class Owner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
        private val registry = LifecycleRegistry(this)
        private val saved = SavedStateRegistryController.create(this)
        override val lifecycle: Lifecycle get() = registry
        override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry
        override val viewModelStore = ViewModelStore()
        fun start() { saved.performRestore(null); registry.currentState = Lifecycle.State.RESUMED }
        fun stop() { registry.currentState = Lifecycle.State.DESTROYED; viewModelStore.clear() }
    }
}
