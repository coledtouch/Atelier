package ai.ciprari.atelier.assist

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import androidx.core.net.toUri

/** The one site this app shows, and the rules for leaving it. */
internal object Atelier {
    const val HOST = "atelier.ciprari.ai"
    const val ORIGIN = "https://$HOST"

    /** Name of the origin-restricted JS object the page sees (window.AtelierAssist). */
    const val BRIDGE = "AtelierAssist"

    /**
     * The panel's start page. `start` is launch.js's quick-launch intent (voice | ask); `via=assist` is already read by
     * launch.js readLaunch (no effect); `panel=assist` is the layout hint for the web app's compact panel mode. Neither
     * grants anything (any site can link to them). What the page may trust is the window.AtelierAssist object, which the
     * WebView injects for this origin only.
     */
    fun startUrl(start: String): String = "$ORIGIN/?start=$start&via=assist&panel=assist"

    /** https://atelier.ciprari.ai on the default port, without user info. */
    fun isAtelier(uri: Uri?): Boolean {
        if (uri == null || !uri.isHierarchical) return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(HOST, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) &&
            uri.userInfo == null
    }

    /** A same-site path from the page ("/", "/?start=ask", …) as a full URL, or null if it isn't one. */
    fun pathUrl(path: String?): Uri? {
        val p = path?.trim().orEmpty().ifEmpty { "/" }
        if (p.length > 2048 || !p.startsWith("/") || p.startsWith("//") || p.contains('\\') || p.any { it.isISOControl() }) return null
        val uri = (ORIGIN + p).toUri()
        return if (isAtelier(uri)) uri else null
    }

    /** Schemes the panel hands to other apps; anything else (intent:, file:, content:, javascript:, data:) is dropped. */
    private val EXTERNAL = setOf("https", "http", "mailto", "tel", "sms")

    fun externalIntent(uri: Uri): Intent? {
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme !in EXTERNAL) return null
        return Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /**
     * A VIEW intent for an Atelier URL, aimed at the installed PWA when that can be trusted. Chrome installs the PWA as a
     * WebAPK (org.chromium.webapk.*) that handles every link in the site's scope. The intent names that package only when
     * it really is one: the org.chromium.webapk. prefix *and* installed by Google Play (which mints WebAPKs for Chrome) or
     * by Chrome itself. A name alone proves nothing (any sideloaded app can take it and claim the site's links), and
     * naming a package skips Android's own link resolution. Otherwise the intent stays implicit and Android resolves the
     * link itself: a verified app-link handler, else the browser. Package visibility comes from the manifest's <queries>.
     *
     * The flag is false only when no WebAPK-looking handler exists at all (the caller then says it opens in the browser).
     */
    fun appIntent(context: Context, url: Uri): Pair<Intent, Boolean> {
        val intent = Intent(Intent.ACTION_VIEW, url)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pm = context.packageManager
        val candidates = webApkHandlers(pm)
        candidates.firstOrNull { trustedInstaller(pm, installerOf(pm, it)) }?.let(intent::setPackage)
        return intent to candidates.isNotEmpty()
    }

    /** Packages named like a Chrome WebAPK that handle the site's links (unverified handlers included). */
    private fun webApkHandlers(pm: PackageManager): List<String> {
        val probe = Intent(Intent.ACTION_VIEW, "$ORIGIN/".toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
        val found: List<ResolveInfo> = try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.queryIntentActivities(probe, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentActivities(probe, 0)
            }
        } catch (_: RuntimeException) {
            emptyList()
        }
        return found.mapNotNull { it.activityInfo?.packageName }.distinct().filter { it.startsWith(WEBAPK_PREFIX) }
    }

    private const val WEBAPK_PREFIX = "org.chromium.webapk."
    private const val PLAY_STORE = "com.android.vending"
    private val CHROMES = setOf("com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary")

    /**
     * Google Play, or a Chrome build that is itself part of the system image or came from Play. (Package names are unique
     * on a device, and the Play Store and a preinstalled Chrome are system apps, so another app can't pose as them.)
     */
    private fun trustedInstaller(pm: PackageManager, installer: String?): Boolean = when {
        installer == PLAY_STORE -> true
        installer != null && installer in CHROMES -> isSystemApp(pm, installer) || installerOf(pm, installer) == PLAY_STORE
        else -> false
    }

    private fun installerOf(pm: PackageManager, pkg: String): String? = try {
        if (Build.VERSION.SDK_INT >= 30) {
            pm.getInstallSourceInfo(pkg).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(pkg)
        }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    } catch (_: RuntimeException) { // IllegalArgumentException (not installed) on API 29
        null
    }

    private fun isSystemApp(pm: PackageManager, pkg: String): Boolean = try {
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(pkg, 0)
        }
        info.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }
}
