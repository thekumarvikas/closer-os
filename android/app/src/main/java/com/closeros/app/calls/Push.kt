package com.closeros.app.calls

import android.content.Context
import com.closeros.app.BuildConfig
import com.closeros.app.data.AppLog
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Firebase push for the company app: the dashboard's "Sync now" wakes this phone even when Closer OS is closed.
 *  Set up in code (no google-services plugin) so the individual app is not affected. */
object Push {
    private const val PREFS = "push"
    @Volatile private var ready = false

    fun init(ctx: Context) {
        if (BuildConfig.SOLO || ready) return
        runCatching {
            if (FirebaseApp.getApps(ctx).isEmpty()) FirebaseApp.initializeApp(ctx, FirebaseOptions.Builder()
                .setApplicationId("1:811258088396:android:9538f4e0b6e9ab0066ab69")
                .setApiKey("AIzaSyDfK94BNou_zW_E6Mdut339Y5A2xDQ8mZA")
                .setProjectId("closer-os-514506")
                .setGcmSenderId("811258088396").build())
            ready = true
            FirebaseMessaging.getInstance().token.addOnSuccessListener { t -> remember(ctx, t) }
        }.onFailure { AppLog.error(ctx, "push", it) }
    }

    fun remember(ctx: Context, token: String) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (p.getString("token", null) != token) p.edit().putString("token", token).putBoolean("sent", false).apply()
    }

    /** Sends this phone's push address to Closer OS (once, and again when it changes). Called from every sync. */
    suspend fun upload(ctx: Context) {
        if (BuildConfig.SOLO) return
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = p.getString("token", null) ?: return
        if (p.getBoolean("sent", false) && p.getString("sent_uid", null) == com.closeros.app.data.Backend.uid) return
        runCatching {
            com.closeros.app.data.Backend.client.postgrest.rpc("save_push_token", buildJsonObject {
                put("p_device", PhoneCalls.deviceId(ctx)); put("p_token", token); put("p_app", "app")
            })
            p.edit().putBoolean("sent", true).putString("sent_uid", com.closeros.app.data.Backend.uid).apply()
        }.onFailure { AppLog.error(ctx, "push token", it) }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.remember(applicationContext, token)
        CallSync.syncNow(applicationContext)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        when (message.data["kind"]) {
            "sync", null -> {
                AppLog.error(applicationContext, "push", null, kind = "info", message = "sync requested from the dashboard")
                CallSync.syncNow(applicationContext)
            }
        }
    }
}
