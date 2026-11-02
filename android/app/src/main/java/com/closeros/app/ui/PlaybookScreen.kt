package com.closeros.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.PlaybookItem
import com.closeros.app.data.Repo
import kotlinx.coroutines.launch

private val kinds = listOf("script" to "Scripts", "objection" to "Objections", "link" to "Links", "doc" to "Documents")

/** The company's scripts, objection answers, links and documents. Opened for a lead, the text is personalised. */
@Composable
fun PlaybookScreen(vm: AppViewModel) {
    BackHandler { vm.showPlaybook = false }
    val ctx = LocalContext.current
    val lead = vm.playbookLead
    var kind by remember { mutableStateOf("script") }
    var q by remember { mutableStateOf("") }
    var open by remember { mutableStateOf<String?>(null) }
    var suggesting by remember { mutableStateOf(false) }
    val all = vm.playbook
    fun fill(t: String) = if (lead != null) vm.fillTemplate(t, lead) else t

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showPlaybook = false }) { Icon(Icons.Default.ArrowBack, "Back") }
            Column(Modifier.weight(1f)) {
                Text("Playbook", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                lead?.let { Text("For ${it.name.ifBlank { fmtPhone(it.phone) }}", fontSize = 13.sp, color = Brand.muted) }
            }
            TextButton(onClick = { suggesting = true }) { Text("Suggest") }
        }
        OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Search, e.g. price, EMI, link") }, leadingIcon = { Icon(Icons.Default.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp, 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            kinds.forEach { (k, l) -> FilterChip(selected = kind == k && q.isBlank(), onClick = { kind = k; q = "" }, label = { Text("$l (${all?.count { it.kind == k && it.status == "published" } ?: 0})") }) }
        }
        if (all == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }
        val shown = all.filter { it.status == "published" || it.created_by == com.closeros.app.data.Backend.uid }
            .filter { if (q.isBlank()) it.kind == kind else listOfNotNull(it.title, it.body, it.section, it.url).any { s -> s.contains(q.trim(), true) } }
        LazyColumn(contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (shown.isEmpty()) item { Text(if (q.isBlank()) "Nothing here yet. Your manager adds these on the dashboard (Playbook)." else "Nothing matches “$q”.", color = Brand.muted) }
            var lastSection: String? = "\u0000"
            shown.forEach { item ->
                if (q.isBlank() && item.section != lastSection) { lastSection = item.section; item.section?.takeIf { it.isNotBlank() }?.let { s -> item(key = "s-$s-${item.id}") { Text(s.uppercase(), fontSize = 12.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold) } } }
                item(key = item.id) {
                    PlaybookCard(item, open == item.id, { open = if (open == item.id) null else item.id }, ::fill, onWhatsApp = lead?.let { l -> { text: String -> PhoneCalls.whatsapp(ctx, l.phone, text) } })
                }
            }
        }
    }
    if (suggesting) SuggestDialog(vm) { suggesting = false }
}

@Composable
private fun PlaybookCard(item: PlaybookItem, expanded: Boolean, toggle: () -> Unit, fill: (String) -> String, onWhatsApp: ((String) -> Unit)?) {
    val ctx = LocalContext.current
    val body = item.body?.let(fill)
    Card(Modifier.fillMaxWidth().clickable(onClick = toggle), colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (item.status == "pending") Text("Waiting for approval", fontSize = 11.sp, color = Color(0xFFB45309))
                if (item.status == "rejected") Text("Not approved", fontSize = 11.sp, color = Brand.red)
            }
            if (body != null) Text(body, fontSize = 15.sp, maxLines = if (expanded) Int.MAX_VALUE else 3, lineHeight = 22.sp)
            item.url?.let { Text(it, fontSize = 13.sp, color = Brand.primary, maxLines = 1) }
            item.review_note?.let { Text("Manager: $it", fontSize = 12.sp, color = Brand.red) }
            if (expanded) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val share = listOfNotNull(body, item.url).joinToString("\n")
                if (item.url != null) OutlinedButton(onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }) { Text("Open") }
                OutlinedButton(onClick = {
                    ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Closer OS", share))
                    android.widget.Toast.makeText(ctx, "Copied", android.widget.Toast.LENGTH_SHORT).show()
                }) { Text("Copy") }
                if (onWhatsApp != null && (item.kind == "link" || item.kind == "doc")) Button(onClick = { onWhatsApp(share) }) { Text("Send on WhatsApp") }
            }
        }
    }
}

@Composable
private fun SuggestDialog(vm: AppViewModel, onClose: () -> Unit) {
    var kind by remember { mutableStateOf("objection") }
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = onClose, title = { Text("Suggest for the playbook") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    kinds.forEach { (k, l) -> FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(l) }) }
                }
                OutlinedTextField(title, { title = it }, label = { Text(if (kind == "objection") "What the lead says" else "Title") }, singleLine = true)
                OutlinedTextField(body, { body = it }, label = { Text(if (kind == "objection") "How to answer" else "Text") }, minLines = 3,
                    trailingIcon = { VoiceButton { s -> body = if (body.isBlank()) s else "$body $s" } })
                if (kind == "link" || kind == "doc") OutlinedTextField(url, { url = it }, label = { Text("Link (https://…)") }, singleLine = true)
                Text("Your manager approves it before the team sees it.", fontSize = 12.sp, color = Brand.muted)
            }
        },
        confirmButton = {
            Button(enabled = title.isNotBlank() && (body.isNotBlank() || url.isNotBlank()), onClick = {
                val m = vm.membership ?: return@Button
                scope.launch {
                    runCatching { Repo.suggestPlaybook(m.org_id, kind, title.trim(), body.trim(), url.trim().ifBlank { null }) }
                        .onSuccess { vm.message = "Sent to your manager for approval"; vm.loadPlaybook(); onClose() }
                        .onFailure { vm.message = "Couldn't send: ${it.message?.take(60)}" }
                }
            }) { Text("Send") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}
