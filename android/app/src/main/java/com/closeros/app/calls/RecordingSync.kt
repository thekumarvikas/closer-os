package com.closeros.app.calls

import android.content.Context
import android.net.Uri
import android.telecom.TelecomManager
import androidx.documentfile.provider.DocumentFile
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalStore
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.storage.storage
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Locale
import kotlin.math.abs

/**
 * Finds the phone's own call recordings (in the folder the rep picked once) and uploads each one
 * to the private recordings store, linked to its call. Works where the phone maker's dialer saves
 * recordings as normal files (Xiaomi/MIUI dialer, Samsung, Vivo, many Realme/Oppo…). Google's
 * Phone app keeps recordings private, so nothing can be picked up on those phones.
 */
object RecordingSync {
    private val audio = Regex(".*\\.(mp3|m4a|amr|aac|wav|ogg|opus|3gp)$", RegexOption.IGNORE_CASE)
    private val stamp = Regex("(20\\d{6})[_\\-]?(\\d{6})")
    private val fmt = SimpleDateFormat("yyyyMMddHHmmss", Locale.US)

    fun googleDialer(ctx: Context) =
        ctx.getSystemService(TelecomManager::class.java)?.defaultDialerPackage == "com.google.android.dialer"

    private data class F(val doc: DocumentFile, val name: String, val modified: Long, val nameTime: Long?)

    private fun listFiles(ctx: Context, tree: Uri, sinceMs: Long): List<F> {
        val out = mutableListOf<F>()
        fun walk(d: DocumentFile, depth: Int) {
            for (f in d.listFiles()) {
                if (f.isDirectory && depth < 3) walk(f, depth + 1)
                else if (f.isFile && audio.matches(f.name.orEmpty()) && f.lastModified() >= sinceMs) {
                    val n = f.name.orEmpty()
                    out += F(f, n, f.lastModified(), stamp.find(n)?.let { runCatching { fmt.parse(it.groupValues[1] + it.groupValues[2])?.time }.getOrNull() })
                }
            }
        }
        DocumentFile.fromTreeUri(ctx, tree)?.let { walk(it, 0) }
        return out
    }

    /** Uploads recordings for answered calls of the last [days] days. Returns how many were uploaded. */
    suspend fun run(ctx: Context, orgId: String, days: Int = 7): Int {
        val store = LocalStore(ctx)
        val tree = store.recordingsFolder?.let(Uri::parse) ?: return 0
        val uid = Backend.uid ?: return 0
        val since = System.currentTimeMillis() - days * 86_400_000L
        val calls = PhoneCalls.readLog(ctx, since).filter { it.durationSec > 0 && it.id !in store.uploadedRecordings }
        if (calls.isEmpty()) return 0
        val files = runCatching { listFiles(ctx, tree, since - 86_400_000L) }.getOrDefault(emptyList()).toMutableList()
        var n = 0
        for (c in calls) {
            val last10 = c.phone.filter { it.isDigit() }.takeLast(10)
            val end = c.startedAtMs + c.durationSec * 1000L
            val f = files.firstOrNull { f ->
                val numberOk = last10.length >= 7 && f.name.filter { it.isDigit() }.contains(last10)
                val timeOk = (f.nameTime != null && abs(f.nameTime - c.startedAtMs) <= 120_000) || f.modified in (c.startedAtMs - 30_000)..(end + 300_000)
                timeOk && (numberOk || f.nameTime != null)
            } ?: continue
            val ext = f.name.substringAfterLast('.', "m4a").lowercase()
            val path = "$orgId/$uid/${c.id}.$ext"
            val ok = runCatching {
                val bytes = ctx.contentResolver.openInputStream(f.doc.uri)!!.use { it.readBytes() }
                Backend.client.storage.from("recordings").upload(path, bytes) { upsert = true }
                Backend.client.postgrest.rpc("set_call_recording", buildJsonObject { put("p_call", c.id); put("p_path", path); put("p_size", bytes.size.toLong()) })
            }.isSuccess
            if (ok) { store.markRecordingUploaded(c.id); files.remove(f); n++ }
        }
        return n
    }
}
