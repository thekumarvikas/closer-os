package com.closeros.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.BatchSummary
import com.closeros.app.data.Lead
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Events: a person groups leads under an event (a webinar, an offer, an exhibition, a batch…), then opens
 * the event's list (sort, filter, call or WhatsApp everyone) or filters the Leads tab by event.
 * Same data as the company's webinars, so every list, filter and report keeps working.
 */
private val eventFmt = DateTimeFormatter.ofPattern("EEE d MMM yyyy, h:mm a")

/** Name + date/time of a new event (or editing one). */
@Composable
fun EventEditDialog(vm: AppViewModel, existing: BatchSummary? = null, addLeads: List<Lead>? = null, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val zone = ZoneId.systemDefault()
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var at by remember {
        mutableStateOf(existing?.let { runCatching { com.closeros.app.data.parseInstant(it.webinar_at).atZone(zone).toLocalDateTime() }.getOrNull() }
            ?: LocalDateTime.now().plusDays(1).withHour(11).withMinute(0).withSecond(0).withNano(0))
    }
    fun pick() {
        DatePickerDialog(ctx, { _, y, m, d ->
            TimePickerDialog(ctx, { _, h, min -> at = LocalDateTime.of(y, m + 1, d, h, min) }, at.hour, at.minute, false).show()
        }, at.year, at.monthValue - 1, at.dayOfMonth).show()
    }
    AlertDialog(onDismissRequest = onClose,
        title = { Text(if (existing != null) "Edit event" else "New event") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Event name, e.g. Diwali offer, Webinar 12 Dec") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedButton(onClick = { pick() }, modifier = Modifier.fillMaxWidth()) { Text("📅 " + at.format(eventFmt)) }
            if (!addLeads.isNullOrEmpty()) Text("${addLeads.size} lead${if (addLeads.size == 1) "" else "s"} will be added to it.", fontSize = 13.sp, color = Brand.muted)
        } },
        confirmButton = { Button(enabled = name.isNotBlank(), onClick = {
            val instant = at.atZone(zone).toInstant()
            if (existing != null) vm.renameEvent(existing.id, name, instant) else vm.createEvent(name, instant, addLeads)
            onClose()
        }) { Text(if (existing != null) "Save" else if (addLeads.isNullOrEmpty()) "Create" else "Create & add") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}

/** "Add to event": pick one of the events (or make a new one) for the chosen leads. */
@Composable
fun EventPickerDialog(vm: AppViewModel) {
    val leads = vm.eventPickFor ?: return
    LaunchedEffect(Unit) { if (vm.batches == null) vm.loadBatches(quiet = true) }
    var creating by remember { mutableStateOf(false) }
    if (creating) { EventEditDialog(vm, addLeads = leads) { creating = false; vm.eventPickFor = null }; return }
    val events = vm.batches.orEmpty()
    AlertDialog(onDismissRequest = { vm.eventPickFor = null },
        title = { Text("Add ${if (leads.size == 1) leads.first().name.ifBlank { "this lead" } else "${leads.size} leads"} to an event") },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            TextButton(onClick = { creating = true }) { Text("+ New event", fontWeight = FontWeight.SemiBold) }
            if (events.isEmpty()) Text("No events yet — create the first one.", color = Brand.muted, fontSize = 14.sp)
            events.forEach { e ->
                val inIt = leads.size == 1 && leads.first().batch_leads.any { it.batch_id == e.id }
                Row(Modifier.fillMaxWidth().clickable { vm.addToEvent(e.id, e.name, leads, add = !inIt) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(e.name, fontWeight = FontWeight.SemiBold)
                        Text("${eventWhen(e)} · ${e.leads} leads", fontSize = 12.sp, color = Brand.muted)
                    }
                    Text(if (inIt) "✓ Added · tap to remove" else "Add", color = Brand.primary, fontSize = 13.sp)
                }
                HorizontalDivider()
            }
        } },
        confirmButton = {}, dismissButton = { TextButton(onClick = { vm.eventPickFor = null }) { Text("Close") } })
}

fun eventWhen(e: BatchSummary): String =
    runCatching { com.closeros.app.data.parseInstant(e.webinar_at).atZone(ZoneId.systemDefault()).format(eventFmt) }.getOrDefault("")

/** Lead page (individual app): the events this lead is in + "Add to event". */
@Composable
fun LeadEventsRow(vm: AppViewModel, l: Lead) {
    val names = l.batch_leads.mapNotNull { it.batch?.name }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(if (names.isEmpty()) "📅 Not in any event" else "📅 " + names.joinToString(" · "), fontSize = 14.sp, color = if (names.isEmpty()) Brand.muted else Brand.primaryDark, modifier = Modifier.weight(1f))
        TextButton(onClick = { vm.eventPickFor = listOf(l) }) { Text(if (names.isEmpty()) "+ Add to event" else "Change") }
    }
}

/** One event card in the individual app's "My events" list. */
@Composable
fun EventCard(vm: AppViewModel, e: BatchSummary) {
    var editing by remember { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf(false) }
    Card(colors = CardDefaults.cardColors(containerColor = androidx.compose.ui.graphics.Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(e.name, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Text(eventWhen(e), color = Brand.muted, fontSize = 13.sp)
            Text("${e.leads} leads · ${e.called} called · ${e.talked} talked", fontSize = 14.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { vm.openBatchList(e, "sales") }, enabled = e.leads > 0) { Text("Open list") }
                Spacer(Modifier.width(6.dp))
                OutlinedButton(onClick = { vm.selectMode = true; vm.showBatches = false; vm.tab = Tab.Leads; vm.message = "Tick leads, then tap 📅 to add them to an event" }) { Text("+ Leads") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { editing = true }) { Text("Edit") }
                TextButton(onClick = { askDelete = true }) { Text("Delete", color = Brand.muted) }
            }
        }
    }
    if (editing) EventEditDialog(vm, existing = e) { editing = false }
    if (askDelete) AlertDialog(onDismissRequest = { askDelete = false }, title = { Text("Delete ${e.name}?") },
        text = { Text("The event is removed. Its leads, calls and notes stay.") },
        confirmButton = { TextButton(onClick = { askDelete = false; vm.deleteEvent(e.id) }) { Text("Delete", color = Brand.red) } },
        dismissButton = { TextButton(onClick = { askDelete = false }) { Text("Cancel") } })
}
