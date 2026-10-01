# Atelier Assist uses no reflection, no @JavascriptInterface and no serialization: the default
# proguard-android-optimize.txt plus the AndroidX consumer rules are enough.
# Keep line numbers out of the release APK (nothing is uploaded anywhere to deobfuscate them).
-renamesourcefileattribute SourceFile
