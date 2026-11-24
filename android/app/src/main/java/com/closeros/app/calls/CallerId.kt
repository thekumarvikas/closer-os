package com.closeros.app.calls

// Caller ID while the phone rings / while dialling (owner, Nov 24 2026): a SLIM strip at the top — not a full-screen card.
// Lead: name · level, ✅ buyer line, profession · city · webinar · saved date, last note. Not a lead (and not a saved
// personal contact): "Not in your leads · + Add". Goes away when the call is answered or ends (dialling: after 15 s), or on ✕.

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.closeros.app.MainActivity
import com.closeros.app.data.Intents
import com.closeros.app.data.LeadIndex
import com.closeros.app.data.LocalStore
import java.time.ZoneId

object CallerId {
    private var view: View? = null
    private var owner: AfterCall.Owner? = null
    private val main = Handler(Looper.getMainLooper())

    data class Lines(val title: String, val tag: String?, val buyer: String?, val facts: String?, val last: String?, val leadId: String?, val phone: String)

    private fun lines(ctx: Context, number: String): Lines? {
        val key = number.filter { it.isDigit() }.takeLast(10)
        if (key.length < 6) return null
        val zone = ZoneId.systemDefault()
        val row = PhoneContacts.stripRow(ctx, number)
        val lead = LeadIndex.find(ctx, number)
        if (row == null && lead == null) {
            // Personal numbers stay quiet: saved in the phone's contacts, or marked "never ask" in the pop-up.
            if (PhoneCalls.contactName(ctx, number) != null) return null
            if (LocalStore(ctx).personalNumbers.any { it.filter { c -> c.isDigit() }.endsWith(key) }) return null
            return Lines("Not in your leads", null, null, null, null, null, number)
        }
        val name = (row?.name ?: lead?.name).orEmpty().ifBlank { number }
        val level = Intents.of(null, row?.intent ?: lead?.intent)?.short
        return if (row != null) Lines(name, level, PhoneContacts.buyerLine(row, zone), PhoneContacts.companyLine(row, zone).ifBlank { null },
            PhoneContacts.noteLine(row, zone)?.let { "Last: $it" }, row.id, number)
        else Lines(name, level, null, listOfNotNull(lead?.profession, lead?.city).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { null },
            lead?.last_note?.let { "Last: $it" }, lead?.id, number)
    }

    fun show(ctx: Context, number: String?, autoHideMs: Long? = null) {
        val app = ctx.applicationContext
        if (number.isNullOrBlank() || !Settings.canDrawOverlays(app)) return
        if (LocalStore(app).afterCallMode == "off") return
        val l = runCatching { lines(app, number) }.getOrNull() ?: return
        main.post {
            hideNow(app)
            val wm = app.getSystemService(WindowManager::class.java) ?: return@post
            val o = AfterCall.Owner().also { it.start() }
            val v = ComposeView(app).apply {
                if (android.os.Build.VERSION.SDK_INT >= 29) isForceDarkAllowed = false
                setViewTreeLifecycleOwner(o); setViewTreeSavedStateRegistryOwner(o); setViewTreeViewModelStoreOwner(o)
                setContent { Strip(l, onClose = { hide(app) }, onAdd = {
                    hide(app)
                    app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("add_lead_phone", l.phone))
                }) }
            }
            val lp = WindowManager.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP; y = 90 }
            runCatching { wm.addView(v, lp); view = v; owner = o }.onFailure { o.stop() }
            autoHideMs?.let { main.postDelayed({ hideNow(app) }, it) }
        }
    }

    fun hide(ctx: Context) { val app = ctx.applicationContext; main.post { hideNow(app) } }
    private fun hideNow(ctx: Context) {
        main.removeCallbacksAndMessages(null)
        val v = view ?: return
        runCatching { ctx.getSystemService(WindowManager::class.java)?.removeViewImmediate(v) }
        owner?.stop(); view = null; owner = null
    }
}

@androidx.compose.runtime.Composable
private fun Strip(l: CallerId.Lines, onClose: () -> Unit, onAdd: () -> Unit) {
    val lead = l.leadId != null
    Row(Modifier.padding(horizontal = 10.dp).fillMaxWidth().background(Color(0xF2102A2B), RoundedCornerShape(14.dp))
        .padding(start = 14.dp, end = 4.dp, top = 9.dp, bottom = 9.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Closer OS · ", color = Color(0xFF5EEAD4), fontSize = 11.sp)
                Text(l.title, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                l.tag?.let { Text("  $it", color = Color(0xFFFDBA74), fontSize = 12.sp, maxLines = 1) }
            }
            l.buyer?.let { Text("✅ $it", color = Color(0xFF86EFAC), fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            l.facts?.let { Text(it, color = Color(0xFFCBD5E1), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            l.last?.let { Text(it, color = Color(0xFFE2E8F0), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            if (!lead) Text("+ Add as lead", color = Color(0xFF5EEAD4), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clickable(onClick = onAdd).padding(top = 2.dp))
        }
        Text("✕", color = Color(0xFF94A3B8), fontSize = 16.sp, modifier = Modifier.clickable(onClick = onClose).padding(horizontal = 10.dp, vertical = 2.dp))
    }
}
