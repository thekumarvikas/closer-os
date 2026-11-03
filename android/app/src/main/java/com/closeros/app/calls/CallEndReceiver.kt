package com.closeros.app.calls

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.closeros.app.MainActivity
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Repo
import com.closeros.app.ui.normalizePhone
import java.util.concurrent.TimeUnit

/** When a call ends, check if it was with a lead and remind the rep to save the outcome. */
class CallEndReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        if (intent.getStringExtra(TelephonyManager.EXTRA_STATE) != TelephonyManager.EXTRA_STATE_IDLE) return
        // The call log is written a moment after the call ends.
        WorkManager.getInstance(ctx).enqueue(OneTimeWorkRequestBuilder<CallEndWorker>().setInitialDelay(4, TimeUnit.SECONDS).build())
    }
}

class CallEndWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val store = LocalStore(ctx)
        val orgId = store.orgId ?: return Result.success()
        val c = PhoneCalls.readLog(ctx, System.currentTimeMillis() - 30 * 60_000).lastOrNull() ?: return Result.success()
        if (c.id in store.loggedCalls) return Result.success()
        if (!((c.direction == "incoming" && c.durationSec > 0) || c.direction == "outgoing")) return Result.success()
        if (store.pendingCall?.logId == null && store.pendingCall != null && c.direction == "outgoing") return Result.success() // started from Closer OS
        val phone = normalizePhone(c.phone, "+91")
        val lead = runCatching { Repo.leadsByPhones(orgId, listOf(phone))[phone] }.getOrNull() ?: return Result.success()
        FollowUpAlarms.ensureChannel(ctx)
        val open = PendingIntent.getActivity(ctx, 7001, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, FollowUpAlarms.CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_outgoing)
            .setContentTitle("Save the outcome: ${lead.name.ifBlank { c.phone }}")
            .setContentText(if (c.direction == "incoming") "Received call — add the outcome and next call time" else "Add the outcome and next call time")
            .setContentIntent(open).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(7001, n) }
        return Result.success()
    }
}
