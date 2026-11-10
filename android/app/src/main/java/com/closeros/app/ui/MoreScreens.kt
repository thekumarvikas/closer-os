package com.closeros.app.ui

import kotlinx.coroutines.launch
import com.closeros.app.calls.safeStart
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.FollowUpAlarms
import com.closeros.app.calls.PhoneCalls
import java.time.Instant

/** One-time setup: the rep's own number and the number of each SIM in the phone. */
@Composable
fun SetupScreen(vm: AppViewModel) {
    val ctx = LocalContext.current
    val sims = remember { PhoneCalls.sims(ctx) }
    var me by remember { mutableStateOf(vm.profile?.phone ?: "") }
    val simNums = remember { mutableStateMapOf<Int, String>().apply { sims.forEach { put(it.slot, vm.store.simNumber(it.slot) ?: PhoneCalls.simOwnNumber(ctx, it.slot) ?: "") } } }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(16.dp))
        Text("Your numbers", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Your manager sees these next to your calls. Android doesn't always tell apps a SIM's number, so please confirm them once.", color = Brand.muted)
        OutlinedTextField(me, { me = it }, label = { Text("Your mobile number") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
        if (sims.isEmpty()) Text("No SIM found. You can add SIM numbers later in Profile.", color = Brand.muted)
        sims.forEach { s ->
            OutlinedTextField(simNums[s.slot] ?: "", { simNums[s.slot] = it }, label = { Text("Number of ${s.label}") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
        }
        error?.let { Text(it, color = Brand.red) }
        Button(onClick = { busy = true; vm.saveSetup(me, simNums.toMap()) { error = it; busy = false } }, enabled = !busy && me.filter { it.isDigit() }.length >= 10,
            modifier = Modifier.fillMaxWidth().height(50.dp)) { Text(if (busy) "Saving…" else "Continue") }
        if (Build.VERSION.SDK_INT >= 31 && !FollowUpAlarms.canExact(ctx)) ExactAlarmHint()
    }
}

@Composable
fun ExactAlarmHint() {
    val ctx = LocalContext.current
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFFFFBEB))) {
        Column(Modifier.padding(14.dp)) {
            Text("Allow on-time follow-up reminders", fontWeight = FontWeight.SemiBold)
            Text("So reminders ring exactly 5 minutes before and at the follow-up time.", fontSize = 14.sp, color = Brand.muted)
            TextButton(onClick = {
                if (Build.VERSION.SDK_INT >= 31) safeStart(ctx, Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}")))
            }) { Text("Allow") }
        }
    }
}

/** Every call in the phone's call history; numbers that aren't leads can be added as leads. */
@Composable
fun CallHistoryScreen(vm: AppViewModel) {
    var adding by remember { mutableStateOf<HistoryItem?>(null) }
    var filter by remember { mutableStateOf("all") }
    LaunchedEffect(Unit) { vm.loadHistory() }
    var q by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<HistoryItem>?>(null) }
    LaunchedEffect(q) {
        found = null
        if (q.trim().length >= 2) { kotlinx.coroutines.delay(350); found = vm.searchCalls(q) }
    }
    val items = vm.history
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp, 4.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Calls", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.loadHistory() }) { Icon(Icons.Default.Refresh, "Refresh") }
        }
        Row(Modifier.padding(horizontal = 12.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (listOf("all" to "All", "dialled" to "Dialled", "received" to "Received", "missed" to "Missed", "notpicked" to "Not picked up", "unknown" to "Not in lead list") +
                (if (com.closeros.app.BuildConfig.WA_TRACKING) listOf("whatsapp" to "WhatsApp") else emptyList())).forEach { (k, l) ->
                FilterChip(selected = filter == k, onClick = { filter = k }, label = { Text(l, fontSize = 13.sp) })
            }
        }
        OutlinedTextField(q, { q = it }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            placeholder = { Text("Search: name, number, city, notes, \"interested\"…", fontSize = 14.sp) },
            trailingIcon = { if (q.isNotEmpty()) TextButton(onClick = { q = "" }) { Text("✕") } })
        CallColorKey(Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        if (items == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        val searching = q.trim().length >= 2
        if (searching) Text(when { found == null -> "Searching…"; else -> "${found!!.size} call${if (found!!.size == 1) "" else "s"} found in your phone's call history" },
            fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(horizontal = 16.dp))
        val shown = (if (searching) found.orEmpty() else items).distinctBy { it.log.id }.filter {
            when (filter) {
                "whatsapp" -> it.log.channel == "whatsapp"; "unknown" -> it.lead == null
                "dialled" -> it.log.direction == "outgoing"; "received" -> it.log.direction == "incoming"
                "missed" -> it.log.direction == "missed" || it.log.direction == "rejected"
                // Dialled and they didn't really talk (no answer, or an operator message of a few seconds).
                "notpicked" -> it.log.direction == "outgoing" && it.log.durationSec < 20
                else -> true }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp, 0.dp, 8.dp, 88.dp)) {
            if (shown.isEmpty() && !(searching && found == null)) item { Text(if (searching) "No calls match \"${q.trim()}\"." else "No calls here.", color = Brand.muted, modifier = Modifier.padding(8.dp)) }
            groupCalls(shown).forEach { (day, rows) ->
                item(key = "d$day") { Text(day.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Brand.muted, modifier = Modifier.padding(start = 4.dp, top = 12.dp, bottom = 2.dp)) }
                items(rows, key = { it.first.log.id }) { (h, n) ->
                    HistoryRow(vm, h, onAdd = { adding = h }, count = n)
                    HorizontalDivider(color = Color(0xFFF1F5F9), modifier = Modifier.padding(start = 30.dp))
                }
            }
            if (vm.historyHasMore && !searching) item {
                OutlinedButton(onClick = { vm.historyLimit += 500; vm.loadHistory() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Load older calls") }
            }
        }
    }
    adding?.let { h -> AddLeadDialog(h.phone, onDismiss = { adding = null }) { name, prof, notes -> vm.addLeadFromCall(h.phone, name, prof, notes) { adding = null } } }
}

@Composable
internal fun AddLeadDialog(phone: String, onDismiss: () -> Unit, onSave: (String, String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var prof by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Add as lead") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(fmtPhone(phone), color = Brand.muted)
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(prof, { prof = it }, label = { Text("Profession (optional)") }, singleLine = true)
                OutlinedTextField(notes, { notes = it }, label = { Text("Note, e.g. referral from…") })
            }
        },
        confirmButton = { Button(onClick = { onSave(name, prof, notes) }) { Text("Add lead") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/** Recordings: pick the folder where the phone's own dialer saves call recordings. */
@Composable
fun RecordingSettings(vm: AppViewModel) {
    val ctx = LocalContext.current
    val folder = remember(vm.setupTick) { com.closeros.app.calls.PhoneSetup.recordingsFolder(ctx) }
    val scope = rememberCoroutineScope()
    Text("Call recordings", fontWeight = FontWeight.SemiBold)
    if (com.closeros.app.calls.RecordingSync.googleDialer(ctx)) {
        Text("This phone uses Google's Phone app, which keeps recordings private. Closer OS can't upload them on this phone.", color = Brand.red, fontSize = 14.sp)
    }
    Text(if (folder == null) "Not set up. Turn on auto call recording in your phone app, then choose the folder where recordings are saved (Xiaomi: MIUI › sound_recorder › call_rec)."
         else "Folder set ✓ · ${vm.store.recordingsUploaded} recordings uploaded", color = Brand.muted, fontSize = 14.sp)
    vm.store.lastRecordingCheck?.let { Text("Last check: $it", fontSize = 12.sp, color = Brand.muted) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { com.closeros.app.calls.PhoneSetup.pickRecordingsFolder(ctx) }) { Text(if (folder == null) "Choose recordings folder" else "Change folder") }
        if (folder != null) OutlinedButton(onClick = { vm.checkRecordingsNow() }) { Text("Check now") }
    }
}

/** WhatsApp calls: the rep allows notification access once (and contacts, to know saved names' numbers). */
@Composable
fun WhatsAppSettings(vm: AppViewModel, compact: Boolean = false) {
    val ctx = LocalContext.current
    if (!com.closeros.app.BuildConfig.WA_TRACKING) { if (!compact) Text("WhatsApp calls: available in the Play Store version of Closer OS.", color = Brand.muted, fontSize = 14.sp); return }
    if (!vm.store.trackWhatsapp) { if (!compact) Text("WhatsApp calls: turned off by your company.", color = Brand.muted, fontSize = 14.sp); return }
    var tick by remember { mutableStateOf(0) }
    val granted = remember(tick) { com.closeros.app.calls.WhatsAppCalls.accessGranted(ctx) }
    val contacts = remember(tick) { PhoneCalls.has(ctx, android.Manifest.permission.READ_CONTACTS) }
    val askContacts = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { tick++ }
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    if (compact && granted && contacts) return
    val body = @Composable {
        Text("WhatsApp calls", fontWeight = FontWeight.SemiBold)
        Text(if (granted) "On ✓ · ${com.closeros.app.calls.WhatsAppCalls.count(ctx)} WhatsApp calls noted on this phone. They can't be recorded."
             else "WhatsApp calls don't show in the phone's call history. Allow Closer OS to see WhatsApp's call notifications so your WhatsApp calls count too. Only call details (who, when, how long) are kept.",
            color = Brand.muted, fontSize = 14.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!granted) Button(onClick = { safeStart(ctx, Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }) { Text("Allow") }
            if (!contacts) OutlinedButton(onClick = { askContacts.launch(android.Manifest.permission.READ_CONTACTS) }) { Text("Allow contacts") }
        }
        if (!contacts) Text("Contacts: needed to know the number when WhatsApp shows a saved name.", fontSize = 12.sp, color = Brand.muted)
        if (granted && !compact) {
            Text("So long WhatsApp calls are never missed, don't let the phone put Closer OS to sleep: Battery → No restrictions (Xiaomi: also turn on Autostart).", fontSize = 12.sp, color = Brand.muted)
            TextButton(onClick = { safeStart(ctx, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))) }) { Text("Open app settings") }
        }
    }
    if (compact) Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFECFDF5))) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { body() } }
    else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { body() }
}
