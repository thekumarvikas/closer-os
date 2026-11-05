package com.closeros.app.calls

import android.content.Context
import android.os.Build
import com.closeros.app.data.Backend
import com.closeros.app.data.LocalDb
import com.closeros.app.data.LocalStore
import com.closeros.app.data.Net
import com.closeros.app.data.Ops
import com.closeros.app.data.Repo
import io.github.jan.supabase.auth.SignOutScope
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * One login = one phone at a time (each phone is a paid seat). Signing in claims the phone; any other
 * phone with the same login signs itself out the next time it is online — but only after everything it
 * saved (outcomes, notes, WhatsApp marks, new leads) has been uploaded, so nothing is ever lost.
 * The web dashboard is not affected.
 */
object DeviceGuard {
    @Volatile private var lastCheckMs = 0L
    fun phoneName() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"

    /** After a successful sign-in on this phone. */
    suspend fun claim(ctx: Context) {
        runCatching { Repo.claimDevice(PhoneCalls.deviceId(ctx), phoneName()) }
        LocalStore(ctx).kickedReason = null
    }

    /** Returns true when this phone was signed out because the login is now used on another phone. */
    suspend fun check(ctx: Context, force: Boolean = false): Boolean {
        if (!Net.isOnline || Backend.auth.currentSessionOrNull() == null) return false
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckMs < 30_000) return false
        lastCheckMs = now
        val r = runCatching { Repo.deviceCheck(PhoneCalls.deviceId(ctx), phoneName()) }.getOrNull() ?: return false
        if (r["active"]?.jsonPrimitive?.booleanOrNull != false) return false
        val other = r["other"]?.jsonPrimitive?.contentOrNull ?: "another phone"

        // Upload everything first. If something can't go yet, stay signed in and try again next time.
        val store = LocalStore(ctx)
        val sent = store.outbox.filter { o -> runCatching { Repo.logCall(o) }.isSuccess }
        store.removeFromOutbox(sent)
        runCatching { Ops.flush(ctx) }
        if (store.outbox.isNotEmpty() || Ops.count(ctx) > 0) return false

        signOutHere(ctx, "Your login was used on $other, so this phone was signed out. One login works on one phone at a time. Everything from this phone was saved.")
        return true
    }


    private suspend fun signOutHere(ctx: Context, reason: String) {
        runCatching { FollowUpAlarms.scheduleAll(ctx, emptyList()) }
        runCatching { Backend.auth.signOut(SignOutScope.LOCAL) }   // only this phone — the new phone stays signed in
        LocalStore(ctx).clear()
        runCatching { LocalDb.get(ctx).clearCache() }
        LocalStore(ctx).kickedReason = reason
    }
}
