package com.closeros.app.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** When a call ends: the after-call pop-up and the "Save the outcome" reminder (see AfterCall). */
class CallEndReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
        CallKind.note(ctx, state)   // remembers ringing / answered so the pop-up knows "received" vs "dialled" at once
        if (state != TelephonyManager.EXTRA_STATE_IDLE) return
        val endedAt = System.currentTimeMillis()
        val app = ctx.applicationContext
        AfterCall.dirHint = CallKind.atIdle(ctx, endedAt)
        runCatching { CallSync.syncAfterCall(app) }   // every call reaches the dashboard within a minute, outcome or not
        val done = goAsync()   // keeps the app awake while the call log is read and the lead looked up
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            @Suppress("DEPRECATION") val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
            try { withTimeoutOrNull(45_000) { AfterCall.handle(app, endedAt, number) } }
            catch (e: Exception) { com.closeros.app.data.AppLog.error(app, "after call", e) }
            finally { done.finish() }
        }
    }
}

/**
 * Received or dialled, known the moment the call ends (before Android writes its call history):
 * the phone rang first → received ("incoming", or "missed" if never answered); otherwise dialled.
 */
object CallKind {
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences("call_kind", Context.MODE_PRIVATE)
    fun note(ctx: Context, state: String?) {
        val now = System.currentTimeMillis()
        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> p(ctx).edit().putLong("ring", now).apply()
            TelephonyManager.EXTRA_STATE_OFFHOOK -> p(ctx).edit().putLong("off", now).apply()
        }
    }
    fun atIdle(ctx: Context, now: Long): String? {
        val sp = p(ctx)
        val idle = sp.getLong("idle", 0); val last = sp.getString("kind", null)
        // Android sends "call ended" twice: the second copy keeps the first answer.
        if (now - idle < 60_000 && last != null && sp.getLong("ring", 0) <= idle && sp.getLong("off", 0) <= idle) return last
        val ring = sp.getLong("ring", 0); val off = sp.getLong("off", 0)
        // Phone line busy (dialling, ringing out, talking) = calling time for the efficiency report.
        if (off > idle) com.closeros.app.data.WorkLog.segment(ctx, "call", off, now)
        val kind = when {
            ring > idle && off > ring -> "incoming"
            ring > idle -> "missed"
            off > idle -> "outgoing"
            else -> null
        }
        sp.edit().putLong("idle", now).putString("kind", kind).apply()
        return kind
    }
}

/** Kept so reminders queued by older versions still run. */
class CallEndWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        runCatching { AfterCall.handle(applicationContext, System.currentTimeMillis() - 5_000) }
        return Result.success()
    }
}
