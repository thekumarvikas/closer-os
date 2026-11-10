package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.Repo
import com.closeros.app.data.Template
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.n(k: String) = (this[k] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.i(k: String) = (this[k] as? JsonPrimitive)?.intOrNull ?: 0
private fun num(d: Double?) = d?.let { if (it % 1.0 == 0.0) it.toInt().toString() else "%.1f".format(java.util.Locale.US, it) } ?: "–"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Bar(title: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    TopAppBar(title = { Text(title, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }, actions = actions)
}

// ───────────── WhatsApp queue ─────────────

/** Pick the one message to send to everyone in the list. */
@Composable
fun WaChooseDialog(vm: AppViewModel) {
    val leads = vm.waChooseFor ?: return
    val company = vm.templates.filter { it.owner_id == null }
    val mine = vm.templates.filter { it.owner_id != null }
    val sample = leads.firstOrNull()
    AlertDialog(onDismissRequest = { vm.waChooseFor = null },
        title = { Text("WhatsApp ${leads.size} lead${if (leads.size > 1) "s" else ""}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Choose the message. Each lead's name and details are filled in.", fontSize = 13.sp, color = Brand.muted)
                if (vm.templates.isEmpty()) Text("No saved messages yet — add company messages on the dashboard (Settings).", color = Brand.muted)
                listOf("Company messages" to company, "My messages" to mine).forEach { (title, list) ->
                    if (list.isNotEmpty()) Text(title, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Brand.muted)
                    list.forEach { t ->
                        Column(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(10.dp))
                            .clickable { vm.waChooseFor = null; vm.startWaQueue(leads, t) }.padding(10.dp)) {
                            Text((if (t.media_path != null) "📎 " else "") + t.name, fontWeight = FontWeight.SemiBold)
                            Text(if (sample != null) vm.fillTemplate(t.body, sample) else t.body, fontSize = 12.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = {}, dismissButton = { TextButton(onClick = { vm.waChooseFor = null }) { Text("Cancel") } })
}

/** One lead at a time: WhatsApp opens with the message ready; back here it is marked sent and the next one opens. */
@Composable
fun WaQueueScreen(vm: AppViewModel) {
    BackHandler { vm.waPaused = true; vm.waCountdown = null }
    val l = vm.waQueue.getOrNull(vm.waPos)
    val t = vm.waTemplate
    LaunchedEffect(vm.waCountdown) {
        val c = vm.waCountdown ?: return@LaunchedEffect
        if (c <= 0) { vm.waOpenCurrent(); return@LaunchedEffect }
        delay(1000); if (vm.waCountdown == c) vm.waCountdown = c - 1
    }
    Column(Modifier.fillMaxSize().background(Brand.bg).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("WhatsApp queue", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = { vm.waStop() }) { Text("Stop") }
        }
        LinearProgressIndicator(progress = { vm.waPos.toFloat() / vm.waQueue.size.coerceAtLeast(1) }, Modifier.fillMaxWidth().height(6.dp))
        Text("${vm.waSent} sent · ${vm.waQueue.size - vm.waPos} to go · message: ${t?.name ?: ""}", fontSize = 13.sp, color = Brand.muted)
        if (l == null || t == null) { Text("Done.", fontSize = 18.sp); return@Column }
        Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${vm.waPos + 1} of ${vm.waQueue.size}", fontSize = 12.sp, color = Brand.muted)
                Text(l.name.ifBlank { fmtPhone(l.phone) }, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(listOfNotNull(fmtPhone(l.phone), l.profession, l.city).filter { it.isNotBlank() }.joinToString(" · "), color = Brand.muted, fontSize = 13.sp)
                Text(vm.fillTemplate(t.body, l), fontSize = 14.sp, modifier = Modifier.fillMaxWidth().background(Color(0xFFDCF8C6), RoundedCornerShape(10.dp)).padding(10.dp),
                    maxLines = 6, overflow = TextOverflow.Ellipsis)
                if (t.media_path != null) Text("📎 ${t.media_name ?: "Attachment"} is sent with it", fontSize = 12.sp, color = Brand.muted)
            }
        }
        if (vm.waAskSent) {
            Text("Did the message to ${l.name.ifBlank { fmtPhone(l.phone) }} go?", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.waConfirmSent(true) }, modifier = Modifier.weight(1f).height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A))) { Text("✓ Sent — next") }
                OutlinedButton(onClick = { vm.waConfirmSent(false) }, modifier = Modifier.weight(1f).height(52.dp)) { Text("✗ Not sent") }
            }
            return@Column
        }
        val cd = vm.waCountdown
        Button(onClick = { vm.waPaused = false; vm.waOpenCurrent() }, modifier = Modifier.fillMaxWidth().height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A))) {
            Icon(Icons.Default.Send, null); Spacer(Modifier.width(8.dp))
            Text(if (cd != null) "Opening WhatsApp in $cd…" else "Send on WhatsApp", fontSize = 17.sp)
        }
        Text("In WhatsApp tap Send, then come back and confirm — only messages you confirm are counted.", fontSize = 12.sp, color = Brand.muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { if (vm.waPaused) { vm.waPaused = false; vm.waCountdown = 3 } else { vm.waPaused = true; vm.waCountdown = null } }, modifier = Modifier.weight(1f)) {
                Text(if (vm.waPaused) "Resume" else "Pause") }
            OutlinedButton(onClick = { vm.waSkip() }, modifier = Modifier.weight(1f)) { Text("Skip") }
            if (vm.waCanUndo) OutlinedButton(onClick = { vm.waUndo() }, modifier = Modifier.weight(1f)) { Text("Undo last") }
        }
    }
}

// ───────────── Lists ─────────────

/** Any list of leads (report numbers, today's focus): call them or WhatsApp them in a queue. */
@Composable
fun LeadListScreen(vm: AppViewModel, onCall: (Lead) -> Unit) {
    val (title, leads) = vm.genericList ?: return
    BackHandler { vm.genericList = null }
    Scaffold(topBar = { Bar("$title (${leads.size})", { vm.genericList = null }) }, bottomBar = {
        if (leads.isNotEmpty()) Row(Modifier.fillMaxWidth().background(Color.White).padding(12.dp, 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { val l = leads; vm.genericList = null; vm.startQueue(l) }, modifier = Modifier.weight(1f).height(48.dp)) {
                Icon(Icons.Default.Call, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Call all") }
            OutlinedButton(onClick = { vm.waChooseFor = leads }, modifier = Modifier.weight(1f).height(48.dp)) {
                Icon(Icons.Default.Send, null, Modifier.size(18.dp), tint = Color(0xFF16A34A)); Spacer(Modifier.width(6.dp)); Text("WhatsApp all") }
        }
    }) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (leads.isEmpty()) item { Text("No leads here.", color = Brand.muted) }
            items(leads.distinctBy { it.id }, key = { it.id }) { l -> Box(Modifier.clickable { vm.openLeadId = l.id }) { LeadCard(vm, l, onCall) } }
        }
    }
}

/** WhatsApp messages sent from Closer OS today, newest first. */
@Composable
fun WaTodayScreen(vm: AppViewModel) {
    BackHandler { vm.showWaToday = false }
    LaunchedEffect(Unit) { vm.loadRound9() }
    val zone = java.time.ZoneId.systemDefault()
    val fmt = DateTimeFormatter.ofPattern("h:mm a")
    val calls = vm.today.count { it.log.direction == "outgoing" || it.log.direction == "incoming" }
    Scaffold(topBar = { Bar("Today's interactions", { vm.showWaToday = false }) }) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp, 8.dp)) {
            item {
                Text("${calls + vm.waToday.size} interactions = ${vm.today.count { it.log.direction == "outgoing" }} dialled + ${vm.today.count { it.log.direction == "incoming" }} received + ${vm.waToday.size} WhatsApp",
                    fontSize = 13.sp, color = Brand.muted, modifier = Modifier.padding(bottom = 8.dp))
                Text("WHATSAPP SENT", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = Brand.muted)
            }
            if (vm.waToday.isEmpty()) item { Text("No WhatsApp messages sent from Closer OS today.", color = Brand.muted, modifier = Modifier.padding(vertical = 8.dp)) }
            items(vm.waToday, key = { it.s("id") ?: it.hashCode().toString() }) { w ->
                Row(Modifier.fillMaxWidth().clickable(enabled = w.s("lead_id") != null) { vm.openLeadId = w.s("lead_id") }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("💬", fontSize = 18.sp, modifier = Modifier.width(30.dp))
                    Column(Modifier.weight(1f)) {
                        Text(w.s("name")?.ifBlank { null } ?: fmtPhone(w.s("phone") ?: ""), fontWeight = FontWeight.SemiBold)
                        Text("${w.s("template_name") ?: "Message"} · ${runCatching { fmt.format(com.closeros.app.data.parseInstant(w.s("sent_at")).atZone(zone)) }.getOrDefault("")}", fontSize = 12.sp, color = Brand.muted)
                    }
                }
                HorizontalDivider(color = Color(0xFFF1F5F9))
            }
            if (vm.waToday.any { it.s("lead_id") != null }) item {
                OutlinedButton(onClick = {
                    vm.genericList = null
                    val ids = vm.waToday.mapNotNull { it.s("lead_id") }.distinct()
                    vm.openLeadsById("Messaged today", ids)
                }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("Open these leads as a list") }
            }
        }
    }
}

// ───────────── Reports: lead work + what works ─────────────

private data class Period(val key: String, val label: String)
private val periods = listOf(Period("all", "All leads"), Period("today", "Assigned today"), Period("week", "This week"), Period("month", "This month"))
internal fun range(key: String): Pair<LocalDate?, LocalDate?> {
    val t = LocalDate.now()
    return when (key) { "today" -> t to t; "week" -> t.minusDays((t.dayOfWeek.value - 1).toLong()) to t; "month" -> t.withDayOfMonth(1) to t; else -> null to null }
}

@Composable
private fun WhoPicker(vm: AppViewModel, who: String, onWho: (String) -> Unit) {
    if (!vm.isManager) return
    var team by remember { mutableStateOf(emptyList<com.closeros.app.data.IdName>()) }
    LaunchedEffect(Unit) { team = runCatching { Repo.teamBrief(vm.membership!!.org_id) }.getOrDefault(emptyList()) }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        FilterChip(who == "all", { onWho("all") }, { Text("Everyone") })
        FilterChip(who == "me", { onWho("me") }, { Text("Me") })
        team.forEach { p -> FilterChip(who == p.id, { onWho(p.id) }, { Text(p.name.substringBefore(' ')) }) }
    }
}

/** Assigned → dialled → conversation, and how many dials it took. Every number opens its leads. */
@Composable
fun LeadWorkScreen(vm: AppViewModel) {
    BackHandler { vm.showLeadWork = false }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val m = vm.membership ?: return
    var period by remember { mutableStateOf("month") }
    var who by remember { mutableStateOf(if (vm.isManager) "all" else "me") }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
    val (from, to) = range(period)
    LaunchedEffect(period, who) {
        data = null; error = null
        runCatching {
            // My own leads: counted on the phone (works offline, no server work). Team: from the server.
            if (who == "me") kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                com.closeros.app.data.LocalReports.leadWork(ctx, com.closeros.app.data.Backend.uid, vm.outcomes, from, to,
                    runCatching { java.time.ZoneId.of(m.organization.timezone) }.getOrDefault(java.time.ZoneId.systemDefault()))
            } else Repo.leadWorkReport(m.org_id, users, from, to) as JsonObject
        }.onSuccess { data = it }.onFailure { error = it.message?.takeIf { m -> m.startsWith("No internet") } ?: "Couldn't load — check internet" }
    }
    val scope = rememberCoroutineScope()
    fun open(title: String, kind: String, attempts: Int? = null, user: String? = null) = scope.launch {
        runCatching { Repo.leadWorkList(m.org_id, users, from, to, kind, attempts, user) }
            .onSuccess { vm.genericList = title to it }.onFailure { vm.message = "Couldn't load the list" }
    }
    Scaffold(topBar = { Bar("Lead work", { vm.showLeadWork = false }) }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp, 0.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                periods.forEach { p -> FilterChip(period == p.key, { period = p.key }, { Text(p.label) }) }
            }
            WhoPicker(vm, who) { who = it }
            error?.let { Text(it, color = Brand.red) }
            val d = data ?: run { if (error == null) CircularProgressIndicator(); return@Column }
            val t = d["totals"] as? JsonObject ?: JsonObject(emptyMap())
            Text("Tap any number to see those leads", fontSize = 12.sp, color = Brand.muted)
            val top = listOf(Triple("Assigned", "assigned", t.i("assigned")), Triple("Dialled", "dialled", t.i("dialled")), Triple("Never dialled", "never", t.i("never")),
                Triple("Conversation", "conversation", t.i("conversation")), Triple("Not reached yet", "not_reached", t.i("not_reached")), Triple("Junk", "junk", t.i("junk")))
            top.chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.forEach { (label, kind, v) ->
                        Column(Modifier.weight(1f).background(Color.White, RoundedCornerShape(10.dp)).clickable { open(label, kind) }.padding(10.dp)) {
                            Text("$v", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = if (kind == "junk" || kind == "never") Color(0xFF92400E) else Color(0xFF0F172A))
                            Text(label, fontSize = 11.sp, color = Brand.muted, maxLines = 1)
                        }
                    }
                }
            }
            t.n("avg_dials_to_talk")?.let { Text("On average the first conversation came on dial ${num(it)}.", fontSize = 13.sp, color = Brand.primaryDark) }

            Text("How many dials it took", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
            Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                Column(Modifier.padding(8.dp)) {
                    Row { listOf("Dials" to 1.1f, "Leads" to 1f, "Talked on it" to 1.2f, "Talked" to 1f, "Not yet" to 1f, "Junk" to 0.9f).forEach { (h, w) ->
                        Text(h, Modifier.weight(w), fontSize = 11.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center) } }
                    (d["attempts"] as? JsonArray).orEmpty().map { it as JsonObject }.forEach { r ->
                        val n = r.i("n")
                        val label = when (n) { 0 -> "Not dialled"; 6 -> "6+ times"; 1 -> "1 time"; else -> "$n times" }
                        HorizontalDivider(color = Color(0xFFF1F5F9))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(label, Modifier.weight(1.1f).padding(vertical = 10.dp), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            listOf(Triple("all", r.i("leads"), 1f), Triple("talked_on", r.i("talked_on"), 1.2f), Triple("talked", r.i("talked"), 1f),
                                Triple("not_talked", r.i("not_talked"), 1f), Triple("junk", r.i("junk"), 0.9f)).forEach { (kind, v, w) ->
                                Text(if (n == 0 && kind in setOf("talked_on", "talked")) "–" else "$v", Modifier.weight(w).clickable(enabled = v > 0) {
                                    open("$label · " + when (kind) { "all" -> "all"; "talked_on" -> "talked on this dial"; "talked" -> "talked"; "not_talked" -> "not talked yet"; else -> "junk" }, kind, n)
                                }.padding(vertical = 10.dp), textAlign = TextAlign.Center, fontSize = 14.sp, color = if (v > 0) Brand.primary else Brand.muted,
                                    fontWeight = if (v > 0) FontWeight.SemiBold else FontWeight.Normal)
                            }
                        }
                    }
                }
            }
            val people = (d["people"] as? JsonArray).orEmpty().map { it as JsonObject }
            if (vm.isManager && people.size > 1) {
                Text("Per person", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
                Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                    Column(Modifier.padding(8.dp)) {
                        Row { listOf("Person" to 1.6f, "Assigned" to 1f, "Dialled" to 1f, "Talked" to 1f, "Junk" to 0.8f).forEach { (h, w) ->
                            Text(h, Modifier.weight(w), fontSize = 11.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center) } }
                        people.forEach { p ->
                            HorizontalDivider(color = Color(0xFFF1F5F9))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(p.s("name") ?: "", Modifier.weight(1.6f).padding(vertical = 10.dp), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                listOf(Triple("assigned", p.i("assigned"), 1f), Triple("dialled", p.i("dialled"), 1f), Triple("conversation", p.i("conversation"), 1f), Triple("junk", p.i("junk"), 0.8f)).forEach { (kind, v, w) ->
                                    Text("$v", Modifier.weight(w).clickable(enabled = v > 0) { open("${p.s("name")} · $kind", kind, null, p.s("user_id")) }.padding(vertical = 10.dp),
                                        textAlign = TextAlign.Center, color = Brand.primary, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** What it took to win my sales, vs the team — and every converted client with its own numbers. */
@Composable
fun RecipeScreen(vm: AppViewModel) {
    BackHandler { vm.showRecipe = false }
    val m = vm.membership ?: return
    var who by remember { mutableStateOf("me") }
    var period by remember { mutableStateOf("all") }
    var data by remember { mutableStateOf<JsonObject?>(null) }
    val users = when (who) { "all" -> null; "me" -> listOfNotNull(com.closeros.app.data.Backend.uid); else -> listOf(who) }
    val (from, to) = range(period)
    LaunchedEffect(who, period) { data = null; data = runCatching { Repo.salesRecipe(m.org_id, users, from, to) as JsonObject }.getOrNull() ?: JsonObject(emptyMap()) }
    Scaffold(topBar = { Bar(if (who == "me") "My sales insights" else "Sales insights", { vm.showRecipe = false }) }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp, 0.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("all" to "All time", "month" to "This month", "week" to "This week").forEach { (k, l) -> FilterChip(period == k, { period = k }, { Text(l) }) }
            }
            WhoPicker(vm, who) { who = it }
            val d = data ?: run { CircularProgressIndicator(); return@Column }
            val mine = d["mine"] as? JsonObject
            val team = d["team"] as? JsonObject
            if (mine == null && team == null) { Text("No sales yet in this period. Once leads are marked “Sale closed”, this shows what it took to win them.", color = Brand.muted); return@Column }
            Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("Average per sale", Modifier.weight(1.6f), fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text(if (who == "me") "Me" else "Selected", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted, textAlign = TextAlign.Center)
                        Text("Team", Modifier.weight(1f), fontSize = 12.sp, color = Brand.muted, textAlign = TextAlign.Center) }
                    listOf("Talk time (min)" to "talk_min", "Calls dialled" to "calls", "Picked up" to "picked", "WhatsApp sent" to "wa",
                        "Interactions" to "interactions", "Follow-ups made" to "follow_ups", "Days to close" to "days").forEach { (label, k) ->
                        HorizontalDivider(color = Color(0xFFF1F5F9))
                        Row { Text(label, Modifier.weight(1.6f), fontSize = 13.sp)
                            Text(num(mine?.n(k)), Modifier.weight(1f), fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                            Text(num(team?.n(k)), Modifier.weight(1f), color = Brand.muted, textAlign = TextAlign.Center) }
                    }
                    Text("Based on ${mine?.i("n") ?: 0} sale(s) · team ${team?.i("n") ?: 0}. A follow-up = a planned next call that was actually made.", fontSize = 11.sp, color = Brand.muted)
                }
            }
            mine?.let { r -> Text("💡 Your sales usually take about ${num(r.n("talk_min"))} min of talk over ${num(r.n("calls"))} calls and ${num(r.n("wa"))} WhatsApp messages. " +
                "Leads already close to that are marked 🔥 — call them first.", fontSize = 13.sp, color = Brand.primaryDark,
                modifier = Modifier.background(Brand.light, RoundedCornerShape(10.dp)).padding(10.dp)) }
            TextButton(onClick = { vm.openHotList() }) { Text("🔥 Show my leads close to converting ›") }
            val leads = (d["leads"] as? JsonArray).orEmpty().map { it as JsonObject }
            if (leads.isNotEmpty()) Text("Converted clients (${leads.size})", fontWeight = FontWeight.SemiBold)
            leads.forEach { l ->
                val e = l["effort"] as? JsonObject ?: JsonObject(emptyMap())
                Column(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).clickable { vm.openLeadId = l.s("id") }.padding(12.dp)) {
                    Text("💰 " + (l.s("name")?.ifBlank { null } ?: fmtPhone(l.s("phone") ?: "")), fontWeight = FontWeight.SemiBold)
                    Text(effortLine(e), fontSize = 12.sp, color = Brand.muted)
                }
            }
        }
    }
}

/** "Won in 9 days · 31 min talk · 5 calls (3 picked up) · 9 WhatsApp · 2 follow-ups" */
fun effortLine(e: JsonObject): String = listOfNotNull(
    e.n("days")?.let { "${if (e.s("won") == "true") "won in" else "for"} ${num(it)} days" },
    "${num(e.n("talk_min"))} min talk", "${e.i("calls")} calls (${e.i("picked")} picked up)",
    e.i("received").takeIf { it > 0 }?.let { "$it received" }, "${e.i("wa")} WhatsApp",
    e.i("follow_ups").takeIf { it > 0 }?.let { "$it follow-ups" },
    e.s("category"), e.n("watch_minutes")?.let { "webinar ${it.toInt()} min" },
).joinToString(" · ").replaceFirstChar { it.uppercase() }

/** On the lead page: effort so far (talk, calls, pick-ups, WhatsApp) and, once won, the path to the sale. */
@Composable
fun EffortCard(vm: AppViewModel, lead: Lead) {
    var path by remember(lead.id) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(lead.id) { path = runCatching { Repo.leadPath(lead.id) as JsonObject }.getOrNull() }
    val e = path?.get("effort") as? JsonObject
    val won = lead.won_at != null
    val interactions = lead.dial_count + (e?.i("received") ?: 0) + lead.wa_count
    Column(Modifier.fillMaxWidth().background(if (won) Color(0xFFECFDF5) else Color.White, RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(if (won) "💰 Path to sale" else "Effort so far", fontWeight = FontWeight.SemiBold)
        Text("$interactions interactions · ${fmtDur(lead.total_talk_sec)} talk · ${lead.call_count} calls (${lead.dial_count} dialled, ${lead.pickup_count} picked up) · ${lead.wa_count} WhatsApp",
            fontSize = 13.sp)
        if (e != null && won) Text(effortLine(e), fontSize = 12.sp, color = Brand.muted)
        // Neutral comparison with my usual sale (never a warning).
        val r = vm.recipe
        if (!won && r != null && (r.n("talk_min") ?: 0.0) > 0) {
            val tMin = r.n("talk_min") ?: 0.0; val c = r.n("calls") ?: 0.0
            Text("Your usual sale: ${num(tMin)} min talk · ${num(c)} calls", fontSize = 12.sp, color = Brand.muted)
            LinearProgressIndicator(progress = { ((lead.total_talk_sec / 60.0) / tMin).toFloat().coerceIn(0f, 1f) }, Modifier.fillMaxWidth().height(5.dp),
                color = Brand.primary, trackColor = Color(0xFFE2E8F0))
        }
        val msgs = (path?.get("messages") as? JsonArray).orEmpty().map { it as JsonObject }
        if (msgs.isNotEmpty()) Text("WhatsApp: " + msgs.take(3).joinToString(" · ") { "${it.s("template_name") ?: "message"} (${fmtWhen(it.s("sent_at") ?: "")})" } +
            if (msgs.size > 3) " · +${msgs.size - 3} more" else "", fontSize = 12.sp, color = Brand.muted)
    }
}

/** "Did these WhatsApp messages go?" — a message opened from Closer OS is counted only when the rep confirms it. */
@Composable
fun WaConfirmDialog(vm: AppViewModel) {
    val list = vm.waToConfirm
    if (list.isEmpty() || vm.waActive) return
    AlertDialog(onDismissRequest = {}, title = { Text("Did ${if (list.size == 1) "this WhatsApp message" else "these WhatsApp messages"} go?") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Only messages you confirm are counted.", fontSize = 12.sp, color = Brand.muted)
                list.forEach { w ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(w.name.ifBlank { fmtPhone(w.phone) }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(w.templateName ?: "Message", fontSize = 12.sp, color = Brand.muted, maxLines = 1)
                        }
                        TextButton(onClick = { vm.confirmWa(w, true) }) { Text("✓ Sent", color = Color(0xFF16A34A), fontWeight = FontWeight.Bold) }
                        TextButton(onClick = { vm.confirmWa(w, false) }) { Text("✗ No", color = Brand.red) }
                    }
                }
            }
        },
        confirmButton = { if (list.size > 1) Button(onClick = { list.forEach { vm.confirmWa(it, true) } }) { Text("All sent") } },
        dismissButton = {})
}
