package com.closeros.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadSeq
import com.closeros.app.data.SeqLimits
import com.closeros.app.data.SeqMessage
import com.closeros.app.data.Seqs
import com.closeros.app.data.Sequence
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * WhatsApp sequences: messages sent to a lead over days (Day 0, Day 2, Day 5…) or around an event.
 * Each day the messages that are due go into the WhatsApp queue — one tap per lead (never sent automatically).
 */
private val WA_GREEN = Color(0xFF16A34A)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SequencesScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadSequences(); vm.loadSeqDue() }
    val list = vm.sequences
    Scaffold(topBar = {
        TopAppBar(title = { Text("WhatsApp sequences") },
            navigationIcon = { IconButton(onClick = { vm.showSequences = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { SeqDueCard(vm, always = true) }
            item {
                Text("A WhatsApp sequence is a set of messages sent to a lead over a few days — for example Day 0, Day 2, Day 5. " +
                    "Each day, the messages that are due open one by one in WhatsApp: you just tap Send.", fontSize = 13.sp, color = Brand.muted)
            }
            item {
                Button(onClick = { vm.newSequence() }, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text("+ New WhatsApp sequence") }
                if (SeqLimits.free(LocalContext.current)) Text("Free plan: ${vm.mySequenceCount()} of 2 sequences · up to 3 messages each, last message by Day 7",
                    fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(top = 4.dp))
            }
            if (list == null) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            else if (list.isEmpty()) item { Text("No sequences yet — make the first one.", color = Brand.muted) }
            else items(list, key = { it.id }) { s -> SequenceCard(vm, s) }
        }
    }
}

@Composable
private fun SequenceCard(vm: AppViewModel, s: Sequence) {
    var askDelete by remember { mutableStateOf(false) }
    val canEdit = s.mine || (s.company && vm.isManager)
    val outcomes = vm.outcomes.associateBy { it.id }
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(s.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                if (!vm.isSolo) Text(if (s.company) "Company" else if (s.mine) "Mine" else "By ${s.owner_name ?: "a teammate"}", fontSize = 11.sp, color = Brand.primaryDark,
                    modifier = Modifier.background(Brand.light, RoundedCornerShape(6.dp)).padding(6.dp, 2.dp))
            }
            Text("${s.messages.size} message${if (s.messages.size == 1) "" else "s"} · " + s.messages.joinToString(", ") { Seqs.whenText(it).substringBefore(" ·") },
                fontSize = 13.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (s.start_outcomes.isNotEmpty()) Text("🔁 Starts by itself after: " + s.start_outcomes.mapNotNull { outcomes[it]?.label }.joinToString(", "), fontSize = 13.sp, color = Brand.primaryDark)
            Text("${if (vm.isManager && s.company && !vm.isSolo) s.active_all else s.active_mine} leads on it now" + if (s.done_all > 0) " · ${s.done_all} finished" else "", fontSize = 13.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = {
                    vm.showSequences = false; vm.selectMode = true; vm.tab = Tab.Leads; vm.message = "Tick leads, then tap 📨 to start a sequence"
                }) { Text("+ Add leads") }
                Spacer(Modifier.weight(1f))
                if (canEdit) {
                    TextButton(onClick = { vm.editSequence = s }) { Text("Edit") }
                    TextButton(onClick = { askDelete = true }) { Text("Delete", color = Brand.muted) }
                }
            }
        }
    }
    if (askDelete) AlertDialog(onDismissRequest = { askDelete = false }, title = { Text("Delete ${s.name}?") },
        text = { Text("Leads on it stop getting its messages. Messages already sent stay counted.") },
        confirmButton = { TextButton(onClick = { askDelete = false; vm.archiveSequence(s.id) }) { Text("Delete", color = Brand.red) } },
        dismissButton = { TextButton(onClick = { askDelete = false }) { Text("Cancel") } })
}

/** Home + sequences screen: messages due now → "Send now" (WhatsApp queue). */
@Composable
fun SeqDueCard(vm: AppViewModel, always: Boolean = false) {
    val d = vm.seqDue ?: return
    val n = d.due.size
    if (n == 0 && !always && d.later_today == 0) return
    val bySeq = d.due.groupingBy { it.sequence }.eachCount()
    Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(12.dp)).clickable(enabled = !always) { vm.showSequences = true }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(if (n == 0) "📨 No WhatsApp messages due now" else "📨 $n WhatsApp message${if (n == 1) "" else "s"} due", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            val sub = listOfNotNull(bySeq.entries.joinToString(" · ") { "${it.key} ${it.value}" }.ifBlank { null },
                if (d.later_today > 0) "${d.later_today} more later today" else null).joinToString(" · ")
            if (sub.isNotBlank()) Text(sub, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (n > 0) Button(onClick = { vm.startSeqQueue() }, colors = ButtonDefaults.buttonColors(containerColor = WA_GREEN)) { Text("Send now") }
    }
}

/** Free plan limit reached → Closer OS Pro. */
@Composable
fun ProAskDialog(vm: AppViewModel) {
    val text = vm.proAsk ?: return
    AlertDialog(onDismissRequest = { vm.proAsk = null }, title = { Text("Closer OS Pro") }, text = { Text(text) },
        confirmButton = { Button(onClick = { vm.proAsk = null; vm.showRemoveAds = true }) { Text("See Closer OS Pro") } },
        dismissButton = { TextButton(onClick = { vm.proAsk = null }) { Text("Not now") } })
}

/** "Start a WhatsApp sequence" for the chosen leads. */
@Composable
fun SequencePickerDialog(vm: AppViewModel) {
    val pick = vm.seqPick ?: return
    LaunchedEffect(Unit) { if (vm.sequences == null) vm.loadSequences() }
    val list = vm.sequences
    AlertDialog(onDismissRequest = { vm.seqPick = null },
        title = { Text("📨 WhatsApp sequence for ${pick.label}") },
        text = { Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Each lead gets the messages on their days. Leads already on the sequence or marked Do not call are skipped.", fontSize = 13.sp, color = Brand.muted)
            if (list == null) CircularProgressIndicator()
            else if (list.isEmpty()) Text("No sequences yet.", color = Brand.muted)
            list.orEmpty().forEach { s ->
                Column(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(10.dp)).clickable { vm.startSequence(s, pick) }.padding(10.dp)) {
                    Text(s.name, fontWeight = FontWeight.SemiBold)
                    Text("${s.messages.size} messages · " + s.messages.joinToString(", ") { Seqs.whenText(it).substringBefore(" ·") }, fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            TextButton(onClick = { vm.seqPick = null; vm.newSequence() }) { Text("+ New sequence", fontWeight = FontWeight.SemiBold) }
        } },
        confirmButton = {}, dismissButton = { TextButton(onClick = { vm.seqPick = null }) { Text("Cancel") } })
}

/** Lead page: this lead's sequences (Pause / Resume / Stop) + start one. */
@Composable
fun LeadSequencesCard(vm: AppViewModel, l: Lead) {
    var rows by remember(l.id) { mutableStateOf<List<LeadSeq>?>(null) }
    LaunchedEffect(l.id, vm.leadRefresh) { rows = runCatching { Seqs.forLead(l.id) }.getOrNull() ?: rows }
    val live = rows.orEmpty().filter { it.status == "active" || it.status == "paused" }
    val past = rows.orEmpty().filter { it.status != "active" && it.status != "paused" }.take(2)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        live.forEach { r ->
            Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(10.dp)).padding(10.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("📨 ${r.name}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(if (r.status == "paused") "Paused · ${r.sent_count} of ${r.total} sent"
                        else "Message ${r.next_pos ?: "–"} of ${r.total} · " + (r.next_due_at?.let { "next ${fmtWhen(it)}" } ?: "nothing planned"),
                        fontSize = 12.sp, color = Brand.muted)
                }
                if (r.status == "paused") TextButton(onClick = { vm.setSeqLead(r.id, "resume") }) { Text("Resume") }
                else TextButton(onClick = { vm.setSeqLead(r.id, "pause") }) { Text("Pause") }
                TextButton(onClick = { vm.setSeqLead(r.id, "stop") }) { Text("Stop", color = Brand.muted) }
            }
        }
        past.forEach { r ->
            Text("📨 ${r.name}: " + (if (r.status == "done") "all ${r.total} done" else "${r.stop_reason ?: "stopped"} · ${r.sent_count} sent"), fontSize = 12.sp, color = Brand.muted)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { vm.seqPick = AppViewModel.SeqPick(listOf(l.id), l.name.ifBlank { "this lead" }) }) { Text("📨 Start a WhatsApp sequence") }
            Spacer(Modifier.weight(1f))
            RemindMeButton(vm, l)
        }
    }
}

/** "⏰ Remind me": a reminder with a note, without a call (5 min … tomorrow, or any date & time). */
@Composable
fun RemindMeButton(vm: AppViewModel, l: Lead) {
    var open by remember { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text("⏰ Remind me") }
    if (!open) return
    val ctx = LocalContext.current
    var note by remember { mutableStateOf("") }
    var at by remember { mutableStateOf<LocalDateTime?>(null) }
    var busy by remember { mutableStateOf(false) }
    val now = LocalDateTime.now().withSecond(0).withNano(0)
    val quick = listOf("5 min" to now.plusMinutes(5), "15 min" to now.plusMinutes(15), "30 min" to now.plusMinutes(30),
        "1 hour" to now.plusHours(1), "3 hours" to now.plusHours(3), "Tomorrow 10 AM" to now.plusDays(1).withHour(10).withMinute(0))
    AlertDialog(onDismissRequest = { if (!busy) open = false }, title = { Text("Remind me about ${l.name.ifBlank { "this lead" }}") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                quick.forEach { (label, t) -> FilterChip(selected = at == t, onClick = { at = t }, label = { Text(label) }) }
                FilterChip(selected = at != null && quick.none { it.second == at }, onClick = {
                    val b = at ?: now.plusHours(1)
                    DatePickerDialog(ctx, { _, y, m, d -> TimePickerDialog(ctx, { _, h, min -> at = LocalDateTime.of(y, m + 1, d, h, min) }, b.hour, b.minute, false).show() },
                        b.year, b.monthValue - 1, b.dayOfMonth).show()
                }, label = { Text("Pick date & time") })
            }
            at?.let { Text("⏰ " + it.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a")), color = Brand.primaryDark, fontWeight = FontWeight.SemiBold) }
            OutlinedTextField(note, { note = it }, label = { Text("Note (what to do)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
        } },
        confirmButton = { Button(enabled = at != null && !busy, onClick = {
            busy = true
            vm.addReminder(l, at!!.atZone(ZoneId.systemDefault()).toInstant(), note) { ok -> busy = false; if (ok) open = false }
        }) { Text(if (busy) "Saving…" else "Set reminder") } },
        dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel") } })
}

/** Outcome screen: optionally start a sequence for this lead when the outcome is saved. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OutcomeSeqChips(vm: AppViewModel, selected: String?, onSelect: (String?) -> Unit) {
    LaunchedEffect(Unit) { if (vm.sequences == null) vm.loadSequences() }
    val list = vm.sequences.orEmpty()
    if (list.isEmpty()) return
    Text("📨 Also start a WhatsApp sequence (optional)", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        list.forEach { s -> FilterChip(selected = selected == s.id, onClick = { onSelect(if (selected == s.id) null else s.id) }, label = { Text(s.name) }) }
    }
}

// ───────────── Editor ─────────────

/** Editable copy of one message. */
private class MsgDraft(m: SeqMessage) {
    var anchor by mutableStateOf(m.anchor)
    var day by mutableStateOf(m.day_offset.toString())
    var time by mutableStateOf(runCatching { LocalTime.parse(m.send_time) }.getOrDefault(LocalTime.of(10, 0)))
    var minutes by mutableStateOf(m.minutes_before ?: 60)
    var body by mutableStateOf(m.body)
    var mediaPath by mutableStateOf(m.media_path)
    var mediaType by mutableStateOf(m.media_type)
    var mediaName by mutableStateOf(m.media_name)
    val key = java.util.UUID.randomUUID().toString()
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SequenceEditor(vm: AppViewModel, seq: Sequence) {
    BackHandler { vm.editSequence = null }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val free = SeqLimits.free(ctx)
    val maxMsg = SeqLimits.maxMessages(ctx); val maxDay = SeqLimits.maxDay(ctx)
    var name by remember { mutableStateOf(seq.name) }
    var company by remember { mutableStateOf(seq.id.isNotEmpty() && seq.company) }
    var outcomes by remember { mutableStateOf(seq.start_outcomes.toSet()) }
    val msgs = remember { mutableStateListOf<MsgDraft>().apply { addAll(seq.messages.ifEmpty { listOf(SeqMessage()) }.map { MsgDraft(it) }) } }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var attachFor by remember { mutableStateOf<MsgDraft?>(null) }
    var savedFor by remember { mutableStateOf<MsgDraft?>(null) }
    val canUpload = vm.isManager || vm.isSolo
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val d = attachFor ?: return@rememberLauncherForActivityResult
        val org = vm.membership?.org_id ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            vm.message = "Uploading the file…"
            runCatching { Seqs.uploadMedia(ctx, org, uri) }
                .onSuccess { (p, t, n) -> d.mediaPath = p; d.mediaType = t; d.mediaName = n; vm.message = "📎 $n attached" }
                .onFailure { vm.message = Seqs.friendly(it) }
        }
    }
    Scaffold(topBar = {
        TopAppBar(title = { Text(if (seq.id.isEmpty()) "New WhatsApp sequence" else "Edit sequence") },
            navigationIcon = { IconButton(onClick = { vm.editSequence = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Name, e.g. After webinar, Interested, New lead") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (seq.id.isEmpty() && vm.isManager && !vm.isSolo) Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("For the whole team", fontWeight = FontWeight.SemiBold)
                    Text(if (company) "Everyone in the company can use it" else "Only you can use it", fontSize = 12.sp, color = Brand.muted)
                }
                Switch(company, { company = it })
            }
            msgs.forEachIndexed { i, d ->
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Message ${i + 1}", fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (i > 0) TextButton(onClick = { msgs.add(i - 1, msgs.removeAt(i)) }) { Text("↑") }
                            if (i < msgs.size - 1) TextButton(onClick = { msgs.add(i + 1, msgs.removeAt(i)) }) { Text("↓") }
                            if (msgs.size > 1) TextButton(onClick = { msgs.removeAt(i) }) { Text("✕", color = Brand.red) }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            FilterChip(selected = d.anchor == "start", onClick = { d.anchor = "start" }, label = { Text("Days after start") })
                            FilterChip(selected = d.anchor == "event", onClick = { d.anchor = "event" }, label = { Text("Around the event") })
                        }
                        if (d.anchor == "start") Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(d.day, { v -> d.day = v.filter { it.isDigit() }.take(3) }, label = { Text("Day") }, singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(90.dp))
                            OutlinedButton(onClick = { TimePickerDialog(ctx, { _, h, m -> d.time = LocalTime.of(h, m) }, d.time.hour, d.time.minute, false).show() }) {
                                Text("at " + d.time.format(DateTimeFormatter.ofPattern("h:mm a")))
                            }
                        } else EventTiming(d, maxDay)
                        val dayN = d.day.toIntOrNull() ?: 0
                        Text(when {
                            d.anchor == "event" -> "Sent ${Seqs.whenText(SeqMessage(anchor = "event", minutes_before = d.minutes))} (the event the lead is in)."
                            dayN == 0 -> "Day 0 = the day the lead joins the sequence."
                            else -> "$dayN day${if (dayN > 1) "s" else ""} after the lead joins · days off move to the next working day."
                        }, fontSize = 12.sp, color = Brand.muted)
                        if (d.anchor == "start" && dayN > maxDay) Text("Up to Day $maxDay" + if (free) " on the free plan — Closer OS Pro goes up to Day 365." else ".", fontSize = 12.sp, color = Brand.red)
                        OutlinedTextField(d.body, { d.body = it }, label = { Text("Message") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                        Text("Fill-ins: {{leadName}} first name · {{repName}} your name · {{companyName}} · {{batchName}} / {{batchDate}} the event · {{city}}",
                            fontSize = 11.sp, color = Brand.muted)
                        if (d.mediaPath != null) Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("📎 ${d.mediaName ?: "File"}", fontSize = 13.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = { d.mediaPath = null; d.mediaType = null; d.mediaName = null }) { Text("Remove") }
                        }
                        Row {
                            if (vm.templates.isNotEmpty()) TextButton(onClick = { savedFor = d }) { Text("Use a saved message") }
                            if (canUpload) TextButton(onClick = { attachFor = d; picker.launch("*/*") }) { Text("📎 Attach a file") }
                        }
                    }
                }
            }
            if (msgs.size < maxMsg) OutlinedButton(onClick = {
                val last = msgs.lastOrNull()
                msgs.add(MsgDraft(SeqMessage(anchor = last?.anchor ?: "start", day_offset = ((last?.day?.toIntOrNull() ?: 0) + 2).coerceAtMost(maxDay),
                    send_time = last?.time?.toString() ?: "10:00", minutes_before = last?.minutes)))
            }, modifier = Modifier.fillMaxWidth()) { Text("+ Add message") }
            else Text(if (free) "The free plan has up to $maxMsg messages per sequence. Closer OS Pro: up to 50." else "Up to 50 messages per sequence.",
                fontSize = 13.sp, color = Brand.muted, modifier = if (free) Modifier.clickable { vm.showRemoveAds = true } else Modifier)

            // Automatic start: saving one of these outcomes puts the lead on this sequence.
            Text("Start automatically when I save this outcome", fontWeight = FontWeight.SemiBold)
            if (free) {
                Text("🔒 Closer OS Pro — e.g. save \"Interested\" and the lead goes on this sequence by itself.", fontSize = 13.sp, color = Brand.muted)
                TextButton(onClick = { vm.showRemoveAds = true }) { Text("See Closer OS Pro") }
            } else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                vm.outcomes.filter { it.is_active }.distinctBy { it.id }.forEach { o ->
                    FilterChip(selected = o.id in outcomes, onClick = { outcomes = if (o.id in outcomes) outcomes - o.id else outcomes + o.id },
                        label = { Text(o.label + if (o.purpose == "reminder") " (reminder)" else "") })
                }
            }
            Text("A lead stops getting messages when it is marked won, lost / not interested or Do not call — or when you tap Stop on the lead.", fontSize = 12.sp, color = Brand.muted)
            error?.let { Text(it, color = Brand.red) }
            Button(enabled = !busy && name.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp), onClick = {
                val bad = msgs.indexOfFirst { it.body.isBlank() && it.mediaPath == null }
                if (bad >= 0) { error = "Message ${bad + 1} is empty"; return@Button }
                if (msgs.any { it.anchor == "start" && (it.day.toIntOrNull() ?: 0) > maxDay }) { error = "Days go up to $maxDay"; return@Button }
                if (msgs.size > maxMsg) { error = "Up to $maxMsg messages"; return@Button }
                busy = true; error = null
                val p = buildJsonObject {
                    if (seq.id.isNotEmpty()) put("id", seq.id)
                    put("name", name.trim()); put("company", company)
                    put("start_outcomes", if (free) JsonArray(emptyList()) else buildJsonArray { outcomes.forEach { add(JsonPrimitive(it)) } })
                    put("messages", buildJsonArray { msgs.forEach { d -> add(buildJsonObject {
                        put("anchor", d.anchor); put("day_offset", d.day.toIntOrNull() ?: 0); put("send_time", d.time.toString())
                        if (d.anchor == "event") put("minutes_before", d.minutes)
                        put("body", d.body); d.mediaPath?.let { put("media_path", it); put("media_type", d.mediaType); put("media_name", d.mediaName) }
                    }) } })
                }
                vm.saveSequence(p) { e -> busy = false; error = e }
            }) { Text(if (busy) "Saving…" else "Save sequence", fontSize = 16.sp) }
            Spacer(Modifier.height(24.dp))
        }
    }
    savedFor?.let { d ->
        AlertDialog(onDismissRequest = { savedFor = null }, title = { Text("Use a saved message") },
            text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                vm.templates.forEach { t ->
                    Column(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(10.dp)).clickable {
                        d.body = t.body; if (t.media_path != null) { d.mediaPath = t.media_path; d.mediaType = t.media_type; d.mediaName = t.media_name }; savedFor = null
                    }.padding(10.dp)) {
                        Text((if (t.media_path != null) "📎 " else "") + t.name, fontWeight = FontWeight.SemiBold)
                        Text(t.body, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            } }, confirmButton = {}, dismissButton = { TextButton(onClick = { savedFor = null }) { Text("Cancel") } })
    }
}

/** "2 hours before the event": amount + unit + before / after. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EventTiming(d: MsgDraft, maxDay: Int) {
    val a = kotlin.math.abs(d.minutes)
    val unit = when { a != 0 && a % 1440 == 0 -> 1440; a != 0 && a % 60 == 0 -> 60; else -> 1 }
    var amount by remember(d.key) { mutableStateOf((a / unit).toString()) }
    var mul by remember(d.key) { mutableStateOf(unit) }
    var before by remember(d.key) { mutableStateOf(d.minutes >= 0) }
    fun apply() { d.minutes = ((amount.toIntOrNull() ?: 0) * mul).coerceAtMost(maxDay * 1440) * (if (before) 1 else -1) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(amount, { v -> amount = v.filter { it.isDigit() }.take(4); apply() }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.width(80.dp))
            listOf(1 to "min", 60 to "hours", 1440 to "days").forEach { (m, l) -> FilterChip(selected = mul == m, onClick = { mul = m; apply() }, label = { Text(l) }) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(selected = before, onClick = { before = true; apply() }, label = { Text("before the event") })
            FilterChip(selected = !before, onClick = { before = false; apply() }, label = { Text("after it starts") })
        }
    }
}
