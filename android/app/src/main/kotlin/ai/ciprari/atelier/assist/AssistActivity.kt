package ai.ciprari.atelier.assist

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.Insets
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * The pop-up: a translucent activity that slides a bottom sheet with Atelier over whatever was on screen.
 *
 * Launched by ACTION_ASSIST (the digital-assistant gesture: Samsung's side-key press and hold, the corner swipe) and by
 * the launcher icon (Samsung's side-key double press → Open app). Pressing again while it is open asks the page to
 * listen. It never shows over the lock screen: a locked phone is asked to unlock first, and the panel closes if that is
 * cancelled. ACTION_ASSIST may carry the previous app's assist data: only the keyboard hint is read, the rest is
 * dropped unread.
 *
 * Configuration: rotation, size and dark mode are handled in place (the WebView and its page stay); dark mode re-reads
 * the theme's colours in [onConfigurationChanged]. Display size and font size recreate the activity, which then starts
 * a fresh page in "ask" mode (never the microphone by itself).
 */
class AssistActivity : ComponentActivity(), PanelHost {

    private lateinit var prefs: SharedPreferences
    private lateinit var root: FrameLayout
    private lateinit var scrim: View
    private lateinit var sheet: LinearLayout
    private lateinit var sheetBackground: GradientDrawable
    private lateinit var header: FrameLayout
    private lateinit var handle: View
    private lateinit var openButton: ImageButton
    private lateinit var bannerHost: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var progressLine: View
    private lateinit var sheetCtl: SheetController
    private var errorView: View? = null
    private var web: PanelWeb? = null

    private var invocation = INVOCATION_LAUNCHER
    private var startMode = "voice"
    private var unlocked = false
    private var finishingQuietly = false
    private var started = false

    /** The page's own background colour, once it has sent one ({type:'theme'}); null: the theme's sheet colour. */
    private var pageColor: Int? = null

    private var pendingMic: PermissionRequest? = null
    private var micAskedAt = 0L
    private var micRationaleBefore = false
    private var micSettingsOpened = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageProxy: JavaScriptReplyProxy? = null
    private var pendingSave: PendingSave? = null

    private class PendingSave(val token: String?, val name: String?, var mime: String?, var armed: Boolean, val at: Long)

    /**
     * Android's answer to the RECORD_AUDIO request. "Blocked" (the Settings banner, and hello's mic:'denied') only when
     * Android won't ask again: its rationale flag went from true (the owner pressed "Don't allow" once) to false (and
     * did it again), or the answer came back instantly with no dialog, or it was already blocked and still is. A
     * dismissed dialog (Back, a tap outside, the side button pressed while it was up) leaves the rationale flag where it
     * was, so it stays "prompt": Android will show the dialog again.
     */
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingMic
        pendingMic = null
        if (granted) {
            prefs.edit { remove(PREF_MIC_BLOCKED) }
            request?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            hideBanner(BANNER_MIC)
            return@registerForActivityResult
        }
        request?.deny()
        val rationale = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        val instant = micAskedAt > 0L && SystemClock.elapsedRealtime() - micAskedAt < MIC_INSTANT_MS
        val blocked = !rationale && (micRationaleBefore || instant || prefs.getBoolean(PREF_MIC_BLOCKED, false))
        prefs.edit { putBoolean(PREF_MIC_BLOCKED, blocked) }
        if (blocked) showMicBlocked()
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback
        fileCallback = null
        callback?.onReceiveValue(pickedUris(result.resultCode, result.data))
    }

    // ───────────────────────── lifecycle ─────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), // light icons over the dimmed app behind
            // Not SystemBarStyle.auto: auto turns the system's nav-bar contrast scrim back on (a band over the sheet with
            // 3-button navigation). The icons are kept matched to the sheet by applyBarAppearance().
            navigationBarStyle = if (sheetIsLight()) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) else SystemBarStyle.dark(Color.TRANSPARENT),
        )
        // androidx re-applies the styles above on every configuration change this activity handles itself, from a hidden
        // view it added to the decor just now. This one is added after it, so it runs after it and puts ours back.
        (window.decorView as ViewGroup).addView(object : View(this) {
            override fun onConfigurationChanged(newConfig: Configuration) = applyBarAppearance()
        }.apply {
            visibility = View.GONE
            setWillNotDraw(true)
        })
        applyBarAppearance()
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        prefs = getSharedPreferences("assist", MODE_PRIVATE)
        val launch = readLaunch(intent)
        invocation = launch.invocation
        // Recreated (display or font size changed): a fresh page, but the microphone never opens by itself for that.
        val recreated = savedInstanceState != null
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else sheetCtl.dismiss()
            }
        })
        web = try {
            PanelWeb(this, this, content, sheetColor())
        } catch (_: RuntimeException) { // Android System WebView missing or mid-update
            toast(R.string.no_webview)
            finishQuietly()
            return
        }
        whenUnlocked { late ->
            unlocked = true
            startMode = if (late || launch.keyboard || recreated) "ask" else "voice"
            web?.load(Atelier.startUrl(startMode))
            maybeShowSetup()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val launch = readLaunch(intent)
        setIntent(intent)
        invocation = launch.invocation
        sheetCtl.cancelDismiss()
        whenUnlocked { late ->
            val mode = if (late || launch.keyboard) "ask" else "voice"
            when {
                // The renderer went away while the panel was hidden: this press starts a fresh page.
                rebuildWeb && web == null -> {
                    rebuildWeb = false
                    unlocked = true
                    replaceWeb(mode)
                }
                !unlocked -> {
                    unlocked = true
                    startMode = mode
                    web?.load(Atelier.startUrl(mode))
                }
                // Pressed again while open: the page decides (Atelier starts listening, with its usual checks).
                !late -> post(JSONObject().put("type", "listen").put("invocation", invocation).put("keyboard", launch.keyboard))
            }
        }
    }

    // The WebView pauses only when the sheet is out of sight (onStop), not on onPause: the microphone permission dialog
    // pauses this activity while Atelier's getUserMedia() is waiting, and a page hidden at that moment would drop it.
    override fun onStart() {
        super.onStart()
        started = true
        // Back in sight after the renderer was reclaimed in the background, without a new launch (onNewIntent normally
        // comes first and has already rebuilt it). Never before the phone is unlocked.
        if (rebuildWeb && web == null && !keyguardLocked()) {
            rebuildWeb = false
            replaceWeb("ask")
        }
        web?.onResume()
    }

    override fun onResume() {
        super.onResume()
        if (bannerKind == BANNER_SETUP && assistantRoleHeld()) hideBanner(BANNER_SETUP)
        if (bannerKind == BANNER_MIC && micGranted()) hideBanner(BANNER_MIC)
        if (micSettingsOpened) {
            // Back from this app's settings, where "Ask every time" may have been chosen: ask again rather than assume it
            // is still blocked (a request that comes back instantly marks it blocked again).
            micSettingsOpened = false
            if (!micGranted()) prefs.edit { remove(PREF_MIC_BLOCKED) }
        }
    }

    override fun onStop() {
        started = false
        web?.onPause()
        android.webkit.CookieManager.getInstance().flush()
        super.onStop()
    }

    override fun onDestroy() {
        dropWeb()
        super.onDestroy()
    }

    /**
     * Rotation, size and dark mode don't recreate the activity (the manifest's configChanges). Dark mode turning on or
     * off, also while the panel waits in the background, must still reach the native parts: the sheet, handle, buttons,
     * progress line, banner and error screen re-read the theme's colours (or keep the page's own colour, if it sent one),
     * and the nav-bar icons follow the sheet again.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        progressLine.setBackgroundColor(getColor(R.color.accent))
        applySheetColor()
        refreshBanner()
        errorView?.let {
            content.removeView(it)
            errorView = null
            onMainFrameError()
        }
        window.decorView.post { applyBarAppearance() }
    }

    /** Close now, without the system's activity animation (the sheet has already slid away, or we're handing off). */
    private fun finishQuietly() {
        if (finishingQuietly) return
        finishingQuietly = true
        finish()
        if (Build.VERSION.SDK_INT < 34) {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    // ───────────────────────── launch + lock screen ─────────────────────────

    private class Launch(val invocation: String, val keyboard: Boolean)

    private fun readLaunch(i: Intent?): Launch {
        val assist = i?.action == Intent.ACTION_ASSIST
        val keyboard = assist && runCatching { i!!.getBooleanExtra(Intent.EXTRA_ASSIST_INPUT_HINT_KEYBOARD, false) }.getOrDefault(false)
        // ACTION_ASSIST can carry the previous app's assist context: never read, kept or passed on.
        runCatching { i?.replaceExtras(null as Bundle?) }
        return Launch(if (assist) INVOCATION_ASSIST else INVOCATION_LAUNCHER, keyboard)
    }

    private fun keyguardLocked(): Boolean = getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true

    /** Runs [then] once the phone is unlocked; `late` when unlocking took long enough that the mic shouldn't open. */
    private fun whenUnlocked(then: (late: Boolean) -> Unit) {
        val km = getSystemService(KeyguardManager::class.java)
        if (km == null || !km.isKeyguardLocked) {
            then(false)
            return
        }
        val asked = SystemClock.elapsedRealtime()
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = then(SystemClock.elapsedRealtime() - asked > LATE_UNLOCK_MS)
            override fun onDismissCancelled() = finishQuietly()
            override fun onDismissError() = finishQuietly()
        })
    }

    // ───────────────────────── UI ─────────────────────────

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    @SuppressLint("ClickableViewAccessibility") // the sheet only swallows stray touches; it has no click action
    private fun buildUi() {
        root = FrameLayout(this)

        scrim = View(this).apply {
            setBackgroundColor(getColor(R.color.scrim))
            alpha = 0f
            contentDescription = getString(R.string.action_close)
            setOnClickListener { sheetCtl.dismiss() }
        }

        sheetBackground = GradientDrawable().apply {
            val r = dp(28).toFloat()
            cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        }
        sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = sheetBackground
            clipToOutline = true
            elevation = dp(6).toFloat()
            // Taps that nothing inside takes must not fall through to the scrim (which closes the sheet).
            setOnTouchListener { _, _ -> true }
        }

        header = FrameLayout(this).apply {
            contentDescription = getString(R.string.sheet_handle)
            setOnClickListener { sheetCtl.toggle() }
        }
        handle = View(this).apply {
            background = GradientDrawable().apply { cornerRadius = dp(2).toFloat() }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        header.addView(handle, FrameLayout.LayoutParams(dp(36), dp(4), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = dp(10) })
        openButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_open_in_new)
            background = borderlessRipple()
            contentDescription = getString(R.string.open_in_atelier)
            tooltipText = getString(R.string.open_in_atelier)
            setOnClickListener { openInAtelier(Atelier.pathUrl("/")!!) }
        }
        header.addView(openButton, FrameLayout.LayoutParams(dp(48), dp(44), Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = dp(6) })

        bannerHost = FrameLayout(this).apply { visibility = View.GONE }

        content = FrameLayout(this)
        progressLine = View(this).apply {
            setBackgroundColor(getColor(R.color.accent))
            pivotX = 0f
            scaleX = 0f
            alpha = 0f
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        content.addView(progressLine, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2), Gravity.TOP))

        sheet.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
        sheet.addView(bannerHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        sheet.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        root.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(sheet, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)
        applySheetColor()

        sheetCtl = SheetController(root, scrim, sheet, header, maxWidth = dp(720), onDismissed = ::finishQuietly)
        sheetCtl.onExpandedChanged = { expanded ->
            labelHeaderClick(expanded)
            post(JSONObject().put("type", "sheet").put("expanded", expanded))
        }

        ViewCompat.addAccessibilityAction(header, getString(R.string.action_close)) { _, _ -> sheetCtl.dismiss(); true }
        labelHeaderClick(false)

        // The sheet absorbs the bars, cutout and keyboard itself; nothing below it applies them again (returning
        // CONSUMED instead would stop the WebView's own keyboard handling, see "understand window insets").
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            sheetCtl.applyInsets(insets)
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build()
        }
    }

    /** TalkBack says what a double-tap on the header does now: expand, or shrink back. */
    private fun labelHeaderClick(expanded: Boolean) {
        val label = getString(if (expanded) R.string.action_collapse else R.string.action_expand)
        ViewCompat.replaceAccessibilityAction(header, AccessibilityActionCompat.ACTION_CLICK, label, null)
    }

    private fun borderlessRipple() = TypedValue().let { tv ->
        theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true)
        getDrawable(tv.resourceId)
    }

    // ───────────────────────── sheet colour + system bars ─────────────────────────

    /** The page's own background once it has said so (Settings → theme can differ from the phone's), else the theme's. */
    private fun sheetColor(): Int = pageColor ?: getColor(R.color.sheet_bg)

    private fun sheetIsLight(): Boolean = ColorUtils.calculateLuminance(sheetColor()) > 0.5

    /**
     * Sheet, WebView backdrop, handle and ↗ in the sheet's colour: the theme's own (values/, values-night/), or, once the
     * page has sent its background, the light or dark set that reads on it (the same values as those two files).
     */
    private fun applySheetColor() {
        val color = sheetColor()
        val light = sheetIsLight()
        val themed = pageColor == null
        sheetBackground.setColor(color)
        web?.view?.setBackgroundColor(color)
        val handleColor = if (themed) getColor(R.color.handle) else if (light) 0x471B1A16 else 0x52ECE6D9
        val inkColor = if (themed) getColor(R.color.ink_2) else if (light) 0xFF5B564C.toInt() else 0xFFA8A295.toInt()
        (handle.background as? GradientDrawable)?.setColor(handleColor)
        openButton.imageTintList = ColorStateList.valueOf(inkColor)
        applyBarAppearance()
    }

    /**
     * Nav-bar icons that read on the sheet behind them, light status-bar icons over the scrim, and no system contrast
     * scrim behind the nav bar (with 3-button navigation it would be a band across the sheet). Called after androidx's
     * own re-run on every handled configuration change (see onCreate). The status bar's contrast scrim is already off
     * (theme, and the non-auto status style).
     */
    private fun applyBarAppearance() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightNavigationBars = sheetIsLight()
            isAppearanceLightStatusBars = false
        }
        window.isNavigationBarContrastEnforced = false
    }

    /** {type:'theme', bg} from the page. */
    private fun applyPageColor(hex: String) {
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(hex)) return
        pageColor = hex.toColorInt()
        applySheetColor()
    }

    // ───────────────────────── banners: setup + microphone ─────────────────────────

    private var bannerKind = 0

    private fun maybeShowSetup() {
        if (invocation != INVOCATION_LAUNCHER || prefs.getBoolean(PREF_SETUP_DISMISSED, false) || assistantRoleHeld()) return
        showSetupBanner()
    }

    private fun showSetupBanner() {
        showBanner(BANNER_SETUP, getString(R.string.setup_text), getString(R.string.setup_action), ::openAssistantSettings) {
            prefs.edit { putBoolean(PREF_SETUP_DISMISSED, true) }
        }
    }

    private fun showMicBlocked() {
        showBanner(BANNER_MIC, getString(R.string.mic_blocked), getString(R.string.mic_settings), ::openAppSettings, null)
    }

    /** The banner that is showing, rebuilt in the current theme's colours. */
    private fun refreshBanner() {
        when (bannerKind) {
            BANNER_SETUP -> showSetupBanner()
            BANNER_MIC -> showMicBlocked()
        }
    }

    private fun showBanner(kind: Int, text: String, action: String, onAction: () -> Unit, onDismiss: (() -> Unit)?) {
        bannerHost.removeAllViews()
        bannerKind = kind
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                setColor(getColor(R.color.sheet_surface))
                cornerRadius = dp(16).toFloat()
            }
            setPaddingRelative(dp(16), dp(6), dp(4), dp(6))
        }
        card.addView(TextView(this).apply {
            this.text = text
            setTextColor(getColor(R.color.ink))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(TextView(this).apply {
            this.text = action
            setTextColor(getColor(R.color.accent))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            minHeight = dp(44)
            setPaddingRelative(dp(12), 0, dp(12), 0)
            background = borderlessRipple()
            isClickable = true
            setOnClickListener { onAction() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        if (onDismiss != null) {
            card.addView(ImageButton(this).apply {
                setImageResource(R.drawable.ic_close)
                imageTintList = ColorStateList.valueOf(getColor(R.color.ink_2))
                background = borderlessRipple()
                contentDescription = getString(R.string.dismiss)
                setOnClickListener { onDismiss(); hideBanner(kind) }
            }, LinearLayout.LayoutParams(dp(44), dp(44)))
        }
        bannerHost.addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            setMargins(dp(12), 0, dp(12), dp(8))
        })
        bannerHost.visibility = View.VISIBLE
    }

    private fun hideBanner(kind: Int) {
        if (bannerKind != kind) return
        bannerKind = 0
        bannerHost.removeAllViews()
        bannerHost.visibility = View.GONE
    }

    private fun assistantRoleHeld(): Boolean {
        val rm = getSystemService(RoleManager::class.java) ?: return false
        return try { rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && rm.isRoleHeld(RoleManager.ROLE_ASSISTANT) } catch (_: RuntimeException) { false }
    }

    /** The assistant role's own settings page (its "manage" intent), else the default-apps list. */
    private fun openAssistantSettings() {
        val tried = listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS)
        for (action in tried) {
            try {
                startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                toast(R.string.setup_hint)
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            micSettingsOpened = true
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun toast(res: Int) = Toast.makeText(this, res, Toast.LENGTH_LONG).show()

    // ───────────────────────── leaving the panel ─────────────────────────

    /** "Open in Atelier": the installed PWA, at [url]; the panel closes. */
    private fun openInAtelier(url: Uri) {
        val (intent, app) = Atelier.appIntent(this, url)
        try {
            startActivity(intent)
            if (!app) toast(R.string.no_atelier)
            finishQuietly()
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_app)
        }
    }

    override fun openExternal(uri: Uri) {
        val intent = if (Atelier.isAtelier(uri)) Atelier.appIntent(this, uri).first else Atelier.externalIntent(uri)
        if (intent == null) return // a scheme we don't hand out (intent:, file:, javascript:, …)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_app)
        }
    }

    // ───────────────────────── PanelHost: page loading ─────────────────────────

    override fun onProgress(percent: Int) {
        progressLine.animate().cancel()
        if (percent >= 100) {
            progressLine.animate().scaleX(1f).alpha(0f).setDuration(220).start()
        } else {
            progressLine.alpha = 1f
            progressLine.animate().scaleX(percent.coerceAtLeast(8) / 100f).setDuration(160).start()
        }
    }

    override fun onMainFrameError() {
        if (errorView != null) return
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.sheet_bg))
            setPadding(dp(32), dp(32), dp(32), dp(32))
            isClickable = true
        }
        box.addView(TextView(this).apply {
            setText(R.string.offline_title)
            setTextColor(getColor(R.color.ink))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            gravity = Gravity.CENTER
        })
        box.addView(TextView(this).apply {
            setText(R.string.offline_body)
            setTextColor(getColor(R.color.ink_2))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(20))
        })
        box.addView(TextView(this).apply {
            setText(R.string.retry)
            setTextColor(getColor(R.color.accent))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            minHeight = dp(48)
            setPadding(dp(24), 0, dp(24), 0)
            background = borderlessRipple()
            isClickable = true
            setOnClickListener {
                content.removeView(errorView)
                errorView = null
                web?.load(Atelier.startUrl("ask"))
            }
        })
        errorView = box
        content.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun onPageVisible() {
        errorView?.let { content.removeView(it) }
        errorView = null
    }

    // ───────────────────────── PanelHost: renderer loss ─────────────────────────

    private var rebuildWeb = false // the renderer went away while the panel was out of sight
    private var rendererCrashes = 0
    private var lastCrashAt = 0L

    /**
     * The WebView can't be used again after its renderer went away, so it is dropped at once. Out of sight (Android
     * reclaims hidden renderers under memory pressure, and this activity can wait in the background for hours) nothing
     * is reloaded and nothing is said: the next time the panel shows, it starts a fresh page. In sight, it is replaced
     * right away; only crashes count, and three within a minute close the panel with a message.
     */
    override fun onRendererGone(crashed: Boolean) {
        dropWeb()
        if (isFinishing) return
        if (!started) {
            rebuildWeb = true
            return
        }
        if (crashed) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastCrashAt > CRASH_WINDOW_MS) rendererCrashes = 0
            lastCrashAt = now
            if (++rendererCrashes > 2) {
                toast(R.string.crashed)
                finishQuietly()
                return
            }
        }
        replaceWeb("ask")
    }

    /** A new WebView at the start page. */
    private fun replaceWeb(start: String) {
        errorView?.let { content.removeView(it) }
        errorView = null
        startMode = start
        web = try {
            PanelWeb(this, this, content, sheetColor()).also { it.load(Atelier.startUrl(start)) }
        } catch (_: RuntimeException) {
            toast(R.string.no_webview)
            finishQuietly()
            null
        }
    }

    /** Everything tied to the current WebView, released (its page and renderer are gone or going). */
    private fun dropWeb() {
        pageProxy = null
        pendingSave = null
        pendingMic?.let { runCatching { it.deny() } }
        pendingMic = null
        fileCallback?.let { runCatching { it.onReceiveValue(null) } }
        fileCallback = null
        web?.destroy()
        web = null
    }

    // ───────────────────────── PanelHost: microphone ─────────────────────────

    private fun micGranted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun micState(): String = when {
        micGranted() -> "granted"
        prefs.getBoolean(PREF_MIC_BLOCKED, false) && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) -> "denied"
        else -> "prompt"
    }

    /** Atelier asked for the microphone (getUserMedia): grant audio only, asking Android first if needed. */
    override fun requestMic(request: PermissionRequest) {
        if (micGranted()) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            return
        }
        pendingMic?.deny()
        pendingMic = request
        micRationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        micAskedAt = SystemClock.elapsedRealtime()
        micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun cancelMic(request: PermissionRequest) {
        if (pendingMic === request) pendingMic = null
    }

    // ───────────────────────── PanelHost: files ─────────────────────────

    override fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
        val types = params.acceptTypes.orEmpty()
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .mapNotNull { if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.drop(1)) ?: if (it == ".json") "application/json" else null else it }
            .filter { '/' in it }
            .distinct()
        when (types.size) {
            0 -> intent.type = "*/*"
            1 -> intent.type = types[0]
            else -> {
                intent.type = "*/*"
                intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            }
        }
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        return try {
            filePicker.launch(intent)
            true
        } catch (_: ActivityNotFoundException) {
            fileCallback = null
            callback.onReceiveValue(null)
            true
        }
    }

    private fun pickedUris(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val out = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(out::add) }
        if (out.isEmpty()) data.data?.let(out::add)
        return out.distinct().toTypedArray().takeIf { it.isNotEmpty() }
    }

    // ───────────────────────── PanelHost: downloads ─────────────────────────

    private var tapSpentAt = -1L // the tap that already paid for a download
    private var lastDownloadAt = Long.MIN_VALUE / 2
    private var savesRunning = 0 // writes queued or running on SAVER (main thread only)

    /**
     * A download started in the page, through WebView's DownloadListener, which can't tell which frame asked. A generated
     * app in a Build preview (a sandboxed iframe with allow-downloads) could start downloads in a loop without a tap,
     * filling Downloads/Atelier or throwing the owner out to the browser again and again. So a download is taken only
     * while Atelier itself is the page, only within [DOWNLOAD_TAP_MS] of a real tap on it (each tap pays for one
     * download), only when no other save is under way, and not more often than every [DOWNLOAD_GAP_MS]; anything else
     * is dropped.
     *
     * data: URLs are decoded off the main thread. A blob: URL only exists inside the page, so the page is asked (by
     * token) to read it and send the bytes over the bridge; https downloads go to the browser.
     */
    override fun onDownload(url: String, mimeType: String?) {
        val w = web ?: return
        val now = SystemClock.elapsedRealtime()
        val tap = w.lastTapAt
        if (tap <= 0L || tap == tapSpentAt || now - tap > DOWNLOAD_TAP_MS) return
        if (!Atelier.isAtelier(w.view.url?.toUri())) return
        tapSpentAt = tap
        if (saveBusy(now) || now - lastDownloadAt < DOWNLOAD_GAP_MS) {
            toast(R.string.save_busy)
            return
        }
        lastDownloadAt = now
        when {
            url.startsWith("data:", ignoreCase = true) ->
                saveLater { Downloads.decodeDataUrl(url)?.let { (mime, bytes) -> Payload(bytes, mime, null) } }
            url.startsWith("blob:", ignoreCase = true) -> {
                if (!w.binaryBridge || !url.startsWith("blob:${Atelier.ORIGIN}/")) {
                    toast(R.string.save_failed)
                    return
                }
                val token = UUID.randomUUID().toString()
                pendingSave = PendingSave(token, null, mimeType, armed = false, at = now)
                w.evaluate(blobReader(url, token))
            }
            else -> openExternal(url.toUri())
        }
    }

    /** A save is being written, or its bytes are still on their way from the page. */
    private fun saveBusy(now: Long): Boolean = savesRunning > 0 || pendingSave?.let { now - it.at <= PENDING_SAVE_BUSY_MS } == true

    private fun blobReader(url: String, token: String): String {
        val u = JSONObject.quote(url)
        val t = JSONObject.quote(token)
        return """(async () => { const A = window.${Atelier.BRIDGE}; if (!A) return;
            try { const b = await (await fetch($u)).blob(); if (b.size > ${Downloads.MAX_BYTES}) throw 0;
              A.postMessage(JSON.stringify({ type: 'save-begin', token: $t, mime: b.type, size: b.size }));
              A.postMessage(await b.arrayBuffer());
            } catch (e) { A.postMessage(JSON.stringify({ type: 'save-failed', token: $t })); } })();""".trimIndent()
    }

    override fun onBridgeBytes(bytes: ByteArray) {
        val save = pendingSave ?: return
        pendingSave = null
        if (!save.armed || SystemClock.elapsedRealtime() - save.at > SAVE_WINDOW_MS) return
        saveLater { Payload(bytes, save.mime, save.name) }
    }

    private class Payload(val bytes: ByteArray, val mime: String?, val name: String?)

    /** Builds (data: URLs decode here) and writes the file on [SAVER], one at a time, off the main thread. */
    private fun saveLater(payload: () -> Payload?) {
        savesRunning++
        val app = applicationContext
        SAVER.execute {
            val saved = try {
                val p = payload()
                val target = p?.let { Downloads.resolve(it.name, it.mime) }
                p != null && target != null && p.bytes.size <= Downloads.MAX_BYTES &&
                    Downloads.save(app, p.bytes, target.second, target.first) != null
            } catch (_: Exception) {
                false
            } catch (_: OutOfMemoryError) {
                false
            }
            runOnUiThread {
                savesRunning--
                Toast.makeText(app, if (saved) R.string.saved else R.string.save_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ───────────────────────── PanelHost: the page bridge (window.AtelierAssist) ─────────────────────────

    private fun post(message: JSONObject) {
        val proxy = pageProxy ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        try { proxy.postMessage(message.toString()) } catch (_: Exception) { pageProxy = null }
    }

    private fun hello() = JSONObject()
        .put("type", "hello")
        .put("v", 1)
        .put("app", "atelier-assist")
        .put("version", appVersion())
        .put("invocation", invocation)
        .put("start", startMode)
        .put("mic", micState())
        .put("expanded", sheetCtl.expanded)
        .put("save", web?.binaryBridge == true)

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    } catch (_: PackageManager.NameNotFoundException) {
        ""
    }

    /**
     * Messages from Atelier's top frame (origin-checked by PanelWeb). Each is a JSON object with a "type":
     *   ready                → reply {type:'hello', …}; the page may then receive {type:'listen'} and {type:'sheet'}
     *   close                → slide the sheet away
     *   open-app {path}      → open the installed Atelier app at that same-site path, then close
     *   expand / collapse    → sheet height
     *   theme {bg:'#rrggbb'} → match the sheet to the page's own background
     *   mic-settings         → this app's Android settings (microphone blocked)
     *   save-begin {mime, size, name?, token?} + one ArrayBuffer message → save to Downloads/Atelier
     *
     * The page's own saves (no token) come only from Atelier's top frame, so they need no tap; they are written one at
     * a time, and refused while [MAX_QUEUED_SAVES] are already waiting.
     */
    override fun onBridgeMessage(message: JSONObject, reply: JavaScriptReplyProxy) {
        when (message.optString("type")) {
            "ready" -> {
                pageProxy = reply
                post(hello())
            }
            "close" -> sheetCtl.dismiss()
            "open-app" -> Atelier.pathUrl(message.optString("path", "/"))?.let(::openInAtelier)
            "expand" -> sheetCtl.setExpanded(true)
            "collapse" -> sheetCtl.setExpanded(false)
            "theme" -> applyPageColor(message.optString("bg"))
            "mic-settings" -> openAppSettings()
            "save-begin" -> {
                val size = message.optLong("size", -1)
                val token = message.optString("token").ifEmpty { null }
                val current = pendingSave
                // With a token: the answer to our own blob read (onDownload), which must match the one we asked for.
                // Without: the page saving one of its own files (assist-panel-integration.md).
                val ours = token != null && token == current?.token
                val askedMime = current?.mime
                if (token != null && !ours) return
                if (size <= 0 || size > Downloads.MAX_BYTES || (!ours && savesRunning >= MAX_QUEUED_SAVES)) {
                    toast(R.string.save_failed)
                    if (ours) pendingSave = null
                    return
                }
                val now = SystemClock.elapsedRealtime()
                pendingSave = if (ours) {
                    PendingSave(token, null, message.optString("mime").ifEmpty { askedMime }, armed = true, at = now)
                } else {
                    PendingSave(null, message.optString("name").take(120), message.optString("mime"), armed = true, at = now)
                }
            }
            "save-failed" -> {
                if (pendingSave?.token != null && pendingSave?.token == message.optString("token")) {
                    pendingSave = null
                    toast(R.string.save_failed)
                }
            }
        }
    }

    private companion object {
        const val INVOCATION_ASSIST = "assist"
        const val INVOCATION_LAUNCHER = "launcher"
        const val PREF_MIC_BLOCKED = "micBlocked"
        const val PREF_SETUP_DISMISSED = "setupDismissed"
        const val BANNER_SETUP = 1
        const val BANNER_MIC = 2
        const val LATE_UNLOCK_MS = 5_000L
        const val SAVE_WINDOW_MS = 60_000L
        const val PENDING_SAVE_BUSY_MS = 15_000L
        const val DOWNLOAD_TAP_MS = 10_000L
        const val DOWNLOAD_GAP_MS = 2_000L
        const val MAX_QUEUED_SAVES = 4
        const val MIC_INSTANT_MS = 600L
        const val CRASH_WINDOW_MS = 60_000L

        /** One writer for the whole process: saves never run in parallel and outlive the activity that started them. */
        val SAVER: ExecutorService = Executors.newSingleThreadExecutor()
    }
}
