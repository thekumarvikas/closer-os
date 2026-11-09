package com.closeros.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One colour per kind of call — the same as the dashboard:
 *  dialled + answered = dark green · dialled, not picked up = light green · received = blue ·
 *  missed = red · declined = dark red. WhatsApp calls keep the colour and get a small "WA" badge. */
object CallColors {
    val outTalk = Color(0xFF166534)
    val outNone = Color(0xFF22C55E)
    val incoming = Color(0xFF2563EB)
    val missed = Color(0xFFEF4444)
    val rejected = Color(0xFF7F1D1D)

    fun of(direction: String?, durationSec: Int): Color = when (direction) {
        "incoming" -> incoming; "missed" -> missed; "rejected" -> rejected
        else -> if (durationSec > 0) outTalk else outNone
    }
    fun arrow(direction: String?): String = when (direction) { "outgoing" -> "↗"; "incoming" -> "↙"; else -> "✕" }
    fun label(direction: String?, durationSec: Int): String = when (direction) {
        "incoming" -> "Received"; "missed" -> "Missed"; "rejected" -> "Declined"
        else -> if (durationSec > 0) "Dialled" else "Not picked up"
    }
}

/** Small green "WA" badge for WhatsApp calls. */
@Composable
fun WaBadge(modifier: Modifier = Modifier) {
    Text("WA", fontSize = 9.sp, fontWeight = FontWeight.Bold, color = Color(0xFF047857),
        modifier = modifier.background(Color(0xFFD1FAE5), RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 0.dp))
}

/** Colour key shown above call lists. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CallColorKey(modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(CallColors.outTalk to "Dialled · answered", CallColors.outNone to "Not picked up", CallColors.incoming to "Received",
            CallColors.missed to "Missed", CallColors.rejected to "Declined").forEach { (c, l) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(c, CircleShape)); Text(" $l", fontSize = 11.sp, color = Brand.muted)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) { WaBadge(); Text(" WhatsApp", fontSize = 11.sp, color = Brand.muted) }
    }
}
