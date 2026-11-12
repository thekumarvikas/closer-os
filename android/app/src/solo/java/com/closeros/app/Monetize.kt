package com.closeros.app

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Individual app (Play Store): Google ads for free users and the "Remove ads" subscription.
 * Ads only start after the privacy-consent step (needed in Europe and some other places).
 * Play product: subscription "remove_ads" with base plans "monthly" and "yearly".
 */
object Monetize {
    const val ENABLED = true
    private const val PRODUCT = "remove_ads"
    private val started = AtomicBoolean(false)
    private var canShowAds by mutableStateOf(false)
    /** Paid "Remove ads" (remembered on the phone, refreshed from Google Play on every start). */
    var paid by mutableStateOf<Boolean?>(null); private set
    private var rewarded: RewardedAd? = null
    private var loadingRewarded = false
    private var billing: BillingClient? = null
    private var product by mutableStateOf<ProductDetails?>(null)
    private var appCtx: Context? = null

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("monetize", Context.MODE_PRIVATE)
    fun adFree(ctx: Context): Boolean = paid ?: prefs(ctx).getBoolean("paid", false).also { paid = it }

    fun init(activity: Activity) {
        appCtx = activity.applicationContext
        adFree(activity)
        connectBilling(activity.applicationContext)
        val ci = UserMessagingPlatform.getConsentInformation(activity)
        runCatching {
            ci.requestConsentInfoUpdate(activity, ConsentRequestParameters.Builder().build(), {
                UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { if (ci.canRequestAds()) startAds(activity) }
            }, { if (ci.canRequestAds()) startAds(activity) })
        }
        if (ci.canRequestAds()) startAds(activity)
    }

    private fun startAds(activity: Activity) {
        if (!started.compareAndSet(false, true)) return
        runCatching { MobileAds.initialize(activity.applicationContext) { canShowAds = true; loadRewarded(activity.applicationContext) } }
    }

    // ───── Banner (one small ad at the bottom of list screens) ─────
    @Composable
    fun Banner(modifier: Modifier = Modifier) {
        val ctx = LocalContext.current
        if (!canShowAds || adFree(ctx)) return
        val width = LocalConfiguration.current.screenWidthDp
        val size = remember(width) { AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(ctx, width) }
        var loaded by remember { mutableStateOf(false) }
        // No internet or no ad available: the space stays closed (no empty gap).
        AndroidView(modifier = modifier.fillMaxWidth().height(if (loaded) size.height.dp else 0.dp), factory = { c ->
            AdView(c).apply {
                setAdSize(size); adUnitId = BuildConfig.AD_BANNER
                adListener = object : AdListener() {
                    override fun onAdLoaded() { loaded = true }
                    override fun onAdFailedToLoad(e: LoadAdError) { loaded = false }
                }
                loadAd(AdRequest.Builder().build())
            }
        }, onRelease = { it.destroy() })
    }

    // ───── Rewarded ("watch a short ad to unlock") ─────
    private fun loadRewarded(ctx: Context) {
        if (rewarded != null || loadingRewarded || !canShowAds) return
        loadingRewarded = true
        RewardedAd.load(ctx, BuildConfig.AD_REWARDED, AdRequest.Builder().build(), object : RewardedAdLoadCallback() {
            override fun onAdLoaded(ad: RewardedAd) { rewarded = ad; loadingRewarded = false }
            override fun onAdFailedToLoad(e: LoadAdError) { rewarded = null; loadingRewarded = false }
        })
    }

    /** Shows the ad; done(true) when the reward was earned OR no ad was available (never punish the user). */
    fun showRewarded(activity: Activity, done: (Boolean) -> Unit) {
        val ad = rewarded
        if (ad == null || !canShowAds) { done(true); loadRewarded(activity.applicationContext); return }
        rewarded = null
        var earned = false
        ad.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdDismissedFullScreenContent() { done(earned); loadRewarded(activity.applicationContext) }
            override fun onAdFailedToShowFullScreenContent(e: com.google.android.gms.ads.AdError) { done(true); loadRewarded(activity.applicationContext) }
        }
        ad.show(activity) { earned = true }
    }

    // ───── "Remove ads" subscription (Google Play Billing) ─────
    private fun connectBilling(ctx: Context) {
        if (billing != null) return
        val c = BillingClient.newBuilder(ctx)
            .setListener { r, purchases -> if (r.responseCode == BillingClient.BillingResponseCode.OK) handle(ctx, purchases.orEmpty()) }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
        billing = c
        c.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(r: BillingResult) {
                if (r.responseCode != BillingClient.BillingResponseCode.OK) return
                c.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(listOf(
                    QueryProductDetailsParams.Product.newBuilder().setProductId(PRODUCT).setProductType(BillingClient.ProductType.SUBS).build())).build()
                ) { _, result -> product = result.productDetailsList.firstOrNull() }
                refresh(ctx) {}
            }
            override fun onBillingServiceDisconnected() { billing = null }
        })
    }

    private fun refresh(ctx: Context, onDone: (Boolean) -> Unit) {
        val c = billing ?: return onDone(adFree(ctx))
        c.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { r, list ->
            if (r.responseCode == BillingClient.BillingResponseCode.OK) setPaid(ctx, list.any { PRODUCT in it.products && it.purchaseState == Purchase.PurchaseState.PURCHASED })
            onDone(adFree(ctx))
        }
    }

    private fun handle(ctx: Context, purchases: List<Purchase>) {
        purchases.filter { PRODUCT in it.products && it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { p ->
            setPaid(ctx, true)
            if (!p.isAcknowledged) billing?.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.purchaseToken).build()) {}
        }
    }

    private fun setPaid(ctx: Context, v: Boolean) { paid = v; prefs(ctx).edit().putBoolean("paid", v).apply() }

    private fun offer(yearly: Boolean) = product?.subscriptionOfferDetails?.let { offers ->
        offers.filter { it.basePlanId == if (yearly) "yearly" else "monthly" }.minByOrNull { it.offerId?.length ?: 0 }
    }

    /** Store price in the user's currency, e.g. "₹99.00" or "$2.99" (null until Google Play answers). */
    fun price(yearly: Boolean): String? = offer(yearly)?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice

    fun buy(activity: Activity, yearly: Boolean, onResult: (String) -> Unit) {
        val c = billing; val d = product; val o = offer(yearly)
        if (c == null || d == null || o == null) { connectBilling(activity.applicationContext); onResult("Google Play isn't ready yet — try again in a moment."); return }
        val r = c.launchBillingFlow(activity, BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(
            BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(o.offerToken).build())).build())
        if (r.responseCode != BillingClient.BillingResponseCode.OK) onResult("Couldn't open Google Play (${r.debugMessage.ifBlank { r.responseCode.toString() }})")
    }

    /** "Restore purchase": asks Google Play again (new phone, reinstall). */
    fun restore(ctx: Context, onResult: (String) -> Unit) {
        connectBilling(ctx.applicationContext)
        refresh(ctx.applicationContext) { onResult(if (it) "Closer OS Pro is on ✓" else "No Closer OS Pro purchase found on this Google account") }
    }
}
