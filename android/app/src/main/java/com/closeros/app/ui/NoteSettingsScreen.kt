package com.closeros.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.NoteLine
import com.closeros.app.data.TagGroup
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Outcome kinds a sentence or tag group can be shown for. */
val OUTCOME_KINDS = listOf("won" to "Sale", "positive" to "Interested", "connected" to "Talking", "lost" to "Not interested",
    "invalid" to "Wrong / invalid", "not_connected" to "Couldn't reach")

/**
 * Notes settings (individuals; managers too — the dashboard has the same): lead profile choices, quick sentences
 * with gaps, and note tags with the outcomes they show for.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NoteSettingsScreen(vm: AppViewModel) {
    BackHandler { vm.showNoteSettings = false }
    val org = vm.membership?.organization ?: return
    val opts = org.profileOptions
    val challenges = remember { opts.challenges.toMutableStateList() }
    val goals = remember { opts.goals.toMutableStateList() }
    val budget = remember { opts.budget.toMutableStateList() }
    val lines = remember { org.noteLines.toMutableStateList() }
    val groups = remember { org.tagGroups.toMutableStateList() }
    var saving by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.showNoteSettings = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Notes & lead profile", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Button(enabled = !saving, onClick = {
                saving = true
                vm.saveOrgSettings(buildJsonObject {
                    put("profile_options", buildJsonObject {
                        put("challenges", JsonArray(challenges.map(::JsonPrimitive))); put("goals", JsonArray(goals.map(::JsonPrimitive))); put("budget", JsonArray(budget.map(::JsonPrimitive)))
                    })
                    put("note_lines", JsonArray(lines.filter { it.text.isNotBlank() }.map { l -> buildJsonObject { put("text", l.text.trim()); put("show_for", JsonArray(l.showFor.map(::JsonPrimitive))) } }))
                    put("tag_groups", JsonArray(groups.filter { it.tags.isNotEmpty() }.map { g -> buildJsonObject {
                        put("name", g.name); put("color", g.color); put("tags", JsonArray(g.tags.map(::JsonPrimitive))); put("show_for", JsonArray(g.showFor.map(::JsonPrimitive))) } }))
                }) { saving = false }
            }) { Text(if (saving) "Saving…" else "Save") }
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp, 0.dp, 16.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (!vm.isSolo) Text("These are your company's settings — everyone in the team uses them.", fontSize = 13.sp, color = Brand.muted)
            Section("Lead profile — challenges") { ListEditor(challenges, "e.g. No time") }
            Section("Lead profile — goals") { ListEditor(goals, "e.g. Job switch") }
            Section("Lead profile — budget choices") { ListEditor(budget, "e.g. 25k–50k") }

            Section("Quick sentences") {
                Text("Write a gap in square brackets: [spouse/parent/boss] gives choices, [budget] [goal] [challenge] use the lead profile (and fill it), [anything else] is typed.",
                    fontSize = 12.sp, color = Brand.muted)
                lines.forEachIndexed { i, l ->
                    Column(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(l.text, { lines[i] = l.copy(text = it) }, modifier = Modifier.fillMaxWidth(), textStyle = LocalTextStyle.current.copy(fontSize = 14.sp))
                        KindChips(l.showFor) { lines[i] = l.copy(showFor = it) }
                        Text("Remove", color = Brand.red, fontSize = 12.sp, modifier = Modifier.clickable { lines.removeAt(i) })
                    }
                }
                TextButton(onClick = { lines.add(NoteLine("", emptyList())) }) { Text("+ Add a sentence") }
            }

            Section("Note tags") {
                Text("Each group shows only for the outcomes ticked (none ticked = every outcome).", fontSize = 12.sp, color = Brand.muted)
                groups.forEachIndexed { i, g ->
                    var tagsText by remember(i) { mutableStateOf(g.tags.joinToString(", ")) }
                    Column(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(g.name, { groups[i] = g.copy(name = it) }, label = { Text("Group name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(tagsText, { tagsText = it; groups[i] = groups[i].copy(tags = it.split(',').map { t -> t.trim() }.filter { t -> t.isNotBlank() }) },
                            label = { Text("Tags, separated by commas") }, modifier = Modifier.fillMaxWidth())
                        KindChips(g.showFor) { groups[i] = groups[i].copy(showFor = it) }
                        Text("Remove group", color = Brand.red, fontSize = 12.sp, modifier = Modifier.clickable { groups.removeAt(i) })
                    }
                }
                TextButton(onClick = { groups.add(TagGroup("New group", "#0E5E57", emptyList())) }) { Text("+ Add a tag group") }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(title, fontWeight = FontWeight.SemiBold); content() }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KindChips(picked: List<String>, onChange: (List<String>) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Shows for:", fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(top = 6.dp))
        OUTCOME_KINDS.forEach { (k, l) ->
            val on = k in picked
            Text(l, fontSize = 12.sp, color = if (on) Color.White else Color(0xFF334155),
                modifier = Modifier.background(if (on) Brand.primary else Color(0xFFF1F5F9), RoundedCornerShape(50))
                    .clickable { onChange(if (on) picked - k else picked + k) }.padding(horizontal = 10.dp, vertical = 5.dp))
        }
    }
}

/** A list of short choices: tap × to remove, type + Add to add. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ListEditor(items: MutableList<String>, hint: String) {
    var adding by remember { mutableStateOf("") }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.toList().forEach { t ->
            Text("$t  ×", fontSize = 13.sp, modifier = Modifier.background(Color.White, RoundedCornerShape(50)).clickable { items.remove(t) }
                .padding(horizontal = 10.dp, vertical = 6.dp))
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(adding, { adding = it }, placeholder = { Text(hint) }, singleLine = true, modifier = Modifier.weight(1f))
        TextButton(enabled = adding.isNotBlank(), onClick = { if (adding.trim() !in items) items.add(adding.trim()); adding = "" }) { Text("Add") }
    }
}
