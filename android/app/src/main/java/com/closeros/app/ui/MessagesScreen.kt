package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Backend
import com.closeros.app.data.Template
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Settings → My WhatsApp messages: add, edit and delete saved messages, with fill-ins and a file. */
@Composable
fun MessagesScreen(vm: AppViewModel) {
    BackHandler { if (vm.tplEdit != null) vm.tplEdit = null else vm.showMessages = false }
    LaunchedEffect(Unit) { vm.reloadTemplates() }
    val uid = Backend.uid
    // Company messages: managers (and the owner of a personal account) can edit them; reps only use them.
    val canCompany = vm.isSolo || vm.isManager
    val company = if (vm.isSolo) emptyList() else vm.templates.filter { it.owner_id == null }
    val mine = if (vm.isSolo) vm.templates else vm.templates.filter { it.owner_id != null }
    var deleting by remember { mutableStateOf<Template?>(null) }
    fun edit(t: Template?) {
        vm.tplEdit = AppViewModel.TplEdit(t?.id, company = t != null && t.owner_id == null, name = t?.name.orEmpty(),
            body = t?.body ?: "Hi {{leadName}}, ", media = t?.media_path?.let { Triple(it, t.media_type.orEmpty(), t.media_name.orEmpty()) })
    }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showMessages = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("My WhatsApp messages", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        LazyColumn(contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Button(onClick = { edit(null) }, modifier = Modifier.fillMaxWidth()) { Text("+ New message") }
                Text("Fill-ins like First name and Webinar date are filled in for each lead when you send. A message can carry a photo, video, PDF or Excel file.",
                    fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(top = 6.dp))
            }
            if (company.isNotEmpty()) {
                item { Text("Company messages" + if (canCompany) "" else " · set by your manager", fontWeight = FontWeight.SemiBold, color = Brand.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                items(company, key = { it.id }) { t -> MessageCard(t, canEdit = canCompany, onEdit = { edit(t) }, onDelete = { deleting = t }) }
            }
            item { Text("My messages", fontWeight = FontWeight.SemiBold, color = Brand.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
            if (mine.isEmpty()) item { Text("None yet. Tap \"+ New message\", or \"Save this message for next time\" when you send one.", color = Brand.muted, fontSize = 14.sp) }
            items(mine, key = { it.id }) { t -> MessageCard(t, canEdit = t.owner_id == uid || canCompany, onEdit = { edit(t) }, onDelete = { deleting = t }) }
            if (vm.isSolo) item { BusinessNameCard(vm) }
        }
    }
    vm.tplEdit?.let { MessageEditor(vm, it) }
    deleting?.let { t ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete \"${t.name}\"?") },
            text = { Text("It's removed from your list. Messages already sent are not affected.") },
            confirmButton = { TextButton(onClick = { vm.deleteMyTemplate(t.id); deleting = null }) { Text("Delete", color = Brand.red) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } })
    }
}

@Composable
private fun MessageCard(t: Template, canEdit: Boolean, onEdit: () -> Unit, onDelete: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(t.name, fontWeight = FontWeight.SemiBold)
            Text(t.body, fontSize = 13.sp, color = Brand.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
            t.media_path?.let { Text("${mediaIcon(t.media_type)} ${t.media_name ?: "Attached file"}", fontSize = 12.sp, color = Brand.primaryDark) }
            if (canEdit) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onEdit, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("✏️ Edit") }
                TextButton(onClick = onDelete, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Delete", color = Brand.red) }
            }
        }
    }
}

/** Add / edit one message: name, text with fill-in chips, and an optional file. */
@Composable
private fun MessageEditor(vm: AppViewModel, e: AppViewModel.TplEdit) {
    val ctx = LocalContext.current
    val main = remember(ctx) { generateSequence(ctx) { (it as? android.content.ContextWrapper)?.baseContext }.firstOrNull { it is com.closeros.app.MainActivity } as? com.closeros.app.MainActivity }
    AlertDialog(onDismissRequest = { if (!e.busy) vm.tplEdit = null },
        title = { Text(if (e.id == null) "New message" else "Edit message") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(e.name, { e.name = it }, label = { Text("Name (only you see it)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                MessageField(e.body, { e.body = it }, "Message", minLines = 4)
                val fileName = e.own?.name ?: e.media?.third?.ifBlank { "Attached file" }
                val fileType = e.own?.type ?: e.media?.second
                if (fileName != null) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${mediaIcon(fileType)} $fileName", fontSize = 13.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = { e.own = null; e.media = null }) { Text("Remove") }
                } else TextButton(onClick = {
                    vm.beforeFilePick("tpl")
                    if (main != null) runCatching { main.pickFile.launch("*/*") } else vm.message = "Open this from Closer OS"
                }) { Text("📎 Attach a file — photo, video, PDF, Excel…") }
            }
        },
        confirmButton = { Button(enabled = !e.busy && e.body.isNotBlank(), onClick = { vm.saveTplEdit() }) { Text(if (e.busy) "Saving…" else "Save") } },
        dismissButton = { TextButton(enabled = !e.busy, onClick = { vm.tplEdit = null }) { Text("Cancel") } })
}

/** Personal account: what {{companyName}} becomes. Optional — left empty, that part of a message is simply left out. */
@Composable
private fun BusinessNameCard(vm: AppViewModel) {
    val current = fillCompanyName(vm.membership?.organization)
    var name by remember(current) { mutableStateOf(current) }
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), modifier = Modifier.padding(top = 12.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Your business name (optional)", fontWeight = FontWeight.SemiBold)
            Text("Used where a message says \"Company\". Leave it empty and that part is left out.", fontSize = 13.sp, color = Brand.muted)
            OutlinedTextField(name, { name = it }, singleLine = true, placeholder = { Text("e.g. Skills Age") }, modifier = Modifier.fillMaxWidth())
            if (name.trim() != current) Button(onClick = { vm.saveOrgSettings(buildJsonObject { put("business_name", name.trim()) }) }) { Text("Save") }
        }
    }
}
