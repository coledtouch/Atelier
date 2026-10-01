// AGP 9 compiles Kotlin itself (built-in Kotlin), so no Kotlin plugin is applied anywhere.
plugins {
    id("com.android.application") version "9.4.1" apply false
}

// Build output goes outside OneDrive (sync locks, MAX_PATH): %LOCALAPPDATA%\atelier-assist-build\<project>.
// ATELIER_ASSIST_BUILD_DIR overrides it; elsewhere (no LOCALAPPDATA) Gradle's default build/ is used.
val assistOut: String? = System.getenv("ATELIER_ASSIST_BUILD_DIR")
    ?: System.getenv("LOCALAPPDATA")?.let { "$it/atelier-assist-build" }
if (assistOut != null) layout.buildDirectory.set(file("$assistOut/root"))
