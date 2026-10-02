package ai.ciprari.atelier.assist

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.trusted.TrustedWebActivityIntentBuilder
import androidx.core.content.IntentCompat
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.google.androidbrowserhelper.trusted.SessionStore
import com.google.androidbrowserhelper.trusted.SharedPreferencesTokenStore
import com.google.androidbrowserhelper.trusted.TwaLauncher

/**
 * The Atelier app: https://atelier.ciprari.ai as a Trusted Web Activity (full screen, no URL bar once Chrome has checked
 * public/.well-known/assetlinks.json), from android-browser-helper's LauncherActivity. Everything else (colours, splash,
 * share target, Custom Tab fallback) is set in the manifest's meta-data.
 *
 * Opened by the launcher icon, the Talk / Ask / Imagine shortcuts, https://atelier.ciprari.ai links (verified app
 * links), shares from other apps, and the Assist card ([AssistActivity] → [Atelier.intent]).
 *
 * On top of the stock LauncherActivity:
 * - Only Atelier URLs open: any other URL in the intent (another app can name this activity directly) is dropped, so the
 *   TWA opens Atelier's start page instead. Content URIs (file handling) are dropped too; Atelier has no file handlers.
 * - A share never forwards this app's own FileProvider files (the splash image) to the browser.
 * - The TWA runs in the trusted Chrome that [Atelier.chrome] names, the browser the owner's sign-in and launch key live
 *   in; with none, the stock provider picker chooses (another TWA browser, else a Custom Tab).
 */
class AtelierLauncherActivity : LauncherActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        intent = sanitized(intent)
        super.onCreate(savedInstanceState)
    }

    override fun createTwaLauncher(): TwaLauncher =
        TwaLauncher(this, Atelier.chrome(packageManager), SessionStore.makeSessionId(taskId), SharedPreferencesTokenStore(this))

    override fun getUrlForIntent(intent: Intent): Uri? = intent.data?.takeIf { LaunchLink.isAtelierUrl(it.toString()) }

    private fun sanitized(original: Intent?): Intent {
        val i = Intent(original ?: Intent(Intent.ACTION_MAIN))
        i.data?.let { if (!LaunchLink.isAtelierUrl(it.toString())) i.data = null }
        i.removeExtra(TrustedWebActivityIntentBuilder.EXTRA_FILE_HANDLING_DATA)
        when (i.action) {
            Intent.ACTION_SEND -> {
                val uri = runCatching { IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java) }.getOrNull()
                if (uri != null && !shareable(uri)) i.removeExtra(Intent.EXTRA_STREAM)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = runCatching { IntentCompat.getParcelableArrayListExtra(i, Intent.EXTRA_STREAM, Uri::class.java) }.getOrNull()
                if (uris != null) i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris.filter(::shareable)))
            }
        }
        return i
    }

    /** A shared file the browser may receive: a content URI that isn't one of this app's own files. */
    private fun shareable(uri: Uri): Boolean =
        uri.scheme.equals("content", ignoreCase = true) && uri.authority != null &&
            uri.authority!!.split(';').none { it == "$packageName.fileprovider" }
}
