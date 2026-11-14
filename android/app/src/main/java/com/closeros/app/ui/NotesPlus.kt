package com.closeros.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Lead
import com.closeros.app.data.LeadProfileData
import com.closeros.app.data.NoteKit
import com.closeros.app.data.NoteLine
import com.closeros.app.data.Objection
import com.closeros.app.data.ProfileOptions
import kotlinx.serialization.json.JsonObject

// ───────────── Fill-in-the-blank sentences ─────────────

/** A note sentence being filled in: the tapped line + what's chosen for each gap. */
class SentenceFill(val line: String, val parts: List<NoteKit.Part>) {
    val values = mutableStateListOf<String>().also { l -> repeat(parts.count { it is NoteKit.Part.Gap }) { l.add("") } }
    val gaps get() = parts.filterIsInstance<NoteKit.Part.Gap>()
    val complete get() = values.all { it.isNotBlank() }
    fun text(): String { var g = 0; return parts.joinToString("") { p -> when (p) { is NoteKit.Part.Text -> p.s; is NoteKit.Part.Gap -> values[g++].trim() } }.trim() }
    /** Gaps tied to the lead profile (budget, goal, challenge) → the profile change. */
    fun profilePatch(opts: ProfileOptions, current: LeadProfileData): Map<String, String> {
        val out = mutableMapOf<String, String>()
        gaps.forEachIndexed { i, gp -> gp.field?.let { f -> values[i].trim().takeIf { it.isNotBlank() }?.let { out[f] = it } } }
        return out
    }
}

/** Turns gap answers into a server profile patch, adding goals / challenges to what the lead already has. */
fun profilePatchFrom(fields: Map<String, String>, opts: ProfileOptions, cur: LeadProfileData): JsonObject? {
    if (fields.isEmpty()) return null
    val goal = fields["goals"]; val ch = fields["challenges"]
    return NoteKit.patch(
        budget = fields["budget"]?.let { b -> if (b in opts.budget) b else null } ?: cur.budget.takeIf { fields["budget"] != null },
        budgetAmount = fields["budget"]?.takeIf { it !in opts.budget },
        goals = goal?.takeIf { it in opts.goals }?.let { (cur.goals + it).distinct() },
        goalsText = goal?.takeIf { it !in opts.goals }?.let { listOfNotNull(cur.goalsText, it).joinToString(", ") },
        challenges = ch?.takeIf { it in opts.challenges }?.let { (cur.challenges + it).distinct() },
        challengesText = ch?.takeIf { it !in opts.challenges }?.let { listOfNotNull(cur.challengesText, it).joinToString(", ") },
    )
}

/**
 * Ready-made sentences for the chosen outcome. Tap one: a sentence without gaps is added at once; one with gaps
 * opens right here (no pop-up window, so it also works on the after-call card) — tap a choice or type for each gap.
 * [onTyping] tells the after-call card that a text box has the keyboard.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SentencePicker(lines: List<NoteLine>, opts: ProfileOptions, onAdd: (text: String, profileFields: Map<String, String>) -> Unit,
                   compact: Boolean = false, onTyping: (Boolean) -> Unit = {}) {
    if (lines.isEmpty()) return
    var fill by remember(lines) { mutableStateOf<SentenceFill?>(null) }
    val f = fill
    if (f == null) {
        if (!compact) Text("Quick sentences", fontSize = 12.sp, color = Brand.muted, fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            lines.forEach { l ->
                Text("✎ " + NoteKit.preview(l.text), fontSize = 13.sp, color = Color(0xFF0F172A),
                    modifier = Modifier.background(Color(0xFFEEF2FF), RoundedCornerShape(50)).clickable {
                        val parts = NoteKit.parse(l.text, opts)
                        if (parts.none { it is NoteKit.Part.Gap }) onAdd(l.text.trim(), emptyMap()) else fill = SentenceFill(l.text, parts)
                    }.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth().background(Color(0xFFEEF2FF), RoundedCornerShape(12.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(f.text().ifBlank { NoteKit.preview(f.line) }.let { if (f.complete) it else NoteKit.preview(f.line) }, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        f.gaps.forEachIndexed { i, g ->
            Text(when (g.field) { "budget" -> "Budget"; "goals" -> "Goal"; "challenges" -> "Challenge"; else -> if (g.choices.isEmpty()) g.name.replaceFirstChar { it.uppercase() } else "Choose" },
                fontSize = 12.sp, color = Brand.muted)
            if (g.choices.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                g.choices.forEach { c ->
                    val on = f.values[i] == c
                    Text(c, fontSize = 13.sp, color = if (on) Color.White else Color(0xFF1E293B),
                        modifier = Modifier.background(if (on) Brand.primary else Color.White, RoundedCornerShape(50)).clickable { f.values[i] = c }
                            .padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
            OutlinedTextField(if (f.values[i] in g.choices) "" else f.values[i], { f.values[i] = it }, singleLine = true,
                placeholder = { Text(if (g.choices.isEmpty()) "Type it" else "Or type") }, textStyle = LocalTextStyle.current.copy(fontSize = 14.sp),
                modifier = Modifier.fillMaxWidth().onFocusChanged { onTyping(it.isFocused) })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = f.complete, onClick = { onAdd(f.text(), f.profilePatch(opts, LeadProfileData())); fill = null; onTyping(false) }) { Text("Add to note") }
            TextButton(onClick = { fill = null; onTyping(false) }) { Text("Cancel") }
        }
    }
}

/** Tag chips for the chosen outcome (each tag group says which outcomes it fits). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OutcomeTags(groups: List<com.closeros.app.data.TagGroup>, tags: List<String>, onTags: (List<String>) -> Unit, small: Boolean = false) {
    groups.forEach { g ->
        val c = runCatching { Color(android.graphics.Color.parseColor(g.color)) }.getOrDefault(Brand.primaryDark)
        if (!small) Text(g.name, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Brand.muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            g.tags.forEach { t ->
                val on = t in tags
                Text((if (on) "✓ " else "") + t, fontSize = 13.sp, color = if (on) Color.White else c,
                    modifier = Modifier.background(if (on) c else c.copy(alpha = 0.1f), RoundedCornerShape(50))
                        .clickable { onTags(if (on) tags - t else tags + t) }.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
    }
}

// ───────────── Lead profile ─────────────

/** The lead's profile at the top of the lead page: profession, city, challenges, goals, budget. */
@Composable
fun ProfileCard(vm: AppViewModel, lead: Lead) {
    val p = NoteKit.profileOf(lead)
    var editing by remember { mutableStateOf(false) }
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("👤 Profile", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = { editing = true }) { Text("Edit") }
            }
            ProfileRow("Profession", lead.profession) { editing = true }
            ProfileRow("City", lead.city) { editing = true }
            ProfileRow("Challenges", p.challengeLine) { editing = true }
            ProfileRow("Goals", p.goalLine) { editing = true }
            ProfileRow("Budget", p.budgetLine) { editing = true }
            // Facts the company set up earlier (Settings → Facts to capture) stay here as extra lines.
            vm.membership?.organization?.leadFacts.orEmpty().forEach { f ->
                (lead.custom?.get(f.key) as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { it.isNotBlank() }?.let { ProfileRow(f.label, it) {} }
            }
        }
    }
    if (editing) ProfileEditDialog(vm, lead) { editing = false }
}

@Composable
private fun ProfileRow(label: String, value: String?, onAdd: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, fontSize = 13.sp, color = Brand.muted, modifier = Modifier.width(92.dp))
        if (value.isNullOrBlank()) Text("+ Add", fontSize = 14.sp, color = Brand.primary, modifier = Modifier.clickable(onClick = onAdd))
        else Text(value, fontSize = 14.sp, modifier = Modifier.weight(1f))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileEditDialog(vm: AppViewModel, lead: Lead, onClose: () -> Unit) {
    val opts = vm.membership?.organization?.profileOptions ?: ProfileOptions(NoteKit.DEFAULT_CHALLENGES, NoteKit.DEFAULT_GOALS, NoteKit.DEFAULT_BUDGET)
    val cur = NoteKit.profileOf(lead)
    var profession by remember { mutableStateOf(lead.profession.orEmpty()) }
    var city by remember { mutableStateOf(lead.city.orEmpty()) }
    var ch by remember { mutableStateOf(cur.challenges) }
    var chText by remember { mutableStateOf(cur.challengesText.orEmpty()) }
    var goals by remember { mutableStateOf(cur.goals) }
    var goalsText by remember { mutableStateOf(cur.goalsText.orEmpty()) }
    var budget by remember { mutableStateOf(cur.budget) }
    var amount by remember { mutableStateOf(cur.budgetAmount.orEmpty()) }
    AlertDialog(onDismissRequest = onClose, title = { Text("Profile · ${lead.name.ifBlank { fmtPhone(lead.phone) }}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(profession, { profession = it }, label = { Text("Profession") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(city, { city = it }, label = { Text("City") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("Challenges", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                PickChips(opts.challenges, ch) { ch = it }
                OutlinedTextField(chText, { chText = it }, label = { Text("In their words") }, modifier = Modifier.fillMaxWidth(),
                    trailingIcon = { VoiceButton { s -> chText = if (chText.isBlank()) s else "$chText, $s" } })
                Text("Goals", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                PickChips(opts.goals, goals) { goals = it }
                OutlinedTextField(goalsText, { goalsText = it }, label = { Text("In their words") }, modifier = Modifier.fillMaxWidth(),
                    trailingIcon = { VoiceButton { s -> goalsText = if (goalsText.isBlank()) s else "$goalsText, $s" } })
                Text("Budget", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                PickChips(opts.budget, listOfNotNull(budget), single = true) { budget = it.firstOrNull() }
                OutlinedTextField(amount, { amount = it }, label = { Text("Exact amount (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            Button(onClick = {
                vm.saveProfile(lead, NoteKit.patch(ch, chText.trim(), goals, goalsText.trim(), budget.orEmpty(), amount.trim(), profession.trim(), city.trim()))
                onClose()
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PickChips(options: List<String>, picked: List<String>, single: Boolean = false, onChange: (List<String>) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        options.forEach { o ->
            val on = o in picked
            Text((if (on) "✓ " else "") + o, fontSize = 13.sp, color = if (on) Color.White else Color(0xFF1E293B),
                modifier = Modifier.background(if (on) Brand.primary else Color.White, RoundedCornerShape(50))
                    .border(1.dp, if (on) Brand.primary else Color(0xFFCBD5E1), RoundedCornerShape(50))
                    .clickable { onChange(if (single) (if (on) emptyList() else listOf(o)) else if (on) picked - o else picked + o) }
                    .padding(horizontal = 10.dp, vertical = 6.dp))
        }
    }
}

/** Profile on the outcome screen: one tap per chip, saved with the outcome. Only what the rep touches is sent. */
class ProfileDraft(lead: Lead?) {
    private val cur = NoteKit.profileOf(lead)
    var challenges by mutableStateOf(cur.challenges)
    var goals by mutableStateOf(cur.goals)
    var budget by mutableStateOf(cur.budget)
    var touched by mutableStateOf(false)
    fun patch(): JsonObject? = if (!touched) null else NoteKit.patch(challenges = challenges, goals = goals, budget = budget.orEmpty())
}

@Composable
fun ProfileQuick(opts: ProfileOptions, d: ProfileDraft) {
    var open by remember { mutableStateOf(false) }
    val summary = listOfNotNull(d.goals.joinToString(", ").ifBlank { null }?.let { "Goal: $it" }, d.challenges.joinToString(", ").ifBlank { null }?.let { "Challenge: $it" },
        d.budget?.let { "Budget: $it" }).joinToString(" · ")
    Column(Modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("👤 Lead profile", fontWeight = FontWeight.SemiBold)
                Text(summary.ifBlank { "Goals, challenges, budget — tap to fill" }, fontSize = 13.sp, color = Brand.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text(if (open) "▲" else "▼", color = Brand.muted)
        }
        if (open) {
            Text("Goals", fontSize = 12.sp, color = Brand.muted); PickChips(opts.goals, d.goals) { d.goals = it; d.touched = true }
            Text("Challenges", fontSize = 12.sp, color = Brand.muted); PickChips(opts.challenges, d.challenges) { d.challenges = it; d.touched = true }
            Text("Budget", fontSize = 12.sp, color = Brand.muted); PickChips(opts.budget, listOfNotNull(d.budget), single = true) { d.budget = it.firstOrNull(); d.touched = true }
        }
    }
}

// ───────────── Pinned notes ─────────────

/** Up to 3 pinned notes under the key facts. */
@Composable
fun PinnedNotes(vm: AppViewModel, lead: Lead) {
    if (lead.pinned.isEmpty()) return
    Column(Modifier.fillMaxWidth().background(Color(0xFFFFFBEB), RoundedCornerShape(12.dp)).border(1.dp, Color(0xFFFDE68A), RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("📌 Pinned notes", fontWeight = FontWeight.SemiBold)
        lead.pinned.forEach { p ->
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(p.text, fontSize = 14.sp)
                    Text(listOfNotNull(p.by, p.at?.let { fmtWhen(it) }).joinToString(" · "), fontSize = 11.sp, color = Brand.muted)
                }
                Text("Unpin", fontSize = 12.sp, color = Brand.muted, modifier = Modifier.clickable { vm.pinNote(lead, p.ref, p.text, false) }.padding(4.dp))
            }
        }
    }
}

// ───────────── Objections ─────────────

/**
 * On the outcome screen: which objection did the lead raise? Tap it → its best answer shows; tap the answer you
 * used (counts towards "used in N calls · M bought"). "+ New objection" adds one (reps: approved by a manager for the team).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ObjectionPicker(vm: AppViewModel, picked: Map<String, String?>, onChange: (Map<String, String?>) -> Unit) {
    LaunchedEffect(Unit) { if (vm.objections == null) vm.loadObjections() }
    val list = vm.objections.orEmpty()
    var adding by remember { mutableStateOf(false) }
    Text("Objection raised?", fontWeight = FontWeight.SemiBold)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        list.forEach { o ->
            val on = o.id in picked
            Text((if (on) "✓ " else "") + o.title.trim('"', '“', '”'), fontSize = 13.sp, color = if (on) Color.White else Color(0xFF9A3412),
                modifier = Modifier.background(if (on) Color(0xFFEA580C) else Color(0xFFFFF7ED), RoundedCornerShape(50))
                    .clickable { onChange(if (on) picked - o.id else picked + (o.id to o.best?.id)) }.padding(horizontal = 10.dp, vertical = 6.dp))
        }
        Text("+ New objection", fontSize = 13.sp, color = Brand.primary,
            modifier = Modifier.border(1.dp, Brand.primary, RoundedCornerShape(50)).clickable { adding = true }.padding(horizontal = 10.dp, vertical = 6.dp))
    }
    picked.keys.mapNotNull { id -> list.firstOrNull { it.id == id } }.forEach { o ->
        val answers = o.allAnswers
        val chosen = picked[o.id]
        Column(Modifier.fillMaxWidth().background(Color(0xFFFFF7ED), RoundedCornerShape(10.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("“${o.title.trim('"', '“', '”')}” — which answer did you use?", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            if (answers.isEmpty()) Text("No answer saved yet — add one in Playbook → Objections.", fontSize = 12.sp, color = Brand.muted)
            answers.forEach { a ->
                val on = chosen == a.id
                Row(Modifier.fillMaxWidth().background(if (on) Color.White else Color.Transparent, RoundedCornerShape(8.dp))
                    .clickable { onChange(picked + (o.id to if (on) null else a.id)) }.padding(6.dp)) {
                    Text(if (on) "◉ " else "○ ", color = Color(0xFFEA580C))
                    Column(Modifier.weight(1f)) {
                        Text(a.body.orEmpty(), fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        answerStats(a.used, a.bought)?.let { Text(it, fontSize = 11.sp, color = Brand.muted) }
                    }
                }
            }
        }
    }
    if (adding) ObjectionEditDialog(vm, parent = null) { newId -> adding = false; newId?.let { onChange(picked + (it to it)) } }
}

fun answerStats(used: Int, bought: Int): String? = if (used == 0) null else "Used in $used call${if (used == 1) "" else "s"}" + if (bought > 0) " · $bought bought" else ""

/** New objection (with its first answer) or, with [parent], another answer to it. */
@Composable
fun ObjectionEditDialog(vm: AppViewModel, parent: Objection?, onClose: (String?) -> Unit) {
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { onClose(null) }, title = { Text(if (parent == null) "New objection" else "Another answer") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (parent == null) OutlinedTextField(title, { title = it }, label = { Text("What the lead says") }, placeholder = { Text("e.g. I'll think about it") },
                    modifier = Modifier.fillMaxWidth(), trailingIcon = { VoiceButton { s -> title = if (title.isBlank()) s else "$title $s" } })
                else Text("“${parent.title.trim('"', '“', '”')}”", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(body, { body = it }, label = { Text(if (parent == null) "How to answer (optional)" else "Your answer") }, minLines = 3,
                    modifier = Modifier.fillMaxWidth(), trailingIcon = { VoiceButton { s -> body = if (body.isBlank()) s else "$body $s" } })
                if (!vm.isManager && !vm.isSolo) Text("You can use it right away. The team sees it after your manager approves it.", fontSize = 12.sp, color = Brand.muted)
            }
        },
        confirmButton = {
            Button(enabled = !saving && (if (parent == null) title.isNotBlank() else body.isNotBlank()), onClick = {
                saving = true
                vm.saveObjection(title.trim().takeIf { parent == null }, body.trim().ifBlank { null }, parent?.id) { id -> saving = false; if (id != null) onClose(if (parent == null) id else null) }
            }) { Text(if (saving) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(onClick = { onClose(null) }) { Text("Cancel") } })
}

/** One objection with all its answers (best first): copy, send on WhatsApp, add an answer. Used in Playbook → Objections. */
@Composable
fun ObjectionCard(vm: AppViewModel, o: Objection, lead: Lead?, expanded: Boolean, toggle: () -> Unit) {
    val ctx = LocalContext.current
    var addAnswer by remember { mutableStateOf(false) }
    fun fill(t: String) = if (lead != null) vm.fillTemplate(t, lead) else t
    Card(Modifier.fillMaxWidth().clickable(onClick = toggle), colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("“${o.title.trim('"', '“', '”')}”", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (o.status == "pending") Text("Only you · waiting for approval", fontSize = 11.sp, color = Color(0xFFB45309))
            }
            if (o.raised > 0) Text("Raised in ${o.raised} call${if (o.raised == 1) "" else "s"}" + if (o.bought > 0) " · ${o.bought} of those leads bought" else "", fontSize = 12.sp, color = Brand.muted)
            val answers = o.allAnswers
            (if (expanded) answers else answers.take(1)).forEachIndexed { i, a ->
                Column(Modifier.fillMaxWidth().background(if (i == 0) Color(0xFFF0FDF4) else Color(0xFFF8FAFC), RoundedCornerShape(8.dp)).padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (i == 0 && answers.size > 1) Text("⭐ Best answer", fontSize = 11.sp, color = Color(0xFF15803D), fontWeight = FontWeight.SemiBold)
                    Text(fill(a.body.orEmpty()), fontSize = 14.sp, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(answerStats(a.used, a.bought), a.by, if (a.status == "pending") "waiting for approval" else null).joinToString(" · "), fontSize = 11.sp, color = Brand.muted)
                    if (expanded) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = {
                            ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Closer OS", fill(a.body.orEmpty())))
                            android.widget.Toast.makeText(ctx, "Copied", android.widget.Toast.LENGTH_SHORT).show()
                        }) { Text("Copy") }
                        if (lead != null) Button(onClick = { com.closeros.app.calls.PhoneCalls.whatsapp(ctx, lead.phone, fill(a.body.orEmpty())) }) { Text("Send on WhatsApp") }
                    }
                }
            }
            if (!expanded && answers.size > 1) Text("+ ${answers.size - 1} more answer${if (answers.size > 2) "s" else ""}", fontSize = 12.sp, color = Brand.primary)
            if (expanded) TextButton(onClick = { addAnswer = true }) { Text("+ Add another answer") }
        }
    }
    if (addAnswer) ObjectionEditDialog(vm, o) { addAnswer = false }
}

// ───────────── Before-call brief ─────────────

/**
 * What to know before dialling, on one screen: profile, pinned notes, last time, their objection with the best answer,
 * a suggested first line, signals and why this call. Shown in the calling queue and on the lead page.
 */
@Composable
fun BriefCard(vm: AppViewModel, lead: Lead, showProfile: Boolean = true) {
    LaunchedEffect(Unit) { if (vm.objections == null) vm.loadObjections() }
    val p = NoteKit.profileOf(lead)
    val fu = vm.followUps.firstOrNull { it.lead_id == lead.id }
    val obj = lead.objections.firstNotNullOfOrNull { vm.objectionById(it) }
    val lastOutcome = vm.outcomes.firstOrNull { it.id == lead.last_outcome_id }?.label
    Column(Modifier.fillMaxWidth().background(Color(0xFFF0F9FF), RoundedCornerShape(12.dp)).border(1.dp, Color(0xFFBAE6FD), RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("🧭 Before you call", fontWeight = FontWeight.SemiBold)
        // Why this call.
        fu?.let { f -> listOfNotNull(f.reason?.takeIf { it.isNotBlank() && it != "Scheduled call" }, f.notes?.takeIf { it.isNotBlank() }).joinToString(" — ").ifBlank { null }
            ?.let { Text("📅 Why now: $it", fontSize = 14.sp) } }
        if (showProfile && !p.isEmpty) Text(listOfNotNull(p.goalLine?.let { "🎯 $it" }, p.challengeLine?.let { "😟 $it" }, p.budgetLine?.let { "💰 $it" }).joinToString("   "), fontSize = 14.sp)
        lead.pinned.forEach { Text("📌 ${it.text}", fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        // Last time.
        if (lead.last_call_at != null || lead.last_note != null) Text("🕒 Last time: " + listOfNotNull(lead.last_call_at?.let { fmtWhen(it) }, lastOutcome,
            lead.last_note?.let { "“${it.take(140)}${if (it.length > 140) "…" else ""}”" }).joinToString(" · "), fontSize = 14.sp)
        else Text("🆕 First call with this lead", fontSize = 14.sp)
        obj?.let { o ->
            Column(Modifier.fillMaxWidth().background(Color(0xFFFFF7ED), RoundedCornerShape(8.dp)).padding(8.dp)) {
                Text("⚠ Their objection: “${o.title.trim('"', '“', '”')}”", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF9A3412))
                o.best?.body?.let { Text("Best answer: " + vm.fillTemplate(it, lead), fontSize = 13.sp, maxLines = 4, overflow = TextOverflow.Ellipsis) }
            }
        }
        Text("💬 Open with: “${openingLine(vm, lead, p, obj)}”", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Brand.primaryDark)
        val signals = listOfNotNull(
            lead.latestBatch?.let { b -> b.watch_minutes?.let { w -> if (w > 0) "🎥 watched $w min" + (if (b.saw_pitch == true) " · saw the pitch" else "") else "🎥 didn't join ${b.batch?.name ?: "the webinar"}" } },
            lead.wa_count.takeIf { it > 0 }?.let { "💬 $it WhatsApp sent" },
            lead.best_hour?.let { h -> "⏰ usually picks up around ${java.time.LocalTime.of(h, 0).format(java.time.format.DateTimeFormatter.ofPattern("h a"))}" },
        )
        if (signals.isNotEmpty()) Text(signals.joinToString(" · "), fontSize = 13.sp, color = Brand.muted)
    }
}

/** A first sentence for the call, built from what we know (never sent anywhere — just a suggestion on screen). */
fun openingLine(vm: AppViewModel, lead: Lead, p: LeadProfileData, obj: Objection?): String {
    val first = lead.name.trim().substringBefore(' ').ifBlank { "there" }
    val me = vm.profile?.full_name?.substringBefore(' ').orEmpty()
    val co = vm.membership?.organization?.name.orEmpty()
    val note = lead.last_note?.trim()?.trimEnd('.')
    return when {
        note != null && note.length in 4..120 -> "Hi $first, it's $me. Last time you mentioned: $note — any update on that?"
        obj != null -> "Hi $first, it's $me. Last time you were thinking about ${obj.title.trim('"', '“', '”').lowercase()} — did you get a chance to think it over?"
        p.goalLine != null -> "Hi $first, it's $me. You said you want to ${p.goalLine.orEmpty().lowercase()} — is that still the plan?"
        lead.latestBatch?.watch_minutes?.let { it > 0 } == true -> "Hi $first, it's $me from $co. You attended ${lead.latestBatch?.batch?.name ?: "our session"} — what did you like most?"
        lead.last_call_at == null -> "Hi $first, this is $me from $co. You showed interest" + (lead.campaign ?: lead.source)?.let { " in $it" }.orEmpty() + " — is this a good time for 2 minutes?"
        else -> "Hi $first, it's $me from $co — is this a good time to talk for 2 minutes?"
    }
}
