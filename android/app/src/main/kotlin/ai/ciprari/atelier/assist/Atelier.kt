package ai.ciprari.atelier.assist

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.net.toUri

/**
 * Where a launch link goes: always this app's own Trusted Web Activity ([AtelierLauncherActivity]), which shows
 * https://atelier.ciprari.ai full screen in a browser that supports TWAs.
 *
 * The launch link can carry the owner's launch key in its fragment, and the TWA hands the URL to a browser. So the key
 * goes along only when that browser is a Chrome the phone can vouch for ([chrome]): part of the system image or
 * installed by Google Play. That is also the browser the key was made in (the owner's Atelier sign-in lives in Chrome's
 * storage for the site), and [AtelierLauncherActivity] pins the TWA to that same Chrome. With no such Chrome, the TWA
 * falls back to another TWA browser, a Custom Tab or the default browser, and the link goes without the key (the words
 * are only prefilled there).
 */
internal object Atelier {

    /** [keyed]: the launch key may go along. [chrome]: the trusted Chrome the TWA will use (null: Android's pick). */
    class Target(val chrome: String?) {
        val keyed: Boolean get() = chrome != null
    }

    fun target(context: Context): Target = Target(chrome(context.packageManager))

    /** An explicit intent to this app's own TWA with [url]: never resolved by Android, so no other app receives it. */
    fun intent(context: Context, url: String): Intent =
        Intent(Intent.ACTION_VIEW, url.toUri())
            .setClass(context, AtelierLauncherActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private const val PLAY_STORE = "com.android.vending"

    /** Stable first: it is the one the owner's Atelier sign-in is in. */
    private val CHROMES = listOf("com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary")

    /**
     * The first Chrome build that is enabled and part of the system image or came from Google Play. (Package names are
     * unique on a device, and the Play Store and a preinstalled Chrome are system apps, so another app can't pose as
     * them.) Visibility: android-browser-helper's <queries> (VIEW + BROWSABLE + https) shows every browser, and the
     * manifest names the Play Store, without which Android 11+ reports a null installer.
     */
    fun chrome(pm: PackageManager): String? = CHROMES.firstOrNull { trustedChrome(pm, it) }

    private fun trustedChrome(pm: PackageManager, pkg: String): Boolean =
        enabled(pm, pkg) && (isSystemApp(pm, pkg) || installerOf(pm, pkg) == PLAY_STORE)

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
