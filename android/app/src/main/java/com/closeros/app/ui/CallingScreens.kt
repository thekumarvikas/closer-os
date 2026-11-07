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
import androidx.compose.material.icons.filled.Email
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

private data class TileDef(val key: String, val label: String, val value: (List<HistoryItem>) -> String, val bad: Boolean = false, val short: String = label)

private val tiles = listOf(
    TileDef("dialled", "Dialled", { l -> l.count { it.log.direction == "outgoing" }.toString() }),
    TileDef("all", "All calls", { it.size.toString() }),
    TileDef("received", "Received", { l -> l.count { it.log.direction == "incoming" }.toString() }),
    TileDef("conversations", "Conversations", { l -> l.count { it.log.durationSec > 0 }.toString() }, short = "Talked"),
    TileDef("noanswer", "No answer", { l -> l.count { it.log.direction == "outgoing" && it.log.durationSec == 0 }.toString() }, bad = true),
    TileDef("missed", "Missed / declined", { l -> l.count { it.log.direction == "missed" || it.log.direction == "rejected" }.toString() }, bad = true, short = "Missed"),
    TileDef("talk", "Talk time", { l -> fmtDur(l.sumOf { it.log.durationSec }) }),
    TileDef("avg", "Avg. conversation", { l -> l.filter { it.log.durationSec > 0 }.let { c -> fmtDur(if (c.isEmpty()) 0 else c.sumOf { it.log.durationSec } / c.size) } }, short = "Avg talk"),
    TileDef("contacts", "Unique contacts", { l -> l.map { it.phone }.distinct().size.toString() }, short = "People"),
    TileDef("leads", "Leads called", { l -> l.mapNotNull { it.lead?.id }.distinct().size.toString() }, short = "Leads"),
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
    fun ms(iso: String?) = iso?.let { runCatching { com.closeros.app.data.parseInstant(it).toEpochMilli() }.getOrNull() }
    val dueToday = vm.followUps.filter { (ms(it.due_at) ?: 0) < now + 86_400_000 }
    val overdue = vm.followUps.count { (ms(it.due_at) ?: 0) < now }
    val newFeedback = vm.reviews.count { it.seen_at == null }
    // A webinar in the next 18 h with reminder calls of mine still to make.
    val upcoming = vm.batches.orEmpty().filter { b -> (ms(b.webinar_at) ?: 0) in (now - 3_600_000)..(now + 18 * 3_600_000) && b.reminder_mine > 0 }
        .minByOrNull { ms(it.webinar_at) ?: 0 }
    LaunchedEffect(Unit) { vm.loadToday(); if (vm.batches == null) vm.loadBatches(quiet = true) }
    var moreTiles by remember { mutableStateOf(false) }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 12.dp, 16.dp, 88.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Who + is everything uploaded (a dot; details only when something is wrong).
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Hi ${vm.profile?.full_name?.substringBefore(' ') ?: ""} 👋", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(m.organization.name, color = Brand.muted, fontSize = 13.sp)
                }
            }
        }
        // Alerts — only when they apply.
        if (vm.access?.state == "grace") item {
            Text("Your company's Closer OS plan has ended — ask the owner to renew it on the dashboard.",
                Modifier.fillMaxWidth().background(Color(0xFFFEE2E2), RoundedCornerShape(10.dp)).padding(12.dp), color = Brand.red, fontSize = 13.sp)
        }
        item { SetupBanner(vm) }
        item { SyncStatusLine(vm, onlyProblems = true) }
        if (newFeedback > 0) item {
            Row(Modifier.fillMaxWidth().background(Color(0xFFEFF6FF), RoundedCornerShape(10.dp)).clickable { vm.showFeedback = true }.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("🎯 New feedback from your manager ($newFeedback)", fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.weight(1f))
                Text("Open ›", color = Brand.primary, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
        }

        // What to do now: one big button that changes with the situation.
        item {
            val fmt = java.time.format.DateTimeFormatter.ofPattern("h:mm a").withZone(java.time.ZoneId.of(m.organization.timezone))
            data class Next(val title: String, val sub: String?, val urgent: Boolean, val go: () -> Unit)
            val next = when {
                vm.queueActive -> Next("Continue calling · ${vm.queuePos + 1} of ${vm.queue.size}", "Your calling queue is paused", false) { vm.queueResume() }
                vm.focusTotal > 0 -> Next("Start today's focus · ${vm.focusTotal}",
                    (if (overdue > 0) "Incl. $overdue overdue follow-up${if (overdue > 1) "s" else ""} · " else "") + "${vm.focusDone} done today · see the list, then call or WhatsApp",
                    overdue > 0) { vm.openFocusList() }
                overdue > 0 -> Next("Call $overdue overdue follow-up${if (overdue > 1) "s" else ""}", "${dueToday.size} due in the next 24 hours", true) { vm.startFollowUpQueue() }
                upcoming != null -> Next("Reminder calls · ${upcoming.name}", "Starts ${ms(upcoming.webinar_at)?.let { fmt.format(Instant.ofEpochMilli(it)) } ?: ""} · ${upcoming.reminder_mine} leads", false) { vm.openBatchList(upcoming, "reminder") }
                dueToday.isNotEmpty() -> Next("Call ${dueToday.size} follow-up${if (dueToday.size > 1) "s" else ""} due", "In the next 24 hours", false) { vm.startFollowUpQueue() }
                else -> Next("Pick leads to call", "No follow-ups due — choose who to call", false) { vm.selectMode = true; vm.tab = Tab.Leads }
            }
            Column(Modifier.fillMaxWidth().background(Brand.primary, RoundedCornerShape(16.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = next.go, modifier = Modifier.fillMaxWidth().height(54.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = if (next.urgent) Color(0xFFDC2626) else Color.White, contentColor = if (next.urgent) Color.White else Brand.primaryDark)) {
                    Icon(Icons.Default.Call, null); Spacer(Modifier.width(8.dp)); Text(next.title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
                next.sub?.let { Text(it, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp, modifier = Modifier.clickable { if (vm.focusTotal > 0 && !vm.queueActive) vm.openFocusList() else vm.tab = Tab.FollowUps }) }
                // Daily focus target set by the manager (e.g. 150 leads a day): progress only, never hides leads.
                vm.progress?.daily?.focus?.takeIf { it > 0 }?.let { goal ->
                    Text("Today's focus target: ${vm.focusDone} of $goal leads", color = Color.White, fontSize = 12.sp)
                    LinearProgressIndicator(progress = { (vm.focusDone.toFloat() / goal).coerceIn(0f, 1f) }, Modifier.fillMaxWidth().height(4.dp),
                        color = Color.White, trackColor = Color.White.copy(alpha = 0.25f))
                }
                upcoming?.takeIf { vm.focusTotal > 0 && !vm.queueActive }?.let { u ->
                    Text("🎓 Reminder calls · ${u.name} (${u.reminder_mine}) ›", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable { vm.openBatchList(u, "reminder") })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HeroLink("📋 Pick leads", Modifier.weight(1f)) { vm.selectMode = true; vm.tab = Tab.Leads }
                    HeroLink("📅 Follow-ups${if (dueToday.isNotEmpty()) " (${dueToday.size})" else ""}", Modifier.weight(1f)) { vm.tab = Tab.FollowUps }
                    HeroLink("🎓 Webinars", Modifier.weight(1f)) { vm.showBatches = true }
                }
            }
        }

        // Today: 4 key numbers (with target bars when targets are set); the rest on "More".
        item {
            val p = vm.progress
            fun target(k: String) = p?.target?.let { t -> when (k) { "dialled" -> t.calls; "conversations" -> t.conversations; "talk" -> t.talk_minutes; else -> null } }?.takeIf { it > 0 }
            fun actual(k: String) = p?.actual?.let { a -> when (k) { "dialled" -> a.calls; "conversations" -> a.conversations; "talk" -> a.talk_minutes; else -> null } } ?: 0
            Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Today", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text(if (moreTiles) "Less ‹" else "More ›", color = Brand.primary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { moreTiles = !moreTiles })
                    }
                    // Interactions = calls dialled + received + WhatsApp sent from Closer OS (tap: today's messages).
                    val interactions = vm.today.count { it.log.direction == "outgoing" || it.log.direction == "incoming" } + vm.waToday.size
                    val keyTiles = listOf("talk", "dialled", "conversations")
                    val shown = (if (moreTiles) tiles.filter { it.key !in keyTiles } else emptyList())
                    (listOf<Any>("interactions") + tiles.filter { it.key in keyTiles }.sortedBy { keyTiles.indexOf(it.key) } + shown).chunked(4).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { any ->
                                val t = any as? TileDef
                                val v = t?.value?.invoke(vm.today) ?: interactions.toString()
                                val tg = t?.let { target(it.key) }
                                Column(Modifier.weight(1f).background(Color(0xFFF8FAFC), RoundedCornerShape(10.dp))
                                    .clickable { if (t == null) vm.showWaToday = true else vm.todayFilter = t.key }.padding(8.dp)) {
                                    Text(v, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = if (t?.bad == true && v != "0") Brand.red else Color(0xFF0F172A), maxLines = 1)
                                    Text(t?.short ?: "Interactions", fontSize = 11.sp, color = Brand.muted, maxLines = 1)
                                    if (t == null && vm.waToday.isNotEmpty()) Text("${vm.waToday.size} WhatsApp", fontSize = 10.sp, color = Color(0xFF16A34A))
                                    if (t != null && tg != null) {
                                        val pct = (actual(t.key).toFloat() / tg).coerceIn(0f, 1f)
                                        LinearProgressIndicator(progress = { pct }, Modifier.fillMaxWidth().padding(top = 4.dp).height(4.dp),
                                            color = if (pct >= 1f) Color(0xFF10B981) else if (pct >= 0.7f) Color(0xFFF59E0B) else Brand.primary, trackColor = Color(0xFFE2E8F0))
                                        Text("of $tg${if (t.key == "talk") " min" else ""}", fontSize = 10.sp, color = Brand.muted)
                                    }
                                }
                            }
                            repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                    p?.target?.sales?.takeIf { it > 0 }?.let { st -> Text("Sales today: ${p.actual.sales ?: 0} of $st", fontSize = 12.sp, color = Brand.muted) }
                    // This month's talk time against the month target (working days set by management) — "on pace" vs where you should be by today.
                    val mf = vm.monthFull; val md = vm.monthToDate
                    val fullT = mf?.target?.talk_minutes ?: 0
                    if (fullT > 0 && md != null) {
                        val done = md.actual.talk_minutes ?: 0; val due = md.target.talk_minutes ?: 0
                        val pace = done - due
                        Text("This month: ${done / 60}h ${done % 60}m of ${fullT / 60}h · day ${md.work_days} of ${mf?.work_days ?: 0} · " +
                            (if (pace >= 0) "on pace ✓" else "${(-pace) / 60}h ${(-pace) % 60}m behind"),
                            fontSize = 12.sp, color = if (pace >= 0) Color(0xFF059669) else Color(0xFF92400E))
                        LinearProgressIndicator(progress = { (done.toFloat() / fullT).coerceIn(0f, 1f) }, Modifier.fillMaxWidth().height(4.dp),
                            color = Brand.primary, trackColor = Color(0xFFE2E8F0))
                    }
                }
            }
        }

        // Speed to lead: how fast new leads get their first call (last 7 days) + who is waiting now.
        if (vm.response != null) item { ResponseLine(vm, vm.response!!) }
        // Leaderboard in one line.
        if (vm.leaderboard.size >= 2) item {
            val rows = vm.leaderboard
            val me = rows.indexOfFirst { it.user_id == com.closeros.app.data.Backend.uid }
            Row(Modifier.fillMaxWidth().background(Color(0xFFFFFBEB), RoundedCornerShape(10.dp)).clickable { vm.showLeaderboard = true }.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("🏆 " + (if (me >= 0) "You're #${me + 1} of ${rows.size} · " else "") + "Leader: ${rows[0].name.substringBefore(' ')} (${fmtDur(rows[0].talk_sec)})",
                    fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("›", color = Brand.primary, fontWeight = FontWeight.Bold)
            }
        }

        // Tools.
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ToolTile("📖", "Playbook", Modifier.weight(1f)) { vm.openPlaybook(null) }
                ToolTile("📊", if (vm.isManager) "Reports" else "My reports", Modifier.weight(1f)) { vm.showReports = true }
                ToolTile("📈", "Lead work", Modifier.weight(1f)) { vm.showLeadWork = true }
                ToolTile("💡", "What works", Modifier.weight(1f)) { vm.showRecipe = true }
                if (vm.reviews.isNotEmpty()) ToolTile("🎯", "Feedback", Modifier.weight(1f)) { vm.showFeedback = true }
            }
        }
        item { SyncStatusLine(vm, onlyProblems = false, small = true) }
    }
}

@Composable
private fun HeroLink(text: String, modifier: Modifier, onClick: () -> Unit) {
    Text(text, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = modifier.background(Color.White.copy(alpha = 0.15f), RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(vertical = 9.dp, horizontal = 6.dp),
        textAlign = androidx.compose.ui.text.style.TextAlign.Center)
}

@Composable
private fun ToolTile(icon: String, label: String, modifier: Modifier, onClick: () -> Unit) {
    Column(modifier.background(Color.White, RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(icon, fontSize = 20.sp); Text(label, fontSize = 12.sp, color = Color(0xFF334155))
    }
}

/** Top of Home: is everything uploaded? */
@Composable
fun SyncStatusLine(vm: AppViewModel, onlyProblems: Boolean = false, small: Boolean = false) {
    val ctx = LocalContext.current
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(20_000); tick++ } }
    val (text, warn) = remember(tick, vm.stats, vm.message) {
        val last = vm.store.lastSyncMs
        val waiting = vm.store.outbox.size
        val waUnsent = runCatching { com.closeros.app.calls.WhatsAppCalls.since(ctx, vm.store.waCursorMs).size }.getOrDefault(0)
        val ago = if (last == 0L) null else ((System.currentTimeMillis() - last) / 60_000).let { if (it < 1) "just now" else if (it < 60) "$it min ago" else "${it / 60} h ago" }
        when {
            waiting + waUnsent > 0 -> "⏳ ${waiting + waUnsent} waiting to upload" + (if (waiting > 0) " (${waiting} outcome${if (waiting > 1) "s" else ""})" else "") + " — will send when online" to true
            last == 0L -> "⏳ Not synced yet" to true
            System.currentTimeMillis() - last > 3 * 3_600_000 -> "⚠ Last synced $ago — check internet" to true
            else -> "✓ All synced · $ago" to false
        }
    }
    if (onlyProblems && !warn) return
    if (small && warn) return   // already shown at the top
    if (small) { Text(text, fontSize = 11.sp, color = Brand.muted, modifier = Modifier.fillMaxWidth().clickable { com.closeros.app.calls.CallSync.syncNow(ctx); vm.message = "Syncing…"; tick++ }, textAlign = androidx.compose.ui.text.style.TextAlign.Center); return }
    Row(Modifier.fillMaxWidth().background(if (warn) Color(0xFFFEF3C7) else Color(0xFFECFDF5), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(text, fontSize = 12.sp, color = if (warn) Color(0xFF92400E) else Color(0xFF065F46), modifier = Modifier.weight(1f))
        TextButton(onClick = { com.closeros.app.calls.CallSync.syncNow(ctx); vm.message = "Syncing…"; tick++ }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Sync now", fontSize = 12.sp) }
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
            items(items.distinctBy { it.log.id }, key = { it.log.id }) { h -> HistoryRow(vm, h) }
            if (items.size > leads.size && leads.isNotEmpty()) item {
                Text("Numbers that are not leads can't go in the queue — add them as leads from the Calls tab first.", fontSize = 12.sp, color = Brand.muted)
            }
        }
    }
}

/** One slim call row: direction arrow · name · one detail line · WhatsApp + Call. Tap for SMS / lead actions. */
@Composable
fun HistoryRow(vm: AppViewModel, h: HistoryItem, onAdd: (() -> Unit)? = null, count: Int = 1) {
    val ctx = LocalContext.current
    var wa by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf(false) }
    val missed = h.log.direction == "missed" || h.log.direction == "rejected"
    val (arrow, arrowColor) = when (h.log.direction) {
        "outgoing" -> "↗" to Color(0xFF0E7490); "incoming" -> "↙" to Color(0xFF16A34A); else -> "✕" to Brand.red
    }
    val name = h.lead?.name?.ifBlank { null } ?: h.log.name ?: fmtPhone(h.phone)
    val twoSims = remember { vm.sims().size > 1 }
    val time = java.time.format.DateTimeFormatter.ofPattern("h:mm a").format(Instant.ofEpochMilli(h.log.startedAtMs).atZone(java.time.ZoneId.systemDefault()))
    val what = when (h.log.direction) {
        "outgoing" -> if (h.log.durationSec > 0) fmtDur(h.log.durationSec) else "No answer"
        "incoming" -> "Received · ${fmtDur(h.log.durationSec)}"
        "missed" -> "Missed"; else -> "Declined"
    }
    Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(start = 4.dp, top = 6.dp, bottom = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(arrow, color = arrowColor, fontSize = 21.sp, fontWeight = FontWeight.Black, modifier = Modifier.width(28.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name + if (count > 1) "  ($count)" else "", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (missed) Brand.red else Color(0xFF0F172A), modifier = Modifier.weight(1f, fill = false))
                    // Leads are the normal case: no tag. Only numbers not in the lead list are tagged.
                    if (h.lead == null && h.phone.isNotBlank()) Text("Not in lead list", fontSize = 10.sp, color = Color(0xFF475569),
                        modifier = Modifier.padding(start = 6.dp).background(Color(0xFFE2E8F0), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 1.dp))
                }
                Text(listOfNotNull(if (h.log.channel == "whatsapp") "WhatsApp" else null, what, time,
                    h.lead?.let { "${it.call_count} calls · ${it.conversation_count} conv." },
                    h.log.simSlot?.takeIf { twoSims && h.log.channel == "phone" }?.let { "SIM $it" }).joinToString(" · "),
                    fontSize = 12.sp, color = if (missed) Brand.red else Brand.muted, maxLines = 1)
            }
            val rec = vm.recordingPaths[h.log.id]
            if (rec != null) IconButton(onClick = { open = true }, modifier = Modifier.size(36.dp)) { Text("▶", color = Brand.primary, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
            if (h.phone.isNotBlank()) {
                IconButton(onClick = { wa = true }, modifier = Modifier.size(40.dp)) { Icon(Icons.Default.Send, "WhatsApp", tint = Color(0xFF16A34A), modifier = Modifier.size(20.dp)) }
                IconButton(onClick = {
                    if (h.lead != null) vm.callRequest = h.lead
                    else PhoneCalls.call(ctx, h.phone, vm.sims().firstOrNull { it.slot == vm.store.preferredSim } ?: vm.sims().firstOrNull())
                }, modifier = Modifier.size(40.dp)) { Icon(Icons.Default.Call, "Call", tint = Brand.primary, modifier = Modifier.size(22.dp)) }
            }
        }
        if (open) vm.recordingPaths[h.log.id]?.let { p -> Box(Modifier.padding(start = 28.dp)) { RecordingPlayer(h.log.id, p) } }
        if (open && h.phone.isNotBlank()) Row(Modifier.padding(start = 26.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { PhoneCalls.sms(ctx, h.phone) }) { Text("✉️ SMS") }
            if (h.lead != null) TextButton(onClick = { vm.openLeadId = h.lead.id }) { Text("👤 Open lead") }
            else if (onAdd != null) TextButton(onClick = onAdd) { Text("+ Add lead") }
            Text(fmtPhone(h.phone), fontSize = 12.sp, color = Brand.muted, modifier = Modifier.align(Alignment.CenterVertically))
        }
    }
    if (wa) WhatsAppPicker(vm, h.lead ?: Lead(id = "", org_id = vm.membership?.org_id ?: "", name = h.log.name ?: "", phone = h.phone)) { wa = false }
}

/** Groups calls by day ("Today", "Yesterday", "Mon 3 Nov") and folds repeat calls to the same number in a row. */
fun groupCalls(list: List<HistoryItem>): List<Pair<String, List<Pair<HistoryItem, Int>>>> {
    val zone = java.time.ZoneId.systemDefault()
    val today = java.time.LocalDate.now(zone)
    val fmt = java.time.format.DateTimeFormatter.ofPattern("EEE d MMM")
    return list.groupBy { Instant.ofEpochMilli(it.log.startedAtMs).atZone(zone).toLocalDate() }.map { (d, calls) ->
        val title = when (d) { today -> "Today"; today.minusDays(1) -> "Yesterday"; else -> d.format(fmt) }
        val folded = mutableListOf<Pair<HistoryItem, Int>>()
        calls.forEach { c ->
            val last = folded.lastOrNull()
            if (last != null && last.first.phone == c.phone && last.first.log.direction == c.log.direction && last.first.log.channel == c.log.channel)
                folded[folded.size - 1] = last.first to last.second + 1
            else folded += c to 1
        }
        title to folded
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
        Text("Next call", fontWeight = FontWeight.SemiBold)
        GlanceCard(vm, next)
        TextButton(onClick = { vm.queuePause(); vm.openPlaybook(next) }) { Text("📖 Script & answers for this call") }
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
    if (l.source == "Phone call") out += Tag("Added from a call", Color(0xFFFEF3C7), Color(0xFF92400E))
    if (l.score >= 40 && l.won_at == null) out += Tag("⚡ Close to converting", Color(0xFFFEF3C7), Color(0xFF92400E))
    // Speed to first call: a fresh lead nobody has dialled yet shows how long it has been waiting.
    if (l.dial_count == 0 && !l.do_not_call) l.created_at?.let { runCatching { com.closeros.app.data.parseInstant(it) }.getOrNull() }?.let { at ->
        val min = java.time.Duration.between(at, Instant.now()).toMinutes()
        if (min in 0..(7 * 24 * 60)) out += Tag("🆕 New · ${if (min < 60) "$min min" else if (min < 1440) "${min / 60} h" else "${min / 1440} d"} waiting",
            if (min <= 30) Color(0xFFDBEAFE) else Color(0xFFFEE2E2), if (min <= 30) Color(0xFF1E40AF) else Color(0xFF991B1B))
    }
    if (l.best_hour != null && l.best_hour == java.time.LocalTime.now().hour) out += Tag("⏰ Best time now", Color(0xFFE0F2FE), Color(0xFF075985))
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
                Text(listOfNotNull(fmtPhone(l.phone), l.company?.takeIf { it.isNotBlank() }, l.profession?.takeIf { it.isNotBlank() }, l.city?.takeIf { it.isNotBlank() })
                    .joinToString(" · "), fontSize = 13.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                l.latestBatch?.let { b ->
                    Text("${b.batch?.name ?: "Webinar"} · " + when { b.watch_minutes == null -> "attendance not uploaded"; b.watch_minutes > 0 -> "watched ${b.watch_minutes} min"; else -> "didn't join" } + (b.warm_reason?.let { " · $it" } ?: ""),
                        fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                // Effort so far in one line: talk time, calls (real pick-ups), WhatsApp sent, last outcome.
                val last = listOfNotNull(
                    l.total_talk_sec.takeIf { it > 0 }?.let { "Talked ${fmtDur(it)}" },
                    callsLine(l.call_count, l.conversation_count),
                    l.wa_count.takeIf { it > 0 }?.let { "$it WA" },
                    vm.outcomes.firstOrNull { it.id == l.last_outcome_id }?.label ?: l.last_call_at?.let { "Last called ${fmtWhen(it)}" },
                ).joinToString(" · ")
                if (last.isNotEmpty()) Text(last, fontSize = 12.sp, color = Brand.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                // Neutral bar: talk so far vs my usual talk per sale (never a warning).
                val usual = vm.recipe?.get("talk_min")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull() }
                if (usual != null && usual > 0 && l.won_at == null && l.total_talk_sec > 0)
                    LinearProgressIndicator(progress = { ((l.total_talk_sec / 60.0) / usual).toFloat().coerceIn(0f, 1f) },
                        Modifier.fillMaxWidth(0.6f).padding(top = 2.dp).height(3.dp), color = Brand.primary, trackColor = Color(0xFFE2E8F0))
                l.next_follow_up_at?.let { Text("Next call: ${fmtWhen(it)}", fontSize = 12.sp, color = Brand.primary) }
                if (tags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                    tags.forEach { Text(it.text, fontSize = 11.sp, color = it.fg, fontWeight = FontWeight.Medium, modifier = Modifier.background(it.bg, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp)) }
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (onCall != null) FilledIconButton(onClick = { onCall(l) }) { Icon(Icons.Default.Call, "Call ${l.name}") }
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
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveName by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<CompanyMedia?>(null) }   // company file: from a template or the file library
    var showFiles by remember { mutableStateOf(false) }
    var chosen by remember { mutableStateOf<com.closeros.app.data.Template?>(null) }   // which saved message (for the record)
    var ownMedia by remember { mutableStateOf<android.net.Uri?>(null) }               // photo/video chosen on the phone
    var sending by remember { mutableStateOf(false) }
    val chooseMedia = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { u -> if (u != null) ownMedia = u }
    val first = lead.name.substringBefore(' ')
    val company = vm.templates.filter { it.owner_id == null }
    val mine = vm.templates.filter { it.owner_id != null }
    fun pick(t: com.closeros.app.data.Template) {
        text = vm.fillTemplate(t.body, lead); ownMedia = null; chosen = t
        picked = t.media_path?.let { CompanyMedia(it, t.media_type, t.media_name) }
    }
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text(if (text == null) "Choose a message" else "WhatsApp to ${first.ifBlank { fmtPhone(lead.phone) }}") },
        text = {
            if (text == null) Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (company.isNotEmpty()) Text("Company messages", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = Brand.muted)
                company.forEach { t -> TemplateRow(vm, (if (t.media_path != null) mediaIcon(t.media_type) + " " else "") + t.name, vm.fillTemplate(t.body, lead), null) { pick(t) } }
                if (mine.isNotEmpty()) Text("My messages", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(top = 6.dp))
                mine.forEach { t -> TemplateRow(vm, t.name, vm.fillTemplate(t.body, lead), onDelete = { vm.deleteMyTemplate(t.id) }) { pick(t) } }
                TextButton(onClick = { text = "Hi ${first.ifBlank { "there" }}, "; picked = null }) { Text("Write a new message") }
            } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text!!, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 4)
                when {
                    picked != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${mediaIcon(picked?.type)} ${picked?.name ?: "Attachment"}", fontSize = 13.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = { picked = null }) { Text("Remove") }
                    }
                    ownMedia != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("📎 Photo/video from your phone", fontSize = 13.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = { ownMedia = null }) { Text("Remove") }
                    }
                    else -> Column {
                        TextButton(onClick = { showFiles = true }) { Text("📁 Company files (brochure, photos…)") }
                        TextButton(onClick = { chooseMedia.launch("*/*") }) { Text("📎 A file from my phone") }
                    }
                }
                if (saving) {
                    OutlinedTextField(saveName, { saveName = it }, label = { Text("Name for this message") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        // Save with a placeholder instead of this lead's name, so it fills in for every lead.
                        val cur = text.orEmpty()
                        val body = if (first.length >= 2) cur.replace(first, "{{leadName}}") else cur
                        vm.saveMyTemplate(saveName, body); saving = false
                    }) { Text("Save to My messages") }
                } else TextButton(onClick = { saving = true }) { Text("Save as my message for next time") }
            }
        },
        confirmButton = {
            if (text != null) Button(enabled = !sending, onClick = {
                val t = picked; val own = ownMedia; val msg = text ?: return@Button
                vm.logWaSend(lead, chosen)   // counted as an interaction on this lead
                when {
                    own != null -> { PhoneCalls.whatsappMedia(ctx, lead.phone, own, ctx.contentResolver.getType(own) ?: "*/*", msg); onDismiss() }
                    t != null -> { sending = true; scope.launch {
                        runCatching {
                            val f = com.closeros.app.data.Repo.templateMediaFile(ctx, t.path, t.name)
                            val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
                            PhoneCalls.whatsappMedia(ctx, lead.phone, uri, t.type ?: "*/*", msg)
                        }.onFailure { vm.message = "Couldn't get the attachment — check internet"; PhoneCalls.whatsapp(ctx, lead.phone, msg) }
                        sending = false; onDismiss()
                    } }
                    else -> { PhoneCalls.whatsapp(ctx, lead.phone, msg); onDismiss() }
                }
            }) { Text(if (sending) "Preparing…" else "Open WhatsApp") }
        },
        dismissButton = { TextButton(onClick = { if (text != null) { text = null; saving = false; picked = null; ownMedia = null } else onDismiss() }) { Text(if (text != null) "Back" else "Cancel") } })
    if (showFiles) CompanyFilesDialog(vm, onDismiss = { showFiles = false }) { f -> picked = CompanyMedia(f.path, f.mime_type, f.name); ownMedia = null; showFiles = false }
}

/** A company file to send on WhatsApp (stored on the server, downloaded when sending). */
data class CompanyMedia(val path: String, val type: String?, val name: String?)

/** The company's file library (uploaded by managers on the dashboard: Settings → Company files). */
@Composable
fun CompanyFilesDialog(vm: AppViewModel, onDismiss: () -> Unit, onPick: (com.closeros.app.data.CompanyFile) -> Unit) {
    var files by remember { mutableStateOf<List<com.closeros.app.data.CompanyFile>?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val org = vm.membership?.org_id ?: return@LaunchedEffect
        runCatching { com.closeros.app.data.Repo.companyFiles(org) }.onSuccess { files = it }.onFailure { failed = true; files = emptyList() }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Company files") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                when {
                    files == null -> Text("Loading…", color = Brand.muted)
                    failed -> Text("Couldn't load the files — check internet.", color = Brand.red)
                    files!!.isEmpty() -> Text("No company files yet. Your manager can add them on the dashboard: Settings → Company files for WhatsApp.", color = Brand.muted)
                }
                files.orEmpty().forEach { f ->
                    Row(Modifier.fillMaxWidth().clickable { onPick(f) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(mediaIcon(f.mime_type), fontSize = 20.sp); Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(f.name, fontWeight = FontWeight.SemiBold, maxLines = 2)
                            f.size_bytes?.let { b -> Text(if (b > 1_048_576) "%.1f MB".format(java.util.Locale.US, b / 1_048_576.0) else "${(b / 1024).coerceAtLeast(1)} KB", fontSize = 12.sp, color = Brand.muted) }
                        }
                    }
                }
            }
        },
        confirmButton = {}, dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } })
}

private fun mediaIcon(type: String?) = when { type == null -> "📎"; type.startsWith("image") -> "🖼️"; type.startsWith("video") -> "🎬"; type.contains("pdf") -> "📄"; else -> "📎" }

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
fun RecordingPlayer(callId: String, path: String?, status: String? = "uploaded") {
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var player by remember { mutableStateOf<android.media.MediaPlayer?>(null) }
    var state by remember { mutableStateOf("idle") } // idle, loading, playing, paused, error
    var errorText by remember { mutableStateOf("Couldn't play · Try again") }
    DisposableEffect(Unit) { onDispose { player?.release() } }
    // Where the recording is: on this phone (recordings folder), already downloaded, or only on the server.
    var where by remember(callId) { mutableStateOf<String?>(null) }   // phone | saved | server | gone
    LaunchedEffect(callId, path, status) {
        where = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            when {
                com.closeros.app.calls.LocalRecordings.uri(ctx, callId) != null -> "phone"
                path != null && java.io.File(java.io.File(ctx.cacheDir, "recordings"), path.substringAfterLast('/')).let { it.exists() && it.length() > 0 } -> "saved"
                path != null && status == "uploaded" -> "server"
                else -> "gone"
            }
        }
    }
    fun start(prepare: android.media.MediaPlayer.() -> Unit) {
        runCatching {
            player = android.media.MediaPlayer().apply {
                prepare()
                setOnPreparedListener { it.start(); state = "playing" }
                setOnCompletionListener { state = "paused"; it.seekTo(0) }
                setOnErrorListener { _, what, extra ->
                    com.closeros.app.data.AppLog.error(ctx, "play recording", null, message = "player error $what/$extra · $where")
                    state = "error"; true }
                prepareAsync()
            }
        }.onFailure { state = "error"; com.closeros.app.data.AppLog.error(ctx, "play recording", it) }
    }
    if (where == "gone") {
        Text("🎙 Recording deleted from this phone and the server", fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(horizontal = 8.dp))
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        when (state) {
            "loading" -> Text(if (where == "server") "Downloading…" else "Loading…", fontSize = 13.sp, color = Brand.muted)
            "error" -> TextButton(onClick = { player?.release(); player = null; state = "idle" }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(errorText, fontSize = 13.sp, color = Brand.red) }
            else -> TextButton(onClick = {
                val p = player
                when {
                    p != null && state == "playing" -> { p.pause(); state = "paused" }
                    p != null && state == "paused" -> { p.start(); state = "playing" }
                    else -> {
                        state = "loading"
                        scope.launch {
                            // 1) The phone's own recording file — no internet needed, nothing downloaded.
                            val local = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.closeros.app.calls.LocalRecordings.uri(ctx, callId) }
                            if (local != null) { runCatching { com.closeros.app.data.Repo.logRecordingPlay(callId) }; start { setDataSource(ctx, local) }; return@launch }
                            // 2) Not on the phone any more: download the copy kept on the server (if it hasn't been deleted there).
                            if (path == null) { state = "error"; errorText = "Not on this phone or the server"; return@launch }
                            runCatching { com.closeros.app.data.Repo.recordingFile(ctx.cacheDir, callId, path) }.onSuccess { file ->
                                where = "saved"; start { setDataSource(file.absolutePath) }
                            }.onFailure {
                                state = "error"
                                errorText = when {
                                    it.message?.contains("No internet") == true -> "No internet · Try again"
                                    it.message?.contains("not found", true) == true || it.message?.contains("404") == true -> "Deleted from the server"
                                    else -> "Couldn't download · Try again"
                                }
                                com.closeros.app.data.AppLog.error(ctx, "play recording", it)
                            }
                        }
                    }
                }
            }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(when (state) {
                    "playing" -> "❚❚ Pause"; "paused" -> "▶ Resume"
                    else -> when (where) { "server" -> "⬇ Download & play recording"; else -> "▶ Play recording" }
                }, fontSize = 13.sp, color = Brand.primary)
            }
        }
        if (where == "phone" && state == "idle") Text("on this phone", fontSize = 11.sp, color = Brand.muted)
    }
}

/** "5 calls · 3 conversations" — shown wherever a lead appears. Conversations = they really talked. */
fun callsLine(dials: Int, conversations: Int): String =
    if (dials == 0 && conversations == 0) "Not called yet" else "$dials call${if (dials == 1) "" else "s"} · $conversations conversation${if (conversations == 1) "" else "s"}"


/** Home: "⚡ New leads called in 6 min (median, 7 days) · target 15" and new leads waiting right now. */
@Composable
fun ResponseLine(vm: AppViewModel, r: kotlinx.serialization.json.JsonObject) {
    fun kotlinx.serialization.json.JsonElement?.num() = (this as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()
    val t = r["total"] as? kotlinx.serialization.json.JsonObject ?: return
    val arrived = t["arrived"].num()?.toInt() ?: 0
    if (arrived == 0) return
    val target = r["target_min"].num()?.toInt() ?: 15
    val median = t["median_min"].num()
    val within = t["within"].num()?.toInt() ?: 0; val responded = t["responded"].num()?.toInt() ?: 0
    val waiting = (r["waiting_list"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
    val oldest = ((r["waiting_list"] as? kotlinx.serialization.json.JsonArray)?.firstOrNull() as? kotlinx.serialization.json.JsonObject)?.get("wait_min").num()?.toInt()
    fun mins(m: Double) = if (m < 1) "under a minute" else if (m < 60) "${m.toInt()} min" else "${(m / 60).toInt()} h ${(m % 60).toInt()} min"
    val good = median != null && median <= target
    Column(Modifier.fillMaxWidth().background(if (waiting > 0) Color(0xFFFEF2F2) else if (good) Color(0xFFECFDF5) else Color(0xFFFFFBEB), RoundedCornerShape(10.dp))
        .clickable { vm.openFocusList() }.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (waiting > 0) Text("🆕 $waiting new lead${if (waiting > 1) "s" else ""} waiting" + (oldest?.let { " · oldest $it min" } ?: "") + " — call now ›",
            fontWeight = FontWeight.SemiBold, color = Color(0xFFB91C1C), fontSize = 14.sp)
        median?.let { m -> Text("⚡ New leads called in ${mins(m)} (median, 7 days) · target $target min · $within of $responded on time",
            fontSize = 13.sp, color = if (good) Color(0xFF047857) else Color(0xFF92400E)) }
    }
}
