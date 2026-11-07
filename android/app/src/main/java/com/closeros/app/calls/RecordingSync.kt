package com.closeros.app.calls

import android.content.Context
import android.net.Uri
import android.telecom.TelecomManager
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import io.github.jan.supabase.auth.auth
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalStore
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.math.abs
import kotlinx.serialization.builtins.serializer

/**
 * Finds the phone's own call recordings (in the folder the rep picked once) and uploads each one
 * to the private recordings store, linked to its call. Works where the phone maker's dialer saves
 * recordings as normal files (Xiaomi/MIUI dialer, Samsung, Vivo, many Realme/Oppo…). Google's
 * Phone app keeps recordings private, so nothing can be picked up on those phones.
 */
/** Which file in the phone's recordings folder belongs to which call — so recordings play from the phone itself. */
object LocalRecordings {
    private const val KEY = "rec_local"
    private val ser = kotlinx.serialization.builtins.MapSerializer(String.serializer(), String.serializer())
    private val lock = Any()
    private fun read(ctx: Context): Map<String, String> = com.closeros.app.data.LocalDb.get(ctx).get(KEY)
        ?.let { runCatching { com.closeros.app.data.json.decodeFromString(ser, it) }.getOrNull() } ?: emptyMap()
    fun put(ctx: Context, callId: String, uri: Uri) = synchronized(lock) {
        val m = read(ctx).toMutableMap(); m[callId] = uri.toString()
        // Keep the newest 3,000.
        val trimmed = if (m.size > 3000) m.entries.toList().takeLast(3000).associate { it.key to it.value } else m
        com.closeros.app.data.LocalDb.get(ctx).put(KEY, com.closeros.app.data.json.encodeToString(ser, trimmed))
    }
    fun known(ctx: Context): Set<String> = read(ctx).keys
    /** The recording on this phone, if the file is still there and readable. */
    fun uri(ctx: Context, callId: String): Uri? {
        val u = read(ctx)[callId]?.let(Uri::parse) ?: return null
        return runCatching { ctx.contentResolver.openFileDescriptor(u, "r")?.use { true } }.getOrNull()?.let { u }
    }
}

object RecordingSync {
    data class Result(val filesFound: Int = 0, val callsChecked: Int = 0, val matched: Int = 0, val uploaded: Int = 0, val error: String? = null)

    private val audio = Regex(".*\\.(mp3|m4a|amr|aac|wav|ogg|opus|3gp)$", RegexOption.IGNORE_CASE)
    // 20261101153045 / 20261101_153045 (Xiaomi, most brands) and 261101_153045 (Samsung).
    private val long = Regex("(20\\d{2})(\\d{2})(\\d{2})[_\\-\\s]?(\\d{2})(\\d{2})(\\d{2})")
    private val short = Regex("(?<!\\d)(\\d{2})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})(?!\\d)")

    fun googleDialer(ctx: Context) =
        ctx.getSystemService(TelecomManager::class.java)?.defaultDialerPackage == "com.google.android.dialer"

    private data class F(val uri: Uri, val name: String, val modified: Long, val nameTime: Long?, val size: Long)

    /** Time written in the file name (the LAST date-time in it, so numbers in the name don't confuse it). */
    private fun nameTime(name: String): Long? {
        val zone = ZoneId.systemDefault()
        fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int, s: Int) =
            runCatching { LocalDateTime.of(y, mo, d, h, mi, s).atZone(zone).toInstant().toEpochMilli() }.getOrNull()
        long.findAll(name).lastOrNull()?.groupValues?.map { it.toIntOrNull() ?: 0 }?.let { g -> at(g[1], g[2], g[3], g[4], g[5], g[6])?.let { return it } }
        short.findAll(name).lastOrNull()?.groupValues?.map { it.toIntOrNull() ?: 0 }?.let { g -> return at(2000 + g[1], g[2], g[3], g[4], g[5], g[6]) }
        return null
    }

    /**
     * Lists recent audio files in the chosen folder (and up to 3 sub-folders) with one quick query per
     * folder — much faster than opening each file on phones with thousands of recordings.
     */
    private fun listFiles(ctx: Context, tree: Uri, sinceMs: Long): List<F> {
        val root = DocumentFile.fromTreeUri(ctx, tree) ?: throw IllegalStateException("Recordings folder can't be opened — choose it again")
        if (!root.canRead()) throw IllegalStateException("No permission to read the recordings folder — choose it again")
        val out = mutableListOf<F>()
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_SIZE)
        fun walk(docId: String, depth: Int) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0); val name = c.getString(1).orEmpty(); val mime = c.getString(2).orEmpty()
                    val modified = c.getLong(3); val size = c.getLong(4)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) { if (depth < 3) walk(id, depth + 1) }
                    else if (modified >= sinceMs && audio.matches(name)) out += F(DocumentsContract.buildDocumentUriUsingTree(tree, id), name, modified, nameTime(name), size)
                }
            }
        }
        walk(DocumentsContract.getTreeDocumentId(tree), 0)
        return out
    }

    /** Streams the file to storage (never loads a long recording fully into memory). Returns bytes sent. */
    private suspend fun streamUpload(ctx: Context, f: F, path: String): Long {
        val token = Backend.client.auth.currentAccessTokenOrNull() ?: throw IllegalStateException("Not signed in")
        val ext = f.name.substringAfterLast('.', "m4a").lowercase()
        val mime = when (ext) { "mp3" -> "audio/mpeg"; "amr" -> "audio/amr"; "aac" -> "audio/aac"; "wav" -> "audio/wav"; "ogg", "opus" -> "audio/ogg"; "3gp" -> "audio/3gpp"; else -> "audio/mp4" }
        val url = java.net.URL(com.closeros.app.BuildConfig.SUPABASE_URL + "/storage/v1/object/recordings/" + path.split('/').joinToString("/") { Uri.encode(it) })
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val con = (url.openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true; connectTimeout = 20_000; readTimeout = 120_000
                setRequestProperty("Authorization", "Bearer $token"); setRequestProperty("apikey", com.closeros.app.BuildConfig.SUPABASE_KEY)
                setRequestProperty("x-upsert", "true"); setRequestProperty("Content-Type", mime)
                if (f.size > 0) setFixedLengthStreamingMode(f.size) else setChunkedStreamingMode(64 * 1024)
            }
            var sent = 0L
            try {
                ctx.contentResolver.openInputStream(f.uri)!!.use { input -> con.outputStream.use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) { val n = input.read(buf); if (n < 0) break; out.write(buf, 0, n); sent += n }
                } }
                val code = con.responseCode
                if (code !in 200..299) throw IllegalStateException("Upload refused ($code): " + (con.errorStream?.bufferedReader()?.readText()?.take(150) ?: ""))
            } finally { con.disconnect() }
            sent
        }
    }

    /** Uploads recordings for answered calls of the last [days] days. */
    suspend fun run(ctx: Context, orgId: String, days: Int = 7): Result {
        val store = LocalStore(ctx)
        val tree = PhoneSetup.recordingsFolder(ctx)?.let(Uri::parse) ?: return Result(error = "Recordings folder not chosen")
        val uid = Backend.uid ?: return Result(error = "Not signed in")
        val since = System.currentTimeMillis() - days * 86_400_000L
        val calls = PhoneCalls.readLog(ctx, since).filter { it.durationSec > 0 && (it.direction == "outgoing" || it.direction == "incoming") }
        val done = store.uploadedRecordings
        val mapped = LocalRecordings.known(ctx)
        // Calls uploaded by older versions: also remember their phone file (no upload), so they play from the phone.
        val todo = calls.filter { it.id !in done || it.id !in mapped }
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
            LocalRecordings.put(ctx, c.id, best.uri)
            if (c.id in done) { files.remove(best); continue }
            val ext = best.name.substringAfterLast('.', "m4a").lowercase()
            val path = "$orgId/$uid/${c.id}.$ext"
            runCatching {
                val size = streamUpload(ctx, best, path)
                Backend.client.postgrest.rpc("set_call_recording", buildJsonObject { put("p_call", c.id); put("p_path", path); put("p_size", size) })
            }.onSuccess { store.markRecordingUploaded(c.id); files.remove(best); uploaded++ }
             .onFailure { lastError = (it.message ?: it.toString()).take(200) }
        }
        store.recordingsUploaded += uploaded
        // Nothing matched although there are files and calls: note what the names and times look like (for support).
        val diagP = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
        if (matched == 0 && files.isNotEmpty() && todo.isNotEmpty() && System.currentTimeMillis() - diagP.getLong("rec_diag_ms", 0) > 86_400_000L) runCatching {
            diagP.edit().putLong("rec_diag_ms", System.currentTimeMillis()).apply()
            val zone = ZoneId.systemDefault(); val fmt = java.time.format.DateTimeFormatter.ofPattern("dd/MM HH:mm:ss")
            fun t(ms: Long) = java.time.Instant.ofEpochMilli(ms).atZone(zone).format(fmt)
            com.closeros.app.data.AppLog.error(ctx, "recordings", null, kind = "info", message = "no match · files: " +
                files.sortedByDescending { it.modified }.take(5).joinToString(" | ") { "${it.name.replace(Regex("\\d{6,}")) { m -> "…" + m.value.takeLast(4) }} (mod ${t(it.modified)}, name ${it.nameTime?.let(::t) ?: "-"})" } +
                " · calls: " + todo.take(4).joinToString(" | ") { "${t(it.startedAtMs)} ${it.durationSec}s …${it.phone.takeLast(4)}" })
        }
        return Result(files.size + uploaded, calls.size, matched, uploaded,
            lastError ?: if (files.isEmpty() && uploaded == 0) "No recording files found in the folder for the last $days days" else null)
    }
}
