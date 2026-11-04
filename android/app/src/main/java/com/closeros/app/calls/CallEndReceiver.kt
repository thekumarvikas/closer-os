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
        if (intent.getStringExtra(TelephonyManager.EXTRA_STATE) != TelephonyManager.EXTRA_STATE_IDLE) return
        val endedAt = System.currentTimeMillis()
        val app = ctx.applicationContext
        val done = goAsync()   // keeps the app awake while the call log is read and the lead looked up
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            @Suppress("DEPRECATION") val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
            try { withTimeoutOrNull(45_000) { AfterCall.handle(app, endedAt, number) } }
            catch (e: Exception) { com.closeros.app.data.AppLog.error(app, "after call", e) }
            finally { done.finish() }
        }
    }
}

/** Kept so reminders queued by older versions still run. */
class CallEndWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        runCatching { AfterCall.handle(applicationContext, System.currentTimeMillis() - 5_000) }
        return Result.success()
    }
}
