package ai.ciprari.atelier.assist

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.os.Build
import androidx.core.net.toUri

/**
 * Where a launch link goes: the installed Atelier app (Chrome's WebAPK) when it can be trusted, else Chrome itself, else
 * whatever Android picks for https://atelier.ciprari.ai links.
 *
 * The launch link can carry the owner's launch key in its fragment, so the key goes only to a package that is really
 * what it claims to be ([Target.keyed]). A package name alone proves nothing: any sideloaded app can take an
 * org.chromium.webapk.* name and claim the site's links, and naming a package skips Android's own link resolution.
 */
internal object Atelier {

    /**
     * [pkg]: the package the intent names (null: Android resolves it). [keyed]: the launch key may go there. [app]: it is
     * the installed Atelier app. [webApk]: an Atelier WebAPK is installed (trusted or not), so "Atelier isn't installed"
     * would be wrong even when the link goes elsewhere.
     */
    class Target(val pkg: String?, val keyed: Boolean, val app: Boolean, val webApk: Boolean = false)

    /**
     * 1. A WebAPK (org.chromium.webapk.*) that handles the site's links and was installed by Google Play (which mints
     *    WebAPKs for Chrome) or by a trusted Chrome: the installed Atelier app. Keyed.
     * 2. Else a Chrome build that is part of the system image or came from Play: the key lives in Chrome's storage for
     *    the site (shared with the installed app), so a keyed link still works there. Keyed.
     * 3. Else an implicit intent that Android resolves (a verified app-link handler, else the default browser). Not
     *    keyed: the words are only prefilled there.
     *
     * Package visibility comes from the manifest's <queries>: VIEW + BROWSABLE + https://atelier.ciprari.ai (every browser
     * and the WebAPK match it) and the Play Store by name. Without the latter, Android 11+ hides Play from this app and
     * getInstallSourceInfo() reports a null installer for every Play-minted WebAPK, so the installed app would never be
     * trusted and every request would open in a Chrome tab.
     */
    fun target(context: Context): Target {
        val pm = context.packageManager
        val webApks = webApkHandlers(pm)
        webApks.firstOrNull { trustedInstaller(pm, installerOf(pm, it)) }?.let { return Target(it, keyed = true, app = true, webApk = true) }
        CHROMES.firstOrNull { trustedChrome(pm, it) }?.let { return Target(it, keyed = true, app = false, webApk = webApks.isNotEmpty()) }
        return Target(null, keyed = false, app = false, webApk = webApks.isNotEmpty())
    }

    fun intent(url: String, target: Target): Intent {
        val intent = Intent(Intent.ACTION_VIEW, url.toUri())
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        target.pkg?.let(intent::setPackage)
        return intent
    }

    /** Packages named like a Chrome WebAPK that handle the site's links (unverified handlers included). */
    private fun webApkHandlers(pm: PackageManager): List<String> {
        val probe = Intent(Intent.ACTION_VIEW, "${LaunchLink.ORIGIN}/".toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
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
    private val CHROMES = listOf("com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary")

    /**
     * Google Play, or a Chrome build that is itself part of the system image or came from Play. (Package names are unique
     * on a device, and the Play Store and a preinstalled Chrome are system apps, so another app can't pose as them.)
     */
    private fun trustedInstaller(pm: PackageManager, installer: String?): Boolean = when {
        installer == PLAY_STORE -> true
        installer != null && installer in CHROMES -> trustedChrome(pm, installer)
        else -> false
    }

    private fun trustedChrome(pm: PackageManager, pkg: String): Boolean = enabled(pm, pkg) && (isSystemApp(pm, pkg) || installerOf(pm, pkg) == PLAY_STORE)

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

    private fun appInfo(pm: PackageManager, pkg: String): ApplicationInfo? = try {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(pkg, 0)
        }
    } catch (_: PackageManager.NameNotFoundException) {
        null
    }

    private fun enabled(pm: PackageManager, pkg: String): Boolean = appInfo(pm, pkg)?.enabled == true

    /** Part of the system image (or an update to it). False when the package is unknown or not visible to this app. */
    fun isSystemApp(pm: PackageManager, pkg: String): Boolean =
        (appInfo(pm, pkg)?.flags ?: 0) and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
}
