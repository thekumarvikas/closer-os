package com.closeros.app

import android.app.Activity
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/** Company builds (full / direct): no ads and nothing to buy — every feature is open. */
object Monetize {
    const val ENABLED = false
    fun init(activity: Activity) {}
    fun adFree(ctx: Context) = true
    @Composable fun Banner(modifier: Modifier = Modifier) {}
    fun showRewarded(activity: Activity, done: (Boolean) -> Unit) = done(true)
    fun price(yearly: Boolean): String? = null
    fun buy(activity: Activity, yearly: Boolean, onResult: (String) -> Unit) {}
    fun restore(ctx: Context, onResult: (String) -> Unit) = onResult("")
}
