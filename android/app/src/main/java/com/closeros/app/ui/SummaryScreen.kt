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
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
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

data class SumLine(val label: String, val value: String, val leadId: String? = null, val sub: String? = null, val phone: String? = null,
    val short: String? = null, val owner: String? = null, val cat: Int = 0, val name: String? = null)
data class SumSection(val title: String, val lines: List<SumLine>, val note: String? = null)
data class SumCard(val header: String, val sub: String, val planTitle: String, val plan: List<String>, val hotTotal: Int, val cols: List<String>,
    val grid: List<Triple<String, List<Int>, Int>>, val top: List<SumLine>, val resultsTitle: String, val yesterday: List<String>,
    val team: List<List<String>>, val noCalls: List<String>)
data class SumModel(val title: String, val sub: String, val sections: List<SumSection>, val hotTotal: Int = 0, val hotShown: Int = 0,
    val card: SumCard? = null, val hot: List<SumLine> = emptyList(), val teamView: Boolean = false)
fun fmtPh(p: String?) = p?.let { Regex("^\\+91(\\d{5})(\\d{5})$").find(it)?.let { m -> "+91 ${m.groupValues[1]} ${m.groupValues[2]}" } ?: it } ?: ""

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

val HOT_CATS = mapOf(1 to "Ready to pay", 2 to "Hot", 3 to "Interested", 4 to "Positive — follow up",
    5 to "Came back + active in Zoom", 6 to "Came back (attended 2+ webinars)", 7 to "Active in Zoom once", 8 to "Talked, not tagged yet — ask the team member")
fun hotGroup(c: Int) = if (c <= 4) "🔥 Hot — tagged or positive outcome" else if (c <= 7) "⭐ Potentially hot — attended, not talked to yet" else "❓ Talked, not tagged yet"
const val HOT_NOTE = "Hot = tagged Ready to pay / Hot / Interested or a positive outcome. Potentially hot = attended webinars (2+ times, or chatted / answered polls) but nobody has talked to them yet. Inside each category: most webinar minutes first, then most talk time with the team."

/** Hot leads grouped by category (same rules as the dashboard). */
fun hotSections(list: List<JsonObject>, total: Int, tz: ZoneId, team: Boolean, nameOf: (String?) -> String): List<SumSection> {
    fun whenTxt(v: String?, pat: String) = v?.let { runCatching { com.closeros.app.data.parseInstant(it).atZone(tz).format(DateTimeFormatter.ofPattern(pat)) }.getOrNull() }
    val out = mutableListOf<SumSection>(); var title = ""; var lines = mutableListOf<SumLine>()
    list.forEachIndexed { i, h ->
        val cat = h.i("cat"); val owner = nameOf(h.t("owner"))
        val why = when { cat == 8 -> "Not tagged yet — ask ${owner.ifBlank { "the team member" }}"; cat >= 5 -> HOT_CATS[cat] ?: ""
            else -> listOfNotNull(h.t("tag"), h.t("outcome")).joinToString(" · ").ifBlank { HOT_CATS[cat] ?: "" } }
        val att = h.i("att"); val watch = h.i("watch"); val best = h.i("best")
        val activity = listOfNotNull("Registered ${h.i("reg")}× · attended $att×",
            if (watch > 0) "watched $watch min" + (if (att > 1 && best > 0) " (best $best min, ${whenTxt(h.t("best_at"), "d MMM")})" else "") else null,
            if (h["pitch"]?.jsonPrimitive?.booleanOrNull == true) "saw the pitch" else null,
            h.i("chats").takeIf { it > 0 }?.let { "$it chat${if (it > 1) "s" else ""}" }, if (h.i("polls") > 0) "answered polls" else null).joinToString(" · ")
        val by = (h["talk_by"] as? JsonArray)?.map { it.jsonObject }?.filter { it.i("sec") > 0 } ?: emptyList()
        val talkSec = h.i("talk")
        val talk = if (talkSec > 0) "Talked ${talkSec / 60} min" + (if (by.size > 1) " (" + by.joinToString(", ") { "${nameOf(it.t("user")).substringBefore(' ')} ${it.i("sec") / 60} min" } + ")" else "") else "Not talked yet"
        val calls = h.i("calls"); val wa = h.i("wa")
        val done = listOfNotNull(talk, "$calls call${if (calls == 1) "" else "s"}", if (wa > 0) "$wa WhatsApp" else null).joinToString(" · ")
        val whenLine = listOfNotNull(whenTxt(h.t("last_talk"), "d MMM, h:mm a")?.let { "Last talked $it" }, whenTxt(h.t("next"), "d MMM, h:mm a")?.let { "Next call $it" }).joinToString(" · ")
        val t = "${hotGroup(cat)} · ${HOT_CATS[cat]}"
        if (t != title) { if (lines.isNotEmpty()) out += SumSection(title, lines); title = t; lines = mutableListOf() }
        val short = listOfNotNull(if (watch > 0) "$watch min" else null, if (h["pitch"]?.jsonPrimitive?.booleanOrNull == true) "✓ pitch" else null,
            h.i("chats").takeIf { it > 0 }?.let { "$it chat${if (it > 1) "s" else ""}" }, if (h.i("polls") > 0) "polls" else null,
            if (att > 1) "attended $att×" else null, if (h.i("reg") > 1) "registered ${h.i("reg")}×" else null,
            if (talkSec > 0) "talked " + (if (talkSec < 60) "${talkSec}s" else "${talkSec / 60}m") else "not talked",
            "$calls call${if (calls == 1) "" else "s"}", if (wa > 0) "$wa WA" else null).joinToString(" · ")
        lines += SumLine("${i + 1}. ${h.t("name") ?: ""}" + (if (team && owner.isNotBlank()) " ($owner)" else ""), "$why — $activity — $done",
            leadId = h.t("lead_id"), sub = whenLine.ifBlank { null }, phone = fmtPh(h.t("phone")), short = short, owner = owner, cat = cat, name = h.t("name"))
    }
    if (lines.isNotEmpty()) out += SumSection(title, lines)
    if (out.isNotEmpty()) out[0] = out[0].copy(note = HOT_NOTE)
    if (total > list.size) out += SumSection("+${total - list.size} more hot leads", listOf(SumLine("Open Closer OS", "to see all and download")))
    return out
}

fun buildSummary(s: JsonObject, currency: String, hotOverride: JsonObject? = null): SumModel {
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
        SumLine("Connected calls", "${st.i("connected")} of $dialled dialled (${pct(st.i("connected"), dialled)}%)"),
        SumLine("Received", "${st.i("received")}"),
        SumLine("Missed", "$missed" + if (missed > 0) (if (open > 0) " ($open not called back)" else " (all called back)") else ""),
        SumLine("Talk time", d(st.i("talk")))))
    done += SumSection("$res · leads", listOf(
        SumLine("Total leads", "$leads"),
        SumLine("Leads connected", "${st.i("leads_connected")} of $leads (${pct(st.i("leads_connected"), leads)}%)"),
        SumLine("Talked 1 min or more", "${st.i("leads_1min")} of $leads (${pct(st.i("leads_1min"), leads)}%)")))
    done += SumSection("Results", listOfNotNull(
        SumLine("Sales", if (st.i("sales") > 0) "${st.i("sales")} · ${money(st.n("revenue"))}" else "0"),
        SumLine("Interested", "${st.i("interested")}"),
        if (st.i("call_later") > 0) SumLine("Asked to call later", "${st.i("call_later")}") else null,
        SumLine("Outcomes saved", "${st.i("conn_outcome")} of ${st.i("conversations")} calls that connected (dialled + received)")))
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
                "${ps.i("dialled")} dialled · ${ps.i("leads_connected")} leads connected · ${d(ps.i("talk"))} · $sl sale${if (sl == 1) "" else "s"}")
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
    val hotObj = hotOverride ?: (pl["hot"] as? JsonObject)
    val ownerName = (s["people"] as? JsonArray)?.associate { it.jsonObject.t("user_id") to (it.jsonObject.t("name") ?: "") } ?: emptyMap()
    val team = s["team"]?.jsonPrimitive?.booleanOrNull == true
    plan += SumLine("Hot leads", "${hotObj?.i("total") ?: 0}")
    val out = mutableListOf(SumSection("${if (morning) "Today" else "Tomorrow"} · plan", plan))
    val hotList = (hotObj?.get("list") as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    out += hotSections(hotList, hotObj?.i("total") ?: 0, tz, team) { ownerName[it] ?: "" }
    // Morning: today's tasks first, yesterday below. Evening: today's results first, then tomorrow.
    if (morning) out.addAll(done) else out.addAll(0, done)
    fun dn(k: String) = runCatching { LocalDate.parse(s.t(k)).format(DateTimeFormatter.ofPattern("EEE, d MMM")) }.getOrDefault(s.t(k) ?: "")
    val day = "Plan for ${dn("plan_day")} · Results of ${dn("day")}"
    val who = if (s["team"]?.jsonPrimitive?.booleanOrNull == true) "${s.t("org_name")} · Team" else s.t("who") ?: ""
    val hotLines = out.filter { it.title.startsWith("🔥") || it.title.startsWith("⭐") || it.title.startsWith("❓") }.flatMap { it.lines }
    val byCat = hotObj?.get("by_cat") as? JsonObject
    val byOwner = (hotObj?.get("by_owner") as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    val owners = if (team) byOwner.map { it.t("owner") }.distinct().sortedBy { ownerName[it] ?: "" } else emptyList()
    val grid = (1..8).filter { (byCat?.i(it.toString()) ?: 0) > 0 }.map { c ->
        Triple((if (c <= 4) "🔥 " else if (c <= 7) "⭐ " else "❓ ") + (if (c == 8) "Not tagged yet" else HOT_CATS[c] ?: ""),
            owners.map { o -> byOwner.firstOrNull { it.t("owner") == o && it.i("cat") == c }?.i("n") ?: 0 }, byCat?.i(c.toString()) ?: 0) }
    val people = (s["people"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()
    val withCalls = people.filter { val ps = it["stats"]!!.jsonObject; ps.i("dialled") + ps.i("received") > 0 }
        .sortedByDescending { it["stats"]!!.jsonObject.i("talk") }
    val card = SumCard("${if (morning) "Morning" else "Evening"} summary", "${if (team) s.t("org_name") else s.t("who") ?: ""} · ${dn("plan_day")}",
        "${if (morning) "Today" else "Tomorrow"} · plan",
        listOf(listOfNotNull("Follow-ups due ${pl.i("follow_ups")}", if (pl.i("overdue") > 0) "Overdue ${pl.i("overdue")}" else null,
            if (open > 0) "Missed callers $open" else null, if (pl.i("no_next") > 0) "Interested, no next call ${pl.i("no_next")}" else null).joinToString(" · ")) +
            ((pl["webinars"] as? JsonArray)?.map { it.jsonObject }?.map { w -> "${w.t("name")} ${runCatching { com.closeros.app.data.parseInstant(w.t("at")!!).atZone(tz).format(DateTimeFormatter.ofPattern("h:mm a")) }.getOrDefault("")} · ${w.i("leads")} to remind" } ?: emptyList()),
        hotObj?.i("total") ?: 0, owners.map { (ownerName[it] ?: "").substringBefore(' ').ifBlank { "Unassigned" } }, grid,
        if (team) emptyList() else hotLines.take(5), res,
        listOf("Dialled $dialled · Connected ${pct(st.i("connected"), dialled)}% · Leads connected ${st.i("leads_connected")}",
            "Talk ${d(st.i("talk"))} · Outcomes saved ${st.i("conn_outcome")} of ${st.i("conversations")} · Sales ${st.i("sales")}"),
        withCalls.map { val ps = it["stats"]!!.jsonObject; listOf(it.t("name") ?: "", "${ps.i("dialled")}", "${ps.i("leads_connected")}", d(ps.i("talk")), "${ps.i("sales")}") },
        people.filter { it !in withCalls }.map { it.t("name") ?: "" })
    return SumModel("${if (morning) "Morning" else "Evening"} summary", "$who · $day · ${ZonedDateTime.now(tz).format(DateTimeFormatter.ofPattern("h:mm a"))}", out,
        hotTotal = hotObj?.i("total") ?: 0, hotShown = hotList.size, card = card, hot = hotLines, teamView = team)
}

fun summaryText(m: SumModel): String {
    val out = mutableListOf("*Closer OS · ${m.title}*", m.sub)
    for (sec in m.sections) {
        if (sec.title.startsWith("🔥") || sec.title.startsWith("⭐") || sec.title.startsWith("❓") || sec.title.startsWith("+")) continue
        out += ""; out += "*${sec.title}*"; sec.lines.forEach { out += "${it.label}: ${it.value}" }
        if (sec.title.endsWith("· plan") && m.hot.isNotEmpty()) {
            m.hot.groupBy { it.owner ?: "" }.forEach { (o, rows) ->
                out += ""; out += "*🔥 Hot leads${if (m.teamView && o.isNotBlank()) " — $o" else ""} (${rows.size})*"
                var cat = 0
                rows.forEachIndexed { i, r ->
                    if (r.cat != cat) { cat = r.cat; out += "_${HOT_CATS[cat]}_" }
                    out += "${i + 1}. ${r.name ?: ""} · ${r.phone ?: ""}"; out += "    ${r.short ?: ""}"
                }
            }
            if (m.hotTotal > m.hotShown) out += "+${m.hotTotal - m.hotShown} more — open Closer OS"
        }
    }
    return out.joinToString("\n")
}

/** ONE phone-shaped picture (4:5, drawn at 2× so WhatsApp keeps it sharp): numbers only. */
fun summaryBitmap(m: SumModel): Bitmap {
    val k = m.card ?: return listBitmap(m).first
    val w = 1080f; val pad = 56f; val sc = 2f
    val colW = 120f; val labW = w - pad * 2 - (k.cols.size + 1) * colW
    var need = 230f + 60 + k.plan.size * 44 + 40
    if (k.hotTotal > 0) need += 70 + (if (k.cols.isNotEmpty()) 50 else 0) + k.grid.size * 52 + (if (k.top.isNotEmpty()) 30 + k.top.size * 76 else 0) + 30
    need += 60 + k.yesterday.size * 46 + 30
    if (k.team.isNotEmpty()) need += 60 + 46 + k.team.size * 48 + (if (k.noCalls.isNotEmpty()) 50 else 0)
    need += 70
    val h = maxOf(w * 1.25f, need)
    val b = Bitmap.createBitmap((w * sc).toInt(), (h * sc).toInt(), Bitmap.Config.ARGB_8888); val c = Canvas(b); c.scale(sc, sc)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    fun t(s: String, x: Float, y: Float, size: Float, color: Long, bold: Boolean = false, right: Boolean = false) {
        p.textSize = size; p.color = color.toInt(); p.typeface = Typeface.create(Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL)
        p.textAlign = if (right) Paint.Align.RIGHT else Paint.Align.LEFT; c.drawText(s, x, y, p)
    }
    fun head(s: String, y: Float) { t(s.uppercase(), pad, y, 26f, 0xFF0E5E57, true); p.color = 0xFFE3E7EE.toInt(); c.drawRect(pad, y + 14, w - pad, y + 16, p) }
    c.drawColor(0xFFFFFFFF.toInt()); p.color = 0xFF0E5E57.toInt(); c.drawRect(0f, 0f, w, 190f, p)
    t("Closer OS", pad, 62f, 28f, 0xFFCFE7E3, true); t(k.header, pad, 122f, 52f, 0xFFFFFFFF, true); t(k.sub, pad, 165f, 28f, 0xFFCFE7E3)
    var y = 250f
    head(k.planTitle, y); y += 58
    k.plan.forEach { t(it, pad, y, 30f, 0xFF1D2433); y += 44 }
    y += 30
    if (k.hotTotal > 0) {
        head("Hot leads · ${k.hotTotal}", y); y += 56
        fun colX(i: Int) = pad + labW + colW * i + colW
        if (k.cols.isNotEmpty()) { k.cols.forEachIndexed { i, n -> t(if (n.length > 8) n.take(7) + "…" else n, colX(i), y, 24f, 0xFF6B7280, true, true) }; t("Total", colX(k.cols.size), y, 24f, 0xFF6B7280, true, true); y += 48 }
        k.grid.forEach { (label, vals, total) ->
            t(label, pad, y, 30f, 0xFF1D2433)
            vals.forEachIndexed { i, v -> t("$v", colX(i), y, 30f, if (v > 0) 0xFF1D2433 else 0xFFC3C9D4, true, true) }
            t("$total", if (k.cols.isNotEmpty()) colX(k.cols.size) else w - pad, y, 32f, 0xFF0E5E57, true, true); y += 52
        }
        if (k.top.isNotEmpty()) {
            y += 14; t("Call first", pad, y, 24f, 0xFF6B7280, true); y += 40
            k.top.forEachIndexed { i, r -> t("${i + 1}. ${r.name ?: ""}", pad, y, 30f, 0xFF1D2433, true); t(r.phone ?: "", w - pad, y, 26f, 0xFF0E5E57, false, true); y += 34
                val sh = r.short ?: ""; t(if (sh.length > 60) sh.take(59) + "…" else sh, pad + 30, y, 24f, 0xFF4A5263); y += 42 }
        }
        y += 26
    }
    head(k.resultsTitle, y); y += 58
    k.yesterday.forEach { t(it, pad, y, 28f, 0xFF1D2433); y += 46 }
    y += 26
    if (k.team.isNotEmpty()) {
        head("Team", y); y += 54
        val cx = listOf(w - pad - 390, w - pad - 250, w - pad - 110, w - pad)
        listOf("Dialled", "Leads conn.", "Talk", "Sales").forEachIndexed { i, s -> t(s, cx[i], y, 22f, 0xFF6B7280, true, true) }; y += 44
        k.team.forEach { r -> t(if (r[0].length > 22) r[0].take(21) + "…" else r[0], pad, y, 28f, 0xFF1D2433)
            (1..4).forEach { i -> t(r[i], cx[i - 1], y, 28f, 0xFF1D2433, true, true) }; y += 48 }
        if (k.noCalls.isNotEmpty()) { y += 6; t("No calls: ${k.noCalls.joinToString(", ")}".take(80), pad, y, 24f, 0xFF6B7280); y += 44 }
    }
    t("Made with Closer OS", pad, h - 34, 22f, 0xFF98A2B3)
    return b
}

data class TelLink(val x: Float, val y: Float, val w: Float, val h: Float, val phone: String)

/** Long picture of every section (inside the PDF) + where each phone number was drawn (tap-to-call). */
fun listBitmap(m: SumModel): Pair<Bitmap, List<TelLink>> {
    val links = mutableListOf<TelLink>()
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
                txt(l.label, pad, y, 30f, 0xFF1D2433.toInt(), true)
                l.phone?.takeIf { it.isNotBlank() }?.let { ph ->
                    p.textSize = 30f; p.typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                    val x = pad + p.measureText(l.label + "   ")
                    txt("📞 $ph", x, y, 28f, 0xFF0B63C5.toInt(), true)
                    p.textSize = 28f; links += TelLink(x - 6, y - 30, p.measureText("📞 $ph") + 12, 40f, ph.filter { it.isDigit() || it == '+' })
                }
                y += 42
                wrap(l.value).forEach { ln -> txt(ln, pad + 24, y, 26f, 0xFF4A5263.toInt(), false); y += 36 }
                y += 14; return@forEach
            }
            txt(if (l.label.length > 36) l.label.take(35) + "…" else l.label, pad, y, 30f, 0xFF4A5263.toInt(), false)
            txt(l.value, w - pad, y, 30f, 0xFF1D2433.toInt(), true, right = true); y += row
        }
        y += 20
    }
    txt("Made with Closer OS", pad, h - 40f, 24f, 0xFF98A2B3.toInt(), false)
    return b to links
}

/** One-page PDF of the full list with tap-to-call links (written by hand: Android's PdfDocument can't add links). */
fun summaryPdf(m: SumModel): ByteArray {
    val (bmp, links) = listBitmap(m)
    val jpg = java.io.ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    val pw = 595f; val ph = 595f * bmp.height / bmp.width; val k = pw / bmp.width
    val out = java.io.ByteArrayOutputStream(); val offs = IntArray(6)
    fun add(s: String) = out.write(s.toByteArray(Charsets.ISO_8859_1))
    fun obj(n: Int, body: () -> Unit) { offs[n] = out.size(); add("$n 0 obj\n"); body(); add("\nendobj\n") }
    fun f(v: Float) = String.format(java.util.Locale.US, "%.1f", v)
    add("%PDF-1.4\n")
    obj(1) { add("<< /Type /Catalog /Pages 2 0 R >>") }
    obj(2) { add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>") }
    val annots = links.joinToString(" ") { l -> "<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${f(l.x * k)} ${f(ph - (l.y + l.h) * k)} ${f((l.x + l.w) * k)} ${f(ph - l.y * k)}] /A << /S /URI /URI (tel:${l.phone}) >> >>" }
    obj(3) { add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R /Annots [$annots] >>") }
    obj(4) { add("<< /Type /XObject /Subtype /Image /Width ${bmp.width} /Height ${bmp.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.size} >>\nstream\n"); out.write(jpg); add("\nendstream") }
    val content = "q ${f(pw)} 0 0 ${f(ph)} 0 0 cm /Im0 Do Q"
    obj(5) { add("<< /Length ${content.length} >>\nstream\n$content\nendstream") }
    val xref = out.size()
    add("xref\n0 6\n0000000000 65535 f \n" + (1..5).joinToString("") { String.format(java.util.Locale.US, "%010d 00000 n \n", offs[it]) } +
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$xref\n%%EOF")
    return out.toByteArray()
}

private fun shareFile(ctx: Context, f: File, mime: String) {
    val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
    val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { ctx.startActivity(Intent.createChooser(i, "Share summary").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Full hot-leads list as a CSV in Downloads (every detail). */
fun saveHotCsv(ctx: Context, full: JsonObject, people: Map<String?, String>, tz: ZoneId) {
    fun q(v: Any?) = "\"" + (v?.toString() ?: "").replace("\"", "\"\"") + "\""
    fun t(v: String?) = v?.let { runCatching { com.closeros.app.data.parseInstant(it).atZone(tz).format(DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a")) }.getOrNull() } ?: ""
    val sb = StringBuilder("#,Category,Lead,Phone,Owner,Tag,Outcome,Registered,Attended,Watched (min),Best (min),Best webinar,Saw the pitch,Chats,Polls,Talk (min),Talk by team member,Calls,WhatsApp,Last talked,Next call\n")
    ((full["list"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()).forEachIndexed { i, h ->
        val by = (h["talk_by"] as? JsonArray)?.map { it.jsonObject }?.joinToString("; ") { "${people[it.t("user")] ?: ""} ${it.i("sec") / 60}m" } ?: ""
        sb.append(listOf(i + 1, HOT_CATS[h.i("cat")], h.t("name"), h.t("phone"), people[h.t("owner")] ?: "", h.t("tag"), h.t("outcome"), h.i("reg"), h.i("att"),
            h.i("watch"), h.i("best"), t(h.t("best_at")), if (h["pitch"]?.jsonPrimitive?.booleanOrNull == true) "yes" else "", h.i("chats"), h.i("polls"),
            h.i("talk") / 60, by, h.i("calls"), h.i("wa"), t(h.t("last_talk")), t(h.t("next"))).joinToString(",") { q(it) }).append('\n')
    }
    saveToDownloads(ctx, "hot-leads-${System.currentTimeMillis() / 1000}.csv", "text/csv") { it.write(sb.toString().toByteArray()) }
}

fun saveToDownloads(ctx: Context, name: String, mime: String, write: (java.io.OutputStream) -> Unit) {
    runCatching {
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val v = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime) }
            val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
            ctx.contentResolver.openOutputStream(uri)!!.use(write)
        } else {
            val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
            File(dir, name).outputStream().use(write)
        }
        Toast.makeText(ctx, "Saved in Downloads: $name", Toast.LENGTH_LONG).show()
    }.onFailure {
        val f = File(File(ctx.cacheDir, "shared").apply { mkdirs() }, name); f.outputStream().use(write); shareFile(ctx, f, mime)
    }
}

/** Save to the phone's Downloads folder. */
fun downloadSummary(ctx: Context, m: SumModel, pdf: Boolean) {
    val name = "${m.title.replace(' ', '-').lowercase()}-${System.currentTimeMillis() / 1000}.${if (pdf) "pdf" else "png"}"
    val mime = if (pdf) "application/pdf" else "image/png"
    runCatching {
        val write: (java.io.OutputStream) -> Unit = { os ->
            if (pdf) os.write(summaryPdf(m)) else summaryBitmap(m).compress(Bitmap.CompressFormat.PNG, 100, os)
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
    val dir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    val f = File(dir, "${m.title.replace(' ', '-').lowercase()}.pdf"); f.writeBytes(summaryPdf(m))
    shareFile(ctx, f, "application/pdf")
}

@Composable
fun SummaryScreen(vm: AppViewModel, initialKind: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val m = vm.membership ?: return
    var kind by remember { mutableStateOf(initialKind) }
    val team = vm.isManager && !vm.isSolo
    var who by remember { mutableStateOf(if (team) "team" else "me") }
    var raw by remember { mutableStateOf<JsonObject?>(null) }
    var allHot by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(kind, who) {
        raw = null; allHot = null; error = null
        runCatching { Repo.dailySummary(m.org_id, kind, if (who == "me") null else who) }
            .onSuccess { raw = it }.onFailure { error = com.closeros.app.data.SafeError.forUser(it, "Couldn't load the summary") }
    }
    val data = remember(raw, allHot) { raw?.let { r -> runCatching { buildSummary(r, m.organization.currency, allHot) }.getOrNull() } }
    suspend fun fetchAll(): JsonObject? = runCatching { Repo.hotLeadsAll(m.org_id, if (who == "me" || who == "team") null else who) }
        .onFailure { Toast.makeText(ctx, com.closeros.app.data.SafeError.forUser(it, "Couldn't load the hot leads"), Toast.LENGTH_LONG).show() }.getOrNull()
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
            if (vm.isManager || vm.isSolo) {
                OutlinedButton({ shareSummaryImage(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send image", maxLines = 1) }
                OutlinedButton({ shareSummaryPdf(ctx, dm) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Send PDF", maxLines = 1) }
            }
        }
        Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ downloadSummary(ctx, dm, false) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download image", maxLines = 1) }
            OutlinedButton({ downloadSummary(ctx, dm, true) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Download PDF", maxLines = 1) }
        }
        if (dm.hotTotal > 0) Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (dm.hotShown < dm.hotTotal) OutlinedButton({ scope.launch { fetchAll()?.let { allHot = it } } }, Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Show all ${dm.hotTotal} hot leads", maxLines = 1) }
            OutlinedButton({ scope.launch {
                val full = allHot ?: fetchAll() ?: return@launch
                allHot = full
                val people = (raw?.get("people") as? JsonArray)?.associate { it.jsonObject.t("user_id") to (it.jsonObject.t("name") ?: "") } ?: emptyMap()
                saveHotCsv(ctx, full, people, ZoneId.of(raw?.t("tz") ?: "Asia/Kolkata"))
            } }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("⬇ Full hot list (CSV)", maxLines = 1) }
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
