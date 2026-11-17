package com.closeros.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Intents
import com.closeros.app.data.Lead

/** "Where is this lead?" — one line until tapped; then the levels as chips (tap the chosen one again to clear). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun IntentRow(vm: AppViewModel, lead: Lead, startOpen: Boolean = false, onChanged: (Lead) -> Unit = {}) {
    val levels = Intents.levels(vm.membership?.organization)
    val cur = Intents.of(vm.membership?.organization, lead.intent)
    var open by remember(lead.id) { mutableStateOf(startOpen) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("📍 Where is this lead?", fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            if (cur != null) IntentChip(cur.short, Color(cur.color), selected = true) { open = !open }
            else Text(if (open) "Choose ▴" else "Set ▾", fontSize = 13.sp, color = Brand.primary, fontWeight = FontWeight.SemiBold)
        }
        if (open) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            levels.forEach { lv ->
                IntentChip(lv.short, Color(lv.color), selected = lv.key == lead.intent) {
                    val next = if (lv.key == lead.intent) null else lv.key
                    open = false
                    vm.setIntent(lead, next) { onChanged(it) }
                }
            }
        }
        if (open) Text(levels.joinToString("  ·  ") { it.label }, fontSize = 11.sp, color = Brand.muted, maxLines = 3)
    }
}

@Composable
fun IntentChip(text: String, color: Color, selected: Boolean, onClick: () -> Unit) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = if (selected) Color.White else color,
        modifier = Modifier.background(if (selected) color else Color.White, RoundedCornerShape(50))
            .border(1.dp, color, RoundedCornerShape(50)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp))
}
