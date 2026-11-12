plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.closeros.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.closeros.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 75
        versionName = "0.21.0"
        // Public values: the publishable key is meant to be in apps; data is protected by database rules.
        buildConfigField("String", "SUPABASE_URL", "\"https://tdbqgoxxxfkfttdznzhb.supabase.co\"")
        buildConfigField("String", "SUPABASE_KEY", "\"sb_publishable_aXH8Wr7Lq1YeOWxhvxEdGQ_ePS1GYTY\"")
        buildConfigField("String", "WEB_URL", "\"https://closer-os-liard.vercel.app\"")
        // "Continue with Google": the WEB OAuth client id from Google Cloud (public). Empty = button hidden.
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${project.findProperty("googleWebClientId") ?: ""}\"")
    }
    // full   = everything, for the Play Store (installs from Play are never blocked).
    // direct = APK shared directly (WhatsApp, dashboard download): no WhatsApp-call tracking, because
    //          Google Play Protect blocks directly-installed apps that read notifications.
    flavorDimensions += "dist"
    productFlavors {
        create("full") { dimension = "dist"; buildConfigField("boolean", "WA_TRACKING", "true"); buildConfigField("boolean", "SOLO", "false") }
        create("direct") { dimension = "dist"; buildConfigField("boolean", "WA_TRACKING", "false"); buildConfigField("boolean", "SOLO", "false") }
        // solo = "Closer OS" for individuals on the Play Store: free with ads, "Remove ads" subscription.
        // Ad IDs below are Google's TEST ids — replace with the real AdMob ids before publishing.
        create("solo") {
            dimension = "dist"
            applicationId = "com.closeros.solo"
            // -Psideload: test copy shared as an APK file (no WhatsApp-call tracking, so Play Protect doesn't block it).
            val sideload = project.hasProperty("sideload")
            buildConfigField("boolean", "WA_TRACKING", if (sideload) "false" else "true"); buildConfigField("boolean", "SOLO", "true")
            manifestPlaceholders["admobAppId"] = "ca-app-pub-3940256099942544~3347511713"
            buildConfigField("String", "AD_BANNER", "\"ca-app-pub-3940256099942544/9214589741\"")
            buildConfigField("String", "AD_REWARDED", "\"ca-app-pub-3940256099942544/5224354917\"")
        }
    }
    // The company builds share one "no ads" version of Monetize.kt.
    sourceSets {
        getByName("full").java.srcDir("src/team/java")
        getByName("direct").java.srcDir("src/team/java")
        if (project.hasProperty("sideload")) getByName("solo").manifest.srcFile("src/soloSideload/AndroidManifest.xml")
    }
    // Test-only signing key so every test build updates the previous one. Not the Play Store key.
    signingConfigs {
        create("devTest") {
            storeFile = rootProject.file("keystore/dev-test.jks")
            storePassword = "closeros-dev"
            keyAlias = "closeros-dev"
            keyPassword = "closeros-dev"
        }
    }
    buildTypes {
        release {
            // Remove unused code and resources: smaller download, faster start.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("devTest")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1,INDEX.LIST,DEPENDENCIES}" } }
}

dependencies {
    val compose = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(compose)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    implementation(platform("io.github.jan-tennert.supabase:bom:3.0.3"))
    implementation("io.github.jan-tennert.supabase:auth-kt")
    implementation("io.github.jan-tennert.supabase:postgrest-kt")
    implementation("io.github.jan-tennert.supabase:storage-kt")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("io.ktor:ktor-client-okhttp:3.0.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // Sign in with Google (Android Credential Manager).
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    // Individual app only: Google ads (with the privacy-consent form) and Google Play subscriptions.
    "soloImplementation"("com.google.android.gms:play-services-ads:23.6.0")
    "soloImplementation"("com.android.billingclient:billing-ktx:7.1.1")
    "soloImplementation"("androidx.fragment:fragment-ktx:1.8.5")   // the ads library brings an old version
}
