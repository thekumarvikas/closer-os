package com.closeros.app.ui

import android.app.Application
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.widget.Toast
import com.closeros.app.calls.AfterCall
import com.closeros.app.calls.PhoneCalls
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Repo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Loads only what the outcome form needs (no Home, leads list or sync). */
class AfterCallViewModel(app: Application) : AppViewModel(app) {
    override val lite: Boolean get() = true
}

/**
 * Full outcome form opened from the after-call pop-up — same form and rules as inside the app,
 * shown as a sheet over whatever the rep was doing. Also "Add as a lead" for unknown numbers.
 */
class AfterCallActivity : ComponentActivity() {
    private val vm: AfterCallViewModel by viewModels()
    private var req by mutableStateOf<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AfterCall.Overlay.hide(applicationContext)
        req = intent
        setContent { CloserTheme { req?.let { Sheet(it) } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent); req = intent
    }

    @Composable
    private fun Sheet(i: Intent) {
        val logId = i.getStringExtra("log_id") ?: run { finish(); return }
        val started = i.getLongExtra("started", 0L)
        val phone = i.getStringExtra("phone").orEmpty()
        var mode by remember(i) { mutableStateOf(i.getStringExtra("mode") ?: "outcome") }
        var leadId by remember(i) { mutableStateOf(i.getStringExtra("lead_id")) }
        var opened by remember(i) { mutableStateOf(false) }

        // Open this call in the form (once the call-log entry is read).
        LaunchedEffect(i, leadId, mode) {
            val id = leadId ?: return@LaunchedEffect
            if (mode != "outcome") return@LaunchedEffect
            val log = withContext(Dispatchers.IO) { runCatching { PhoneCalls.readLog(this@AfterCallActivity, started - 60_000).firstOrNull { it.id == logId } }.getOrNull() }
            val lead = if (i.getStringExtra("lead_id") == id) null else runCatching { Repo.lead(id) }.getOrNull()
            vm.openAfterCall(LocalStore.PendingCall(id, lead?.name ?: i.getStringExtra("lead_name").orEmpty(), lead?.phone ?: i.getStringExtra("lead_phone") ?: phone,
                log?.startedAtMs ?: started, "sales", null, lead?.profession ?: i.getStringExtra("profession"), null, logId = logId), log)
            opened = true
        }
        // Saved (here or on the laptop): close.
        LaunchedEffect(vm.pending, opened) { if (opened && vm.pending == null) finish() }
        LaunchedEffect(vm.message) { vm.message?.let { Toast.makeText(this@AfterCallActivity, it, Toast.LENGTH_SHORT).show(); vm.message = null } }
        BackHandler { finish() }

        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { finish() }) {
            if (mode == "outcome") Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.92f)
                .background(Brand.bg, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("How did the call go?", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    IconButton(onClick = { finish() }) { Icon(Icons.Default.Close, "Close") }
                }
                if (leadId != null) {
                    Text("Closing this is fine — Closer OS will ask again when you open it.",
                        fontSize = 12.sp, color = Brand.muted, modifier = Modifier.padding(16.dp, 0.dp, 16.dp, 0.dp))
                    if (vm.pending == null || vm.membership == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    else OutcomeScreen(vm, popup = true)
                }
            }
        }
        val scope = rememberCoroutineScope()
        if (mode == "add") AddLeadDialog(phone, onDismiss = { finish() }) { name, prof, notes ->
            val m = vm.membership ?: run { vm.message = "Still loading — try again"; return@AddLeadDialog }
            val p = normalizePhone(phone, m.organization.phone_prefix)
            vm.addLeadFromCall(p, name, prof, notes) {
                // Added: if this call needs an outcome, ask for it now.
                scope.launch {
                    val id = runCatching { Repo.leadsByPhones(m.org_id, listOf(p))[p]?.id }.getOrNull()
                    val log = withContext(Dispatchers.IO) { runCatching { PhoneCalls.readLog(this@AfterCallActivity, started - 60_000).firstOrNull { it.id == logId } }.getOrNull() }
                    if (id != null && log != null && AfterCall.needsOutcome(log)) { leadId = id; mode = "outcome" } else finish()
                }
            }
        }
    }
}
