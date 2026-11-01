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
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.math.abs

/**
 * Finds the phone's own call recordings (in the folder the rep picked once) and uploads each one
 * to the private recordings store, linked to its call. Works where the phone maker's dialer saves
 * recordings as normal files (Xiaomi/MIUI dialer, Samsung, Vivo, many Realme/Oppo…). Google's
 * Phone app keeps recordings private, so nothing can be picked up on those phones.
 */
object RecordingSync {
    data class Result(val filesFound: Int = 0, val callsChecked: Int = 0, val matched: Int = 0, val uploaded: Int = 0, val error: String? = null)

    private val audio = Regex(".*\\.(mp3|m4a|amr|aac|wav|ogg|opus|3gp)$", RegexOption.IGNORE_CASE)
    // 20261101153045 / 20261101_153045 (Xiaomi, most brands) and 261101_153045 (Samsung).
    private val long = Regex("(20\\d{2})(\\d{2})(\\d{2})[_\\-\\s]?(\\d{2})(\\d{2})(\\d{2})")
    private val short = Regex("(?<!\\d)(\\d{2})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})(?!\\d)")

    fun googleDialer(ctx: Context) =
        ctx.getSystemService(TelecomManager::class.java)?.defaultDialerPackage == "com.google.android.dialer"

    private data class F(val doc: DocumentFile, val name: String, val modified: Long, val nameTime: Long?)

    /** Time written in the file name (the LAST date-time in it, so numbers in the name don't confuse it). */
    private fun nameTime(name: String): Long? {
        val zone = ZoneId.systemDefault()
        fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int, s: Int) =
            runCatching { LocalDateTime.of(y, mo, d, h, mi, s).atZone(zone).toInstant().toEpochMilli() }.getOrNull()
        long.findAll(name).lastOrNull()?.groupValues?.map { it.toIntOrNull() ?: 0 }?.let { g -> at(g[1], g[2], g[3], g[4], g[5], g[6])?.let { return it } }
        short.findAll(name).lastOrNull()?.groupValues?.map { it.toIntOrNull() ?: 0 }?.let { g -> return at(2000 + g[1], g[2], g[3], g[4], g[5], g[6]) }
        return null
    }

    private fun listFiles(ctx: Context, tree: Uri, sinceMs: Long): List<F> {
        val out = mutableListOf<F>()
        fun walk(d: DocumentFile, depth: Int) {
            for (f in d.listFiles()) {
                if (f.isDirectory && depth < 3) walk(f, depth + 1)
                else if (f.isFile && audio.matches(f.name.orEmpty()) && f.lastModified() >= sinceMs) {
                    val n = f.name.orEmpty()
                    out += F(f, n, f.lastModified(), nameTime(n))
                }
            }
        }
        val root = DocumentFile.fromTreeUri(ctx, tree) ?: throw IllegalStateException("Recordings folder can't be opened — choose it again")
        if (!root.canRead()) throw IllegalStateException("No permission to read the recordings folder — choose it again")
        walk(root, 0)
        return out
    }

    /** Uploads recordings for answered calls of the last [days] days. */
    suspend fun run(ctx: Context, orgId: String, days: Int = 7): Result {
        val store = LocalStore(ctx)
        val tree = store.recordingsFolder?.let(Uri::parse) ?: return Result(error = "Recordings folder not chosen")
        val uid = Backend.uid ?: return Result(error = "Not signed in")
        val since = System.currentTimeMillis() - days * 86_400_000L
        val calls = PhoneCalls.readLog(ctx, since).filter { it.durationSec > 0 && (it.direction == "outgoing" || it.direction == "incoming") }
        val todo = calls.filter { it.id !in store.uploadedRecordings }
        val files = try { listFiles(ctx, tree, since - 86_400_000L).toMutableList() } catch (e: Exception) { return Result(error = e.message) }
        var matched = 0; var uploaded = 0; var lastError: String? = null
        for (c in todo) {
            val last10 = c.phone.filter { it.isDigit() }.takeLast(10)
            val end = c.startedAtMs + c.durationSec * 1000L
            // Score every file: how close its time is to this call; the number in the name helps.
            val best = files.mapNotNull { f ->
                val numberOk = last10.length >= 7 && f.name.filter { it.isDigit() }.contains(last10)
                val dName = f.nameTime?.let { abs(it - c.startedAtMs) }
                val dMod = if (f.modified in (c.startedAtMs - 30_000)..(end + 300_000)) abs(f.modified - end) else null
                val d = listOfNotNull(dName?.takeIf { it <= 180_000 }, dMod).minOrNull() ?: return@mapNotNull null
                f to (if (numberOk) d / 10 else d)
            }.minByOrNull { it.second }?.first ?: continue
            matched++
            val ext = best.name.substringAfterLast('.', "m4a").lowercase()
            val path = "$orgId/$uid/${c.id}.$ext"
            runCatching {
                val bytes = ctx.contentResolver.openInputStream(best.doc.uri)!!.use { it.readBytes() }
                Backend.client.storage.from("recordings").upload(path, bytes) { upsert = true }
                Backend.client.postgrest.rpc("set_call_recording", buildJsonObject { put("p_call", c.id); put("p_path", path); put("p_size", bytes.size.toLong()) })
            }.onSuccess { store.markRecordingUploaded(c.id); files.remove(best); uploaded++ }
             .onFailure { lastError = (it.message ?: it.toString()).take(200) }
        }
        store.recordingsUploaded += uploaded
        return Result(files.size + uploaded, calls.size, matched, uploaded,
            lastError ?: if (files.isEmpty() && uploaded == 0) "No recording files found in the folder for the last $days days" else null)
    }
}
