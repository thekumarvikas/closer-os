package com.closeros.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.BuildConfig
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.calls.Sim
import com.closeros.app.data.CallRow
import com.closeros.app.data.Lead
import com.closeros.app.data.Repo
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ───────────── Formatting ─────────────

private val zone: ZoneId = ZoneId.of("Asia/Kolkata")
fun fmtWhen(iso: String?): String = iso?.let {
    runCatching { DateTimeFormatter.ofPattern("dd/MM, h:mm a").withZone(zone).format(Instant.parse(it)) }.getOrNull()
} ?: "—"
fun fmtDur(sec: Int): String = when {
    sec >= 3600 -> "${sec / 3600}h ${sec % 3600 / 60}m"
    sec >= 60 -> "${sec / 60}m ${sec % 60}s"
    else -> "${sec}s"
}
fun fmtPhone(p: String): String = Regex("^\\+91(\\d{5})(\\d{5})$").find(p)?.let { "+91 ${it.groupValues[1]} ${it.groupValues[2]}" } ?: p

// ───────────── Login ─────────────

@Composable
fun LoginScreen(vm: AppViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().background(Brand.primary).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Closer OS", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Text("Make more calls. Close more sales.", color = Color.White.copy(alpha = .8f))
        Spacer(Modifier.height(32.dp))
        Card(shape = RoundedCornerShape(16.dp)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                error?.let { Text(it, color = Brand.red, fontSize = 14.sp) }
                Button(onClick = { busy = true; error = null; vm.signIn(email, password) { error = it; busy = false } },
                    enabled = !busy && email.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth().height(50.dp)) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp) else Text("Sign in", fontSize = 16.sp)
                }
                TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_URL))) }, modifier = Modifier.fillMaxWidth()) {
                    Text("No account? Ask your manager to invite you, then sign up on the website")
                }
            }
        }
    }
}

@Composable
fun NoCompanyScreen(vm: AppViewModel) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("You're not in a company yet", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text("Ask your manager to invite ${vm.profile?.email ?: "your email"} from the Closer OS dashboard (Team → Invite people).", color = Brand.muted)
        Spacer(Modifier.height(20.dp))
        Button(onClick = { vm.loadOrg() }) { Text("I've been invited — check again") }
        TextButton(onClick = { vm.signOut() }) { Text("Sign out") }
    }
}

// ───────────── Permissions ─────────────

val requiredPermissions = buildList {
    add(Manifest.permission.READ_CALL_LOG); add(Manifest.permission.READ_PHONE_STATE); add(Manifest.permission.CALL_PHONE)
    if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
}

@Composable
fun PermissionScreen(onDone: () -> Unit) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onDone() }
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(24.dp))
        Text("Before you start", fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("Closer OS needs a few permissions to log your calls automatically:", color = Brand.muted)
        Perm(Icons.Default.Call, "Make calls", "Call leads with one tap, on the SIM you choose.")
        Perm(Icons.Default.List, "Call history", "Your calls are uploaded to your company's Closer OS so no call needs to be typed in.")
        Perm(Icons.Default.Phone, "Phone & SIM", "To know which SIM each call used.")
        Perm(Icons.Default.Notifications, "Notifications", "Follow-up reminders.")
        Text("Your company has chosen to track all calls on this phone. Use a work phone/SIM for Closer OS.", fontSize = 13.sp, color = Brand.muted)
        Button(onClick = { launcher.launch(requiredPermissions.toTypedArray()) }, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text("Allow and continue") }
    }
}

@Composable
private fun Perm(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(Brand.light), contentAlignment = Alignment.Center) { Icon(icon, null, tint = Brand.primary) }
        Spacer(Modifier.width(12.dp))
        Column { Text(title, fontWeight = FontWeight.SemiBold); Text(text, color = Brand.muted, fontSize = 14.sp) }
    }
}

// ───────────── Home ─────────────

@Composable
fun HomeScreen(vm: AppViewModel) {
    val m = vm.membership ?: return
    val now = System.currentTimeMillis()
    val due = vm.followUps.count { runCatching { Instant.parse(it.due_at).toEpochMilli() }.getOrDefault(0) < now + 86_400_000 }
    val overdue = vm.followUps.count { runCatching { Instant.parse(it.due_at).toEpochMilli() }.getOrDefault(0) < now }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Hi ${vm.profile?.full_name?.substringBefore(' ') ?: ""} 👋", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(m.organization.name, color = Brand.muted)
        }
        item {
            Text("Today", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile("Calls", vm.stats.calls.toString(), Modifier.weight(1f))
                StatTile("Connected", vm.stats.connected.toString(), Modifier.weight(1f))
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatTile("Talk time", fmtDur(vm.stats.talkSec), Modifier.weight(1f))
                StatTile("Not picked", vm.stats.notPicked.toString(), Modifier.weight(1f))
            }
        }
        item {
            Card(Modifier.fillMaxWidth().clickable { vm.tab = Tab.FollowUps }, colors = CardDefaults.cardColors(containerColor = if (overdue > 0) Color(0xFFFEF2F2) else Color.White)) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.DateRange, null, tint = if (overdue > 0) Brand.red else Brand.primary)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Follow-ups", fontWeight = FontWeight.SemiBold)
                        Text("$due due within 24 hours" + if (overdue > 0) " · $overdue overdue" else "", color = if (overdue > 0) Brand.red else Brand.muted, fontSize = 14.sp)
                    }
                    Icon(Icons.Default.KeyboardArrowRight, null, tint = Brand.muted)
                }
            }
        }
        item {
            Button(onClick = { vm.tab = Tab.Leads }, modifier = Modifier.fillMaxWidth().height(56.dp)) {
                Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text("Start calling", fontSize = 17.sp)
            }
        }
        item {
            val last = vm.store.lastSyncMs
            Text(if (last == 0L) "Calls not synced yet" else "Calls synced ${fmtWhen(Instant.ofEpochMilli(last).toString())}" +
                    if (vm.store.outbox.isNotEmpty()) " · ${vm.store.outbox.size} outcome(s) waiting for internet" else "",
                fontSize = 12.sp, color = Brand.muted)
        }
    }
}

@Composable
fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp)) {
            Text(label, fontSize = 13.sp, color = Brand.muted)
            Text(value, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// ───────────── Leads ─────────────

@Composable
fun LeadsScreen(vm: AppViewModel, onCall: (Lead) -> Unit) {
    val outcomes = vm.outcomes.associateBy { it.id }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(vm.leadsQuery, { vm.search(it) }, placeholder = { Text("Search name or phone") }, singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, null) }, modifier = Modifier.fillMaxWidth().padding(16.dp, 12.dp, 16.dp, 4.dp))
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(vm.leads, key = { it.id }) { l ->
                Card(Modifier.fillMaxWidth().clickable { vm.openLeadId = l.id }, colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(l.name.ifBlank { "No name" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(fmtPhone(l.phone), fontSize = 14.sp, color = Brand.muted)
                            val sub = listOfNotNull(outcomes[l.last_outcome_id]?.label, l.next_follow_up_at?.let { "Next: ${fmtWhen(it)}" }).joinToString(" · ")
                            if (sub.isNotEmpty()) Text(sub, fontSize = 12.sp, color = Brand.primary)
                        }
                        FilledIconButton(onClick = { onCall(l) }, enabled = !l.do_not_call) { Icon(Icons.Default.Call, "Call ${l.name}") }
                    }
                }
            }
            item {
                if (vm.leadsLoading) Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else if (vm.leads.isEmpty()) Text("No leads yet. Leads assigned to you on the dashboard appear here.", color = Brand.muted, modifier = Modifier.padding(16.dp))
                else if (!vm.leadsEnd) LaunchedEffect(vm.leads.size) { vm.loadMoreLeads() }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeadDetailScreen(vm: AppViewModel, leadId: String, onCall: (Lead) -> Unit) {
    var lead by remember { mutableStateOf<Lead?>(null) }
    var calls by remember { mutableStateOf<List<CallRow>>(emptyList()) }
    val ctx = LocalContext.current
    LaunchedEffect(leadId) {
        lead = runCatching { Repo.lead(leadId) }.getOrNull()
        calls = runCatching { Repo.leadCalls(leadId) }.getOrDefault(emptyList())
    }
    val outcomes = vm.outcomes.associateBy { it.id }
    Scaffold(topBar = {
        TopAppBar(title = { Text(lead?.name?.ifBlank { "Lead" } ?: "Lead") },
            navigationIcon = { IconButton(onClick = { vm.openLeadId = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        val l = lead
        if (l == null) { Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return@Scaffold }
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(fmtPhone(l.phone), fontSize = 18.sp)
                listOfNotNull(l.profession, l.company, l.city).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { Text(it, color = Brand.muted) }
                listOfNotNull(l.source, l.campaign).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { Text("Source: $it", color = Brand.muted, fontSize = 14.sp) }
                l.next_follow_up_at?.let { Text("Next follow-up: ${fmtWhen(it)}", color = Brand.primary, fontSize = 14.sp) }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = { onCall(l) }, enabled = !l.do_not_call, modifier = Modifier.weight(1f).height(52.dp)) {
                        Icon(Icons.Default.Call, null); Spacer(Modifier.width(6.dp)); Text("Call")
                    }
                    OutlinedButton(onClick = { PhoneCalls.whatsapp(ctx, l.phone, "Hi ${l.name.substringBefore(' ')}, ") }, modifier = Modifier.weight(1f).height(52.dp)) {
                        Icon(Icons.Default.Send, null); Spacer(Modifier.width(6.dp)); Text("WhatsApp")
                    }
                }
                if (l.do_not_call) Text("Marked Do Not Call", color = Brand.red, fontSize = 13.sp)
            }
            if (!l.notes.isNullOrBlank()) item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(14.dp)) { Text("Notes", fontWeight = FontWeight.SemiBold); Text(l.notes, fontSize = 14.sp) }
                }
            }
            item { Text("Calls", fontWeight = FontWeight.SemiBold) }
            if (calls.isEmpty()) item { Text("No calls yet.", color = Brand.muted) }
            items(calls) { c ->
                Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).padding(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("${c.direction.replaceFirstChar { it.uppercase() }} · ${if (c.duration_sec > 0) fmtDur(c.duration_sec) else "not connected"}", fontSize = 14.sp)
                        Text(fmtWhen(c.started_at), fontSize = 12.sp, color = Brand.muted)
                    }
                    Text(outcomes[c.outcome_id]?.label ?: "", fontSize = 13.sp, color = Brand.primary)
                }
            }
        }
    }
}

// ───────────── Follow-ups ─────────────

@Composable
fun FollowUpsScreen(vm: AppViewModel) {
    val now = System.currentTimeMillis()
    LaunchedEffect(Unit) { vm.refreshHome() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Follow-ups", fontSize = 22.sp, fontWeight = FontWeight.Bold) }
        if (vm.followUps.isEmpty()) item { Text("Nothing pending. Follow-ups appear when you save a call with a next-call time.", color = Brand.muted) }
        items(vm.followUps, key = { it.id }) { f ->
            val overdue = runCatching { Instant.parse(f.due_at).toEpochMilli() < now }.getOrDefault(false)
            Card(Modifier.fillMaxWidth().clickable { vm.openLeadId = f.lead_id }, colors = CardDefaults.cardColors(containerColor = Color.White)) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(f.lead?.name?.ifBlank { null } ?: fmtPhone(f.lead?.phone ?: ""), fontWeight = FontWeight.SemiBold)
                        Text((if (overdue) "Overdue · " else "") + fmtWhen(f.due_at), color = if (overdue) Brand.red else Brand.muted, fontSize = 14.sp)
                        f.reason?.let { Text(it, fontSize = 13.sp) }
                    }
                    Icon(Icons.Default.KeyboardArrowRight, null, tint = Brand.muted)
                }
            }
        }
    }
}

// ───────────── Profile ─────────────

@Composable
fun ProfileScreen(vm: AppViewModel) {
    val ctx = LocalContext.current
    val sims = remember { PhoneCalls.sims(ctx) }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(vm.profile?.full_name ?: "", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("${vm.profile?.email ?: ""}\n${vm.membership?.organization?.name ?: ""} · ${vm.membership?.role?.replaceFirstChar { it.uppercase() } ?: ""}", color = Brand.muted)
        HorizontalDivider()
        Text("SIM cards", fontWeight = FontWeight.SemiBold)
        if (sims.isEmpty()) Text("No SIM found (or phone permission not given).", color = Brand.muted)
        sims.forEach { Text(it.label + if (vm.store.preferredSim == it.slot) "  ✓ last used" else "") }
        HorizontalDivider()
        Text("Sync", fontWeight = FontWeight.SemiBold)
        Text(if (vm.store.lastSyncMs == 0L) "Not synced yet" else "Last sync ${fmtWhen(Instant.ofEpochMilli(vm.store.lastSyncMs).toString())}", color = Brand.muted)
        OutlinedButton(onClick = { com.closeros.app.calls.CallSync.syncNow(ctx); vm.message = "Syncing calls…" }) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(6.dp)); Text("Sync calls now") }
        HorizontalDivider()
        OutlinedButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.WEB_URL))) }) { Text("Open dashboard website") }
        TextButton(onClick = { vm.signOut() }) { Text("Sign out", color = Brand.red) }
        Text("Closer OS ${BuildConfig.VERSION_NAME}", fontSize = 12.sp, color = Brand.muted)
    }
}

// ───────────── SIM picker ─────────────

@Composable
fun SimPicker(sims: List<Sim>, onPick: (Sim) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, confirmButton = {}, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Call using") },
        text = { Column { sims.forEach { s -> TextButton(onClick = { onPick(s) }, modifier = Modifier.fillMaxWidth()) { Text(s.label, modifier = Modifier.fillMaxWidth()) } } } })
}
