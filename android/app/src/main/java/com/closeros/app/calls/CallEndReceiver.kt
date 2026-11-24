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
        @Suppress("DEPRECATION") val num = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
        // Caller ID strip: while it rings; while dialling (15 s); gone once answered or ended.
        runCatching {
            val sp = ctx.applicationContext.getSharedPreferences("call_kind", Context.MODE_PRIVATE)
            when (state) {
                TelephonyManager.EXTRA_STATE_RINGING -> CallerId.show(ctx, num)
                TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                    val rangRecently = System.currentTimeMillis() - sp.getLong("ring", 0) < 120_000 && sp.getLong("ring", 0) > sp.getLong("idle", 0)
                    if (rangRecently) CallerId.hide(ctx)
                    else CallerId.show(ctx, num ?: com.closeros.app.data.LocalStore(ctx).pendingCall?.phone, autoHideMs = 15_000)
                }
                TelephonyManager.EXTRA_STATE_IDLE -> CallerId.hide(ctx)
            }
        }
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
        val kind = when {
            ring > idle && off > ring -> "incoming"
            ring > idle -> "missed"
            off > idle -> "outgoing"
            else -> null
        }
        sp.edit().putLong("idle", now).putString("kind", kind).apply()
        // Ringing time: incoming = rang until answered / dropped; outgoing = line time (talk is taken off once the call log has it).
        runCatching {
            val e = when (kind) {
                "incoming" -> org.json.JSONObject().put("s", ring).put("r", off - ring)
                "missed" -> org.json.JSONObject().put("s", ring).put("r", now - ring)
                "outgoing" -> org.json.JSONObject().put("s", off).put("l", now - off)
                else -> null
            }
            if (e != null) {
                val arr = org.json.JSONArray(sp.getString("rings", "[]"))
                arr.put(e)
                val keep = org.json.JSONArray(); val from = maxOf(0, arr.length() - 300)
                for (i in from until arr.length()) keep.put(arr.get(i))
                sp.edit().putString("rings", keep.toString()).apply()
            }
        }
        return kind
    }

    /** Seconds each call rang, for calls in the phone's call log (matched by start time ± 15 s). */
    fun ringSecs(ctx: Context, calls: List<LogCall>): Map<String, Int> {
        val arr = runCatching { org.json.JSONArray(p(ctx).getString("rings", "[]")) }.getOrNull() ?: return emptyMap()
        val es = (0 until arr.length()).map { arr.getJSONObject(it) }
        val out = HashMap<String, Int>()
        for (c in calls) {
            if (c.channel == "whatsapp") continue
            val e = es.minByOrNull { kotlin.math.abs(it.getLong("s") - c.startedAtMs) } ?: continue
            if (kotlin.math.abs(e.getLong("s") - c.startedAtMs) > 15_000) continue
            val sec = when {
                e.has("r") -> (e.getLong("r") / 1000).toInt()
                e.has("l") -> ((e.getLong("l") / 1000) - c.durationSec).toInt()
                else -> continue
            }
            if (sec in 0..600) out[c.id] = sec
        }
        return out
    }
}

/** Kept so reminders queued by older versions still run. */
class CallEndWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        runCatching { AfterCall.handle(applicationContext, System.currentTimeMillis() - 5_000) }
        return Result.success()
    }
}
