package com.closeros.poc

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.MediaStore
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import androidx.documentfile.provider.DocumentFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

data class SimInfo(val slot: Int, val subscriptionId: Int, val carrier: String, val displayName: String)

data class CallEntry(
    val number: String,
    val type: String,
    val startMillis: Long,
    val durationSec: Long,
    val phoneAccountId: String?,
) {
    // MIUI stores ring time as "duration" on missed calls, so only count real answered calls.
    val isAnswered get() = durationSec > 0 && (type == "Incoming" || type == "Outgoing")
}

data class RecordingFile(
    val uri: Uri,
    val name: String,
    val folder: String,
    val sizeBytes: Long,
    val modifiedMillis: Long,
    val source: String, // "MediaStore" or "Folder"
)

data class Match(val call: CallEntry, val recording: RecordingFile?, val reason: String)

object Diagnostics {

    fun deviceInfo(ctx: Context): Map<String, String> {
        val telecom = ctx.getSystemService(TelecomManager::class.java)
        return linkedMapOf(
            "Manufacturer" to Build.MANUFACTURER,
            "Model" to Build.MODEL,
            "Android" to "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "MIUI/HyperOS" to (sysProp("ro.mi.os.version.name").ifBlank { sysProp("ro.miui.ui.version.name") }.ifBlank { "-" }),
            "Default phone app" to (telecom?.defaultDialerPackage ?: "unknown"),
        )
    }

    @SuppressLint("PrivateApi")
    private fun sysProp(key: String): String = try {
        val c = Class.forName("android.os.SystemProperties")
        c.getMethod("get", String::class.java).invoke(null, key) as String
    } catch (e: Exception) { "" }

    @SuppressLint("MissingPermission")
    fun sims(ctx: Context): List<SimInfo> = try {
        val sm = ctx.getSystemService(SubscriptionManager::class.java)
        sm.activeSubscriptionInfoList.orEmpty().map {
            SimInfo(it.simSlotIndex + 1, it.subscriptionId, it.carrierName?.toString() ?: "", it.displayName?.toString() ?: "")
        }
    } catch (e: SecurityException) { emptyList() }

    fun recentCalls(ctx: Context, limit: Int = 40): List<CallEntry> {
        val out = mutableListOf<CallEntry>()
        val cols = arrayOf(
            CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE,
            CallLog.Calls.DURATION, CallLog.Calls.PHONE_ACCOUNT_ID,
        )
        try {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI, cols, null, null, "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                while (c.moveToNext() && out.size < limit) {
                    out += CallEntry(
                        number = c.getString(0) ?: "",
                        type = when (c.getInt(1)) {
                            CallLog.Calls.INCOMING_TYPE -> "Incoming"
                            CallLog.Calls.OUTGOING_TYPE -> "Outgoing"
                            CallLog.Calls.MISSED_TYPE -> "Missed"
                            CallLog.Calls.REJECTED_TYPE -> "Rejected"
                            else -> "Other"
                        },
                        startMillis = c.getLong(2),
                        durationSec = c.getLong(3),
                        phoneAccountId = c.getString(4),
                    )
                }
            }
        } catch (e: SecurityException) { /* permission missing */ }
        return out
    }

    private val callFolderHints = listOf("call", "sound_recorder", "phonerecord", "record")

    /** Audio files that look like call recordings, found via the shared media index. */
    fun recordingsFromMediaStore(ctx: Context, limit: Int = 300): List<RecordingFile> {
        val out = mutableListOf<RecordingFile>()
        val uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val pathCol = if (Build.VERSION.SDK_INT >= 29) MediaStore.MediaColumns.RELATIVE_PATH
                      else @Suppress("DEPRECATION") MediaStore.MediaColumns.DATA
        val cols = arrayOf(
            MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, pathCol,
            MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED,
        )
        try {
            ctx.contentResolver.query(uri, cols, null, null, "${MediaStore.MediaColumns.DATE_MODIFIED} DESC")?.use { c ->
                while (c.moveToNext() && out.size < limit) {
                    val folder = c.getString(2) ?: ""
                    if (callFolderHints.none { folder.lowercase().contains(it) }) continue
                    out += RecordingFile(
                        uri = Uri.withAppendedPath(uri, c.getLong(0).toString()),
                        name = c.getString(1) ?: "",
                        folder = folder,
                        sizeBytes = c.getLong(3),
                        modifiedMillis = c.getLong(4) * 1000,
                        source = "MediaStore",
                    )
                }
            }
        } catch (e: SecurityException) { /* permission missing */ }
        return out
    }

    /** Fallback: files inside a folder the user picked with the system folder picker. */
    fun recordingsFromFolder(ctx: Context, tree: Uri, limit: Int = 300): List<RecordingFile> {
        val out = mutableListOf<RecordingFile>()
        fun walk(dir: DocumentFile, path: String, depth: Int) {
            for (f in dir.listFiles()) {
                if (out.size >= limit) return
                if (f.isDirectory && depth < 3) walk(f, "$path${f.name}/", depth + 1)
                else if (f.isFile && (f.type?.startsWith("audio") == true || f.name.orEmpty().matches(Regex(".*\\.(mp3|m4a|amr|aac|wav|ogg|opus)$", RegexOption.IGNORE_CASE)))) {
                    out += RecordingFile(f.uri, f.name ?: "", path, f.length(), f.lastModified(), "Folder")
                }
            }
        }
        DocumentFile.fromTreeUri(ctx, tree)?.let { walk(it, it.name.orEmpty() + "/", 0) }
        return out.sortedByDescending { it.modifiedMillis }
    }

    private fun digits(s: String) = s.filter { it.isDigit() }

    private val stampRegex = Regex("(20\\d{6})[_\\-]?(\\d{6})")
    private val stampFormat = SimpleDateFormat("yyyyMMddHHmmss", Locale.US)

    /** Start time encoded in the file name, e.g. "..._20261031153045.mp3". */
    private fun timeFromName(name: String): Long? = stampRegex.find(name)?.let {
        runCatching { stampFormat.parse(it.groupValues[1] + it.groupValues[2])?.time }.getOrNull()
    }

    /**
     * Matches each answered call to a recording. A file matches when its name contains the
     * number, or its name timestamp / saved time falls inside the call window.
     */
    fun match(calls: List<CallEntry>, recordings: List<RecordingFile>): List<Match> {
        val used = mutableSetOf<Uri>()
        return calls.filter { it.isAnswered }.map { call ->
            val last10 = digits(call.number).takeLast(10)
            val callEnd = call.startMillis + call.durationSec * 1000
            var best: Pair<RecordingFile, String>? = null
            for (r in recordings) {
                if (r.uri in used) continue
                val nameTime = timeFromName(r.name)
                val nameHasNumber = last10.length >= 7 && digits(r.name).contains(last10)
                val nameTimeOk = nameTime != null && abs(nameTime - call.startMillis) <= 90_000
                val savedTimeOk = r.modifiedMillis in (call.startMillis - 30_000)..(callEnd + 180_000)
                val reason = when {
                    nameHasNumber && (nameTimeOk || savedTimeOk) -> "number + time"
                    nameTimeOk -> "time in file name"
                    savedTimeOk -> "file saved time"
                    else -> null
                }
                if (reason != null) { best = r to reason; if (reason == "number + time") break }
            }
            best?.let { used += it.first.uri }
            Match(call, best?.first, best?.second ?: "no recording found")
        }
    }

    fun mask(number: String): String {
        val d = digits(number)
        return if (d.length <= 4) d else "••••" + d.takeLast(4)
    }

    private val fmt = SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.US)
    fun time(ms: Long): String = fmt.format(Date(ms))

    fun report(
        device: Map<String, String>, sims: List<SimInfo>, calls: List<CallEntry>,
        recordings: List<RecordingFile>, matches: List<Match>,
    ): String = buildString {
        appendLine("CLOSER OS RECORDING TEST REPORT")
        device.forEach { (k, v) -> appendLine("$k: $v") }
        appendLine("SIMs: " + sims.joinToString { "slot ${it.slot} ${it.carrier} (sub ${it.subscriptionId})" }.ifBlank { "none visible" })
        appendLine("Calls read: ${calls.size}, answered: ${calls.count { it.isAnswered }}")
        appendLine("Recording files found: ${recordings.size}")
        recordings.map { "${it.source}: ${it.folder}" }.distinct().take(5).forEach { appendLine("  folder $it") }
        recordings.take(5).forEach { appendLine("  e.g. ${it.name.replace(Regex("\\d{6,}")) { m -> "#".repeat(m.value.length) }}") }
        val ok = matches.count { it.recording != null }
        appendLine("Answered calls matched to a recording: $ok / ${matches.size}")
        matches.take(15).forEach {
            appendLine("  ${time(it.call.startMillis)} ${it.call.type} ${mask(it.call.number)} ${it.call.durationSec}s -> ${it.reason}")
        }
    }
}
