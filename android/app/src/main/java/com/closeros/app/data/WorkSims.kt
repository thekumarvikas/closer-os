package com.closeros.app.data

import android.content.Context
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable data class WorkSim(val id: String, val user_id: String, val sim_number: String, val slot: Int? = null, val label: String? = null,
    val kind: String = "first", val status: String = "pending", val note: String? = null)
@Serializable data class WorkSimList(val used: Int = 0, val seats: Int? = null, val sims: List<WorkSim> = emptyList())

/**
 * Company app: only the rep's WORK SIM(s) are tracked. Calls from any other SIM are never shown, counted or sent.
 * Until a work SIM is chosen (and in the individual app) everything is tracked as before.
 */
object WorkSims {
    private fun p(ctx: Context) = ctx.applicationContext.getSharedPreferences("work_sims", Context.MODE_PRIVATE)
    @Volatile private var cache: Set<String>? = null
    private fun key(n: String?) = n?.filter { it.isDigit() }?.takeLast(10)?.takeIf { it.length >= 8 }

    /** Phone-number keys (last 10 digits) of my active work SIMs; empty = no choice made yet. */
    fun keys(ctx: Context): Set<String> = cache ?: (p(ctx).getStringSet("active", emptySet()) ?: emptySet()).also { cache = it }

    /** Is a call on this SIM tracked? Unknown SIM (single-SIM phones, WhatsApp) = yes. */
    fun allowed(ctx: Context, simNumber: String?): Boolean {
        if (com.closeros.app.BuildConfig.SOLO) return true
        val k = keys(ctx); if (k.isEmpty()) return true
        return key(simNumber)?.let { it in k } ?: true
    }

    fun mine(ctx: Context): List<WorkSim> = p(ctx).getString("mine", null)?.let { runCatching { json.decodeFromString<List<WorkSim>>(it) }.getOrNull() }.orEmpty()

    /** Reads my SIMs from the server and remembers them (works offline afterwards). */
    suspend fun refresh(ctx: Context, orgId: String): List<WorkSim> {
        val l: WorkSimList = json.decodeFromString(Backend.client.postgrest.rpc("org_work_sims", buildJsonObject { put("p_org", orgId) }).data)
        val me = Backend.uid
        val mine = l.sims.filter { it.user_id == me }
        p(ctx).edit().putStringSet("active", mine.filter { it.status == "active" }.mapNotNull { key(it.sim_number) }.toSet())
            .putString("mine", json.encodeToString(kotlinx.serialization.builtins.ListSerializer(WorkSim.serializer()), mine)).apply()
        cache = null
        return mine
    }

    /** kind: null (first SIM / change) | "add" (track a second SIM too). Returns the server's message. */
    suspend fun request(orgId: String, number: String, slot: Int?, label: String?, kind: String?): String {
        val r = Backend.client.postgrest.rpc("request_work_sim", buildJsonObject {
            put("p_org", orgId); put("p_number", number); slot?.let { put("p_slot", it) }; label?.let { put("p_label", it) }; kind?.let { put("p_kind", it) }
        }).data
        return runCatching { json.parseToJsonElement(r).let { (it as kotlinx.serialization.json.JsonObject)["message"]?.toString()?.trim('"') } }.getOrNull() ?: "Saved"
    }

    fun clear(ctx: Context) { p(ctx).edit().clear().apply(); cache = null }
}
