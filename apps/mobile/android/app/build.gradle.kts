plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.zvault.android"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.zvault.android"
        // Android 14: fingerprint-bound keystore keys and a small support matrix.
        minSdk = 34
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Published APKs are signed with the Zvault upload key, passed in by the
    // release workflow. Android only installs an update over an app signed with
    // the same key, so every release must use it. Local and CI builds without
    // it fall back to the debug key, which is fine for testing.
    val releaseKeystore = System.getenv("ZVAULT_ANDROID_KEYSTORE")?.takeIf { it.isNotEmpty() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("ZVAULT_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ZVAULT_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ZVAULT_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig =
                signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
