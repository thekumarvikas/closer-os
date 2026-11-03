# Closer OS — shrinking rules. We shrink (remove unused code) but don't rename, so crash reports stay readable.
-dontobfuscate

# Our data classes are turned into JSON and back by kotlinx.serialization.
-keep class com.closeros.app.data.** { *; }
-keepclassmembers class com.closeros.app.** { *** Companion; }
-keepclasseswithmembers class com.closeros.app.** { kotlinx.serialization.KSerializer serializer(...); }
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod, Exceptions, SourceFile, LineNumberTable
-keep,includedescriptorclasses class com.closeros.app.**$$serializer { *; }

# Supabase + Ktor (network) use reflection / service loading in places: keep them whole.
-keep class io.github.jan.supabase.** { *; }
-keep class io.ktor.** { *; }
-keep class kotlinx.serialization.** { *; }
-keepclassmembers class kotlinx.** { volatile <fields>; }
-dontwarn io.ktor.**
-dontwarn org.slf4j.**
-dontwarn kotlinx.serialization.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn java.lang.management.**
-dontwarn javax.naming.**

# Android components declared in the manifest are kept automatically; keep WorkManager workers' constructors.
-keep class * extends androidx.work.ListenableWorker { <init>(...); }
