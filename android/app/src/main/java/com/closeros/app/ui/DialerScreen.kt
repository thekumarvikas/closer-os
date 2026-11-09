package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.LogCall
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.Lead
import com.closeros.app.data.Repo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant

/** Dial pad: type a number, see matching leads and call history, then Call (choose SIM), WhatsApp, SMS or add as lead. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DialerScreen(vm: AppViewModel) {
    BackHandler { vm.showDialer = false }
    val ctx = LocalContext.current
    var number by remember { mutableStateOf("") }
    var leads by remember { mutableStateOf<List<Lead>>(emptyList()) }
    var history by remember { mutableStateOf<List<LogCall>>(emptyList()) }
    var wa by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    val sims = remember { vm.sims() }
    val digits = number.filter { it.isDigit() }
    // The phone's call history is read once when the dial pad opens, not on every key press.
    val allHistory by produceState<List<LogCall>?>(null) { value = withContext(Dispatchers.IO) { runCatching { PhoneCalls.history(ctx, 3000) }.getOrDefault(emptyList()) } }
    LaunchedEffect(digits, allHistory) {
        if (digits.length < 3) { leads = emptyList(); history = emptyList(); return@LaunchedEffect }
        delay(250)
        history = allHistory.orEmpty().filter { it.phone.filter { c -> c.isDigit() }.contains(digits) }.take(30)
        val m = vm.membership
        leads = if (m != null && digits.length >= 4) runCatching { Repo.leads(m.org_id, digits, 0, vm.membership?.role == "rep") }.getOrDefault(emptyList()).take(5) else emptyList()
    }
    val exactLead = leads.firstOrNull { it.phone.filter { c -> c.isDigit() }.endsWith(digits.takeLast(10)) && digits.length >= 10 }
    fun press(c: String) { if (number.length < 16) number += c }

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showDialer = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Text("Dial a number", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        // Matches: leads first, then the phone's call history with this number.
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp, 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (leads.isNotEmpty()) item { Text("Leads", fontSize = 12.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold) }
            items(leads.distinctBy { "l" + it.id }, key = { "l" + it.id }) { l ->
                Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).combinedClickable(onClick = { vm.openLeadId = l.id; vm.showDialer = false }).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(l.name.ifBlank { "No name" }, fontWeight = FontWeight.SemiBold)
                        Text(listOfNotNull(fmtPhone(l.phone), callsLine(l.call_count, l.conversation_count), vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.label).joinToString(" · "), fontSize = 12.sp, color = Brand.muted)
                    }
                    IconButton(onClick = { vm.callRequest = l; vm.showDialer = false }) { Icon(Icons.Default.Call, "Call", tint = Brand.primary) }
                }
            }
            if (history.isNotEmpty()) item { Text("Call history", fontSize = 12.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold) }
            items(history.distinctBy { "h" + it.id }, key = { "h" + it.id }) { h ->
                Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).combinedClickable(onClick = { number = h.phone }).padding(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(h.name ?: fmtPhone(h.phone), fontWeight = FontWeight.Medium)
                        Text((h.simSlot?.let { "SIM $it · " } ?: "") + CallColors.label(h.direction, h.durationSec) +
                            " · ${if (h.durationSec > 0) fmtDur(h.durationSec) else "no talk"} · ${fmtWhen(Instant.ofEpochMilli(h.startedAtMs).toString())}", fontSize = 12.sp,
                            color = CallColors.of(h.direction, h.durationSec))
                    }
                }
            }
            if (digits.length >= 3 && leads.isEmpty() && history.isEmpty()) item { Text("No calls with this number yet.", color = Brand.muted, fontSize = 13.sp) }
        }
        // Number + actions
        Text(if (number.isEmpty()) "Enter number" else number, fontSize = 30.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center,
            color = if (number.isEmpty()) Brand.muted else Color(0xFF0F172A), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        exactLead?.let { Text("Lead: ${it.name}", color = Brand.primary, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
        if (digits.length >= 6) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            TextButton(onClick = { wa = true }) { Icon(Icons.Default.Send, null, tint = Color(0xFF16A34A)); Spacer(Modifier.width(4.dp)); Text("WhatsApp") }
            TextButton(onClick = { PhoneCalls.sms(ctx, number) }) { Icon(Icons.Default.Email, null); Spacer(Modifier.width(4.dp)); Text("SMS") }
            if (exactLead == null) TextButton(onClick = { adding = true }) { Text("+ Add lead") }
        }
        // Keypad
        Column(Modifier.fillMaxWidth().padding(horizontal = 40.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("*", "0", "#")).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    row.forEach { k ->
                        Box(Modifier.size(64.dp).clip(CircleShape).background(Color.White)
                            .combinedClickable(onClick = { press(k) }, onLongClick = { if (k == "0") press("+") }), contentAlignment = Alignment.Center) {
                            Text(k, fontSize = 26.sp)
                        }
                    }
                }
            }
        }
        // Call buttons: one per SIM when the phone has two.
        Row(Modifier.fillMaxWidth().padding(16.dp, 10.dp, 16.dp, 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { number = number.dropLast(1) }, enabled = number.isNotEmpty()) { Text("⌫", fontSize = 22.sp) }
            fun dial(sim: com.closeros.app.calls.Sim?) {
                if (digits.length < 3) return
                if (exactLead != null) { sim?.let { vm.store.preferredSim = it.slot }; vm.callRequest = exactLead; vm.showDialer = false }
                else PhoneCalls.call(ctx, number, sim)
            }
            if (sims.size > 1) sims.forEach { s ->
                Button(onClick = { dial(s) }, enabled = digits.length >= 3, modifier = Modifier.weight(1f).height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A))) { Icon(Icons.Default.Call, null); Spacer(Modifier.width(6.dp)); Text("SIM ${s.slot}") }
            } else Button(onClick = { dial(sims.firstOrNull()) }, enabled = digits.length >= 3, modifier = Modifier.weight(1f).height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A))) { Icon(Icons.Default.Call, null); Spacer(Modifier.width(6.dp)); Text("Call") }
        }
    }
    if (wa) WhatsAppPicker(vm, exactLead ?: Lead(id = "", org_id = vm.membership?.org_id ?: "", phone = number)) { wa = false }
    if (adding) AddLeadQuick(vm, number) { adding = false }
}

@Composable
private fun AddLeadQuick(vm: AppViewModel, phone: String, onClose: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var prof by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onClose, title = { Text("Add as lead") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(phone, color = Brand.muted)
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(prof, { prof = it }, label = { Text("Profession (optional)") }, singleLine = true)
            }
        },
        confirmButton = { Button(onClick = { vm.addLeadFromCall(normalizePhone(phone, vm.membership?.organization?.phone_prefix ?: "+91"), name, prof, "") { onClose() } }) { Text("Add lead") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}
