package com.closeros.app.data

import kotlinx.coroutines.flow.MutableStateFlow

/** Small signals between parts of the app running at the same time (e.g. pop-up → main screens). */
object AppEvents {
    /** Bumped when leads changed outside the main screens (after-call pop-up saved / added a lead). */
    val leadsChanged = MutableStateFlow(0L)
    fun bumpLeads() { leadsChanged.value = System.currentTimeMillis() }
}
