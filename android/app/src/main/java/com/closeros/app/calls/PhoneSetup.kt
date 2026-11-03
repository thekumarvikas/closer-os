package com.closeros.app.calls

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.telecom.TelecomManager
import com.closeros.app.data.LocalStore

/**
 * Everything a rep's phone needs for Closer OS to work fully, each with a status and the most
 * direct way Android allows to turn it on. Simple permissions get a one-tap "Allow" pop-up; the
 * rest open the exact switch in Android's settings, and the status updates when the rep comes back.
 */
object PhoneSetup {
    enum class Kind { Runtime, Special, Confirm }

    data class Item(
        val key: String, val title: String, val why: String, val done: Boolean, val kind: Kind,
        val required: Boolean = true, val perms: List<String> = emptyList(), val intent: Intent? = null,
        val steps: String? = null, val warning: String? = null,
    )

    val callPerms = buildList {
        add(Manifest.permission.READ_CALL_LOG); add(Manifest.permission.READ_PHONE_STATE); add(Manifest.permission.CALL_PHONE)
        add(Manifest.permission.READ_PHONE_NUMBERS)
    }

    private fun has(ctx: Context, p: String) = PhoneCalls.has(ctx, p)

    fun defaultDialer(ctx: Context): String = ctx.getSystemService(TelecomManager::class.java)?.defaultDialerPackage ?: ""

    /** Phone app made by the phone's maker (these can record calls into a normal folder). */
    private fun makerDialer(pkg: String) = pkg in setOf(
        "com.android.contacts", "com.android.incallui", "com.samsung.android.dialer", "com.samsung.android.incallui",
        "com.android.dialer", "com.oplus.dialer", "com.coloros.dialer", "com.vivo.contacts", "com.android.server.telecom",
        "com.asus.contacts", "com.oneplus.dialer", "com.motorola.dialer", "com.miui.contacts",
    ) || pkg.startsWith("com.android.") || pkg.startsWith("com.samsung.") || pkg.startsWith("com.miui.")

    private val brand get() = Build.MANUFACTURER.lowercase()

    /** The brand's "Autostart" / background-launch screen, where one exists. */
    private fun autostartIntent(ctx: Context): Intent? {
        val candidates = listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oplus.safecenter" to "com.oplus.safecenter.permission.startup.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.autostart.AutoStartActivity",
        )
        return candidates.map { (p, c) -> Intent().setComponent(ComponentName(p, c)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            .firstOrNull { it.resolveActivity(ctx.packageManager) != null }
    }

    fun items(ctx: Context): List<Item> {
        val store = LocalStore(ctx)
        val pm = ctx.getSystemService(PowerManager::class.java)
        val dialer = defaultDialer(ctx)
        val google = dialer == "com.google.android.dialer"
        val list = mutableListOf<Item>()

        list += Item("calls", "Calls & call history", "Call leads in one tap and log every call automatically.",
            callPerms.all { has(ctx, it) }, Kind.Runtime, perms = callPerms)
        if (Build.VERSION.SDK_INT >= 33) list += Item("notify", "Notifications", "Follow-up reminders with a Call button.",
            has(ctx, Manifest.permission.POST_NOTIFICATIONS), Kind.Runtime, perms = listOf(Manifest.permission.POST_NOTIFICATIONS))
        list += Item("contacts", "Contacts", "Know who a WhatsApp call was with when WhatsApp shows a saved name.",
            has(ctx, Manifest.permission.READ_CONTACTS), Kind.Runtime, perms = listOf(Manifest.permission.READ_CONTACTS))
        if (Build.VERSION.SDK_INT >= 31) list += Item("alarms", "On-time reminders", "Reminders ring exactly 5 minutes before and at the follow-up time.",
            FollowUpAlarms.canExact(ctx), Kind.Special,
            intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}")),
            steps = "Turn on the switch for Closer OS, then come back.")
        if (store.trackWhatsapp && com.closeros.app.BuildConfig.WA_TRACKING) list += Item("whatsapp", "WhatsApp calls", "Count WhatsApp call time in your talk time.",
            WhatsAppCalls.accessGranted(ctx), Kind.Special,
            intent = if (Build.VERSION.SDK_INT >= 30)
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, WhatsAppCalls.listenerComponent(ctx).flattenToString())
            else Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
            steps = "Turn on \"Closer OS\" and tap Allow, then come back." + if (Build.VERSION.SDK_INT >= 33)
                "\nIf it says \"Restricted setting\": tap \"Open app info\" below → ⋮ (top right) → \"Allow restricted settings\" → confirm, then come back and tap Turn on again." else "")
        list += Item("battery", "Keep running in background", "So calls and reminders are never missed, even when the app is closed.",
            pm.isIgnoringBatteryOptimizations(ctx.packageName), Kind.Special,
            intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")),
            steps = "Tap Allow on the pop-up.")
        autostartIntent(ctx)?.let { list += Item("autostart", "Autostart", "Your phone (${Build.MANUFACTURER}) stops apps from starting by themselves unless this is on.",
            store.confirmed("autostart"), Kind.Confirm, intent = it, steps = "Find Closer OS in the list and turn its switch on, then come back and tap \"Done\".") }
        list += Item("dialer", "Phone app that records calls", when {
                google -> "This phone uses Google's Phone app, which keeps recordings private."
                makerDialer(dialer) -> "Your phone's own Phone app is set as the default ✓"
                else -> "Another app is set as your Phone app. Choose your phone's own Phone app so calls can be recorded."
            }, makerDialer(dialer) && !google, Kind.Special, required = false,
            intent = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS),
            steps = "Open \"Phone app\" and choose your phone's own Phone app (not a third-party dialer).",
            warning = if (google) "Recordings can't be uploaded on this phone. Call history, talk time and WhatsApp calls still work." else null)
        if (!google) {
            list += Item("autorecord", "Auto call recording on", "Turn on automatic recording in your Phone app so every call is recorded.",
                store.confirmed("autorecord"), Kind.Confirm, required = false,
                intent = ctx.packageManager.getLaunchIntentForPackage(dialer),
                steps = if (brand == "xiaomi" || brand == "redmi" || brand == "poco") "Phone app → ⋮ → Settings → Call recording → Record calls automatically → All numbers. Then come back and tap \"Done\"."
                        else if (brand == "samsung") "Phone app → ⋮ → Settings → Record calls → Auto record calls → All calls. Then come back and tap \"Done\"."
                        else "Phone app → Settings → Call recording → turn on automatic recording for all calls. Then come back and tap \"Done\".")
            list += Item("recfolder", "Recordings folder", "Closer OS uploads your call recordings from this folder.",
                store.recordingsFolder != null, Kind.Special, required = false,
                steps = if (brand == "xiaomi" || brand == "redmi" || brand == "poco") "Open MIUI → sound_recorder → call_rec, then tap \"Use this folder\" → Allow."
                        else if (brand == "samsung") "Open Recordings → Call (or Call recordings), then tap \"Use this folder\" → Allow."
                        else "Open the folder where your Phone app saves call recordings, then tap \"Use this folder\" → Allow.")
        }
        return list
    }

    /** Saves the folder the rep picked and says how many recordings are in it. */
    suspend fun saveRecordingsFolder(ctx: Context, uri: Uri?): String {
        if (uri == null) return "No folder chosen"
        runCatching { ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        LocalStore(ctx).recordingsFolder = uri.toString()
        // Counting can take a while in a folder with thousands of recordings, so it runs off the screen thread.
        val n = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching {
            val root = androidx.documentfile.provider.DocumentFile.fromTreeUri(ctx, uri)
            fun count(d: androidx.documentfile.provider.DocumentFile?, depth: Int): Int = d?.listFiles()?.sumOf {
                if (it.isDirectory && depth < 2) count(it, depth + 1) else if (it.isFile && Regex(".*\\.(mp3|m4a|amr|aac|wav|ogg|opus|3gp)$", RegexOption.IGNORE_CASE).matches(it.name.orEmpty())) 1 else 0
            } ?: 0
            count(root, 0)
        }.getOrDefault(-1) }
        CallSync.syncNow(ctx)
        val name = uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':') ?: "folder"
        return when {
            n < 0 -> "Folder saved ($name), but it can't be read. Choose it again."
            n == 0 -> "Folder saved ($name) — but no recordings in it. Is this the right folder? Is auto-recording on?"
            else -> "Folder saved ✓ $n recordings found in $name. Uploading…"
        }
    }

    /** Folder the picker should open at, where we know the brand's usual place. */
    fun recordingsHint(): Uri? {
        if (Build.VERSION.SDK_INT < 31) return null   // older pickers (e.g. MIUI 12) can fail with a starting folder
        val path = when (brand) {
            "xiaomi", "redmi", "poco" -> "MIUI/sound_recorder/call_rec"
            "samsung" -> "Recordings/Call"
            else -> return null
        }
        return android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:$path")
    }

    /** Short summary for the dashboard: which items are done. */
    fun summary(ctx: Context): Map<String, Boolean> = items(ctx).associate { it.key to it.done }
}
