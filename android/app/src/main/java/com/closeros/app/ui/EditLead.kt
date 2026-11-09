package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.AppEvents
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadIndex
import com.closeros.app.data.LocalDb
import com.closeros.app.data.Repo
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Edit a lead's details from the phone. Only changed fields are sent; works offline (sent later). */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EditLeadScreen(vm: AppViewModel, lead: Lead, onClose: () -> Unit, onSaved: (Lead) -> Unit) {
    BackHandler { onClose() }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(lead.name) }
    var phone by remember { mutableStateOf(lead.phone) }
    var email by remember { mutableStateOf(lead.email.orEmpty()) }
    var company by remember { mutableStateOf(lead.company.orEmpty()) }
    var profession by remember { mutableStateOf(lead.profession.orEmpty()) }
    var category by remember { mutableStateOf(lead.profession_category_id) }
    var city by remember { mutableStateOf(lead.city.orEmpty()) }
    var state by remember { mutableStateOf(lead.state.orEmpty()) }
    // Company's own fields: the facts the company asks for + anything already on this lead.
    val facts = vm.membership?.organization?.leadFacts.orEmpty()
    val oldCustom = lead.custom?.mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull.orEmpty() }.orEmpty()
    val customKeys = (facts.map { it.key } + oldCustom.keys).distinct()
    val custom = remember { mutableStateMapOf<String, String>().apply { customKeys.forEach { put(it, oldCustom[it].orEmpty()) } } }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun changes(): JsonObject = buildJsonObject {
        fun f(k: String, new: String, old: String?) { if (new.trim() != old.orEmpty().trim()) put(k, new.trim()) }
        f("name", name, lead.name); f("email", email, lead.email); f("company", company, lead.company)
        f("profession", profession, lead.profession); f("city", city, lead.city); f("state", state, lead.state)
        if (phone.filter { it.isDigit() } != lead.phone.filter { it.isDigit() }) put("phone", phone.trim())
        if (category != lead.profession_category_id) put("profession_category_id", category ?: "")
        val c = custom.filter { (k, v) -> v.trim() != oldCustom[k].orEmpty() }
        if (c.isNotEmpty()) put("custom", buildJsonObject { c.forEach { (k, v) -> if (v.isBlank()) put(k, JsonNull) else put(k, v.trim()) } })
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Edit lead") },
            navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } })
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            @Composable fun field(label: String, v: String, set: (String) -> Unit, type: KeyboardType = KeyboardType.Text, cap: KeyboardCapitalization = KeyboardCapitalization.Words) =
                OutlinedTextField(v, set, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = type, capitalization = cap))
            field("Name", name, { name = it })
            field("Phone number", phone, { phone = it }, KeyboardType.Phone, KeyboardCapitalization.None)
            if (phone.filter { it.isDigit() } != lead.phone.filter { it.isDigit() })
                Text("Changing the number: calls with the new number will show on this lead.", fontSize = 12.sp, color = Brand.muted)
            field("Email", email, { email = it }, KeyboardType.Email, KeyboardCapitalization.None)
            field("Company", company, { company = it })
            field("Profession", profession, { profession = it })
            if (vm.categories.isNotEmpty()) {
                Text("Profession group", fontSize = 13.sp, color = Brand.muted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    vm.categories.forEach { c -> FilterChip(category == c.id, { category = if (category == c.id) null else c.id }, { Text(c.name, fontSize = 13.sp) }) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) { field("City", city, { city = it }) }
                Box(Modifier.weight(1f)) { field("State", state, { state = it }) }
            }
            if (customKeys.isNotEmpty()) {
                Text("Other details", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp))
                customKeys.forEach { k ->
                    val fact = facts.firstOrNull { it.key == k }
                    val label = fact?.label?.ifBlank { null } ?: k.replace('_', ' ').replaceFirstChar { it.uppercase() }
                    if (fact != null) {
                        Text(label, fontSize = 13.sp, color = Brand.muted)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            fact.options.forEach { o -> FilterChip(custom[k] == o, { custom[k] = if (custom[k] == o) "" else o }, { Text(o, fontSize = 13.sp) }) }
                        }
                    } else field(label, custom[k].orEmpty(), { custom[k] = it })
                }
            }
            error?.let { Text(it, color = Brand.red, fontSize = 14.sp) }
            Button(enabled = !saving, modifier = Modifier.fillMaxWidth().height(52.dp).padding(top = 4.dp), onClick = {
                val ch = changes()
                if (ch.isEmpty()) { onClose(); return@Button }
                if (name.isBlank()) { error = "Name can't be empty"; return@Button }
                if (phone.filter { it.isDigit() }.length < 8) { error = "Enter a valid phone number"; return@Button }
                saving = true; error = null
                scope.launch {
                    runCatching { Repo.updateLeadDetails(lead.id, ch) }.onSuccess { sent ->
                        // Fresh copy from the server when online; else the edited copy, so the phone shows it at once.
                        val updated = (if (sent) runCatching { Repo.lead(lead.id) }.getOrNull() else null) ?: lead.copy(
                            name = name.trim(), phone = if (ch.containsKey("phone")) phone.trim() else lead.phone,
                            email = email.trim().ifBlank { null }, company = company.trim().ifBlank { null },
                            profession = profession.trim().ifBlank { null }, city = city.trim().ifBlank { null }, state = state.trim().ifBlank { null },
                            profession_category_id = category,
                            custom = JsonObject((lead.custom.orEmpty() + custom.filterValues { it.isNotBlank() }.mapValues { JsonPrimitive(it.value.trim()) })
                                .filterKeys { k -> custom[k]?.isNotBlank() != false }))
                        if (updated.phone != lead.phone) runCatching { LocalDb.get(ctx).putLeads(listOf(Triple(lead.phone, lead.id, null))) }
                        LeadIndex.remember(ctx, listOf(updated))
                        AppEvents.bumpLeads()
                        vm.message = if (sent) "Lead updated ✓" else "Saved on this phone — will update when online"
                        onSaved(updated)
                    }.onFailure {
                        saving = false
                        error = it.message?.substringAfter("ERROR:")?.substringBefore("\n")?.substringAfter(":")?.trim()?.take(140) ?: "Couldn't save"
                    }
                }
            }) { Text(if (saving) "Saving…" else "Save changes", fontSize = 16.sp) }
        }
    }
}
