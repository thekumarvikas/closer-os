package com.closeros.app.ui

// Morning (8 AM) / evening (9:30 PM) summary: same model as the dashboard (web/src/lib/summary.ts) → screen,
// WhatsApp text (*bold* headings), picture (PNG) and PDF, shared through the phone's share sheet.

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.closeros.app.data.Repo
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

data class SumLine(val label: String, val value: String, val leadId: String? = null, val sub: String? = null)
data class SumSection(val title: String, val lines: List<SumLine>, val note: String? = null)
data class SumModel(val title: String, val sub: String, val sections: List<SumSection>)

private fun JsonObject.n(k: String) = this[k]?.jsonPrimitive?.doubleOrNull ?: 0.0
private fun JsonObject.i(k: String) = n(k).toInt()
private fun JsonObject.t(k: String) = this[k]?.jsonPrimitive?.contentOrNull
private fun hl(h: Int) = "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
private fun slot(h: Int) = "${hl(h)} – ${hl((h + 1) % 24)}"
private fun pct(a: Int, b: Int) = if (b > 0) a * 100 / b else 0
private fun d(sec: Int): String { val h = sec / 3600; val m = sec % 3600 / 60; return if (h > 0) "${h}h ${m}m" else if (m > 0) "${m}m ${sec % 60}s" else "${sec}s" }

/** Best hour: conversations, talk time and positive outcomes count equally (same rule as the reports). */
private fun bestHour(hours: List<JsonObject>): JsonObject? {
    val live = hours.filter { it.i("conn") > 0 || it.i("pos") > 0 }; if (live.isEmpty()) return null
    val mc = live.maxOf { it.i("conn") }.coerceAtLeast(1).toFloat(); val mt = live.maxOf { it.i("talk") }.coerceAtLeast(1).toFloat(); val mp = live.maxOf { it.i("pos") }
    fun sc(r: JsonObject) = (r.i("conn") / mc + r.i("talk") / mt + (if (mp > 0) r.i("pos") / mp.toFloat() else 0f)) / (if (mp > 0) 3 else 2)
    return live.sortedWith(compareByDescending<JsonObject> { sc(it) }.thenByDescending { it.i("conn") }).first()
}

fun buildSummary(s: JsonObject, currency: String): SumModel {
    val st = s["stats"]!!.jsonObject
    val tz = runCatching { ZoneId.of(s.t("tz")) }.getOrDefault(ZoneId.of("Asia/Kolkata"))
    val money = { v: Double -> java.text.NumberFormat.getCurrencyInstance(java.util.Locale("en", "IN")).apply {
        runCatching { this.currency = java.util.Currency.getInstance(currency) }; maximumFractionDigits = 0 }.format(v) }
    val morning = s.t("kind") == "morning"
    val done = mutableListOf<SumSection>()
    val res = if (morning) "Yesterday" else "Today"
    val dialled = st.i("dialled"); val missed = st.i("missed"); val open = st.i("missed_open"); val leads = st.i("leads")
    done += SumSection("$res · calls", listOf(
        SumLine("Dialled", "$dialled"),
        SumLine("Connected", "${st.i("connected")} of $dialled (${pct(st.i("connected"), dialled)}%)"),
        SumLine("Received", "${st.i("received")}"),
        SumLine("Missed", "$missed" + if (missed > 0) (if (open > 0) " ($open not called back)" else " (all called back)") else ""),
        SumLine("Talk time", d(st.i("talk")))))
    done += SumSection("$res · leads", listOf(
        SumLine("Total leads", "$leads"),
        SumLine("Connected", "${st.i("leads_connected")} of $leads (${pct(st.i("leads_connected"), leads)}%)"),
        SumLine("Talked 1 min or more", "${st.i("leads_1min")} of $leads (${pct(st.i("leads_1min"), leads)}%)")))
    done += SumSection("Results", listOfNotNull(
        SumLine("Sales", if (st.i("sales") > 0) "${st.i("sales")} · ${money(st.n("revenue"))}" else "0"),
        SumLine("Interested", "${st.i("interested")}"),
        if (st.i("call_later") > 0) SumLine("Asked to call later", "${st.i("call_later")}") else null,
        SumLine("Outcomes filled", "${st.i("conn_outcome")} of ${st.i("conversations")} connected calls")))
    bestHour((st["hours"] as? JsonArray)?.map { it.jsonObject } ?: emptyList())?.let {
        done += SumSection("Best hour", listOf(SumLine(slot(it.i("hr")), "${it.i("conn")} connected · ${d(it.i("talk"))}"))) }
    if (st.i("fu_due") > 0) done += SumSection("Follow-ups", listOfNotNull(
        SumLine("On time", "${st.i("fu_on_time")} of ${st.i("fu_due")}"),
        if (st.i("fu_late") > 0) SumLine("Late", "${st.i("fu_late")}") else null,
        if (st.i("fu_missed") > 0) SumLine("Not called", "${st.i("fu_missed")}") else null))
    (s["people"] as? JsonArray)?.map { it.jsonObject }?.takeIf { it.isNotEmpty() }?.let { people ->
        done += SumSection("Team", people.sortedWith(compareByDescending<JsonObject> { it["stats"]!!.jsonObject.i("talk") }.thenByDescending { it["stats"]!!.jsonObject.i("dialled") }).map { p ->
            val ps = p["stats"]!!.jsonObject; val sl = ps.i("sales")
            SumLine(p.t("name") ?: "Someone", if (ps.i("dialled") + ps.i("received") == 0) "no calls" else
                "${ps.i("dialled")} dialled · ${ps.i("leads_connected")} connected · ${d(ps.i("talk"))} · $sl sale${if (sl == 1) "" else "s"}")
        })
    }
    val pl = s["plan"]!!.jsonObject; val plan = mutableListOf<SumLine>()
    if (s["working_day"]?.jsonPrimitive?.booleanOrNull == false) plan += SumLine("Holiday", if (pl.i("follow_ups") > 0) "follow-ups are lined up if you want to call" else "no calls planned")
    plan += SumLine("Follow-ups due", "${pl.i("follow_ups")}")
    if (pl.i("overdue") > 0) plan += SumLine("Overdue from earlier", "${pl.i("overdue")}")
    if (open > 0) plan += SumLine("Missed callers to call back", "$open")
    if (pl.i("no_next") > 0) plan += SumLine("Interested, no next call planned", "${pl.i("no_next")}")
    (pl["webinars"] as? JsonArray)?.map { it.jsonObject }?.forEach { w ->
        val at = runCatching { com.closeros.app.data.parseInstant(w.t("at")!!).atZone(tz).format(DateTimeFormatter.ofPattern("h:mm a")) }.getOrDefault("")
        plan += SumLine(w.t("name") ?: "Webinar", "$at · ${w.i("leads")} leads to remind")
    }
    val hotObj = pl["hot"] as? JsonObject
    val ownerName = (s["people"] as? JsonArray)?.associate { it.jsonObject.t("user_id") to (it.jsonObject.t("name") ?: "") } ?: emptyMap()
    val team = s["team"]?.jsonPrimitive?.booleanOrNull == true
    plan += SumLine("Hot leads", "${hotObj?.i("total") ?: 0}")
    val out = mutableListOf(SumSection("${if (morning) "Today" else "Tomorrow"} · plan", plan))
    (hotObj?.get("list") as? JsonArray)?.map { it.jsonObject }?.takeIf { it.isNotEmpty() }?.let { hot ->
        fun whenTxt(k: String, h: JsonObject) = h.t(k)?.let { runCatching { com.closeros.app.data.parseInstant(it).atZone(tz).format(DateTimeFormatter.ofPattern("d MMM, h:mm a")) }.getOrNull() }
        out += SumSection("Hot leads · call first (${hotObj.i("total")})", hot.mapIndexed { i, h ->
            val why = (h["why"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }?.joinToString(" · ")?.ifBlank { null } ?: "Engaged"
            val calls = h.i("calls"); val wa = h.i("wa")
            val done = (if (calls > 0) "$calls call${if (calls > 1) "s" else ""} · ${h.i("connected")} connected · ${d(h.i("talk"))} talk" else "Not called yet") + (if (wa > 0) " · $wa WhatsApp" else "")
            val whenLine = listOfNotNull(whenTxt("last_talk", h)?.let { "Last talked $it" }, whenTxt("next", h)?.let { "Next call $it" }).joinToString(" · ")
            val owner = if (team) ownerName[h.t("owner")]?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "" else ""
            SumLine("${i + 1}. ${h.t("name") ?: ""}$owner", "$why — $done", leadId = h.t("lead_id"), sub = whenLine.ifBlank { null })
        }, note = "Hot = marked Hot or Ready to pay, interested on a recent call, talked 5+ min, called us back, or very engaged in a webinar in the last 14 days (watched most of it, saw the pitch, chatted, answered polls, registered again).")
    }
    // Morning: today's tasks first, yesterday below. Evening: today's results first, then tomorrow.
    if (morning) out.addAll(done) else out.addAll(0, done)
    fun dn(k: String) = runCatching { LocalDate.parse(s.t(k)).format(DateTimeFormatter.ofPattern("EEE, d MMM")) }.getOrDefault(s.t(k) ?: "")
    val day = "Plan for ${dn("plan_day")} · Results of ${dn("day")}"
    val who = if (s["team"]?.jsonPrimitive?.booleanOrNull == true) "${s.t("org_name")} · Team" else s.t("who") ?: ""
    return SumModel("${if (morning) "Morning" else "Evening"} summary", "$who · $day · ${ZonedDateTime.now(tz).format(DateTimeFormatter.ofPattern("h:mm a"))}", out)
}

fun summaryText(m: SumModel) = (listOf("*Closer OS · ${m.title}*", m.sub) +
    m.sections.flatMap { s ->
        // Hot leads: the first 10 per owner in the WhatsApp text; the rest stay in the app / image / PDF.
        val per = mutableMapOf<String, Int>(); var more = 0
        val lines = if (!s.title.startsWith("Hot leads")) s.lines else s.lines.filter { l ->
            val k = Regex("\\(([^)]*)\\)$").find(l.label)?.groupValues?.get(1) ?: ""; val n = (per[k] ?: 0) + 1; per[k] = n
            (n <= 10).also { if (!it) more++ } }
        listOf("", "*${s.title}*") + listOfNotNull(s.note?.let { "_${it}_" }) + lines.map { "${it.label}: ${it.value}" } +
            (if (more > 0) listOf("+$more more — open Closer OS") else emptyList())
    }).joinToString("\n")

/** Phone-sized picture of the summary (same look as the dashboard's image). */
fun summaryBitmap(m: SumModel): Bitmap {
    val w = 1080; val pad = 64f; val row = 56
    fun wrap(t: String): List<String> { val out = mutableListOf<String>(); var line = ""; t.split(' ').forEach { w -> if (("$line $w").length > 62) { out += line; line = w } else line = if (line.isEmpty()) w else "$line $w" }; if (line.isNotEmpty()) out += line; return out }
    val h = 260 + m.sections.sumOf { sec -> 90 + sec.lines.sumOf { if (it.value.length > 44) 56 + wrap(it.value).size * 36 + 14 else row } + (sec.note?.let { n -> wrap(n).size * 40 + 16 } ?: 0) } + 80
    val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888); val c = Canvas(b)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    c.drawColor(0xFFFFFFFF.toInt()); p.color = 0xFF0E5E57.toInt(); c.drawRect(0f, 0f, w.toFloat(), 200f, p)
    fun txt(s: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean, right: Boolean = false) {
        p.textSize = size; p.color = color; p.typeface = Typeface.create(Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL)
        p.textAlign = if (right) Paint.Align.RIGHT else Paint.Align.LEFT; c.drawText(s, x, y, p)
    }
    txt("Closer OS", pad, 70f, 30f, 0xFFFFFFFF.toInt(), true); txt(m.title, pad, 135f, 54f, 0xFFFFFFFF.toInt(), true); txt(m.sub, pad, 180f, 28f, 0xFFCFE7E3.toInt(), false)
    var y = 270f
    m.sections.forEach { s ->
        txt(s.title.uppercase(), pad, y, 32f, 0xFF0E5E57.toInt(), true)
        p.color = 0xFFE3E7EE.toInt(); c.drawRect(pad, y + 18, w - pad, y + 20, p); y += 70
        s.note?.let { n -> wrap(n).forEach { ln -> txt(ln, pad, y, 26f, 0xFF6B7280.toInt(), false); y += 40 }; y += 16 }
        s.lines.forEach { l ->
            if (l.value.length > 44) {
                txt(l.label, pad, y, 30f, 0xFF1D2433.toInt(), true); y += 42
                wrap(l.value).forEach { ln -> txt(ln, pad + 24, y, 26f, 0xFF4A5263.toInt(), false); y += 36 }
                y += 14; return@forEach
            }
            txt(if (l.label.length > 36) l.label.take(35) + "…" else l.label, pad, y, 30f, 0xFF4A5263.toInt(), false)
            txt(l.value, w - pad, y, 30f, 0xFF1D2433.toInt(), true, right = true); y += row
        }
        y += 20
    }
    txt("Made with Closer OS", pad, h - 40f, 24f, 0xFF98A2B3.toInt(), false)
    return b
}

private fun shareFile(ctx: Context, f: File, mime: String) {
    val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
    val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { ctx.startActivity(Intent.createChooser(i, "Share summary").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Save to the phone's Downloads folder. */
fun downloadSummary(ctx: Context, m: SumModel, pdf: Boolean) {
    val name = "${m.title.replace(' ', '-').lowercase()}-${System.currentTimeMillis() / 1000}.${if (pdf) "pdf" else "png"}"
    val mime = if (pdf) "application/pdf" else "image/png"
    runCatching {
        val write: (java.io.OutputStream) -> Unit = { os ->
            if (pdf) {
                val bmp = summaryBitmap(m); val doc = PdfDocument(); val pw = 595; val ph = 595 * bmp.height / bmp.width
                val page = doc.startPage(PdfDocument.PageInfo.Builder(pw, ph, 1).create())
                page.canvas.drawBitmap(bmp, null, android.graphics.Rect(0, 0, pw, ph), Paint(Paint.FILTER_BITMAP_FLAG)); doc.finishPage(page)
                doc.writeTo(os); doc.close()
            } else summaryBitmap(m).compress(Bitmap.CompressFormat.PNG, 100, os)
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val v = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
            }
            val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
            ctx.contentResolver.openOutputStream(uri)!!.use(write)
        } else {
            val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
            File(dir, name).outputStream().use(write)
        }
        Toast.makeText(ctx, "Saved in Downloads: $name", Toast.LENGTH_LONG).show()
    }.onFailure { if (pdf) shareSummaryPdf(ctx, m) else shareSummaryImage(ctx, m) }
}

fun shareSummaryImage(ctx: Context, m: SumModel) {
    val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    val f = File(dir, "${m.title.replace(' ', '-').lowercase()}.png")
    f.outputStream().use { summaryBitmap(m).compress(Bitmap.CompressFormat.PNG, 100, it) }
    shareFile(ctx, f, "image/png")
}

fun shareSummaryPdf(ctx: Context, m: SumModel) {
    val bmp = summaryBitmap(m)
    val doc = PdfDocument(); val pw = 595; val ph = 595 * bmp.height / bmp.width
    val page = doc.startPage(PdfDocument.PageInfo.Builder(pw, ph, 1).create())
    page.canvas.drawBitmap(bmp, null, android.graphics.Rect(0, 0, pw, ph), Paint(Paint.FILTER_BITMAP_FLAG)); doc.finishPage(page)
    val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    val f = File(dir, "${m.title.replace(' ', '-').lowercase()}.pdf"); f.outputStream().use { doc.writeTo(it) }; doc.close()
    shareFile(ctx, f, "application/pdf")
}

@Composable
fun SummaryScreen(vm: AppViewModel, initialKind: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val m = vm.membership ?: return
    var kind by remember { mutableStateOf(initialKind) }
    val team = vm.isManager && !vm.isSolo
    var who by remember { mutableStateOf(if (team) "team" else "me") }
    var data by remember { mutableStateOf<SumModel?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(kind, who) {
        data = null; error = null
        runCatching { buildSummary(Repo.dailySummary(m.org_id, kind, if (who == "me") null else who), m.organization.currency) }
            .onSuccess { data = it }.onFailure { error = com.closeros.app.data.SafeError.forUser(it, "Couldn't load the summary") }
    }
    Column(Modifier.fillMaxSize().background(Brand.bg)) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 8.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") }
            Text(if (kind == "morning") "Morning summary" else "Evening summary", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(kind == "morning", { kind = "morning" }, { Text("☀️ Morning · 8 AM") })
            FilterChip(kind == "evening", { kind = "evening" }, { Text("🌙 Evening · 9:30 PM") })
            if (team) { FilterChip(who == "team", { who = "team" }, { Text("Team") }); FilterChip(who == "me", { who = "me" }, { Text("Me") }) }
        }
        val dm = data
        if (dm == null) { Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { if (error != null) Text(error!!, color = Brand.muted) else CircularProgressIndicator() }; return@Column }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Summary", summaryText(dm)))
                Toast.makeText(ctx, "Copied — paste it in WhatsApp", Toast.LENGTH_SHORT).show()
            }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Copy text", maxLines = 1) }
            OutlinedButton({ shareSummaryImage(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send image", maxLines = 1) }
            OutlinedButton({ shareSummaryPdf(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send PDF", maxLines = 1) }
        }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ downloadSummary(ctx, dm, false) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download image", maxLines = 1) }
            OutlinedButton({ downloadSummary(ctx, dm, true) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download PDF", maxLines = 1) }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
            Card(shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = androidx.compose.ui.graphics.Color.White)) {
                Column(Modifier.padding(16.dp)) {
                    Text(dm.sub, fontSize = 12.sp, color = Brand.muted)
                    dm.sections.forEach { s ->
                        Text(s.title.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = Brand.primary, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
                        s.note?.let { Text(it, fontSize = 12.sp, color = Brand.muted, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic, modifier = Modifier.padding(bottom = 4.dp)) }
                        s.lines.forEach { l ->
                            if (l.leadId != null) Column(Modifier.fillMaxWidth().clickable { vm.openLeadId = l.leadId }.padding(vertical = 6.dp)) {
                                Text(l.label, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Brand.primary)
                                Text(l.value, fontSize = 13.sp)
                                l.sub?.let { Text(it, fontSize = 12.sp, color = Brand.muted) }
                            } else Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                                Text(l.label, Modifier.weight(1f), fontSize = 14.sp, color = Brand.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(l.value, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End)
                            }
                        }
                    }
                }
            }
        }
    }
}
