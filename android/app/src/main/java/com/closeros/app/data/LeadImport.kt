package com.closeros.app.data

import android.content.Context
import android.net.Uri
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.xmlpull.v1.XmlPullParser
import java.util.zip.ZipInputStream

/** Adding leads from the app: one lead, a CSV / Excel file, or phone contacts. */
@Serializable data class AddLeadResult(val id: String, val existing: Boolean = false)
@Serializable data class ImportResult(val inserted: Int = 0, val already: Int = 0, val joined: Int = 0, val invalid: Int = 0)

/** A file read into a header row + data rows. */
class SheetData(val headers: List<String>, val rows: List<List<String>>)

object LeadFields {
    /** Field key → label; "" = ignore the column. */
    val all = listOf("name" to "Name", "phone" to "Phone number", "city" to "City", "profession" to "Profession", "email" to "Email",
        "company" to "Company", "state" to "State", "notes" to "Notes", "source" to "Source", "" to "Don't import")

    /** Guesses which lead field a column holds, from its heading. */
    fun guess(header: String): String {
        val h = header.lowercase().replace(Regex("[^a-z ]"), " ").trim()
        return when {
            Regex("\\b(phone|mobile|contact no|contact number|whatsapp|number|mob|cell)\\b").containsMatchIn(h) -> "phone"
            Regex("\\b(e ?mail)\\b").containsMatchIn(h) -> "email"
            Regex("\\b(city|town|location|place)\\b").containsMatchIn(h) -> "city"
            Regex("\\b(state|province|region)\\b").containsMatchIn(h) -> "state"
            Regex("\\b(profession|occupation|designation|job|role|title)\\b").containsMatchIn(h) -> "profession"
            Regex("\\b(company|organisation|organization|business|firm)\\b").containsMatchIn(h) -> "company"
            Regex("\\b(note|notes|remark|remarks|comment|comments|message)\\b").containsMatchIn(h) -> "notes"
            Regex("\\b(source|campaign|lead source)\\b").containsMatchIn(h) -> "source"
            Regex("\\b(name|full name|first name|lead|customer|client)\\b").containsMatchIn(h) -> "name"
            else -> ""
        }
    }
}

object LeadImport {
    private val db get() = Backend.client.postgrest

    suspend fun addLead(orgId: String, p: JsonObject): AddLeadResult =
        json.decodeFromString(db.rpc("add_lead", buildJsonObject { put("p_org", orgId); put("p", p) }).data)

    /** Sends rows (field → value) in chunks of 1,000. */
    suspend fun import(orgId: String, rows: List<Map<String, String>>, batchId: String?, progress: (Int) -> Unit): ImportResult {
        var total = ImportResult()
        rows.chunked(1000).forEachIndexed { i, chunk ->
            progress(i * 1000)
            val r: ImportResult = json.decodeFromString(db.rpc("import_my_leads", buildJsonObject {
                put("p_org", orgId); batchId?.let { put("p_batch", it) }
                put("p_rows", buildJsonArray { chunk.forEach { row -> add(buildJsonObject { row.forEach { (k, v) -> put(k, v) } }) } })
            }).data)
            total = ImportResult(total.inserted + r.inserted, total.already + r.already, total.joined + r.joined, total.invalid + r.invalid)
        }
        return total
    }

    /** Reads a CSV / TSV or an Excel (.xlsx) file. The first non-empty row is the heading. */
    fun read(ctx: Context, uri: Uri): SheetData {
        val cr = ctx.contentResolver
        val name = runCatching { cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } }.getOrNull().orEmpty()
        val type = cr.getType(uri).orEmpty()
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn't open the file")
        val isZip = bytes.size > 4 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte()
        val table = when {
            isZip || name.endsWith(".xlsx", true) || type.contains("spreadsheetml") -> readXlsx(bytes)
            name.endsWith(".xls", true) -> error("Old Excel (.xls) files can't be read — in Excel or Google Sheets choose Save as / Download → .xlsx or .csv")
            else -> readCsv(String(bytes, Charsets.UTF_8).removePrefix("﻿"))
        }.filter { r -> r.any { it.isNotBlank() } }
        if (table.isEmpty()) error("The file is empty")
        val width = table.maxOf { it.size }
        val headers = table.first().let { h -> List(width) { i -> h.getOrNull(i)?.trim()?.ifBlank { null } ?: "Column ${i + 1}" } }
        return SheetData(headers, table.drop(1).map { r -> List(width) { i -> r.getOrNull(i)?.trim().orEmpty() } })
    }

    private fun readCsv(text: String): List<List<String>> {
        val firstLine = text.lineSequence().firstOrNull().orEmpty()
        val sep = listOf(',', ';', '\t').maxBy { c -> firstLine.count { it == c } }
        val rows = mutableListOf<List<String>>(); var row = mutableListOf<String>(); val cell = StringBuilder(); var quoted = false; var i = 0
        while (i < text.length) {
            val ch = text[i]
            when {
                quoted && ch == '"' && text.getOrNull(i + 1) == '"' -> { cell.append('"'); i++ }
                ch == '"' -> quoted = !quoted
                !quoted && ch == sep -> { row.add(cell.toString()); cell.clear() }
                !quoted && (ch == '\n' || ch == '\r') -> {
                    if (ch == '\r' && text.getOrNull(i + 1) == '\n') i++
                    row.add(cell.toString()); cell.clear(); rows.add(row); row = mutableListOf()
                }
                else -> cell.append(ch)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) { row.add(cell.toString()); rows.add(row) }
        return rows
    }

    /** Minimal .xlsx reader: shared strings + the first worksheet (numbers kept as typed, long numbers without ".0"). */
    private fun readXlsx(bytes: ByteArray): List<List<String>> {
        val files = mutableMapOf<String, ByteArray>()
        ZipInputStream(bytes.inputStream()).use { z ->
            var e = z.nextEntry
            while (e != null) {
                if (e.name == "xl/sharedStrings.xml" || e.name.startsWith("xl/worksheets/sheet")) files[e.name] = z.readBytes()
                e = z.nextEntry
            }
        }
        val shared = mutableListOf<String>()
        files["xl/sharedStrings.xml"]?.let { data ->
            val p = parser(data); val sb = StringBuilder(); var inSi = false; var inT = false
            while (p.next() != XmlPullParser.END_DOCUMENT) {
                when (p.eventType) {
                    XmlPullParser.START_TAG -> when (p.name) { "si" -> { inSi = true; sb.clear() }; "t" -> inT = inSi }
                    XmlPullParser.TEXT -> if (inT) sb.append(p.text)
                    XmlPullParser.END_TAG -> when (p.name) { "t" -> inT = false; "si" -> { shared.add(sb.toString()); inSi = false } }
                }
            }
        }
        val sheet = files.keys.filter { it.startsWith("xl/worksheets/sheet") }.minByOrNull { it.filter(Char::isDigit).toIntOrNull() ?: 99 }
            ?: error("No sheet found in the Excel file")
        val p = parser(files.getValue(sheet))
        val rows = mutableListOf<List<String>>(); var row = sortedMapOf<Int, String>(); var col = 0; var t = ""; val v = StringBuilder(); var inV = false
        fun colIndex(ref: String): Int { var n = 0; ref.takeWhile { it.isLetter() }.forEach { n = n * 26 + (it.uppercaseChar() - 'A' + 1) }; return n - 1 }
        while (p.next() != XmlPullParser.END_DOCUMENT) {
            when (p.eventType) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "row" -> row = sortedMapOf()
                    "c" -> { col = p.getAttributeValue(null, "r")?.let(::colIndex) ?: (row.keys.maxOrNull()?.plus(1) ?: 0); t = p.getAttributeValue(null, "t").orEmpty(); v.clear() }
                    "v", "t" -> inV = true
                }
                XmlPullParser.TEXT -> if (inV) v.append(p.text)
                XmlPullParser.END_TAG -> when (p.name) {
                    "v", "t" -> inV = false
                    "c" -> {
                        val raw = v.toString()
                        row[col] = when (t) {
                            "s" -> shared.getOrNull(raw.toIntOrNull() ?: -1).orEmpty()
                            "inlineStr", "str" -> raw
                            else -> raw.toDoubleOrNull()?.let { d -> if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) d.toLong().toString() else raw } ?: raw
                        }
                    }
                    "row" -> rows.add(if (row.isEmpty()) emptyList() else List(row.lastKey() + 1) { row[it].orEmpty() })
                }
            }
        }
        return rows
    }

    private fun parser(data: ByteArray) = android.util.Xml.newPullParser().apply {
        setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false); setInput(data.inputStream(), "UTF-8")
    }

    /** Phone contacts with a number (for "Pick from contacts"), sorted by name. */
    fun contacts(ctx: Context): List<Pair<String, String>> = runCatching {
        val out = linkedMapOf<String, Pair<String, String>>()
        ctx.contentResolver.query(android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null, android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE NOCASE ASC")?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(0).orEmpty(); val num = c.getString(1).orEmpty()
                val key = num.filter(Char::isDigit).takeLast(10)
                if (key.length >= 8 && key !in out) out[key] = name to num
            }
        }
        out.values.toList()
    }.getOrDefault(emptyList())
}
