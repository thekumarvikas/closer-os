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
        versionCode = 42
        versionName = "0.10.7"
        // Public values: the publishable key is meant to be in apps; data is protected by database rules.
        buildConfigField("String", "SUPABASE_URL", "\"https://tdbqgoxxxfkfttdznzhb.supabase.co\"")
        buildConfigField("String", "SUPABASE_KEY", "\"sb_publishable_aXH8Wr7Lq1YeOWxhvxEdGQ_ePS1GYTY\"")
        buildConfigField("String", "WEB_URL", "\"https://closer-os-liard.vercel.app\"")
    }
    // full   = everything, for the Play Store (installs from Play are never blocked).
    // direct = APK shared directly (WhatsApp, dashboard download): no WhatsApp-call tracking, because
    //          Google Play Protect blocks directly-installed apps that read notifications.
    flavorDimensions += "dist"
    productFlavors {
        create("full") { dimension = "dist"; buildConfigField("boolean", "WA_TRACKING", "true") }
        create("direct") { dimension = "dist"; buildConfigField("boolean", "WA_TRACKING", "false") }
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
}
