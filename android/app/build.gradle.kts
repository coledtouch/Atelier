import java.util.Properties

plugins {
    id("com.android.application")
}

// Same out-of-OneDrive build directory as the root project (see ../build.gradle.kts).
val assistOut: String? = System.getenv("ATELIER_ASSIST_BUILD_DIR")
    ?: System.getenv("LOCALAPPDATA")?.let { "$it/atelier-assist-build" }
if (assistOut != null) layout.buildDirectory.set(file("$assistOut/app"))

// The release key never lives in the repo. Default: %USERPROFILE%\.atelier-assist\keystore.properties with
// storeFile, storePassword, keyAlias, keyPassword. ATELIER_ASSIST_KEYSTORE_PROPERTIES points elsewhere.
// Without it, assembleRelease still builds, but leaves an unsigned APK.
val keyProps = Properties().apply {
    val path = System.getenv("ATELIER_ASSIST_KEYSTORE_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.atelier-assist/keystore.properties"
    val f = file(path)
    if (f.isFile) f.inputStream().use { load(it) }
}
val hasReleaseKey = !keyProps.getProperty("storeFile").isNullOrBlank()

android {
    namespace = "ai.ciprari.atelier.assist"
    compileSdk = 36
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "ai.ciprari.atelier.assist"
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "1.0.1"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
                // minSdk 29: no JAR signing; with v2+v3 enabled the packager writes the v3 block (verified by Android 9+).
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
            vcsInfo.include = false // no git metadata inside the APK; keeps builds reproducible
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Sideloaded, owner-only: no dependency report signed for Play inside the APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    packaging {
        resources {
            excludes += setOf("META-INF/*.version", "META-INF/**/LICENSE*", "kotlin/**", "DebugProbesKt.bin")
        }
    }
}

dependencies {
    // core-ktx 1.18.0, not 1.19.x: 1.19 needs compileSdk 37.
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.1")
}
