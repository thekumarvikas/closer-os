package com.closeros.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.MainActivity
import com.closeros.app.R
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadSeq
import com.closeros.app.data.SeqDetail
import com.closeros.app.data.SeqLimits
import com.closeros.app.data.SeqMessage
import com.closeros.app.data.Seqs
import com.closeros.app.data.Sequence
import com.closeros.app.data.WaScheduled
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
 * WhatsApp sequences: messages sent to a lead over days (Day 0, Day 2, Day 5…) or around an event, plus messages
 * scheduled for one lead. Due messages go into the WhatsApp queue — one tap per lead (never sent automatically).
 */
private val WA_GREEN = Color(0xFF16A34A)

/** The WhatsApp-sequence icon: green chat bubble with a clock. */
@Composable
fun SeqIcon(size: Dp = 20.dp) = Icon(painterResource(R.drawable.ic_wa_sequence), null, Modifier.size(size), tint = Color.Unspecified)

/** Opens the phone's file picker for [target] ("import", "seq:<key>", "wa"); the result arrives in vm.onFilePicked. */
fun pickFile(ctx: android.content.Context, vm: AppViewModel, target: String) {
    vm.filePickFor = target
    if (target.startsWith("seq:")) vm.backupSeqDraft()
    (ctx as? MainActivity)?.pickFile?.launch("*/*") ?: run { vm.filePickFor = null; vm.message = "Couldn't open the file picker" }
}

// ───────────── Fill-ins: tap to insert {{leadName}} etc. ─────────────

val FILL_INS = listOf("First name" to "{{leadName}}", "Full name" to "{{leadFullName}}", "My name" to "{{repName}}",
    "Company" to "{{companyName}}", "Event" to "{{batchName}}", "Event date" to "{{batchDate}}", "City" to "{{city}}",
    "Profession" to "{{profession}}", "Next call" to "{{followUpTime}}")

/**
 * A message box with tappable fill-ins under it: tap one to insert it where the cursor is. Typing "{" highlights the
 * list; picking one then replaces that "{".
 */
@OptIn(ExperimentalLayoutApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun MessageField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, minLines: Int = 3,
                 trailing: (@Composable () -> Unit)? = null) {
    var tf by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    // Texts this field itself sent up. When typing is fast, [value] can arrive a step behind what is
    // already in the box; adopting it would wipe the newest letters. Only a change made elsewhere
    // (a saved message picked, a draft restored) replaces the text.
    val sent = remember { ArrayDeque<String>() }
    fun emit(t: String) { sent.addLast(t); while (sent.size > 64) sent.removeFirst(); onChange(t) }
    LaunchedEffect(value) {
        if (value == tf.text) sent.clear()
        else if (value !in sent) { sent.clear(); tf = TextFieldValue(value, TextRange(value.length)) }
    }
    val braceBefore = tf.selection.start > 0 && tf.text.getOrNull(tf.selection.start - 1) == '{' && tf.text.getOrNull(tf.selection.start - 2) != '{'
    // Keep the fill-in chips in sight above the keyboard (in small pop-ups they ended up hidden under it).
    val chipsInView = remember { androidx.compose.foundation.relocation.BringIntoViewRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(focused, braceBefore) { if (focused) { kotlinx.coroutines.delay(350); chipsInView.bringIntoView() } }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(tf, { val changed = it.text != tf.text; tf = it; if (changed) emit(it.text) }, label = { Text(label) },
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }, minLines = minLines, trailingIcon = trailing)
        Text(if (braceBefore) "Pick a fill-in:" else "Tap to insert:", fontSize = 11.sp, color = if (braceBefore) Brand.primary else Brand.muted)
        Row(Modifier.bringIntoViewRequester(chipsInView).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FILL_INS.forEach { (l, v) ->
                Text(l, fontSize = 12.sp, color = Brand.primaryDark,
                    modifier = Modifier.background(if (braceBefore) Color(0xFFD1FAE5) else Brand.light, RoundedCornerShape(50)).clickable {
                        val start = if (braceBefore) tf.selection.start - 1 else tf.selection.start
                        val t = tf.text.substring(0, start) + v + tf.text.substring(tf.selection.end)
                        tf = TextFieldValue(t, TextRange(start + v.length)); emit(t)
                    }.padding(horizontal = 10.dp, vertical = 5.dp))
            }
        }
    }
}

// ───────────── Sequences list ─────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SequencesScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadSequences(); vm.loadSeqDue() }
    val list = vm.sequences
    Scaffold(topBar = {
        TopAppBar(title = { Row(verticalAlignment = Alignment.CenterVertically) { SeqIcon(24.dp); Spacer(Modifier.width(8.dp)); Text("WhatsApp sequences") } },
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
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), modifier = Modifier.clickable { vm.openSequenceId = s.id }) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SeqIcon(18.dp); Spacer(Modifier.width(6.dp))
                Text(s.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
                if (!vm.isSolo) Text(if (s.company) "Company" else if (s.mine) "Mine" else "By ${s.owner_name ?: "a teammate"}", fontSize = 11.sp, color = Brand.primaryDark,
                    modifier = Modifier.background(Brand.light, RoundedCornerShape(6.dp)).padding(6.dp, 2.dp))
            }
            Text("${s.messages.size} message${if (s.messages.size == 1) "" else "s"} · " + s.messages.joinToString(", ") { Seqs.whenText(it).substringBefore(" ·") },
                fontSize = 13.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (s.start_outcomes.isNotEmpty()) Text("🔁 Starts by itself after: " + s.start_outcomes.mapNotNull { outcomes[it]?.label }.joinToString(", "), fontSize = 13.sp, color = Brand.primaryDark)
            Text("${if (vm.isManager && s.company && !vm.isSolo) s.active_all else s.active_mine} leads on it now" + (if (s.done_all > 0) " · ${s.done_all} finished" else "") + " · See leads & stats ›",
                fontSize = 13.sp, color = Brand.primary)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { vm.showSequences = false; vm.selectMode = true; vm.tab = Tab.Leads; vm.message = "Tick leads, then tap the sequence icon" }) { Text("+ Add leads") }
                Spacer(Modifier.weight(1f))
                if (canEdit) {
                    TextButton(onClick = { vm.openSequenceEditor(s) }) { Text("Edit") }
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

/** Home + sequences screen: messages due now (sequences + scheduled) → "Send now" (WhatsApp queue). */
@Composable
fun SeqDueCard(vm: AppViewModel, always: Boolean = false) {
    val d = vm.seqDue ?: return
    val n = d.due.size
    if (n == 0 && !always && d.later_today == 0) return
    val bySeq = d.due.groupingBy { it.sequence }.eachCount()
    Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(12.dp)).clickable(enabled = !always) { vm.showSequences = true }.padding(12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        SeqIcon(26.dp); Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(if (n == 0) "No WhatsApp messages due now" else "$n WhatsApp message${if (n == 1) "" else "s"} due", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
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
        title = { Row(verticalAlignment = Alignment.CenterVertically) { SeqIcon(22.dp); Spacer(Modifier.width(8.dp)); Text("WhatsApp sequence for ${pick.label}") } },
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

// ───────────── Lead page: sequences, scheduled call, scheduled WhatsApp ─────────────

/** Lead page: "📞 Schedule a call" + "💬 Schedule a WhatsApp message", what's planned, and the lead's sequences. */
@Composable
fun LeadSequencesCard(vm: AppViewModel, l: Lead) {
    var rows by remember(l.id) { mutableStateOf<List<LeadSeq>?>(null) }
    var scheduled by remember(l.id) { mutableStateOf<List<WaScheduled>>(emptyList()) }
    LaunchedEffect(l.id, vm.leadRefresh) {
        rows = runCatching { Seqs.forLead(l.id) }.getOrNull() ?: rows
        scheduled = runCatching { Seqs.leadScheduled(l.id) }.getOrNull() ?: scheduled
    }
    var callOpen by remember { mutableStateOf(false) }
    var waOpen by remember { mutableStateOf<WaScheduled?>(null) }
    var waNew by remember { mutableStateOf(false) }
    val planned = vm.followUps.firstOrNull { it.lead_id == l.id }
    val live = rows.orEmpty().filter { it.status == "active" || it.status == "paused" }
    val past = rows.orEmpty().filter { it.status != "active" && it.status != "paused" }.take(2)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { callOpen = true }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("📞 Schedule a call", fontSize = 13.sp) }
            OutlinedButton(onClick = { waNew = true }, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("💬 Schedule WhatsApp", fontSize = 13.sp) }
        }
        // What's planned
        (planned?.due_at ?: l.next_follow_up_at)?.let { due ->
            Row(Modifier.fillMaxWidth().background(Brand.light, RoundedCornerShape(10.dp)).padding(10.dp, 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("📞 Next call: ${fmtWhen(due)}" + (planned?.notes?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (planned != null) {
                    TextButton(onClick = { callOpen = true }) { Text("Change") }
                    TextButton(onClick = { vm.cancelScheduledCall(l) }) { Text("Cancel", color = Brand.muted) }
                }
            }
        }
        scheduled.forEach { s ->
            Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(10.dp)).padding(10.dp, 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("💬 WhatsApp ${fmtWhen(s.due_at)}" + (s.media_name?.let { " · 📎" } ?: ""), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(s.body, fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (s.mine) {
                    TextButton(onClick = { waOpen = s }) { Text("Change") }
                    TextButton(onClick = { vm.cancelWa(s.id) }) { Text("Cancel", color = Brand.muted) }
                }
            }
        }
        live.forEach { r ->
            Row(Modifier.fillMaxWidth().background(Color(0xFFECFDF5), RoundedCornerShape(10.dp)).padding(10.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
                SeqIcon(18.dp); Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f)) {
                    Text(r.name, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
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
            Text("${r.name}: " + (if (r.status == "done") "all ${r.total} done" else "${r.stop_reason ?: "stopped"} · ${r.sent_count} sent"), fontSize = 12.sp, color = Brand.muted)
        }
        TextButton(onClick = { vm.seqPick = AppViewModel.SeqPick(listOf(l.id), l.name.ifBlank { "this lead" }) }) {
            SeqIcon(18.dp); Spacer(Modifier.width(6.dp)); Text("Start a WhatsApp sequence")
        }
    }
    if (callOpen) ScheduleCallDialog(vm, l, planned?.notes.orEmpty()) { callOpen = false }
    if (waNew) ScheduleWaDialog(vm, l, null) { waNew = false }
    waOpen?.let { s -> ScheduleWaDialog(vm, l, s) { waOpen = null } }
}

/** Quick times + any date & time. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TimePicks(at: LocalDateTime?, onPick: (LocalDateTime) -> Unit) {
    val ctx = LocalContext.current
    val now = remember { LocalDateTime.now().withSecond(0).withNano(0) }
    val quick = listOf("In 30 min" to now.plusMinutes(30), "1 hour" to now.plusHours(1), "3 hours" to now.plusHours(3),
        "Today 6 PM" to now.withHour(18).withMinute(0), "Tomorrow 11 AM" to now.plusDays(1).withHour(11).withMinute(0),
        "Tomorrow 6 PM" to now.plusDays(1).withHour(18).withMinute(0)).filter { it.second.isAfter(now) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        quick.forEach { (label, t) -> FilterChip(selected = at == t, onClick = { onPick(t) }, label = { Text(label) }) }
        FilterChip(selected = at != null && quick.none { it.second == at }, onClick = {
            val b = at ?: now.plusHours(1)
            DatePickerDialog(ctx, { _, y, m, d -> TimePickerDialog(ctx, { _, h, min -> onPick(LocalDateTime.of(y, m + 1, d, h, min)) }, b.hour, b.minute, false).show() },
                b.year, b.monthValue - 1, b.dayOfMonth).show()
        }, label = { Text("Pick date & time") })
    }
    at?.let { Text("⏰ " + it.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a")), color = Brand.primaryDark, fontWeight = FontWeight.SemiBold) }
}

@Composable
fun ScheduleCallDialog(vm: AppViewModel, l: Lead, oldNote: String, onClose: () -> Unit) {
    var at by remember { mutableStateOf<LocalDateTime?>(null) }
    var note by remember { mutableStateOf(oldNote) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text("📞 Call ${l.name.ifBlank { "this lead" }}") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TimePicks(at) { at = it }
            OutlinedTextField(note, { note = it }, label = { Text("Note (optional) — what to talk about") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            Text("You get a reminder with a Call button at that time. It shows in Follow-ups.", fontSize = 12.sp, color = Brand.muted)
        } },
        confirmButton = { Button(enabled = at != null && !busy, onClick = {
            busy = true; vm.scheduleCall(l, at!!.atZone(ZoneId.systemDefault()).toInstant(), note) { ok -> busy = false; if (ok) onClose() }
        }) { Text(if (busy) "Saving…" else "Schedule call") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}

@Composable
fun ScheduleWaDialog(vm: AppViewModel, l: Lead, existing: WaScheduled?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var at by remember { mutableStateOf(existing?.let { runCatching { com.closeros.app.data.parseInstant(it.due_at).atZone(ZoneId.systemDefault()).toLocalDateTime() }.getOrNull() }) }
    var body by remember { mutableStateOf(existing?.body.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var savedPick by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.waPickedFile = existing?.media_path?.let { Triple(it, existing.media_type.orEmpty(), existing.media_name.orEmpty()) } }
    val file = vm.waPickedFile
    val canUpload = vm.isManager || vm.isSolo
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text("💬 WhatsApp ${l.name.ifBlank { "this lead" }}") },
        text = { Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TimePicks(at) { at = it }
            MessageField(body, { body = it }, "Message")
            if (file != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("📎 ${file.third}", fontSize = 13.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.waPickedFile = null }) { Text("Remove") }
            }
            Row {
                if (vm.templates.isNotEmpty()) TextButton(onClick = { savedPick = true }) { Text("Use a saved message") }
                if (canUpload) TextButton(onClick = { pickFile(ctx, vm, "wa") }) { Text("📎 Attach a file") }
            }
            Text("At that time you get a notification. Tap it and WhatsApp opens with the message ready — you just press Send.", fontSize = 12.sp, color = Brand.muted)
        } },
        confirmButton = { Button(enabled = at != null && (body.isNotBlank() || file != null) && !busy, onClick = {
            busy = true; vm.scheduleWa(l, at!!.atZone(ZoneId.systemDefault()).toInstant(), body, file, existing?.id) { ok -> busy = false; if (ok) { vm.waPickedFile = null; onClose() } }
        }) { Text(if (busy) "Saving…" else "Schedule") } },
        dismissButton = { TextButton(onClick = { vm.waPickedFile = null; onClose() }) { Text("Cancel") } })
    if (savedPick) AlertDialog(onDismissRequest = { savedPick = false }, title = { Text("Use a saved message") },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            vm.templates.forEach { t ->
                Column(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(10.dp)).clickable {
                    body = t.body; t.media_path?.let { vm.waPickedFile = Triple(it, t.media_type.orEmpty(), t.media_name.orEmpty()) }; savedPick = false
                }.padding(10.dp)) {
                    Text((if (t.media_path != null) "📎 " else "") + t.name, fontWeight = FontWeight.SemiBold)
                    Text(t.body, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        } }, confirmButton = {}, dismissButton = { TextButton(onClick = { savedPick = false }) { Text("Cancel") } })
}

/** Follow-ups tab: my scheduled WhatsApp messages. */
@Composable
fun ScheduledWaList(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadWaScheduled() }
    val list = vm.waScheduled
    if (list.isEmpty()) return
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFECFDF5))) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("💬 Scheduled WhatsApp messages (${list.size})", fontWeight = FontWeight.SemiBold)
            list.take(10).forEach { s ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).clickable { s.lead_id?.let { vm.openLeadId = it } }) {
                        Text("${fmtWhen(s.due_at)} · ${s.lead_name?.ifBlank { null } ?: fmtPhone(s.phone.orEmpty())}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text(s.body, fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { vm.cancelWa(s.id) }) { Text("Cancel", color = Brand.muted) }
                }
            }
            if (list.size > 10) Text("+ ${list.size - 10} more", fontSize = 12.sp, color = Brand.muted)
        }
    }
}

/** Outcome screen: optionally start a sequence for this lead when the outcome is saved. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OutcomeSeqChips(vm: AppViewModel, selected: String?, onSelect: (String?) -> Unit) {
    LaunchedEffect(Unit) { if (vm.sequences == null) vm.loadSequences() }
    val list = vm.sequences.orEmpty()
    if (list.isEmpty()) return
    Row(verticalAlignment = Alignment.CenterVertically) { SeqIcon(18.dp); Spacer(Modifier.width(6.dp)); Text("Also start a WhatsApp sequence (optional)", fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        list.forEach { s -> FilterChip(selected = selected == s.id, onClick = { onSelect(if (selected == s.id) null else s.id) }, label = { Text(s.name) }) }
    }
}

// ───────────── Sequence details: stats + leads ─────────────

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SequenceDetailScreen(vm: AppViewModel, id: String) {
    BackHandler { vm.openSequenceId = null }
    val scope = rememberCoroutineScope()
    var data by remember(id) { mutableStateOf<SeqDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var filter by remember { mutableStateOf("active") }
    val selected = remember { mutableStateListOf<String>() }
    var askRemove by remember { mutableStateOf<List<String>?>(null) }
    val seq = vm.sequences.orEmpty().firstOrNull { it.id == id }
    LaunchedEffect(id, reload) { runCatching { Seqs.detail(id) }.onSuccess { data = it; error = null }.onFailure { error = Seqs.friendly(it) } }
    fun act(ids: List<String>, action: String) = scope.launch {
        runCatching { Seqs.setLeads(ids, action) }.onSuccess { n ->
            vm.message = when (action) { "stop" -> "Removed $n from the sequence"; "pause" -> "Paused $n"; else -> "Resumed $n" }
            selected.clear(); reload++; vm.loadSequences(); vm.loadSeqDue()
        }.onFailure { vm.message = Seqs.friendly(it) }
    }
    askRemove?.let { ids ->
        AlertDialog(onDismissRequest = { askRemove = null },
            title = { Text(if (ids.size == 1) "Remove this lead from the sequence?" else "Remove ${ids.size} leads from the sequence?") },
            text = { Text("They stop getting this sequence's messages. Messages already sent stay counted.") },
            confirmButton = { TextButton(onClick = { askRemove = null; act(ids, "stop") }) { Text("Remove", color = Brand.red) } },
            dismissButton = { TextButton(onClick = { askRemove = null }) { Text("Keep") } })
    }
    Scaffold(topBar = {
        TopAppBar(title = { Text(seq?.name ?: "WhatsApp sequence", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = { vm.openSequenceId = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = { if (seq != null && (seq.mine || (seq.company && vm.isManager))) TextButton(onClick = { vm.openSequenceEditor(seq) }) { Text("Edit") } })
    }) { pad ->
        val d = data
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            error?.let { item { Text(it, color = Brand.red) } }
            if (d == null) { if (error == null) item { CircularProgressIndicator() }; return@LazyColumn }
            item {
                val st = d.stats
                val tiles = listOf("On it now" to st.active, "Paused" to st.paused, "Finished" to st.done, "Stopped" to st.stopped,
                    "Due today" to st.due_today, "Sent on time" to st.sent_on_time, "Sent late" to st.sent_late, "Not sent" to st.skipped, "Bought after" to st.bought)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = 3) {
                    tiles.forEach { (label, v) ->
                        Column(Modifier.weight(1f).background(Color.White, RoundedCornerShape(10.dp)).padding(10.dp)) {
                            Text("$v", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = if (label == "Bought after" && v > 0) Brand.green else Color(0xFF0F172A))
                            Text(label, fontSize = 11.sp, color = Brand.muted)
                        }
                    }
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { vm.openSequenceId = null; vm.showSequences = false; vm.selectMode = true; vm.tab = Tab.Leads
                        vm.message = "Tick leads, then tap the sequence icon" }) { Text("+ Add leads") }
                    Spacer(Modifier.weight(1f))
                    Text("${d.total} message${if (d.total == 1) "" else "s"}", fontSize = 13.sp, color = Brand.muted)
                }
            }
            item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("active" to "On it", "paused" to "Paused", "done" to "Finished", "stopped" to "Stopped", "all" to "All").forEach { (k, l) ->
                        val n = if (k == "all") d.leads.size else d.leads.count { it.status == k }
                        FilterChip(selected = filter == k, onClick = { filter = k; selected.clear() }, label = { Text("$l ($n)") })
                    }
                }
            }
            if (selected.isNotEmpty()) item {
                Row(Modifier.fillMaxWidth().background(Brand.light, RoundedCornerShape(10.dp)).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${selected.size} selected", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = { act(selected.toList(), "pause") }) { Text("Pause") }
                    TextButton(onClick = { act(selected.toList(), "resume") }) { Text("Resume") }
                    TextButton(onClick = { askRemove = selected.toList() }) { Text("Remove", color = Brand.red) }
                }
            }
            val rows = d.leads.filter { filter == "all" || it.status == filter }
            if (rows.isEmpty()) item { Text("Nobody here.", color = Brand.muted) }
            items(rows, key = { it.id }) { r ->
                val live = r.status == "active" || r.status == "paused"
                Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).clickable { vm.openLeadId = r.lead_id }.padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    if (live) Checkbox(r.id in selected, { on -> if (on) selected.add(r.id) else selected.remove(r.id) })
                    Column(Modifier.weight(1f)) {
                        Text(r.name.ifBlank { fmtPhone(r.phone) } + if (r.bought) "  🎉" else "", fontWeight = FontWeight.SemiBold)
                        Text(when (r.status) {
                            "active" -> "Message ${r.next_pos ?: "–"} of ${d.total} · " + (r.next_due_at?.let { "next ${fmtWhen(it)}" } ?: "nothing planned")
                            "paused" -> "Paused · ${r.sent_count} sent"
                            "done" -> "Finished · ${r.sent_count} sent"
                            else -> "${r.stop_reason ?: "Stopped"} · ${r.sent_count} sent"
                        } + (if (!vm.isSolo && r.user_name != null) " · ${r.user_name}" else ""), fontSize = 12.sp, color = Brand.muted)
                    }
                    if (r.status == "active") TextButton(onClick = { act(listOf(r.id), "pause") }) { Text("Pause") }
                    if (r.status == "paused") TextButton(onClick = { act(listOf(r.id), "resume") }) { Text("Resume") }
                    if (live) TextButton(onClick = { askRemove = listOf(r.id) }) { Text("Remove", color = Brand.muted) }
                }
            }
        }
    }
}

// ───────────── Editor ─────────────

/** Editable copy of one message (kept in the view model, so picking a file never loses the typing). */
class MsgDraft(m: SeqMessage) {
    var anchor by mutableStateOf(m.anchor)
    var day by mutableStateOf(m.day_offset.toString())
    var time by mutableStateOf(runCatching { LocalTime.parse(m.send_time) }.getOrDefault(LocalTime.of(10, 0)))
    var minutes by mutableStateOf(m.minutes_before ?: 60)
    var body by mutableStateOf(m.body)
    var mediaPath by mutableStateOf(m.media_path)
    var mediaType by mutableStateOf(m.media_type)
    var mediaName by mutableStateOf(m.media_name)
    val key = java.util.UUID.randomUUID().toString()
    fun toMessage(i: Int) = SeqMessage(position = i + 1, anchor = anchor, day_offset = day.toIntOrNull() ?: 0, send_time = time.toString(),
        minutes_before = if (anchor == "event") minutes else null, body = body, media_path = mediaPath, media_type = mediaType, media_name = mediaName)
}

/** The whole sequence being edited. */
class SeqDraft(seq: Sequence, val openedAt: Long) {
    val seqId = seq.id
    val original = seq
    var name by mutableStateOf(seq.name)
    var company by mutableStateOf(seq.id.isNotEmpty() && seq.company)
    var outcomes by mutableStateOf(seq.start_outcomes.toSet())
    val messages = mutableStateListOf<MsgDraft>().apply { addAll(seq.messages.ifEmpty { listOf(SeqMessage()) }.map { MsgDraft(it) }) }
    fun toSequence() = original.copy(name = name, company = company, start_outcomes = outcomes.toList(), messages = messages.mapIndexed { i, m -> m.toMessage(i) })
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SequenceEditor(vm: AppViewModel, seq: Sequence) {
    BackHandler { vm.closeSequenceEditor() }
    val ctx = LocalContext.current
    val free = SeqLimits.free(ctx)
    val maxMsg = SeqLimits.maxMessages(ctx); val maxDay = SeqLimits.maxDay(ctx)
    val dr = vm.draftFor(seq)
    val msgs = dr.messages
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var savedFor by remember { mutableStateOf<MsgDraft?>(null) }
    val canUpload = vm.isManager || vm.isSolo
    Scaffold(topBar = {
        TopAppBar(title = { Text(if (seq.id.isEmpty()) "New WhatsApp sequence" else "Edit sequence") },
            navigationIcon = { IconButton(onClick = { vm.closeSequenceEditor() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(dr.name, { dr.name = it }, label = { Text("Name, e.g. After webinar, Interested, New lead") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (seq.id.isEmpty() && vm.isManager && !vm.isSolo) Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("For the whole team", fontWeight = FontWeight.SemiBold)
                    Text(if (dr.company) "Everyone in the company can use it" else "Only you can use it", fontSize = 12.sp, color = Brand.muted)
                }
                Switch(dr.company, { dr.company = it })
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
                        MessageField(d.body, { d.body = it }, "Message")
                        if (d.mediaPath != null) Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("📎 ${d.mediaName ?: "File"}", fontSize = 13.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = { d.mediaPath = null; d.mediaType = null; d.mediaName = null }) { Text("Remove") }
                        }
                        Row {
                            if (vm.templates.isNotEmpty()) TextButton(onClick = { savedFor = d }) { Text("Use a saved message") }
                            if (canUpload) TextButton(onClick = { pickFile(ctx, vm, "seq:${d.key}") }) { Text("📎 Attach a file") }
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

            Text("Start automatically when I save this outcome", fontWeight = FontWeight.SemiBold)
            if (free) {
                Text("🔒 Closer OS Pro — e.g. save \"Interested\" and the lead goes on this sequence by itself.", fontSize = 13.sp, color = Brand.muted)
                TextButton(onClick = { vm.showRemoveAds = true }) { Text("See Closer OS Pro") }
            } else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                vm.outcomes.filter { it.is_active }.distinctBy { it.id }.forEach { o ->
                    FilterChip(selected = o.id in dr.outcomes, onClick = { dr.outcomes = if (o.id in dr.outcomes) dr.outcomes - o.id else dr.outcomes + o.id },
                        label = { Text(o.label + if (o.purpose == "reminder") " (reminder)" else "") })
                }
            }
            Text("A lead stops getting messages when it is marked won, lost / not interested or Do not call — or when you tap Stop on the lead.", fontSize = 12.sp, color = Brand.muted)
            error?.let { Text(it, color = Brand.red) }
            Button(enabled = !busy && dr.name.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp), onClick = {
                val bad = msgs.indexOfFirst { it.body.isBlank() && it.mediaPath == null }
                if (bad >= 0) { error = "Message ${bad + 1} is empty"; return@Button }
                if (msgs.any { it.anchor == "start" && (it.day.toIntOrNull() ?: 0) > maxDay }) { error = "Days go up to $maxDay"; return@Button }
                if (msgs.size > maxMsg) { error = "Up to $maxMsg messages"; return@Button }
                busy = true; error = null
                val p = buildJsonObject {
                    if (seq.id.isNotEmpty()) put("id", seq.id)
                    put("name", dr.name.trim()); put("company", dr.company)
                    put("start_outcomes", if (free) JsonArray(emptyList()) else buildJsonArray { dr.outcomes.forEach { add(JsonPrimitive(it)) } })
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
