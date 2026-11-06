package com.closeros.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Backend
import com.closeros.app.data.Lead
import com.closeros.app.data.Person
import com.closeros.app.data.Repo
import kotlinx.coroutines.launch

/** Lead page: share the lead with a teammate for follow-up. Both see calls, notes, recordings; each keeps their own next call. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LeadShareCard(vm: AppViewModel, lead: Lead, onChanged: (Lead) -> Unit) {
    val org = vm.membership?.org_id ?: return
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var picking by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(org) { people = runCatching { Repo.orgPeople(org) }.getOrDefault(emptyList()) }
    val me = Backend.uid
    val canShare = lead.assigned_to == me || me in lead.shared_with || vm.membership?.role in listOf("owner", "admin", "manager")
    fun nameOf(id: String?) = people.firstOrNull { it.user_id == id }?.name ?: "Teammate"
    fun change(user: String, on: Boolean) {
        if (busy) return; busy = true
        scope.launch {
            runCatching { Repo.shareLead(lead.id, user, on) }
                .onSuccess { onChanged(lead.copy(shared_with = if (on) lead.shared_with + user else lead.shared_with - user)); vm.message = if (on) "Shared with ${nameOf(user)} ✓" else "Stopped sharing" }
                .onFailure { vm.message = it.message?.substringAfter("ERROR:")?.trim() ?: "Couldn't share — check the internet" }
            busy = false; picking = false
        }
    }
    if (lead.shared_with.isEmpty() && !canShare) return
    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
        Column(Modifier.padding(14.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("👥 Shared for follow-up", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (canShare) TextButton(onClick = { picking = true }) { Text("+ Share") }
            }
            if (lead.shared_with.isEmpty()) Text("Only ${if (lead.assigned_to == me) "you" else nameOf(lead.assigned_to)} work this lead.", fontSize = 13.sp, color = Brand.muted)
            else FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                (listOfNotNull(lead.assigned_to) + lead.shared_with).distinct().forEach { u ->
                    val owner = u == lead.assigned_to
                    Row(Modifier.background(if (owner) Brand.light else Color(0xFFE0F2FE), RoundedCornerShape(14.dp)).padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text((if (u == me) "You" else nameOf(u)) + if (owner) " · owner" else "", fontSize = 13.sp)
                        if (!owner && canShare) Text("  ✕", fontSize = 13.sp, color = Color(0xFFB91C1C), modifier = Modifier.clickable { change(u, false) }.padding(4.dp))
                        else Spacer(Modifier.width(6.dp))
                    }
                }
            }
            if (lead.shared_with.isNotEmpty()) Text("Everyone here sees all calls, notes and recordings. Each keeps their own next-call time.", fontSize = 12.sp, color = Brand.muted)
        }
    }
    if (picking) AlertDialog(onDismissRequest = { picking = false }, confirmButton = {}, dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
        title = { Text("Share with") },
        text = {
            val options = people.filter { it.user_id != lead.assigned_to && it.user_id !in lead.shared_with && it.user_id != me }
            if (options.isEmpty()) Text("No one else to share with.", color = Brand.muted)
            else LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(options, key = { it.user_id }) { p ->
                    Text(p.name, fontSize = 16.sp, modifier = Modifier.fillMaxWidth().clickable { change(p.user_id, true) }.padding(vertical = 12.dp))
                }
            }
        })
}
