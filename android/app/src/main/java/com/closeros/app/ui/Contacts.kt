package com.closeros.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Backend
import com.closeros.app.data.SafeError
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun copyText(ctx: Context, text: String, what: String = "Copied") {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(what, text))
    Toast.makeText(ctx, "$what: $text", Toast.LENGTH_SHORT).show()
}

/** A number or email: long-press copies, the ⧉ button copies. Tapping never calls — only the Call button does. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CopyText(value: String, shown: String = value, fontSize: TextUnit = 15.sp, color: Color = Color.Unspecified, what: String = "Copied") {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(shown, fontSize = fontSize, color = color, modifier = Modifier.combinedClickable(onClick = {}, onLongClick = { copyText(ctx, value, what) }))
        Text("⧉", fontSize = 16.sp, color = Brand.muted, modifier = Modifier.padding(start = 6.dp).combinedClickable(onClick = { copyText(ctx, value, what) }))
    }
}

@Serializable data class ContactItem(val id: String? = null, val value: String, val label: String? = null, val main: Boolean = false, val source: String? = null, val at: String? = null)
@Serializable data class NameUsed(val name: String, val at: String? = null, val source: String? = null)
@Serializable data class LeadContactsData(val phones: List<ContactItem> = emptyList(), val emails: List<ContactItem> = emptyList(),
    val names: List<NameUsed> = emptyList(), val can_remove: Boolean = false)

private val cjson = Json { ignoreUnknownKeys = true; coerceInputValues = true }

object LeadContactsApi {
    suspend fun load(leadId: String): LeadContactsData? {
        val t = Backend.client.postgrest.rpc("lead_contacts", buildJsonObject { put("p_lead", leadId) }).data
        return if (t.isBlank() || t == "null") null else cjson.decodeFromString(t)
    }
    suspend fun change(leadId: String, kind: String, op: String, id: String? = null, value: String? = null, label: String? = null) {
        Backend.client.postgrest.rpc("set_lead_contact", buildJsonObject {
            put("p_lead", leadId)
            put("p", buildJsonObject { put("kind", kind); put("op", op); id?.let { put("id", it) }; value?.let { put("value", it) }; label?.let { put("label", it) } })
        })
    }
}

/** Main number at the top of the lead page + every other number/email the person used, with labels; "Registered as" names. */
@Composable
fun LeadContactsBlock(lead: com.closeros.app.data.Lead, onChanged: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember(lead.id) { mutableStateOf<LeadContactsData?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(lead.id, tick) { data = runCatching { LeadContactsApi.load(lead.id) }.getOrNull() }
    var adding by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Pair<String, ContactItem>?>(null) }
    fun run(block: suspend () -> Unit) = scope.launch {
        runCatching { block() }.onSuccess { tick++; onChanged() }.onFailure { Toast.makeText(ctx, SafeError.forUser(it, "Couldn't save — try again"), Toast.LENGTH_LONG).show() }
    }
    val d = data
    val phones = d?.phones ?: listOf(ContactItem(value = lead.phone, label = "Primary", main = true))
    val emails = d?.emails ?: listOfNotNull(lead.email?.takeIf { it.isNotBlank() }?.let { ContactItem(value = it, label = "Primary", main = true) })

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        d?.names?.filter { !it.name.equals(lead.name, true) }?.takeIf { it.isNotEmpty() }?.let { ns ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ns.take(3).forEach { n ->
                    Text("Registered as: ${n.name}" + (n.at?.let { " · ${fmtWhen(it).substringBefore(",")}" } ?: ""), fontSize = 12.sp, color = Color(0xFF6D28D9),
                        modifier = Modifier.background(Color(0xFFF5F3FF), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp))
                }
            }
        }
        phones.forEach { p -> ContactLine("phone", p, fmtPhone(p.value), lead.id, d != null, { renaming = "phone" to p }, { run { LeadContactsApi.change(lead.id, "phone", "main", p.id) } }) }
        emails.forEach { e -> ContactLine("email", e, e.value, lead.id, d != null, { renaming = "email" to e }, { run { LeadContactsApi.change(lead.id, "email", "main", e.id) } }) }
        if (d != null) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { adding = "phone" }, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("+ Add number", fontSize = 13.sp) }
            TextButton(onClick = { adding = "email" }, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("+ Add email", fontSize = 13.sp) }
        }
    }

    adding?.let { kind ->
        var v by remember { mutableStateOf("") }
        var lbl by remember { mutableStateOf("Secondary") }
        AlertDialog(onDismissRequest = { adding = null }, title = { Text(if (kind == "phone") "Add a number" else "Add an email") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(v, { v = it }, label = { Text(if (kind == "phone") "Number" else "Email") }, singleLine = true)
                OutlinedTextField(lbl, { lbl = it }, label = { Text("Label (e.g. Secondary, Office, WhatsApp)") }, singleLine = true)
            } },
            confirmButton = { TextButton(enabled = v.isNotBlank(), onClick = { adding = null; run { LeadContactsApi.change(lead.id, kind, "add", value = v.trim(), label = lbl.trim().ifBlank { "Secondary" }) } }) { Text("Add") } },
            dismissButton = { TextButton(onClick = { adding = null }) { Text("Cancel") } })
    }
    renaming?.let { (kind, item) ->
        var lbl by remember { mutableStateOf(item.label ?: "") }
        AlertDialog(onDismissRequest = { renaming = null }, title = { Text("Label for ${if (kind == "phone") fmtPhone(item.value) else item.value}") },
            text = { OutlinedTextField(lbl, { lbl = it }, singleLine = true) },
            confirmButton = { TextButton(enabled = lbl.isNotBlank(), onClick = { renaming = null; run { LeadContactsApi.change(lead.id, kind, "label", item.id, label = lbl.trim()) } }) { Text("Save") } },
            dismissButton = {
                Row {
                    if (data?.can_remove == true && !item.main && item.id != null)
                        TextButton(onClick = { renaming = null; run { LeadContactsApi.change(lead.id, kind, "remove", item.id) } }) { Text("Remove", color = Color(0xFFB91C1C)) }
                    TextButton(onClick = { renaming = null }) { Text("Cancel") }
                }
            })
    }
}

@Composable
private fun ContactLine(kind: String, c: ContactItem, shown: String, leadId: String, editable: Boolean, onLabel: () -> Unit, onMain: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        CopyText(c.value, shown, fontSize = if (c.main && kind == "phone") 18.sp else 15.sp, what = if (kind == "phone") "Number copied" else "Email copied")
        Text((c.label ?: if (c.main) "Primary" else "Secondary") + if (c.main) " ★" else "", fontSize = 11.sp, color = Brand.muted,
            modifier = Modifier.background(Color(0xFFF1F5F9), RoundedCornerShape(50)).then(if (editable) Modifier.clickableNoRipple(onLabel) else Modifier).padding(horizontal = 6.dp, vertical = 1.dp))
        if (editable && !c.main) Text("Make main", fontSize = 12.sp, color = Brand.primary, fontWeight = FontWeight.Medium, modifier = Modifier.clickableNoRipple(onMain))
    }
}

private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
