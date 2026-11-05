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
    data class Company(val orgId: String, val prefix: String, val timezone: String, val outcomes: List<Outcome>,
                       val name: String = "", val repName: String = "", val templates: List<com.closeros.app.data.Template> = emptyList())

    fun company(ctx: Context): Company? {
        val db = com.closeros.app.data.LocalDb.get(ctx)
        val m = db.get("membership")?.let { runCatching { com.closeros.app.data.json.decodeFromString<Membership>(it) }.getOrNull() } ?: return null
        val outcomes = db.get("outcomes")?.let { runCatching { com.closeros.app.data.json.decodeFromString<List<Outcome>>(it) }.getOrNull() }.orEmpty()
        val templates = db.get("templates")?.let { runCatching { com.closeros.app.data.json.decodeFromString<List<com.closeros.app.data.Template>>(it) }.getOrNull() }.orEmpty()
        val rep = db.get("profile")?.let { runCatching { com.closeros.app.data.json.decodeFromString<com.closeros.app.data.Profile>(it) }.getOrNull() }?.full_name.orEmpty()
        return Company(m.org_id, m.organization.phone_prefix, m.organization.timezone, outcomes, m.organization.name, rep, templates)
    }

    /**
     * Everything the pop-up shows for one call. The card opens straight away with what is known at
     * that moment and fills in as the rest arrives: [call] (from the call log, ~1 s), [lead] (phone's
     * own lead list first, then confirmed by the server), [checking] while the server is asked.
     */
    data class Info(val call: LogCall?, val phone: String?, val lead: Lead?, val co: Company, val appCall: LocalStore.PendingCall?,
                    val lookupFailed: Boolean = false, val checking: Boolean = false, val contactName: String? = null) {
        val purpose get() = appCall?.purpose ?: "sales"
        val number get() = call?.phone?.takeIf { it.isNotBlank() } ?: phone
    }

    /** Does this call need an outcome? (answered incoming, or any outgoing — same rule as the app) */
    fun needsOutcome(c: LogCall) = (c.direction == "incoming" && c.durationSec > 0) || c.direction == "outgoing"

    /** What happened the last time a call ended (shown in Phone setup, and sent to the error log). */
    private fun trace(ctx: Context, text: String) {
        LocalStore(ctx).lastAfterCallTrace = "${java.time.LocalTime.now().withNano(0)} · $text"
        com.closeros.app.data.AppLog.error(ctx, "after-call", null, kind = "info", message = text)
    }

    /** Android sends "call ended" twice (with and without the number): handle it once. */
    @Volatile private var lastIdleMs = 0L
    /** The number, if it arrives with the second "call ended" message. */
    @Volatile private var lateNumber: String? = null

    suspend fun handle(ctx: Context, endedAtMs: Long, number: String? = null) {
        if (endedAtMs - lastIdleMs < 5_000) { if (!number.isNullOrBlank()) lateNumber = number; return }
        lastIdleMs = endedAtMs; lateNumber = null
        lock.withLock { run(ctx, endedAtMs, number) }
        runCatching { com.closeros.app.data.AppLog.flush(ctx) }
    }

    private suspend fun run(ctx: Context, endedAtMs: Long, number: String?) {
        val store = LocalStore(ctx)
        if (store.orgId == null) return trace(ctx, "not signed in")
        val co = company(ctx) ?: return trace(ctx, "company not loaded yet — open Closer OS once")
        val mode = store.afterCallMode
        fun ms() = System.currentTimeMillis() - endedAtMs
        val blockedBy = when {
            mode == "off" -> "pop-up turned off in Profile"
            !allowed(ctx) -> "\"Display over other apps\" is off"
            else -> null
        }
        suspend fun canShow() = blockedBy == null && !MainActivity.visible
        var shown = false
        suspend fun showOrUpdate(info: Info) = withContext(Dispatchers.Main) {
            if (shown) Overlay.update(info) else if (canShow()) shown = Overlay.show(ctx.applicationContext, info)
        }

        // 1) Straight away: the number Android gave us + the phone's own lead list (no internet needed),
        // 2) while looking for the call-log entry (written a moment after the call ends) every 0.15 s for up to 10 s.
        var phone: String? = null
        var lead: Lead? = null
        var firstShownMs: Long? = null
        var call: LogCall? = null
        for (i in 0 until 66) {
            if (phone == null) (number ?: lateNumber)?.takeIf { it.isNotBlank() }?.let { n ->
                phone = normalizePhone(n, co.prefix)
                lead = com.closeros.app.data.LeadIndex.find(ctx, phone!!)
                if (mode == "all" || lead != null) { showOrUpdate(Info(null, phone, lead, co, null, checking = true)); if (shown) firstShownMs = ms() }
            }
            call = runCatching { PhoneCalls.latest(ctx, 2).firstOrNull() }.getOrNull()
                ?.takeIf { it.startedAtMs + it.durationSec * 1000L >= endedAtMs - 180_000 && it.startedAtMs <= endedAtMs + 5_000 }
            if (call != null) break
            delay(150)
        }
        val c = call ?: run { if (shown) withContext(Dispatchers.Main) { Overlay.hide(ctx) }; return trace(ctx, "call not found in the call log") }
        if (c.id == store.lastAfterCallId) return
        store.lastAfterCallId = c.id
        if (c.id in store.loggedCalls) { if (shown) withContext(Dispatchers.Main) { Overlay.hide(ctx) }; return trace(ctx, "outcome already saved") }
        if (c.phone.isBlank()) { if (shown) withContext(Dispatchers.Main) { Overlay.hide(ctx) }; return trace(ctx, "no pop-up: private number") }

        phone = normalizePhone(c.phone, co.prefix)
        if (phone in store.personalNumbers) { if (shown) withContext(Dispatchers.Main) { Overlay.hide(ctx) }; return trace(ctx, "no pop-up: number marked personal") }
        val contact = PhoneCalls.contactName(ctx, c.phone)
        if (lead?.phone != phone) lead = com.closeros.app.data.LeadIndex.find(ctx, phone!!)
        // A call started from Closer OS (lead list, queue, webinar list): keep its purpose / webinar.
        val appCall = store.pendingCall?.takeIf { p -> p.logId == c.id || (p.logId == null && normalizePhone(p.phone, co.prefix) == phone) }
        val num = phone!!
        if (mode == "all" || lead != null) showOrUpdate(Info(c, phone, lead, co, appCall, checking = true, contactName = contact))
        val cardMs = if (shown) ms() else null

        // 3) Confirm with the server (fresh login first) — the card is already on screen meanwhile.
        val loggedIn = com.closeros.app.data.Backend.ensureFreshSession()
        var lookupFailed = !loggedIn
        if (loggedIn) runCatching { Repo.leadsByPhones(co.orgId, listOf(num))[num] }
            .onSuccess { found -> lead = found; found?.let { com.closeros.app.data.LeadIndex.remember(ctx, listOf(it)) } }
            .onFailure { lookupFailed = true; com.closeros.app.data.AppLog.error(ctx, "after-call lead lookup", it) }
        val l = lead
        if (l != null && needsOutcome(c)) notifySaveOutcome(ctx, l, c)

        if (blockedBy != null) return trace(ctx, "no pop-up: $blockedBy")
        if (l == null && mode == "leads" && !lookupFailed) {
            if (shown) withContext(Dispatchers.Main) { Overlay.hide(ctx) }
            return trace(ctx, "no pop-up: not a lead (pop-up set to leads only)")
        }
        showOrUpdate(Info(c, num, l, co, appCall, lookupFailed = lookupFailed && l == null, checking = false, contactName = contact))
        trace(ctx, when {
            shown -> "pop-up shown after ${((firstShownMs ?: cardMs ?: ms()) / 100) / 10.0} s" +
                (if (l != null) " (lead)" else if (lookupFailed) " (couldn't check: ${if (loggedIn) "no internet" else "login"})" else " (not a lead)")
            MainActivity.visible -> "no pop-up: Closer OS was on screen (it asks itself)"
            else -> "pop-up blocked by the phone"
        })
    }

    /** Profile → "Test the pop-up": shows the card for the most recent call right now. */
    suspend fun test(ctx: Context): String {
        if (!allowed(ctx)) return "Turn on \"Display over other apps\" first (Phone setup)."
        val co = company(ctx) ?: return "Company not loaded yet — wait a moment and try again."
        val c = withContext(Dispatchers.IO) { runCatching { PhoneCalls.history(ctx, 5).firstOrNull { it.channel == "phone" && it.phone.isNotBlank() } }.getOrNull() }
            ?: return "Make one call first, then test."
        val loggedIn = com.closeros.app.data.Backend.ensureFreshSession()
        val phone = normalizePhone(c.phone, co.prefix)
        var failed = !loggedIn
        val lead = if (!loggedIn) null else runCatching { Repo.leadsByPhones(co.orgId, listOf(phone))[phone] }.onFailure { failed = true }.getOrNull()
        val ok = withContext(Dispatchers.Main) { Overlay.show(ctx.applicationContext, Info(c, phone, lead, co, null, lookupFailed = failed)) }
        return if (ok) "Pop-up works ✓ (shown for your last call)" else "The phone blocked the pop-up — check \"Display over other apps\"."
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
        private var state: androidx.compose.runtime.MutableState<Info>? = null
        /** True while the card is on screen (the calling queue waits). */
        val isShowing: Boolean get() = view != null

        /** New details for the card already on screen (keeps what the rep has tapped). */
        fun update(info: Info) { state?.value = info }

        fun show(ctx: Context, info: Info): Boolean {
            hide(ctx)
            val wm = ctx.getSystemService(WindowManager::class.java) ?: return false
            val o = Owner().also { it.start() }
            val st = androidx.compose.runtime.mutableStateOf(info)
            val v = ComposeView(ctx).apply {
                setViewTreeLifecycleOwner(o); setViewTreeSavedStateRegistryOwner(o); setViewTreeViewModelStoreOwner(o)
                setContent { CloserTheme { AfterCallCard(st.value, onClose = { hide(ctx) }) } }
            }
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT,
            ).apply { gravity = Gravity.CENTER }
            return runCatching { wm.addView(v, lp); view = v; owner = o; state = st }
                .onFailure { o.stop(); com.closeros.app.data.AppLog.error(ctx, "after-call pop-up", it) }.isSuccess
        }

        fun hide(ctx: Context) {
            val v = view ?: return
            runCatching { ctx.getSystemService(WindowManager::class.java)?.removeViewImmediate(v) }
            owner?.stop(); view = null; owner = null; state = null
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
