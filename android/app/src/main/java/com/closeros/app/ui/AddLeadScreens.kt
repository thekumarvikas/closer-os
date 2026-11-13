package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.LeadFields
import com.closeros.app.data.LeadImport

/** "+ Add lead": one lead, a CSV / Excel file, or phone contacts. */
@Composable
fun AddMenuDialog(vm: AppViewModel) {
    if (!vm.showAddMenu) return
    val ctx = LocalContext.current
    val free = com.closeros.app.data.Unlocks.adsOn(ctx)
    AlertDialog(onDismissRequest = { vm.showAddMenu = false }, title = { Text("Add leads") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            @Composable fun Option(icon: String, title: String, sub: String, onClick: () -> Unit) {
                Row(Modifier.fillMaxWidth().border(1.dp, Color(0xFFE2E8F0), RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(icon, fontSize = 24.sp); Spacer(Modifier.width(12.dp))
                    Column { Text(title, fontWeight = FontWeight.SemiBold); Text(sub, fontSize = 12.sp, color = Brand.muted) }
                }
            }
            Option("✍️", "Add one lead", "Name, number, profession, city") { vm.showAddMenu = false; vm.showAddLead = true }
            Option("📄", "Import from a file", "CSV or Excel (.xlsx)" + if (free) " · free plan: 50 per file" else "") {
                vm.showAddMenu = false; vm.importData = null; vm.importResult = null; vm.showImport = true }
            Option("👥", "Pick from phone contacts", "Tick several contacts at once") { vm.showAddMenu = false; vm.showContactsPick = true }
        } },
        confirmButton = {}, dismissButton = { TextButton(onClick = { vm.showAddMenu = false }) { Text("Close") } })
}

/** Event / webinar the new leads join (optional). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EventChoice(vm: AppViewModel, value: String?, onChange: (String?) -> Unit) {
    LaunchedEffect(Unit) { if (vm.batches == null) vm.loadBatches(quiet = true) }
    val events = vm.batches.orEmpty()
    if (events.isEmpty()) return
    Text(if (vm.isSolo) "Add to an event (optional)" else "Add to a webinar / event (optional)", fontSize = 13.sp, color = Brand.muted)
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        events.take(15).forEach { e -> FilterChip(selected = value == e.id, onClick = { onChange(if (value == e.id) null else e.id) }, label = { Text(e.name, maxLines = 1) }) }
    }
}

/** One lead: Name, Number, Profession, City (+ more). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AddLeadDialog(vm: AppViewModel) {
    if (!vm.showAddLead) return
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var profession by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var company by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(false) }
    var event by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Cities already used, most common first (one tap instead of typing).
    val cities = remember(vm.leads.size) { vm.leads.mapNotNull { it.city?.trim()?.ifBlank { null } }.groupingBy { it }.eachCount().entries.sortedByDescending { it.value }.map { it.key } }
    val citySuggest = cities.filter { city.isBlank() || (it.startsWith(city, true) && !it.equals(city, true)) }.take(6)
    AlertDialog(onDismissRequest = { if (!busy) vm.showAddLead = false }, title = { Text("Add a lead") },
        text = { Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(phone, { phone = it }, label = { Text("Phone number") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
            OutlinedTextField(profession, { profession = it }, label = { Text("Profession") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(city, { city = it }, label = { Text("City / location") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (citySuggest.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                citySuggest.forEach { c -> SuggestionChip(onClick = { city = c }, label = { Text(c) }) }
            }
            if (!more) TextButton(onClick = { more = true }) { Text("+ Email, company, notes") }
            else {
                OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(company, { company = it }, label = { Text("Company") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
            EventChoice(vm, event) { event = it }
            error?.let { Text(it, color = Brand.red, fontSize = 13.sp) }
        } },
        confirmButton = { Button(enabled = !busy && phone.count { it.isDigit() } >= 6, onClick = {
            busy = true; error = null
            vm.addLeadManual(mapOf("name" to name, "phone" to phone, "profession" to profession, "city" to city, "email" to email,
                "company" to company, "notes" to notes), event) { e -> busy = false; error = e }
        }) { Text(if (busy) "Adding…" else "Add lead") } },
        dismissButton = { TextButton(onClick = { vm.showAddLead = false }) { Text("Cancel") } })
}

/** Import from a CSV / Excel file: choose the file, check the columns, import. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportScreen(vm: AppViewModel) {
    BackHandler { vm.showImport = false; vm.importData = null; vm.importResult = null }
    val ctx = LocalContext.current
    val d = vm.importData
    var event by remember { mutableStateOf<String?>(null) }
    val free = com.closeros.app.data.Unlocks.adsOn(ctx)
    Scaffold(topBar = {
        TopAppBar(title = { Text("Import leads") },
            navigationIcon = { IconButton(onClick = { vm.showImport = false; vm.importData = null; vm.importResult = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            vm.importResult?.let { r ->
                Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFECFDF5))) {
                    Column(Modifier.padding(14.dp)) {
                        Text("✓ ${r.inserted} new lead${if (r.inserted == 1) "" else "s"} added", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = Brand.green)
                        if (r.already > 0) Text("${r.already} were already in your leads (not added twice)" + if (r.joined > 0) " · ${r.joined} joined the event" else "")
                        if (r.invalid > 0) Text("${r.invalid} rows had no valid phone number", color = Brand.muted)
                        Button(onClick = { vm.showImport = false; vm.importData = null; vm.importResult = null; vm.tab = Tab.Leads }, modifier = Modifier.padding(top = 8.dp)) { Text("See my leads") }
                    }
                }
            }
            if (d == null) {
                Text("Choose a CSV or Excel (.xlsx) file on this phone. The first row should be the headings (Name, Phone, City…).", color = Brand.muted)
                if (free) Text("Free plan: up to 50 leads per file, after a short ad. Closer OS Pro: no limit.", fontSize = 13.sp, color = Brand.muted)
                Button(onClick = { pickFile(ctx, vm, "import") }, enabled = vm.importBusy == null, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                    Text(vm.importBusy ?: "📄 Choose file")
                }
                Text("Tip: from Google Sheets use File → Download → CSV, then pick it from Downloads.", fontSize = 12.sp, color = Brand.muted)
                return@Column
            }
            val phoneCol = vm.importMap.indexOf("phone")
            val count = if (phoneCol < 0) 0 else d.rows.count { r -> r.getOrNull(phoneCol).orEmpty().any(Char::isDigit) }
            Text("${d.rows.size} rows found. Check which column is which:", fontWeight = FontWeight.SemiBold)
            d.headers.forEachIndexed { i, h ->
                var open by remember { mutableStateOf(false) }
                val sample = d.rows.asSequence().map { it.getOrNull(i).orEmpty() }.firstOrNull { it.isNotBlank() }.orEmpty()
                Row(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(h, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sample.ifBlank { "(empty)" }, fontSize = 12.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box {
                        val field = vm.importMap.getOrElse(i) { "" }
                        OutlinedButton(onClick = { open = true }) { Text(LeadFields.all.first { it.first == field }.second, fontSize = 13.sp) }
                        DropdownMenu(open, { open = false }) {
                            LeadFields.all.forEach { (k, l) -> DropdownMenuItem(text = { Text(l) }, onClick = {
                                open = false
                                vm.importMap = vm.importMap.mapIndexed { j, f -> if (j == i) k else if (k.isNotEmpty() && f == k) "" else f }
                            }) }
                        }
                    }
                }
            }
            EventChoice(vm, event) { event = it }
            if (phoneCol < 0) Text("Choose the column with the phone number.", color = Brand.red)
            if (free && count > vm.importLimit) Text("Free plan: the first ${vm.importLimit} of $count leads will be added. Closer OS Pro adds all.", fontSize = 13.sp, color = Color(0xFF92400E))
            Button(onClick = { vm.runImport(event) }, enabled = phoneCol >= 0 && count > 0 && vm.importBusy == null, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text(vm.importBusy ?: "Import ${minOf(count, vm.importLimit)} lead${if (count == 1) "" else "s"}")
            }
            Text("Numbers already in your leads are not added twice.", fontSize = 12.sp, color = Brand.muted)
            TextButton(onClick = { vm.importData = null }) { Text("Choose another file") }
        }
    }
}

/** Pick several phone contacts and add them as leads. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsPickScreen(vm: AppViewModel) {
    BackHandler { vm.showContactsPick = false }
    val ctx = LocalContext.current
    var allowed by remember { mutableStateOf(PhoneCalls.has(ctx, android.Manifest.permission.READ_CONTACTS)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    var all by remember { mutableStateOf<List<Pair<String, String>>?>(null) }
    LaunchedEffect(allowed) { if (allowed) all = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { LeadImport.contacts(ctx) } }
    var q by remember { mutableStateOf("") }
    val picked = remember { mutableStateMapOf<String, Pair<String, String>>() }
    var event by remember { mutableStateOf<String?>(null) }
    Scaffold(topBar = {
        TopAppBar(title = { Text("Pick contacts") },
            navigationIcon = { IconButton(onClick = { vm.showContactsPick = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }, bottomBar = {
        if (picked.isNotEmpty()) Column(Modifier.background(Color.White).padding(12.dp)) {
            EventChoice(vm, event) { event = it }
            Button(onClick = { vm.importContacts(picked.values.toList(), event) }, enabled = vm.importBusy == null, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Text(vm.importBusy ?: "Add ${minOf(picked.size, vm.importLimit)} as leads")
            }
            if (picked.size > vm.importLimit) Text("Free plan: the first ${vm.importLimit} are added.", fontSize = 12.sp, color = Brand.muted)
        }
    }) { pad ->
        if (!allowed) {
            Column(Modifier.padding(pad).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Closer OS needs to read your contacts to show them here. Nothing is uploaded until you pick contacts.")
                Button(onClick = { ask.launch(android.Manifest.permission.READ_CONTACTS) }) { Text("Allow contacts") }
            }
            return@Scaffold
        }
        val list = all
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            item { OutlinedTextField(q, { q = it }, placeholder = { Text("Search name or number") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
            if (list == null) { item { CircularProgressIndicator() }; return@LazyColumn }
            val shown = list.filter { q.isBlank() || it.first.contains(q, true) || it.second.filter(Char::isDigit).contains(q.filter(Char::isDigit).ifBlank { "§" }) }
            item { Text("${shown.size} contacts · ${picked.size} picked", fontSize = 12.sp, color = Brand.muted) }
            items(shown.take(1500), key = { it.second }) { c ->
                val on = picked.containsKey(c.second)
                Row(Modifier.fillMaxWidth().background(if (on) Brand.light else Color.White, RoundedCornerShape(8.dp))
                    .clickable { if (on) picked.remove(c.second) else picked[c.second] = c }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(on, { if (it) picked[c.second] = c else picked.remove(c.second) })
                    Column { Text(c.first.ifBlank { c.second }, fontWeight = FontWeight.SemiBold); Text(c.second, fontSize = 12.sp, color = Brand.muted) }
                }
            }
        }
    }
}
