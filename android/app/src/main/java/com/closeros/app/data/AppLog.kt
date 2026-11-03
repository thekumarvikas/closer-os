package com.closeros.app.data

import android.content.Context
import android.os.Build
import com.closeros.app.BuildConfig
import com.closeros.app.calls.PhoneCalls
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import io.github.jan.supabase.postgrest.postgrest
import java.io.File
import java.time.Instant

/**
 * Crash and error reports. Each problem is written to a small file on the phone at once, then sent to
 * Closer OS (Super Admin → App errors) on the next sync, so we see problems before reps complain.
 */
object AppLog {
    private fun file(ctx: Context) = File(ctx.filesDir, "errors.jsonl")

    fun error(ctx: Context, place: String, t: Throwable?, kind: String = "error", message: String? = null) {
        runCatching {
            val store = LocalStore(ctx)
            val o = buildJsonObject {
                put("kind", kind); put("place", place)
                put("message", (message ?: t?.let { "${it::class.java.simpleName}: ${it.message}" } ?: "").take(500))
                put("stack", t?.stackTraceToString()?.take(6000) ?: "")
                put("at", Instant.now().toString()); put("org_id", store.orgId ?: "")
                put("device_id", PhoneCalls.deviceId(ctx)); put("app_version", BuildConfig.VERSION_NAME)
                put("model", "${Build.MANUFACTURER} ${Build.MODEL}"); put("android", Build.VERSION.RELEASE)
            }
            val f = file(ctx)
            // Keep at most the last 100 problems.
            val lines = if (f.exists()) f.readLines().takeLast(99) else emptyList()
            f.writeText((lines + o.toString()).joinToString("\n") + "\n")
        }
    }

    private fun pending(ctx: Context): List<JsonObject> =
        runCatching { file(ctx).takeIf { it.exists() }?.readLines()?.filter { it.isNotBlank() }?.map { json.parseToJsonElement(it).jsonObject } }.getOrNull() ?: emptyList()

    /** Sends saved reports (called by sync and when the app opens). */
    suspend fun flush(ctx: Context) {
        val items = pending(ctx)
        if (items.isEmpty()) return
        runCatching {
            Backend.client.postgrest.rpc("report_app_errors", buildJsonObject { put("p", JsonArray(items)) })
        }.onSuccess { file(ctx).delete() }
    }

    /** For crashes: send right away without signing in (the app is about to close). */
    fun sendNowBlocking(ctx: Context) {
        val items = pending(ctx).takeIf { it.isNotEmpty() } ?: return
        val t = Thread {
            runCatching {
                val con = (java.net.URL(BuildConfig.SUPABASE_URL + "/rest/v1/rpc/report_app_errors").openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 3000
                    setRequestProperty("apikey", BuildConfig.SUPABASE_KEY); setRequestProperty("Content-Type", "application/json")
                }
                con.outputStream.use { it.write(buildJsonObject { put("p", JsonArray(items)) }.toString().toByteArray()) }
                if (con.responseCode in 200..299) file(ctx).delete()
                con.disconnect()
            }
        }
        t.start(); t.join(4000)
    }

    /** Catch crashes anywhere in the app. */
    fun install(ctx: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            error(ctx, "crash in ${thread.name}", e, kind = "crash")
            runCatching { sendNowBlocking(ctx) }
            previous?.uncaughtException(thread, e)
        }
    }
}
