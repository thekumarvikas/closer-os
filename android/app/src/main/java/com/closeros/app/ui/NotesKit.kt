package com.closeros.app.ui

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.NoteEntry
import com.closeros.app.data.Repo
import kotlinx.coroutines.launch

/** Mic button: speak and the words are added to the note (English / Hindi as the phone supports). */
@Composable
fun VoiceButton(onText: (String) -> Unit) {
    val ctx = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK) r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let(onText)
    }
    IconButton(onClick = {
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your note")
        runCatching { launcher.launch(i) }.onFailure { android.widget.Toast.makeText(ctx, "Voice typing isn't available on this phone", android.widget.Toast.LENGTH_SHORT).show() }
    }) { Text("🎤", fontSize = 20.sp) }
}

/** Note box with voice typing and one-tap tags. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NoteEditor(text: String, onText: (String) -> Unit, tags: List<String>, onTags: (List<String>) -> Unit, allTags: List<String>, label: String = "Notes",
               groups: List<com.closeros.app.data.TagGroup> = emptyList()) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(text, onText, label = { Text(label) }, modifier = Modifier.fillMaxWidth(), minLines = 2,
            trailingIcon = { VoiceButton { spoken -> onText(if (text.isBlank()) spoken else "$text $spoken") } })
        // Company tag groups (e.g. Objection · Interest · Status), each in its own colour.
        groups.forEach { g ->
            val c = runCatching { Color(android.graphics.Color.parseColor(g.color)) }.getOrDefault(Brand.primaryDark)
            Text(g.name, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Brand.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                g.tags.forEach { t ->
                    val on = t in tags
                    Text((if (on) "✓ " else "") + t, fontSize = 13.sp, color = if (on) Color.White else c,
                        modifier = Modifier.background(if (on) c else c.copy(alpha = 0.1f), RoundedCornerShape(50))
                            .clickable { onTags(if (on) tags - t else tags + t) }.padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
        if (allTags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            allTags.forEach { t ->
                val on = t in tags
                Text((if (on) "✓ " else "+ ") + t, fontSize = 13.sp, color = if (on) Color.White else Color(0xFF334155),
                    modifier = Modifier.background(if (on) Brand.primaryDark else Color(0xFFF1F5F9), RoundedCornerShape(50))
                        .clickable { onTags(if (on) tags - t else tags + t) }.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
    }
}

/** The lead's key facts: the few things every caller must know, always at the top. */
@Composable
fun KeyFactsCard(lead: Lead, onSaved: (String) -> Unit) {
    var editing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var text by remember(lead.id, lead.key_facts) { mutableStateOf(lead.key_facts.orEmpty()) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFFFFBEB)), modifier = Modifier.border(1.dp, Color(0xFFFDE68A), RoundedCornerShape(12.dp))) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("📌 Key facts", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (!editing) IconButton(onClick = { editing = true }, modifier = Modifier.size(32.dp)) { Icon(Icons.Default.Edit, "Edit", Modifier.size(18.dp)) }
            }
            if (editing) {
                OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 3,
                    placeholder = { Text("e.g. Owns 2 clothing shops · wife decides · wants EMI · call after 7 PM") },
                    trailingIcon = { VoiceButton { s -> text = if (text.isBlank()) s else "$text · $s" } })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !saving, onClick = {
                        saving = true
                        scope.launch {
                            runCatching { Repo.setKeyFacts(lead.id, text) }
                                .onSuccess { editing = false; onSaved(text) }
                                .onFailure { android.widget.Toast.makeText(ctx, "Couldn't save — check internet", android.widget.Toast.LENGTH_SHORT).show() }
                            saving = false
                        }
                    }) { Text(if (saving) "Saving…" else "Save") }
                    TextButton(onClick = { editing = false; text = lead.key_facts.orEmpty() }) { Text("Cancel") }
                }
            } else Text(lead.key_facts?.ifBlank { null } ?: "Nothing yet. Add what matters most: who decides, budget, objections, best time to call.",
                fontSize = 14.sp, color = if (lead.key_facts.isNullOrBlank()) Brand.muted else Color(0xFF1E293B))
        }
    }
}

/** Every note on a lead, newest first, plus "Add note" without making a call. */
@Composable
fun NotesTimeline(vm: AppViewModel, leadId: String, lead: Lead? = null) {
    var notes by remember { mutableStateOf<List<NoteEntry>?>(null) }
    var adding by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(leadId, reload) { notes = runCatching { Repo.leadNotes(leadId) }.getOrDefault(emptyList()) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Notes", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            TextButton(onClick = { adding = true }) { Icon(Icons.Default.Add, null, Modifier.size(18.dp)); Text("Add note") }
        }
        val list = notes
        if (list == null) Text("Loading…", color = Brand.muted, fontSize = 13.sp)
        else if (list.isEmpty()) Text("No notes yet.", color = Brand.muted, fontSize = 13.sp)
        list?.forEach { n ->
            Column(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(listOfNotNull(fmtWhen(n.at), n.by,
                    if (n.kind == "call") listOfNotNull(
                        when (n.direction) { "incoming" -> "Received call"; "outgoing" -> "Dialled"; else -> "Call" },
                        n.duration_sec?.takeIf { it > 0 }?.let { fmtDur(it) }, n.outcome, if (n.purpose == "reminder") "reminder" else null).joinToString(" · ")
                    else "Note").joinToString(" · "), fontSize = 12.sp, color = Brand.muted)
                n.text?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 14.sp) }
                if (n.tags.isNotEmpty()) Text(n.tags.joinToString("  ") { "#$it" }, fontSize = 12.sp, color = Brand.primaryDark)
                n.objections?.takeIf { it.isNotEmpty() }?.let { o -> Text("⚠ Objection: " + o.joinToString(", ") { it.trim('"', '“', '”') }, fontSize = 12.sp, color = Color(0xFF9A3412)) }
                // Pin an important note to the top of the lead (max 3).
                if (lead != null && n.id != null && !n.text.isNullOrBlank()) {
                    val pinned = lead.pinned.any { it.ref == n.id }
                    Text(if (pinned) "📌 Pinned · unpin" else "📌 Pin", fontSize = 12.sp, color = Brand.primary,
                        modifier = Modifier.clickable { vm.pinNote(lead, n.id, n.text, !pinned) }.padding(vertical = 2.dp))
                }
            }
        }
    }
    if (adding) {
        var text by remember { mutableStateOf("") }
        var tags by remember { mutableStateOf(emptyList<String>()) }
        var saving by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        AlertDialog(onDismissRequest = { adding = false }, title = { Text("Add note") },
            text = { NoteEditor(text, { text = it }, tags, { tags = it }, emptyList(), "Note", groups = vm.membership?.organization?.tagGroups.orEmpty()) },
            confirmButton = {
                Button(onClick = {
                    saving = true
                    scope.launch {
                        runCatching { Repo.addNote(leadId, text, tags) }
                            .onSuccess { adding = false; reload++ }
                            .onFailure { vm.message = "Couldn't save the note — check internet" }
                        saving = false
                    }
                }, enabled = !saving && (text.isNotBlank() || tags.isNotEmpty())) { Text(if (saving) "Saving…" else "Save") }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } })
    }
}
