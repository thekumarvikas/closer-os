package com.closeros.poc

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var player: MediaPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Screen(::play) } }
    }

    private fun play(uri: Uri) {
        player?.release()
        player = runCatching {
            MediaPlayer().apply { setDataSource(this@MainActivity, uri); prepare(); start() }
        }.getOrElse {
            Toast.makeText(this, "Could not play: ${it.message}", Toast.LENGTH_LONG).show(); null
        }
    }

    override fun onDestroy() { player?.release(); super.onDestroy() }
}

private val permissions = buildList {
    add(Manifest.permission.READ_CALL_LOG)
    add(Manifest.permission.READ_PHONE_STATE)
    add(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE)
}.toTypedArray()

private const val PREF_FOLDER = "folder_uri"

@Composable
private fun Screen(onPlay: (Uri) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { ctx.getSharedPreferences("poc", Context.MODE_PRIVATE) }

    var loading by remember { mutableStateOf(false) }
    var device by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var sims by remember { mutableStateOf<List<SimInfo>>(emptyList()) }
    var calls by remember { mutableStateOf<List<CallEntry>>(emptyList()) }
    var recordings by remember { mutableStateOf<List<RecordingFile>>(emptyList()) }
    var matches by remember { mutableStateOf<List<Match>>(emptyList()) }
    var folder by remember { mutableStateOf(prefs.getString(PREF_FOLDER, null)?.let(Uri::parse)) }

    fun runTest() = scope.launch {
        loading = true
        withContext(Dispatchers.IO) {
            device = Diagnostics.deviceInfo(ctx)
            sims = Diagnostics.sims(ctx)
            calls = Diagnostics.recentCalls(ctx)
            val fromFolder = folder?.let { runCatching { Diagnostics.recordingsFromFolder(ctx, it) }.getOrDefault(emptyList()) }.orEmpty()
            recordings = (Diagnostics.recordingsFromMediaStore(ctx) + fromFolder).distinctBy { it.name + it.sizeBytes }
            matches = Diagnostics.match(calls, recordings)
        }
        loading = false
    }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { runTest() }
    val folderLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            prefs.edit().putString(PREF_FOLDER, uri.toString()).apply()
            folder = uri
            runTest()
        }
    }

    Scaffold { pad ->
        LazyColumn(Modifier.padding(pad).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text("Closer OS – Recording Test", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Text(
                    "1. Turn on auto call recording in your phone app.\n" +
                    "2. Make 3–4 short test calls (talk at least 15 seconds).\n" +
                    "3. Tap Run test and allow the permissions.\n" +
                    "4. Tap Copy report and paste it back to Claude.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { permLauncher.launch(permissions) }, enabled = !loading) { Text(if (loading) "Testing…" else "Run test") }
                    OutlinedButton(onClick = { folderLauncher.launch(null) }) { Text("Pick folder") }
                }
                OutlinedButton(
                    onClick = {
                        val text = Diagnostics.report(device, sims, calls, recordings, matches)
                        ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("report", text))
                        Toast.makeText(ctx, "Report copied", Toast.LENGTH_SHORT).show()
                    },
                    enabled = device.isNotEmpty(),
                ) { Text("Copy report") }
                Text(
                    "Use Pick folder only if no recordings are found. On Xiaomi, try MIUI › sound_recorder › call_rec.",
                    style = MaterialTheme.typography.bodySmall, color = Color.Gray,
                )
            }
            item { InAppRecordingTest(onPlay) }
            if (device.isNotEmpty()) {
                item { Section("Device") { device.forEach { (k, v) -> Text("$k: $v") } } }
                item {
                    Section("SIM cards") {
                        if (sims.isEmpty()) Text("No SIMs visible (phone permission missing?)")
                        sims.forEach { Text("Slot ${it.slot}: ${it.carrier} – ${it.displayName}") }
                    }
                }
                item {
                    val ok = matches.count { it.recording != null }
                    Section("Result") {
                        Text("Calls read: ${calls.size}")
                        Text("Recording files found: ${recordings.size}")
                        Text(
                            "Answered calls with a recording: $ok / ${matches.size}",
                            fontWeight = FontWeight.Bold,
                            color = if (matches.isNotEmpty() && ok == matches.size) Color(0xFF1B7F3B) else Color(0xFFB3261E),
                        )
                    }
                }
                items(matches) { m ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text("${m.call.type} ${Diagnostics.mask(m.call.number)} · ${m.call.durationSec}s", fontWeight = FontWeight.SemiBold)
                            Text(Diagnostics.time(m.call.startMillis), style = MaterialTheme.typography.bodySmall)
                            if (m.recording != null) {
                                Text("✓ ${m.recording.name}", color = Color(0xFF1B7F3B), style = MaterialTheme.typography.bodySmall)
                                Text("Matched by ${m.reason}", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                                TextButton(onClick = { onPlay(m.recording.uri) }) { Text("▶ Play – check both voices are audible") }
                            } else {
                                Text("✗ No recording found", color = Color(0xFFB3261E), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Text(title, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            content()
        }
    }
}

@Composable
private fun InAppRecordingTest(onPlay: (Uri) -> Unit) {
    val ctx = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    DisposableEffect(Unit) {
        RecorderService.onChange = { tick++ }
        onDispose { RecorderService.onChange = null }
    }
    var source by remember { mutableStateOf("MIC") }
    val perms = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.RECORD_AUDIO] == true) RecorderService.start(ctx, source)
        else Toast.makeText(ctx, "Microphone permission is needed for this test", Toast.LENGTH_LONG).show()
    }
    @Suppress("UNUSED_EXPRESSION") tick // re-read live values on every change

    Section("Experiment: can Closer OS record the call itself?") {
        Text(
            "1. Pick a method and tap Start.\n" +
            "2. Open your Phone app and call someone. Keep the phone at your ear (not speaker). Talk 20 seconds.\n" +
            "3. End the call, come back here, tap Stop.\n" +
            "4. Tap Play. Can you hear YOU, THEM, or BOTH?\n" +
            "Please try all 3 methods, one call each.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RecorderService.sources.keys.forEachIndexed { i, key ->
                FilterChip(
                    selected = source == key, onClick = { source = key },
                    enabled = !RecorderService.isRecording,
                    label = { Text("Method ${i + 1}") },
                )
            }
        }
        if (RecorderService.isRecording) {
            Text("● Recording… loudness ${RecorderService.liveLoudness}", color = Color(0xFFB3261E), fontWeight = FontWeight.Bold)
            Button(onClick = { RecorderService.stop(ctx) }) { Text("Stop") }
        } else {
            Button(onClick = { launcher.launch(perms) }) { Text("Start (Method ${RecorderService.sources.keys.indexOf(source) + 1})") }
        }
        RecorderService.lastError?.let { Text(it, color = Color(0xFFB3261E), style = MaterialTheme.typography.bodySmall) }
        RecorderService.results.forEach { r ->
            val n = RecorderService.sources.keys.indexOf(r.source) + 1
            val silent = r.peak < 200
            Spacer(Modifier.height(6.dp))
            Text("Method $n · ${r.seconds}s · peak ${r.peak} · avg ${r.avgLoudness}" + if (silent) " · SILENT" else "",
                fontWeight = FontWeight.SemiBold, color = if (silent) Color(0xFFB3261E) else Color.Unspecified)
            TextButton(onClick = { onPlay(Uri.fromFile(r.file)) }) { Text("▶ Play Method $n") }
        }
        if (RecorderService.results.isNotEmpty()) {
            OutlinedButton(onClick = {
                val text = buildString {
                    appendLine("IN-APP RECORDING TEST")
                    appendLine("${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}")
                    RecorderService.results.forEach {
                        appendLine("Method ${RecorderService.sources.keys.indexOf(it.source) + 1} (${it.source}): ${it.seconds}s, peak ${it.peak}, avg ${it.avgLoudness}")
                    }
                }
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("report", text))
                Toast.makeText(ctx, "Experiment report copied", Toast.LENGTH_SHORT).show()
            }) { Text("Copy experiment report") }
        }
    }
}
