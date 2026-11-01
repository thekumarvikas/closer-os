package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.Lead
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

// ───────────── Today's numbers (from the phone's own call log) ─────────────

private data class TileDef(val key: String, val label: String, val value: (List<HistoryItem>) -> String, val bad: Boolean = false)

private val tiles = listOf(
    TileDef("all", "All calls", { it.size.toString() }),
    TileDef("dialled", "Dialled", { l -> l.count { it.log.direction == "outgoing" }.toString() }),
    TileDef("received", "Received", { l -> l.count { it.log.direction == "incoming" }.toString() }),
    TileDef("conversations", "Conversations", { l -> l.count { it.log.durationSec > 0 }.toString() }),
    TileDef("noanswer", "No answer", { l -> l.count { it.log.direction == "outgoing" && it.log.durationSec == 0 }.toString() }, bad = true),
    TileDef("missed", "Missed / declined", { l -> l.count { it.log.direction == "missed" || it.log.direction == "rejected" }.toString() }, bad = true),
    TileDef("talk", "Talk time", { l -> fmtDur(l.sumOf { it.log.durationSec }) }),
    TileDef("avg", "Avg. conversation", { l -> l.filter { it.log.durationSec > 0 }.let { c -> fmtDur(if (c.isEmpty()) 0 else c.sumOf { it.log.durationSec } / c.size) } }),
    TileDef("contacts", "Unique contacts", { l -> l.map { it.phone }.distinct().size.toString() }),
    TileDef("leads", "Leads called", { l -> l.mapNotNull { it.lead?.id }.distinct().size.toString() }),
)

fun todayMatches(key: String, h: HistoryItem): Boolean = when (key) {
    "dialled" -> h.log.direction == "outgoing"
    "received" -> h.log.direction == "incoming"
    "conversations", "talk", "avg" -> h.log.durationSec > 0
    "noanswer" -> h.log.direction == "outgoing" && h.log.durationSec == 0
    "missed" -> h.log.direction == "missed" || h.log.direction == "rejected"
    "leads" -> h.lead != null
    else -> true
}

@Composable
fun HomeScreen(vm: AppViewModel) {
    val m = vm.membership ?: return
    val now = System.currentTimeMillis()
    val dueSoon = vm.followUps.filter { runCatching { Instant.parse(it.due_at).toEpochMilli() }.getOrDefault(0) < now + 86_400_000 }
    val overdue = vm.followUps.count { runCatching { Instant.parse(it.due_at).toEpochMilli() }.getOrDefault(0) < now }
    LaunchedEffect(Unit) { vm.loadToday() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Hi ${vm.profile?.full_name?.substringBefore(' ') ?: ""} 👋", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(m.organization.name, color = Brand.muted)
        }
        item { SetupBanner(vm) }
        if (vm.queueActive) item {
            Card(Modifier.fillMaxWidth().clickable { vm.queueResume() }, colors = CardDefaults.cardColors(containerColor = Brand.light)) {
                Text("Calling queue: ${vm.queuePos + 1} of ${vm.queue.size} — tap to continue", Modifier.padding(14.dp), color = Brand.primaryDark, fontWeight = FontWeight.SemiBold)
            }
        }
        item {
            Text("Today · tap a number to see the calls", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            tiles.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 10.dp)) {
                    row.forEach { t ->
                        val v = t.value(vm.today)
                        Card(Modifier.weight(1f).clickable { vm.todayFilter = t.key }, colors = CardDefaults.cardColors(containerColor = Color.White)) {
                            Column(Modifier.padding(12.dp)) {
                                Text(t.label, fontSize = 13.sp, color = Brand.muted)
                                Text(v, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = if (t.bad && v != "0") Brand.red else Color(0xFF0F172A))
                            }
                        }
                    }
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth().clickable { vm.tab = Tab.FollowUps }, colors = CardDefaults.cardColors(containerColor = if (overdue > 0) Color(0xFFFEF2F2) else Color.White)) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.DateRange, null, tint = if (overdue > 0) Brand.red else Brand.primary)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Follow-ups", fontWeight = FontWeight.SemiBold)
                        Text("${dueSoon.size} due within 24 hours" + if (overdue > 0) " · $overdue overdue" else "", color = if (overdue > 0) Brand.red else Brand.muted, fontSize = 14.sp)
                    }
                    Icon(Icons.Default.KeyboardArrowRight, null, tint = Brand.muted)
                }
            }
        }
        item {
            Button(onClick = { vm.startFollowUpQueue() }, enabled = dueSoon.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(54.dp)) {
                Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text("Call due follow-ups (${dueSoon.size})", fontSize = 16.sp)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { vm.tab = Tab.Leads }, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text("Pick leads to call") }
        }
        item {
            val last = vm.store.lastSyncMs
            Text((if (last == 0L) "Calls not synced yet" else "Synced ${fmtWhen(Instant.ofEpochMilli(last).toString())}") +
                    (if (vm.store.recordingsUploaded > 0) " · ${vm.store.recordingsUploaded} recordings uploaded" else "") +
                    (if (vm.store.outbox.isNotEmpty()) " · ${vm.store.outbox.size} outcome(s) waiting for internet" else ""), fontSize = 12.sp, color = Brand.muted)
        }
    }
}

/** The calls behind one of today's numbers; leads among them can go straight into a calling queue. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayListScreen(vm: AppViewModel, key: String) {
    BackHandler { vm.todayFilter = null }
    val label = tiles.firstOrNull { it.key == key }?.label ?: "Calls"
    val items = vm.today.filter { todayMatches(key, it) }
    val leads = items.mapNotNull { it.lead }.distinctBy { it.id }
    Scaffold(topBar = {
        TopAppBar(title = { Text("$label today (${items.size})") }, navigationIcon = { IconButton(onClick = { vm.todayFilter = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }, bottomBar = {
        if (leads.isNotEmpty()) Surface(shadowElevation = 8.dp) {
            Button(onClick = { vm.startQueue(leads) }, modifier = Modifier.fillMaxWidth().padding(16.dp).height(52.dp)) {
                Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text("Call these ${leads.size} leads in a queue")
            }
        }
    }) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (items.isEmpty()) item { Text("No calls here yet today.", color = Brand.muted) }
            items(items, key = { it.log.id }) { h -> HistoryRow(vm, h) }
            if (items.size > leads.size && leads.isNotEmpty()) item {
                Text("Numbers that are not leads can't go in the queue — add them as leads from the Calls tab first.", fontSize = 12.sp, color = Brand.muted)
            }
        }
    }
}

@Composable
fun HistoryRow(vm: AppViewModel, h: HistoryItem, onAdd: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp))
        .clickable(enabled = h.lead != null) { h.lead?.let { vm.openLeadId = it.id } }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(h.lead?.name?.ifBlank { null } ?: h.log.name ?: fmtPhone(h.phone), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val dir = when (h.log.direction) { "outgoing" -> "Dialled"; "incoming" -> "Received"; "missed" -> "Missed"; else -> "Declined" }
            Text((if (h.log.channel == "whatsapp") "WhatsApp · " else "") + "$dir · ${if (h.log.durationSec > 0) fmtDur(h.log.durationSec) else "no talk"} · ${fmtWhen(Instant.ofEpochMilli(h.log.startedAtMs).toString())}",
                fontSize = 13.sp, color = if (h.log.direction == "missed" || h.log.direction == "rejected") Brand.red else Brand.muted)
            if (h.lead != null || h.log.name != null) Text(fmtPhone(h.phone), fontSize = 12.sp, color = Brand.muted)
        }
        when {
            h.lead == null && onAdd != null && h.phone.isNotBlank() -> OutlinedButton(onClick = onAdd, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("Add lead", fontSize = 13.sp) }
            h.lead != null -> IconButton(onClick = { vm.callRequest = h.lead }) { Icon(Icons.Default.Call, "Call", tint = Brand.primary) }
        }
    }
}

// ───────────── Calling queue ─────────────

/** Shown between calls while a queue is running: who is next, countdown, pause/skip/stop. */
@Composable
fun QueueScreen(vm: AppViewModel) {
    BackHandler { vm.queuePause() }
    val next = vm.queue.getOrNull(vm.queuePos)
    LaunchedEffect(vm.countdown) { if (vm.countdown != null) { delay(1000); vm.queueTick() } }
    Column(Modifier.fillMaxSize().background(Brand.bg).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Calling queue", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("${minOf(vm.queuePos + 1, vm.queue.size)} of ${vm.queue.size}", color = Brand.muted)
        }
        LinearProgressIndicator(progress = { vm.queuePos.toFloat() / vm.queue.size.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
        Text("${vm.queueDone} calls done · ${vm.queue.size - vm.queuePos} left", color = Brand.muted, fontSize = 14.sp)
        if (next == null) { Button(onClick = { vm.queueStop() }) { Text("Finish") }; return@Column }
        Text("Next", fontWeight = FontWeight.SemiBold)
        LeadCard(vm, next, onCall = null)
        when {
            vm.countdown != null -> {
                Text("Calling in ${vm.countdown}…", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Brand.primary, modifier = Modifier.align(Alignment.CenterHorizontally))
                Button(onClick = { vm.queueCallNow() }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text("Call now") }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { vm.queuePause() }, modifier = Modifier.weight(1f)) { Text("Pause") }
                    OutlinedButton(onClick = { vm.queueSkip() }, modifier = Modifier.weight(1f)) { Text("Skip") }
                }
            }
            else -> {
                Text(if (vm.queuePaused) "Paused" else "Ready", color = Brand.muted, modifier = Modifier.align(Alignment.CenterHorizontally))
                Button(onClick = { vm.queuePaused = false; vm.queueCallNow() }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text("Call ${next.name.substringBefore(' ').ifBlank { "next" }}") }
                OutlinedButton(onClick = { vm.queueSkip() }, modifier = Modifier.fillMaxWidth()) { Text("Skip this lead") }
            }
        }
        TextButton(onClick = { vm.queueStop() }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Stop queue", color = Brand.red) }
        val later = vm.queue.drop(vm.queuePos + 1).take(5)
        if (later.isNotEmpty()) {
            Text("Coming up", fontWeight = FontWeight.SemiBold)
            later.forEach { Text("• ${it.name.ifBlank { fmtPhone(it.phone) }}", color = Brand.muted) }
        }
    }
}

// ───────────── Lead card with details, colour tags and WhatsApp ─────────────

data class Tag(val text: String, val bg: Color, val fg: Color)

fun leadTags(vm: AppViewModel, l: Lead): List<Tag> {
    val out = mutableListOf<Tag>()
    val cat = vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.category
    when (cat) {
        "won" -> out += Tag("Won", Color(0xFFDCFCE7), Color(0xFF166534))
        "positive" -> out += Tag("Interested", Color(0xFFDCFCE7), Color(0xFF166534))
        "lost" -> out += Tag("Not interested", Color(0xFFF1F5F9), Color(0xFF64748B))
    }
    val b = l.latestBatch
    if (b != null && (b.watch_minutes ?: 0) >= 60) out += Tag("🔥 Hot · ${b.watch_minutes} min", Color(0xFFFFEDD5), Color(0xFF9A3412))
    if (l.do_not_call) out += Tag("Do not call", Color(0xFFFEE2E2), Color(0xFF991B1B))
    return out
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LeadCard(vm: AppViewModel, l: Lead, onCall: ((Lead) -> Unit)?) {
    var wa by remember { mutableStateOf(false) }
    val tags = leadTags(vm, l)
    val hot = tags.any { it.text.startsWith("🔥") || it.text == "Interested" || it.text == "Won" }
    Card(Modifier.fillMaxWidth().clickable { vm.openLeadId = l.id },
        colors = CardDefaults.cardColors(containerColor = if (hot) Color(0xFFF7FEF9) else Color.White)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(l.name.ifBlank { "No name" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(fmtPhone(l.phone), fontSize = 13.sp, color = Brand.muted)
                listOfNotNull(l.company?.takeIf { it.isNotBlank() }, l.profession?.takeIf { it.isNotBlank() }, l.city?.takeIf { it.isNotBlank() })
                    .joinToString(" · ").takeIf { it.isNotEmpty() }?.let { Text(it, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                l.latestBatch?.let { b ->
                    Text("${b.batch?.name ?: "Webinar"} · " + when { b.watch_minutes == null -> "attendance not uploaded"; b.watch_minutes > 0 -> "watched ${b.watch_minutes} min"; else -> "didn't join" },
                        fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                val last = listOfNotNull(
                    l.last_connected_at?.let { "Last talked ${fmtWhen(it)}" } ?: l.last_call_at?.let { "Last called ${fmtWhen(it)}" },
                    vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.label,
                ).joinToString(" · ")
                if (last.isNotEmpty()) Text(last, fontSize = 12.sp, color = Brand.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                l.next_follow_up_at?.let { Text("Next call: ${fmtWhen(it)}", fontSize = 12.sp, color = Brand.primary) }
                if (tags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                    tags.forEach { Text(it.text, fontSize = 11.sp, color = it.fg, fontWeight = FontWeight.Medium, modifier = Modifier.background(it.bg, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp)) }
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (onCall != null) FilledIconButton(onClick = { onCall(l) }, enabled = !l.do_not_call) { Icon(Icons.Default.Call, "Call ${l.name}") }
                IconButton(onClick = { wa = true }) { Icon(Icons.Default.Send, "WhatsApp", tint = Color(0xFF16A34A)) }
            }
        }
    }
    if (wa) WhatsAppPicker(vm, l) { wa = false }
}

/**
 * Choose a company message or one of my own; it is filled in for this lead (name etc.), can be edited,
 * then WhatsApp opens with it. My own messages can be saved from here.
 */
@Composable
fun WhatsAppPicker(vm: AppViewModel, lead: Lead, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    var text by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveName by remember { mutableStateOf("") }
    val first = lead.name.substringBefore(' ')
    val company = vm.templates.filter { it.owner_id == null }
    val mine = vm.templates.filter { it.owner_id != null }
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text(if (text == null) "Choose a message" else "WhatsApp to ${first.ifBlank { "lead" }}") },
        text = {
            if (text == null) Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (company.isNotEmpty()) Text("Company messages", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = Brand.muted)
                company.forEach { t -> TemplateRow(vm, t.name, vm.fillTemplate(t.body, lead), null) { text = vm.fillTemplate(t.body, lead) } }
                if (mine.isNotEmpty()) Text("My messages", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 6.dp))
                mine.forEach { t -> TemplateRow(vm, t.name, vm.fillTemplate(t.body, lead), onDelete = { vm.deleteMyTemplate(t.id) }) { text = vm.fillTemplate(t.body, lead) } }
                TextButton(onClick = { text = "Hi ${first.ifBlank { "there" }}, " }) { Text("Write a new message") }
            } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text!!, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 5)
                if (saving) {
                    OutlinedTextField(saveName, { saveName = it }, label = { Text("Name for this message") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        // Save with a placeholder instead of this lead's name, so it fills in for every lead.
                        val body = if (first.length >= 2) text!!.replace(first, "{{leadName}}") else text!!
                        vm.saveMyTemplate(saveName, body); saving = false
                    }) { Text("Save to My messages") }
                } else TextButton(onClick = { saving = true }) { Text("Save as my message for next time") }
            }
        },
        confirmButton = { if (text != null) Button(onClick = { PhoneCalls.whatsapp(ctx, lead.phone, text!!); onDismiss() }) { Text("Open WhatsApp") } },
        dismissButton = { TextButton(onClick = { if (text != null) { text = null; saving = false } else onDismiss() }) { Text(if (text != null) "Back" else "Cancel") } })
}

@Composable
private fun TemplateRow(vm: AppViewModel, name: String, preview: String, onDelete: (() -> Unit)?, onPick: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(Brand.bg, RoundedCornerShape(10.dp)).clickable(onClick = onPick).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(name, fontWeight = FontWeight.SemiBold)
            Text(preview, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (onDelete != null) TextButton(onClick = onDelete) { Text("Delete", color = Brand.red, fontSize = 12.sp) }
    }
}

/** Plays a call recording inside the app (private link, 15 minutes). */
@Composable
fun RecordingPlayer(callId: String, path: String) {
    val scope = rememberCoroutineScope()
    var player by remember { mutableStateOf<android.media.MediaPlayer?>(null) }
    var state by remember { mutableStateOf("idle") } // idle, loading, playing, paused, error
    DisposableEffect(Unit) { onDispose { player?.release() } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        when (state) {
            "loading" -> Text("Loading…", fontSize = 13.sp, color = Brand.muted)
            "error" -> Text("Couldn't play the recording", fontSize = 13.sp, color = Brand.red)
            else -> TextButton(onClick = {
                val p = player
                when {
                    p != null && state == "playing" -> { p.pause(); state = "paused" }
                    p != null && state == "paused" -> { p.start(); state = "playing" }
                    else -> {
                        state = "loading"
                        scope.launch {
                            runCatching { com.closeros.app.data.Repo.recordingUrl(callId, path) }.onSuccess { url ->
                                player = android.media.MediaPlayer().apply {
                                    setDataSource(url)
                                    setOnPreparedListener { it.start(); state = "playing" }
                                    setOnCompletionListener { state = "paused"; it.seekTo(0) }
                                    setOnErrorListener { _, _, _ -> state = "error"; true }
                                    prepareAsync()
                                }
                            }.onFailure { state = "error" }
                        }
                    }
                }
            }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(when (state) { "playing" -> "❚❚ Pause"; "paused" -> "▶ Resume"; else -> "▶ Play recording" }, fontSize = 13.sp, color = Brand.primary)
            }
        }
    }
}
