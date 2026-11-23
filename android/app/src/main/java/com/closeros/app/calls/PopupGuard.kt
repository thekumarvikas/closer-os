package com.closeros.app.calls

// "After-call pop-up is off" alert for the rep. Without "Display over other apps" no outcome card appears after calls
// (Nikhil: 0 of 47 outcomes saved). While it is off, a notification that can't be swiped away stays on the phone;
// tapping it opens the exact Android switch. It disappears by itself once the switch is on (checked on every sync,
// app open and call end). Skipped when the rep turned the pop-up off on purpose (Settings → After-call pop-up: Off).

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat

object PopupGuard {
    private const val CHANNEL = "popup_off"
    private const val ID = 7501

    fun check(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val off = !Settings.canDrawOverlays(ctx) && runCatching { com.closeros.app.data.LocalStore(ctx).afterCallMode != "off" }.getOrDefault(true)
        if (!off) { nm.cancel(ID); return }
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "After-call pop-up is off", NotificationManager.IMPORTANCE_HIGH)
            .apply { description = "Shown until the after-call pop-up is turned on" })
        // Opens Closer OS → Phone setup, which sends the rep to the right screen for this phone (vivo / Xiaomi have their own).
        val fix = Intent(ctx, com.closeros.app.MainActivity::class.java).putExtra("open_tab", "setup")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(ctx, ID, fix, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val text = "Your calls are not getting outcomes saved. Tap here → Phone setup → \"After-call pop-up\" → turn it on."
        val n = NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(com.closeros.app.R.drawable.ic_notif).setColor(0xFFB91C1C.toInt())
            .setContentTitle("⚠ After-call pop-up is OFF").setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(pi).setPriority(NotificationCompat.PRIORITY_HIGH).build()
        runCatching { nm.notify(ID, n) }
    }
}
