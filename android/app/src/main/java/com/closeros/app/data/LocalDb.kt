package com.closeros.app.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The app's own small database on the phone (Android's built-in SQLite):
 *  - cache:    last copy of screens' data (leads, follow-ups, outcomes…) so screens open instantly / offline
 *  - marks:    "already done" lists (calls whose outcome was saved, recordings uploaded)
 *  - wa_calls: WhatsApp calls noticed on this phone
 *  - lead_index: number → lead (name, profession, key facts…) so the after-call pop-up knows a lead instantly, offline
 */
class LocalDb private constructor(ctx: Context) : SQLiteOpenHelper(ctx, "closeros.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("create table cache (k text primary key, v text not null, at integer not null)")
        db.execSQL("create table marks (kind text not null, id text not null, at integer not null, primary key (kind, id))")
        db.execSQL("create table wa_calls (id text primary key, phone text not null, name text, direction text not null, started integer not null, duration integer not null)")
        db.execSQL("create index wa_calls_started on wa_calls (started)")
        createLeadIndex(db)
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { if (oldVersion < 2) createLeadIndex(db) }
    private fun createLeadIndex(db: SQLiteDatabase) {
        db.execSQL("create table if not exists lead_index (phone text primary key, id text not null, v text not null)")
    }

    // ── lead_index ──
    fun putLeads(rows: List<Triple<String, String, String?>>) {   // phone, id, lead json (null = removed)
        val w = writableDatabase
        w.beginTransaction()
        try {
            rows.forEach { (phone, id, v) ->
                if (v == null) w.delete("lead_index", "id = ?", arrayOf(id))
                else w.insertWithOnConflict("lead_index", null, ContentValues().apply { put("phone", phone); put("id", id); put("v", v) }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            w.setTransactionSuccessful()
        } finally { w.endTransaction() }
    }
    fun leadJsonByPhone(phone: String): String? = readableDatabase.rawQuery("select v from lead_index where phone = ?", arrayOf(phone)).use { if (it.moveToFirst()) it.getString(0) else null }
    fun leadPhones(): Set<String> = readableDatabase.rawQuery("select phone from lead_index", null).use { c -> buildSet { while (c.moveToNext()) add(c.getString(0)) } }
    fun leadIndexCount(): Int = readableDatabase.rawQuery("select count(*) from lead_index", null).use { if (it.moveToFirst()) it.getInt(0) else 0 }

    // ── cache ──
    fun put(key: String, value: String) { writableDatabase.insertWithOnConflict("cache", null, ContentValues().apply { put("k", key); put("v", value); put("at", System.currentTimeMillis()) }, SQLiteDatabase.CONFLICT_REPLACE) }
    fun get(key: String): String? = readableDatabase.rawQuery("select v from cache where k = ?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
    fun clearCache() { writableDatabase.delete("cache", null, null); writableDatabase.delete("lead_index", null, null) }

    // ── marks ──
    fun mark(kind: String, id: String) { writableDatabase.insertWithOnConflict("marks", null, ContentValues().apply { put("kind", kind); put("id", id); put("at", System.currentTimeMillis()) }, SQLiteDatabase.CONFLICT_IGNORE) }
    fun isMarked(kind: String, id: String) = readableDatabase.rawQuery("select 1 from marks where kind = ? and id = ?", arrayOf(kind, id)).use { it.moveToFirst() }
    fun marked(kind: String): Set<String> = readableDatabase.rawQuery("select id from marks where kind = ?", arrayOf(kind)).use { c -> buildSet { while (c.moveToNext()) add(c.getString(0)) } }
    /** Keep the lists small: forget marks older than 60 days. */
    fun pruneMarks() { writableDatabase.delete("marks", "at < ?", arrayOf((System.currentTimeMillis() - 60L * 86_400_000).toString())) }

    // ── WhatsApp calls ──
    fun addWa(id: String, phone: String, name: String?, direction: String, started: Long, duration: Int) {
        writableDatabase.insertWithOnConflict("wa_calls", null, ContentValues().apply {
            put("id", id); put("phone", phone); put("name", name); put("direction", direction); put("started", started); put("duration", duration)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
    fun waSince(ms: Long, limit: Int = 5000): List<Array<Any?>> =
        readableDatabase.rawQuery("select id, phone, name, direction, started, duration from wa_calls where started > ? order by started limit $limit", arrayOf(ms.toString())).use { c ->
            buildList { while (c.moveToNext()) add(arrayOf(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getLong(4), c.getInt(5))) }
        }
    fun waCount(): Int = readableDatabase.rawQuery("select count(*) from wa_calls", null).use { it.moveToFirst(); it.getInt(0) }

    companion object {
        @Volatile private var inst: LocalDb? = null
        fun get(ctx: Context): LocalDb = inst ?: synchronized(this) { inst ?: LocalDb(ctx.applicationContext).also { inst = it; it.migrateFromPrefs(ctx) } }
    }

    /** One time: move lists that used to live in the settings file into this database. */
    private fun migrateFromPrefs(ctx: Context) {
        val p = ctx.getSharedPreferences("closeros", Context.MODE_PRIVATE)
        if (p.getBoolean("db_migrated", false)) return
        writableDatabase.beginTransaction()
        try {
            p.getStringSet("logged_calls", emptySet())?.forEach { mark("logged", it) }
            p.getStringSet("rec_uploaded", emptySet())?.forEach { mark("rec", it) }
            val wa = ctx.getSharedPreferences("wa_calls", Context.MODE_PRIVATE).getString("calls", null)
            if (wa != null) runCatching {
                json.parseToJsonElement(wa).let { it as kotlinx.serialization.json.JsonArray }.forEach { e ->
                    val o = e as kotlinx.serialization.json.JsonObject
                    fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                    addWa(s("id")!!, s("phone").orEmpty(), s("name"), s("direction") ?: "outgoing", s("startedAtMs")!!.toLong(), s("durationSec")?.toInt() ?: 0)
                }
            }
            writableDatabase.setTransactionSuccessful()
        } finally { writableDatabase.endTransaction() }
        p.edit().putBoolean("db_migrated", true).remove("logged_calls").remove("rec_uploaded").apply()
        ctx.getSharedPreferences("wa_calls", Context.MODE_PRIVATE).edit().clear().apply()
    }
}
