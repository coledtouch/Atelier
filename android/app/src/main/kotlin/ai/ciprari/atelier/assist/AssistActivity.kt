package ai.ciprari.atelier.assist

import android.Manifest
import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Atelier Assist: a small card over whatever is on screen. The "A" hovers and pulses while you talk, the words appear
 * as you say them with a chip for the mode they suggest (Ask, Code, Image, Video, Ideas, Build), and when you stop, this
 * app's own Atelier (its Trusted Web Activity, [AtelierLauncherActivity]) opens in that mode with your words (sent after Atelier's own visible, cancellable hold once the
 * app is paired; otherwise in the box for you to send).
 *
 * Launched by ACTION_ASSIST (the digital-assistant gesture: Samsung's side-key press and hold, the corner swipe). The
 * launcher icon is the full Atelier app now ([AtelierLauncherActivity]); this card has its own task affinity so the
 * Atelier it opens lands in the app's normal task, not in this excluded-from-recents one. Pressing again while it listens finishes the
 * utterance; pressing again otherwise listens anew. It never shows over the lock screen: a locked phone is asked to
 * unlock first, and the card closes if that is cancelled. ACTION_ASSIST can carry the previous app's assist data: only
 * the keyboard hint is read, the rest is dropped unread.
 *
 * States: listening → thinking → a 1.2 s "Opening in …" window (any touch on the card holds it, so the chip can change
 * the mode) → opening. Typing is the same card with a text field. Tap outside, Back or × cancels. The card closes when
 * it goes out of sight, except on the setup page (the owner may be copying the link in Atelier) and during system
 * round trips it started (unlock, permission settings, digital-assistant settings).
 *
 * Privacy: nothing said or typed is logged or stored; only the pairing key is kept (SharedPreferences, no backup).
 */
class AssistActivity : ComponentActivity(), Listener.Events {

    private enum class Phase { SETUP, IDLE, PERMISSION, LISTENING, THINKING, REVIEW, HELD, TYPING, ERROR, OPENING }

    private lateinit var prefs: SharedPreferences
    private lateinit var listener: Listener
    private val main = Handler(Looper.getMainLooper())

    private lateinit var root: FrameLayout
    private lateinit var scrim: View
    private lateinit var card: TouchCard
    private lateinit var mainPage: LinearLayout
    private var setupPage: View? = null
    private lateinit var mark: MarkView
    private lateinit var status: TextView
    private lateinit var words: TextView
    private lateinit var input: EditText
    private lateinit var progress: View
    private lateinit var chooser: HorizontalScrollView
    private lateinit var chooserRow: LinearLayout
    private lateinit var chip: TextView
    private lateinit var secondary: TextView
    private lateinit var primary: TextView
    private lateinit var more: ImageButton

    private var phase = Phase.IDLE
    private var heard = ""
    private var guess = ModeClassifier.classify("")
    private var chosen: Mode? = null
    private var failure: Listener.Failure? = null
    private var micBlocked = false
    private var micAskedAt = 0L
    private var micRationaleBefore = false
    private var waitingUnlock = false
    private var awayOnPurpose = false
    private var leaving = false
    private var entered = false

    /**
     * The card was started by the system (the assistant gesture), the home screen or this app: it may open Atelier by
     * itself after the 1.2 s. Started by any other app, it waits for the owner's Open tap, so an app can't make it
     * turn played-back speech into a keyed send.
     */
    private var ownerLaunch = false
    private var setupNote: Pair<Int, Boolean>? = null // (message, good)
    private var barInsets = androidx.core.graphics.Insets.NONE
    private var imeBottom = 0

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (leaving) return@registerForActivityResult
        if (granted) {
            micBlocked = false
            if (phase == Phase.PERMISSION || phase == Phase.ERROR) listenNow()
            return@registerForActivityResult
        }
        // "Blocked" only when Android won't ask again: the rationale flag went from true to false (a second "Don't
        // allow"), or the answer came back at once with no dialog. A dismissed dialog keeps "Allow" (it asks again).
        val rationale = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        val instant = SystemClock.elapsedRealtime() - micAskedAt < MIC_INSTANT_MS
        micBlocked = !rationale && (micRationaleBefore || instant)
        fail(Listener.Failure.PERMISSION)
    }

    // ───────────────────────── lifecycle ─────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), // light icons over the scrim at the bottom
        )
        window.isNavigationBarContrastEnforced = false
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        dropLegacyWebData()
        listener = Listener(this, this)
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    chooser.isVisible -> showChooser(false)
                    phase == Phase.SETUP && prefs.getBoolean(PREF_SETUP_SEEN, false) -> closeSetup()
                    else -> leave()
                }
            }
        })
        val launch = readLaunch(intent)
        val recreated = savedInstanceState != null
        whenUnlocked { late ->
            when {
                !prefs.getBoolean(PREF_SETUP_SEEN, false) -> openSetup()
                launch.keyboard -> type("")
                late || recreated -> setPhase(Phase.IDLE) // the mic never opens by itself long after the press
                else -> listen()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val launch = readLaunch(intent)
        setIntent(intent)
        if (leaving) return
        whenUnlocked { late ->
            when (phase) {
                Phase.SETUP -> refreshSetup()
                // Pressed again while talking: that's the end of it (with nothing said yet: close).
                Phase.LISTENING -> if (heard.isBlank()) leave() else listener.stop()
                Phase.THINKING, Phase.OPENING -> Unit
                else -> when {
                    launch.keyboard -> type(if (phase == Phase.TYPING) input.text.toString() else "")
                    late -> setPhase(Phase.IDLE)
                    else -> listen()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        awayOnPurpose = false
        when {
            phase == Phase.SETUP -> refreshSetup()
            phase == Phase.ERROR && failure == Listener.Failure.PERMISSION && micGranted() -> listenNow()
        }
    }

    override fun onStop() {
        super.onStop()
        if (leaving || isFinishing || phase == Phase.OPENING) return // OPENING: handOff() closes the card itself
        listener.cancel()
        cancelCountdown()
        // Out of sight: an assistant card doesn't wait around. Except the setup page (the owner may be copying the link
        // in Atelier right now) and round trips this card started (unlock, Settings).
        if (phase == Phase.SETUP || waitingUnlock || awayOnPurpose) {
            if (phase == Phase.LISTENING || phase == Phase.THINKING || phase == Phase.REVIEW) setPhase(Phase.IDLE)
            return
        }
        finishQuietly()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        listener.destroy()
        super.onDestroy()
    }

    private fun finishQuietly() {
        if (isFinishing) return
        leaving = true
        listener.cancel()
        finish()
        if (Build.VERSION.SDK_INT < 34) {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    /** Slide the card away, then close. */
    private fun leave() {
        if (leaving) return
        leaving = true
        listener.cancel()
        cancelCountdown()
        hideKeyboard()
        card.animate().alpha(0f).translationY(dp(16).toFloat()).setDuration(150).setInterpolator(EASE).withEndAction {
            leaving = false
            finishQuietly()
        }.start()
        scrim.animate().alpha(0f).setDuration(150).start()
    }

    // ───────────────────────── launch + lock screen ─────────────────────────

    private class Launch(val keyboard: Boolean)

    /** Call synchronously from onCreate/onNewIntent: the system's record of the caller is only current there. */
    private fun readLaunch(i: Intent?): Launch {
        val assist = i?.action == Intent.ACTION_ASSIST
        val keyboard = assist && runCatching { i!!.getBooleanExtra(Intent.EXTRA_ASSIST_INPUT_HINT_KEYBOARD, false) }.getOrDefault(false)
        // ACTION_ASSIST can carry the previous app's assist context: never read, kept or passed on. Clearing the extras
        // also drops any EXTRA_REFERRER the caller wrote itself, so getReferrer() below is the system's own record.
        runCatching { i?.replaceExtras(null as Bundle?) }
        runCatching { intent?.replaceExtras(null as Bundle?) }
        ownerLaunch = launchedByOwner()
        return Launch(keyboard)
    }

    /**
     * The system ("android", System UI: the assistant gesture and side key), the default home app, this app, or another
     * app that is part of the system image (an OEM side-key handler). Unknown or invisible callers count as other apps.
     */
    private fun launchedByOwner(): Boolean {
        val pkg = runCatching { referrer }.getOrNull()?.takeIf { it.scheme == "android-app" }?.host ?: return false
        if (pkg == packageName || pkg in SYSTEM_CALLERS) return true
        val home = runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                packageManager.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
            } else {
                @Suppress("DEPRECATION")
                packageManager.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)
            }
        }.getOrNull()?.activityInfo?.packageName
        if (pkg == home) return true
        return runCatching { Atelier.isSystemApp(packageManager, pkg) }.getOrDefault(false)
    }

    /** Runs [then] once the phone is unlocked; `late` when unlocking took long enough that the mic shouldn't open. */
    private fun whenUnlocked(then: (late: Boolean) -> Unit) {
        val km = getSystemService(KeyguardManager::class.java)
        if (km == null || !km.isKeyguardLocked) {
            then(false)
            return
        }
        if (waitingUnlock) return
        waitingUnlock = true
        val asked = SystemClock.elapsedRealtime()
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                waitingUnlock = false
                then(SystemClock.elapsedRealtime() - asked > LATE_UNLOCK_MS)
            }

            override fun onDismissCancelled() {
                waitingUnlock = false
                finishQuietly()
            }

            override fun onDismissError() {
                waitingUnlock = false
                finishQuietly()
            }
        })
    }

    // ───────────────────────── listening ─────────────────────────

    private fun micGranted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun locale(): Locale = resources.configuration.locales.takeIf { !it.isEmpty }?.get(0) ?: Locale.getDefault()

    /** Start a new utterance (the owner's mode pick, if any, stays). */
    private fun listen() {
        if (leaving) return
        cancelCountdown()
        hideKeyboard()
        showChooser(false)
        heard = ""
        guess = ModeClassifier.classify("")
        if (!listener.available()) return fail(Listener.Failure.UNAVAILABLE)
        if (!micGranted()) {
            setPhase(Phase.PERMISSION)
            micRationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
            micAskedAt = SystemClock.elapsedRealtime()
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        listenNow()
    }

    private fun listenNow() {
        if (leaving) return
        failure = null
        setPhase(Phase.LISTENING)
        listener.start(locale())
    }

    override fun onListening() {
        if (phase == Phase.LISTENING) render()
    }

    override fun onLevel(level: Float) {
        if (phase == Phase.LISTENING) mark.setLevel(level)
    }

    override fun onPartial(text: String) {
        if (phase != Phase.LISTENING && phase != Phase.THINKING) return
        heard = text
        guess = ModeClassifier.classify(text)
        renderWords()
        renderChip()
        mark.setAccent(currentMode().accent)
    }

    override fun onSpeechEnd() {
        if (phase == Phase.LISTENING) setPhase(Phase.THINKING)
    }

    override fun onFinal(text: String) {
        if (phase != Phase.LISTENING && phase != Phase.THINKING) return
        heard = text
        guess = ModeClassifier.classify(text)
        tick()
        // "Make an image" and nothing else: wait for the owner (Open still works: Atelier opens in that mode). With TalkBack
        // (touch exploration) the 1.2 s window is too short to hear and change: it waits for Open too.
        // Started by another app (not the system, home screen or this app): wait for Open too.
        val emptyCommand = chosen == null && guess.explicit && guess.prompt.isBlank()
        if (emptyCommand || touchExploring() || !ownerLaunch) setPhase(Phase.HELD) else startCountdown()
    }

    override fun onFailed(error: Listener.Failure) {
        if (phase != Phase.LISTENING && phase != Phase.THINKING) return
        // The speech service says "no permission" although this app has the mic: the service itself can't record.
        if (error == Listener.Failure.PERMISSION && micGranted()) return fail(Listener.Failure.AUDIO)
        if (error == Listener.Failure.PERMISSION) micBlocked = !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
        fail(error)
    }

    private fun fail(error: Listener.Failure) {
        listener.cancel()
        failure = error
        setPhase(Phase.ERROR)
    }

    // ───────────────────────── review, typing, hand-off ─────────────────────────

    private val countdown = Runnable { if (phase == Phase.REVIEW) go(heard) }

    private fun startCountdown() {
        setPhase(Phase.REVIEW)
        progress.animate().cancel()
        progress.scaleX = 0f
        progress.animate().scaleX(1f).setDuration(REVIEW_MS).setInterpolator(LinearInterpolator()).start()
        main.postDelayed(countdown, REVIEW_MS)
    }

    private fun cancelCountdown() {
        main.removeCallbacks(countdown)
        if (::progress.isInitialized) {
            progress.animate().cancel()
            progress.scaleX = 0f
        }
    }

    /** Any touch on the card during "Opening in …" holds it there: the owner wants to check or change something. */
    private fun hold() {
        if (phase != Phase.REVIEW) return
        cancelCountdown()
        setPhase(Phase.HELD)
    }

    private fun type(prefill: String) {
        if (leaving) return
        listener.cancel()
        cancelCountdown()
        showChooser(false)
        setPhase(Phase.TYPING)
        input.setText(prefill)
        input.setSelection(input.length())
        guess = ModeClassifier.classify(prefill)
        render()
        input.requestFocus()
        input.post { WindowCompat.getInsetsController(window, input).show(WindowInsetsCompat.Type.ime()) }
    }

    private fun hideKeyboard() {
        if (!::input.isInitialized) return
        if (input.hasFocus()) input.clearFocus()
        WindowCompat.getInsetsController(window, input).hide(WindowInsetsCompat.Type.ime())
    }

    private fun currentMode(): Mode = chosen ?: guess.mode

    private fun touchExploring(): Boolean = getSystemService(AccessibilityManager::class.java)?.isTouchExplorationEnabled == true

    /**
     * Open Atelier with [text]: in the owner's chosen mode, else the classifier's. The classifier's trimmed prompt is used
     * when its mode is the one going out ("make an image of a red fox" → "a red fox"); a mode the owner picked instead
     * gets the whole request.
     */
    private fun go(text: String) {
        if (leaving || phase == Phase.OPENING) return
        cancelCountdown()
        val g = ModeClassifier.classify(text)
        val mode = chosen ?: g.mode
        val prompt = if (mode == g.mode) g.prompt else ModeClassifier.spoken(text)
        val target = Atelier.target(this)
        val saved = prefs.getString(PREF_KEY, null)?.takeIf(LaunchLink::isKey)
        val url = LaunchLink.build(mode, prompt, if (target.keyed) saved else null)
        guess = g
        hideKeyboard()
        setPhase(Phase.OPENING)
        tick(confirm = true)
        main.postDelayed({ handOff(url, target, paired = saved != null) }, OPEN_DELAY_MS)
    }

    /** Opens [url] in this app's own TWA (an explicit intent: no other app can receive it, key or not). */
    private fun handOff(url: String, target: Atelier.Target, paired: Boolean) {
        if (isFinishing || leaving) return // closed meanwhile (a tap outside, Back): nothing opens
        try {
            startActivity(Atelier.intent(this, url))
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_app)
            failure = Listener.Failure.OTHER
            setPhase(Phase.HELD)
            return
        } catch (_: SecurityException) {
            toast(R.string.no_app)
            setPhase(Phase.HELD)
            return
        }
        // No trusted Chrome: the TWA opens in another browser, and the key stayed here.
        if (paired && !target.keyed) toast(R.string.not_keyed)
        finishQuietly()
    }

    private fun tick(confirm: Boolean = false) {
        val kind = if (confirm && Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.KEYBOARD_TAP
        card.performHapticFeedback(kind)
    }

    private fun toast(res: Int) = Toast.makeText(applicationContext, res, Toast.LENGTH_LONG).show()

    // ───────────────────────── UI ─────────────────────────

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()
    private fun color(res: Int) = getColor(res)

    private fun buildUi() {
        root = FrameLayout(this)
        scrim = View(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0x00000000, 0x14000000, color(R.color.scrim_low)))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            setOnClickListener { leave() }
            alpha = 0f
        }
        card = TouchCard(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(color(R.color.card_bg))
                cornerRadius = dp(28).toFloat()
                setStroke(max(1, dp(1) / 2 + 1), color(R.color.card_line))
            }
            elevation = dp(18).toFloat()
            outlineAmbientShadowColor = Color.BLACK
            outlineSpotShadowColor = Color.BLACK
            accessibilityPaneTitle = getString(R.string.app_name)
            setPadding(dp(16), dp(14), dp(12), dp(14))
            // The A's view hangs 4 dp over its slot (MarkGeometry): let it draw into the card's padding. The card's own
            // rounded background and shadow come from its background drawable and outline, which this doesn't change,
            // and the overhang stays well inside the card's rounded corners.
            clipToPadding = false
            clipChildren = false
            onTouchDown = { ev ->
                // A touch on the card that no other window covers is the owner: from now on it may open by itself.
                if (ev.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) == 0) ownerLaunch = true
                hold()
            }
            alpha = 0f
        }

        mainPage = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            clipToPadding = false
        }
        card.addView(mainPage, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // Top row: the A, the status and words, ×.
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            clipChildren = false
            clipToPadding = false
        }
        mark = MarkView(this).apply {
            isClickable = true
            isFocusable = true
            setOnClickListener { onMarkTap() }
            setOnLongClickListener { openSetup(); true }
        }
        // An 80 dp view in 1.1.0's 72 dp slot (4 dp overhang all round; 1.1.0 also pulled the slot 4 dp to the start), so
        // the pulse, glow and ring have room for the bob and the +12% pulse without the card's layout changing.
        val overhang = dp(MarkGeometry.OVERHANG_DP)
        top.addView(mark, LinearLayout.LayoutParams(dp(MarkGeometry.VIEW_DP.toInt()), dp(MarkGeometry.VIEW_DP.toInt())).apply {
            marginStart = -dp(4) - overhang
            marginEnd = -overhang
            topMargin = -overhang
            bottomMargin = -overhang
        })

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(10), 0, 0)
        }
        status = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            letterSpacing = 0.14f
            isAllCaps = true
            setTextColor(color(R.color.ink_2))
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        words = TextView(this).apply {
            setTextColor(color(R.color.ink))
            setLineSpacing(0f, 1.12f)
            maxLines = 4
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(0, dp(4), 0, 0)
        }
        input = EditText(this).apply {
            setTextColor(color(R.color.ink))
            setHintTextColor(color(R.color.ink_3))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            hint = getString(R.string.hint_typing)
            // Not MULTI_LINE: Enter is Send. Long text still wraps (horizontally scrolling off).
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            setHorizontallyScrolling(false)
            maxLines = 5
            filters = arrayOf(InputFilter.LengthFilter(LaunchLink.MAX_PROMPT))
            background = GradientDrawable().apply {
                setColor(color(R.color.card_surface))
                cornerRadius = dp(14).toFloat()
            }
            setPadding(dp(12), dp(10), dp(12), dp(10))
            isVisible = false
            doAfterTextChanged {
                main.removeCallbacks(classifyTyped)
                main.postDelayed(classifyTyped, TYPE_DEBOUNCE_MS)
                if (phase == Phase.TYPING) {
                    primary.isEnabled = !it.isNullOrBlank()
                    primary.alpha = if (primary.isEnabled) 1f else 0.4f
                }
            }
            setOnEditorActionListener { _, actionId, event ->
                val enter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (actionId == EditorInfo.IME_ACTION_SEND || enter) {
                    sendTyped()
                    true
                } else {
                    false
                }
            }
        }
        col.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        col.addView(words, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        col.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        top.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(iconButton(R.drawable.ic_close, R.string.close) { leave() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        mainPage.addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        // The "Opening in …" countdown.
        progress = View(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(1).toFloat()
                setColor(Mode.ASK.accent)
            }
            pivotX = 0f
            scaleX = 0f
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            visibility = View.INVISIBLE
        }
        mainPage.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)).apply {
            topMargin = dp(10)
            marginStart = dp(4)
            marginEnd = dp(4)
        })

        // Mode chooser: all six, in Atelier's order.
        chooserRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (m in Mode.entries) {
            chooserRow.addView(modeChip(m), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) })
        }
        chooser = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(chooserRow)
            isVisible = false
        }
        mainPage.addView(chooser, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

        // Footer: mode chip … secondary, primary, ⋯
        val foot = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        chip = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
            letterSpacing = 0.12f
            isAllCaps = true
            gravity = Gravity.CENTER_VERTICAL
            minHeight = dp(34)
            setPadding(dp(12), 0, dp(14), 0)
            compoundDrawablePadding = dp(7)
            isClickable = true
            isFocusable = true
            setOnClickListener { showChooser(!chooser.isVisible) }
            visibility = View.INVISIBLE
        }
        foot.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(4) })
        foot.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        secondary = ghostButton()
        foot.addView(secondary, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        primary = pillButton()
        foot.addView(primary, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(4) })
        more = iconButton(R.drawable.ic_more_horiz, R.string.setup_open) { openSetup() }
        foot.addView(more, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(2) })
        mainPage.addView(foot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

        root.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(card, FrameLayout.LayoutParams(dp(360), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            barInsets = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            layoutCard()
            WindowInsetsCompat.CONSUMED
        }
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) root.post { layoutCard() }
        }
        render()
    }

    /** ~92% of the width, at most 420 dp, above the nav bar or the keyboard; slides in the first time. */
    private fun layoutCard() {
        if (root.width == 0) return
        val lp = card.layoutParams as FrameLayout.LayoutParams
        val avail = root.width - barInsets.left - barInsets.right
        val width = min((avail * 0.92f).roundToInt(), dp(MAX_CARD_DP))
        val bottom = max(barInsets.bottom, imeBottom) + dp(14)
        if (lp.width != width || lp.bottomMargin != bottom || lp.topMargin != barInsets.top + dp(12) ||
            lp.leftMargin != barInsets.left || lp.rightMargin != barInsets.right
        ) {
            lp.width = width
            lp.bottomMargin = bottom
            lp.topMargin = barInsets.top + dp(12)
            lp.leftMargin = barInsets.left
            lp.rightMargin = barInsets.right
            card.layoutParams = lp
        }
        if (!entered) {
            entered = true
            card.translationY = dp(28).toFloat()
            card.animate().alpha(1f).translationY(0f).setDuration(240).setInterpolator(EASE).start()
            scrim.animate().alpha(1f).setDuration(240).start()
        }
    }

    private fun iconButton(icon: Int, label: Int, onClick: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon)
        imageTintList = ColorStateList.valueOf(color(R.color.ink_2))
        background = ripple(null, dp(20).toFloat())
        contentDescription = getString(label)
        tooltipText = getString(label)
        setOnClickListener { onClick() }
    }

    private fun ripple(fill: Int?, radius: Float): Drawable {
        val shape = GradientDrawable().apply {
            cornerRadius = radius
            setColor(fill ?: Color.TRANSPARENT)
        }
        val mask = GradientDrawable().apply {
            cornerRadius = radius
            setColor(Color.WHITE)
        }
        val wave = if (fill == null) 0x29ECE6D9 else 0x33000000
        return RippleDrawable(ColorStateList.valueOf(wave), if (fill == null) null else shape, mask)
    }

    private fun ghostButton() = TextView(this).apply {
        setTextColor(color(R.color.ink_2))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        gravity = Gravity.CENTER
        minHeight = dp(40)
        setPadding(dp(12), 0, dp(12), 0)
        compoundDrawablePadding = dp(6)
        background = ripple(null, dp(20).toFloat())
        isClickable = true
        isFocusable = true
    }

    private fun pillButton() = TextView(this).apply {
        setTextColor(color(R.color.card_bg))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
        minHeight = dp(40)
        minWidth = dp(72)
        setPadding(dp(18), 0, dp(18), 0)
        isClickable = true
        isFocusable = true
    }

    private fun setButton(b: TextView, label: Int?, icon: Int? = null, onClick: (() -> Unit)? = null) {
        if (label == null) {
            b.isVisible = false
            b.setOnClickListener(null)
            return
        }
        b.isVisible = true
        b.isEnabled = true
        b.alpha = 1f
        b.text = getString(label)
        val d = icon?.let { getDrawable(it)?.mutate()?.apply { setTint(color(R.color.ink_2)) } }
        b.setCompoundDrawablesRelativeWithIntrinsicBounds(d, null, null, null)
        b.setOnClickListener { onClick?.invoke() }
    }

    private fun modeChip(m: Mode) = TextView(this).apply {
        text = m.label
        tag = m
        typeface = Typeface.MONOSPACE
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
        letterSpacing = 0.12f
        isAllCaps = true
        gravity = Gravity.CENTER
        minHeight = dp(36)
        setPadding(dp(14), 0, dp(14), 0)
        contentDescription = getString(R.string.mode_a11y, m.label)
        isClickable = true
        isFocusable = true
        setOnClickListener {
            chosen = m
            showChooser(false)
            mark.setAccent(m.accent)
            render()
        }
    }

    private fun chipBackground(accent: Int, strong: Boolean, filled: Boolean = false): Drawable {
        val shape = GradientDrawable().apply {
            cornerRadius = dp(18).toFloat()
            when {
                filled -> setColor(accent)
                strong -> {
                    setColor(ColorUtils.setAlphaComponent(accent, 0x24))
                    setStroke(dp(1), ColorUtils.setAlphaComponent(accent, 0x73))
                }
                else -> {
                    setColor(Color.TRANSPARENT)
                    setStroke(dp(1), color(R.color.card_line))
                }
            }
        }
        val mask = GradientDrawable().apply {
            cornerRadius = dp(18).toFloat()
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(0x29ECE6D9), shape, mask)
    }

    private fun dot(color: Int): Drawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
        setSize(dp(7), dp(7))
    }

    private fun showChooser(show: Boolean) {
        if (!::chooser.isInitialized) return
        if (show) renderChooser()
        chooser.isVisible = show
    }

    private val classifyTyped = Runnable {
        if (phase != Phase.TYPING) return@Runnable
        guess = ModeClassifier.classify(input.text.toString())
        renderChip()
        mark.setAccent(currentMode().accent)
    }

    private fun sendTyped() {
        val text = input.text.toString()
        if (text.isBlank()) return
        heard = text
        go(text)
    }

    private fun onMarkTap() {
        when (phase) {
            Phase.LISTENING -> if (heard.isBlank()) {
                listener.cancel()
                setPhase(Phase.IDLE)
            } else {
                listener.stop()
            }
            Phase.THINKING, Phase.OPENING, Phase.PERMISSION -> Unit
            Phase.SETUP -> Unit
            else -> listen()
        }
    }

    // ───────────────────────── render ─────────────────────────

    private fun setPhase(p: Phase) {
        if (p != Phase.REVIEW) main.removeCallbacks(countdown)
        if (phase != p && p != Phase.HELD && p != Phase.TYPING) showChooser(false)
        phase = p
        render()
    }

    private fun render() {
        if (!::more.isInitialized) return
        val inSetup = phase == Phase.SETUP
        mainPage.isVisible = !inSetup
        setupPage?.isVisible = inSetup
        if (inSetup) return

        val mode = currentMode()
        mark.look = when (phase) {
            Phase.LISTENING -> MarkView.Look.LISTENING
            Phase.THINKING -> MarkView.Look.THINKING
            Phase.OPENING -> MarkView.Look.OPENING
            Phase.ERROR -> MarkView.Look.ERROR
            Phase.PERMISSION -> MarkView.Look.STILL
            else -> MarkView.Look.IDLE
        }
        mark.setAccent(if (phase == Phase.ERROR) color(R.color.ink_3) else mode.accent)
        mark.contentDescription = getString(if (phase == Phase.LISTENING) R.string.mark_stop else R.string.mark_start)

        status.text = when (phase) {
            Phase.LISTENING -> getString(R.string.status_listening)
            Phase.THINKING -> getString(R.string.status_thinking)
            Phase.REVIEW -> getString(R.string.status_opening_in, mode.label)
            Phase.HELD -> getString(if (chosen == null && guess.explicit && guess.prompt.isBlank()) R.string.status_what else R.string.status_ready)
            Phase.TYPING -> getString(R.string.status_typing)
            Phase.IDLE -> getString(R.string.status_idle)
            Phase.PERMISSION -> getString(R.string.status_permission)
            Phase.OPENING -> getString(R.string.status_opening)
            Phase.ERROR -> getString(errorTitle(failure))
            Phase.SETUP -> ""
        }
        status.setTextColor(color(if (phase == Phase.ERROR) R.color.warn else R.color.ink_2))
        // Never read out while the mic is open (a screen reader speaking into it would be transcribed).
        status.accessibilityLiveRegion = if (phase == Phase.LISTENING || phase == Phase.THINKING) View.ACCESSIBILITY_LIVE_REGION_NONE else View.ACCESSIBILITY_LIVE_REGION_POLITE

        val typing = phase == Phase.TYPING
        input.isVisible = typing
        words.isVisible = !typing
        renderWords()

        progress.visibility = if (phase == Phase.REVIEW) View.VISIBLE else View.INVISIBLE
        (progress.background as? GradientDrawable)?.setColor(mode.accent)
        renderChip()
        renderButtons()
        more.isVisible = phase != Phase.OPENING
        if (chooser.isVisible) renderChooser()
    }

    private fun renderWords() {
        when {
            phase == Phase.ERROR -> {
                words.text = getString(errorBody(failure))
                words.typeface = Typeface.DEFAULT
                words.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                words.setTextColor(color(R.color.ink))
            }
            heard.isBlank() -> {
                words.text = getString(R.string.hint_listening)
                words.typeface = Typeface.create(Typeface.SERIF, Typeface.ITALIC)
                words.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                words.setTextColor(color(R.color.ink_3))
            }
            else -> {
                words.text = tail(heard)
                words.typeface = Typeface.DEFAULT
                words.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                words.setTextColor(color(R.color.ink))
            }
        }
    }

    /** The newest words: a long utterance shows its end (multi-line TextViews can't ellipsize at the start). */
    private fun tail(s: String): String {
        val t = s.trim()
        if (t.length <= TAIL_CHARS) return t
        val cut = t.substring(t.length - TAIL_CHARS)
        val space = cut.indexOf(' ')
        return "…" + if (space in 1..24) cut.substring(space + 1) else cut
    }

    private fun renderChip() {
        val text = if (phase == Phase.TYPING) input.text.toString() else heard
        val show = phase !in setOf(Phase.ERROR, Phase.PERMISSION, Phase.IDLE) && (chosen != null || text.isNotBlank())
        chip.visibility = if (show) View.VISIBLE else View.INVISIBLE
        if (!show) return
        val mode = currentMode()
        val strong = chosen != null || guess.sure
        chip.text = mode.label
        chip.setTextColor(if (strong) mode.accent else color(R.color.ink_2))
        chip.background = chipBackground(mode.accent, strong)
        chip.setCompoundDrawablesRelativeWithIntrinsicBounds(dot(if (strong) mode.accent else color(R.color.ink_3)), null, null, null)
        chip.contentDescription = getString(R.string.chip_a11y, mode.label)
    }

    private fun renderChooser() {
        val current = currentMode()
        for (i in 0 until chooserRow.childCount) {
            val v = chooserRow.getChildAt(i) as TextView
            val m = v.tag as Mode
            val on = m == current
            v.setTextColor(if (on) color(R.color.card_bg) else m.accent)
            v.background = chipBackground(m.accent, strong = true, filled = on)
            v.isSelected = on
        }
    }

    private fun renderButtons() {
        val mode = currentMode()
        primary.background = ripple(mode.accent, dp(20).toFloat())
        when (phase) {
            Phase.IDLE -> {
                setButton(secondary, R.string.type, R.drawable.ic_keyboard) { type("") }
                setButton(primary, R.string.talk) { listen() }
            }
            Phase.PERMISSION -> {
                setButton(secondary, R.string.type, R.drawable.ic_keyboard) { type("") }
                setButton(primary, null)
            }
            Phase.LISTENING -> {
                setButton(secondary, R.string.type, R.drawable.ic_keyboard) { type(heard) }
                setButton(primary, null)
            }
            Phase.THINKING, Phase.OPENING, Phase.SETUP -> {
                setButton(secondary, null)
                setButton(primary, null)
            }
            Phase.REVIEW, Phase.HELD -> {
                setButton(secondary, R.string.edit, R.drawable.ic_keyboard) { type(heard) }
                setButton(primary, R.string.open) { go(heard) }
            }
            Phase.TYPING -> {
                setButton(secondary, R.string.talk, R.drawable.ic_mic) { listen() }
                setButton(primary, R.string.send) { sendTyped() }
                primary.isEnabled = input.text.isNotBlank()
                primary.alpha = if (primary.isEnabled) 1f else 0.4f
            }
            Phase.ERROR -> {
                val f = failure
                when {
                    f == Listener.Failure.UNAVAILABLE || f == Listener.Failure.LANGUAGE -> {
                        setButton(secondary, if (f == Listener.Failure.LANGUAGE) R.string.retry else null) { listen() }
                        setButton(primary, R.string.type) { type(heard) }
                    }
                    f == Listener.Failure.PERMISSION -> {
                        setButton(secondary, R.string.type, R.drawable.ic_keyboard) { type("") }
                        if (micBlocked) setButton(primary, R.string.settings) { openAppSettings() } else setButton(primary, R.string.allow) { listen() }
                    }
                    else -> {
                        setButton(secondary, R.string.type, R.drawable.ic_keyboard) { type(heard) }
                        setButton(primary, R.string.retry) { listen() }
                    }
                }
            }
        }
        if (phase == Phase.TYPING) primary.alpha = if (primary.isEnabled) 1f else 0.4f
    }

    private fun errorTitle(f: Listener.Failure?): Int = when (f) {
        Listener.Failure.NO_MATCH -> R.string.err_no_match_title
        Listener.Failure.NETWORK -> R.string.err_network_title
        Listener.Failure.BUSY -> R.string.err_busy_title
        Listener.Failure.PERMISSION -> R.string.err_permission_title
        Listener.Failure.AUDIO -> R.string.err_audio_title
        Listener.Failure.UNAVAILABLE -> R.string.err_unavailable_title
        Listener.Failure.LANGUAGE -> R.string.err_language_title
        else -> R.string.err_other_title
    }

    private fun errorBody(f: Listener.Failure?): Int = when (f) {
        Listener.Failure.NO_MATCH -> R.string.err_no_match
        Listener.Failure.NETWORK -> R.string.err_network
        Listener.Failure.BUSY -> R.string.err_busy
        Listener.Failure.PERMISSION -> if (micBlocked) R.string.err_permission_blocked else R.string.err_permission
        Listener.Failure.AUDIO -> R.string.err_audio
        Listener.Failure.UNAVAILABLE -> R.string.err_unavailable
        Listener.Failure.LANGUAGE -> R.string.err_language
        else -> R.string.err_other
    }

    // ───────────────────────── setup: pairing + side button ─────────────────────────

    private fun openSetup() {
        if (leaving) return
        listener.cancel()
        cancelCountdown()
        hideKeyboard()
        showChooser(false)
        setupNote = null
        setPhase(Phase.SETUP)
        refreshSetup()
    }

    /** Back to the card, and listen: the setup page has been seen (first run shows it once). */
    private fun closeSetup() {
        prefs.edit { putBoolean(PREF_SETUP_SEEN, true) }
        setupPage?.let { card.removeView(it) }
        setupPage = null
        setupNote = null
        listen()
    }

    private fun refreshSetup() {
        if (phase != Phase.SETUP) return
        setupPage?.let { card.removeView(it) }
        setupPage = buildSetup().also { card.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)) }
        render()
    }

    private fun buildSetup(): View {
        val paired = LaunchLink.isKey(prefs.getString(PREF_KEY, null))
        val scroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), 0, dp(4), dp(2))
        }
        scroll.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(eyebrow(R.string.setup_eyebrow), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(iconButton(R.drawable.ic_close, R.string.close) { closeSetup() }, LinearLayout.LayoutParams(dp(40), dp(40)))
        col.addView(head)

        col.addView(text(getString(R.string.setup_title), 24f, R.color.ink, Typeface.SERIF).apply { setPadding(0, 0, 0, dp(6)) })
        col.addView(text(getString(R.string.setup_body), 14f, R.color.ink_2))
        listOf(R.string.setup_step1, R.string.setup_step2, R.string.setup_step3).forEachIndexed { i, res ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(8), 0, 0)
            }
            row.addView(text("${i + 1}", 12f, R.color.accent, Typeface.MONOSPACE).apply { setPadding(0, dp(2), dp(10), 0) })
            row.addView(text(getString(res), 14f, R.color.ink), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            col.addView(row)
        }

        col.addView(text(getString(if (paired) R.string.setup_paired else R.string.setup_unpaired), 13f, if (paired) R.color.accent else R.color.ink_2).apply {
            setCompoundDrawablesRelativeWithIntrinsicBounds(dot(color(if (paired) R.color.accent else R.color.ink_3)), null, null, null)
            compoundDrawablePadding = dp(8)
            setPadding(0, dp(14), 0, 0)
        })
        setupNote?.let { (msg, good) ->
            col.addView(text(getString(msg), 13f, if (good) R.color.ink else R.color.warn).apply {
                setPadding(0, dp(6), 0, 0)
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            })
        }
        val acts = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(12), 0, 0)
        }
        acts.addView(pillButton().apply {
            text = getString(R.string.paste)
            background = ripple(Mode.ASK.accent, dp(20).toFloat())
            setOnClickListener { pasteLink() }
        })
        if (paired) {
            acts.addView(ghostButton().apply {
                text = getString(R.string.unpair)
                setOnClickListener { unpair() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(6) })
        }
        col.addView(acts)

        col.addView(divider())
        col.addView(eyebrow(R.string.side_eyebrow).apply { setPadding(0, 0, 0, dp(6)) })
        val held = assistantRoleHeld()
        col.addView(text(getString(if (held) R.string.side_ready else R.string.side_todo), 14f, if (held) R.color.ink else R.color.ink_2))
        if (!held) {
            col.addView(ghostButton().apply {
                text = getString(R.string.side_open)
                setTextColor(color(R.color.accent))
                setOnClickListener { openAssistantSettings() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
                marginStart = -dp(12)
            })
        }

        col.addView(divider())
        col.addView(text(getString(R.string.privacy_note), 12f, R.color.ink_3))
        val done = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, dp(12), 0, 0)
        }
        done.addView(pillButton().apply {
            text = getString(R.string.done)
            background = ripple(color(R.color.ink), dp(20).toFloat())
            setOnClickListener { closeSetup() }
        })
        col.addView(done)
        return scroll
    }

    private fun eyebrow(res: Int) = text(getString(res), 11f, R.color.ink_2, Typeface.MONOSPACE).apply {
        letterSpacing = 0.14f
        isAllCaps = true
    }

    private fun text(s: String, sp: Float, colorRes: Int, face: Typeface? = null) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color(colorRes))
        setLineSpacing(0f, 1.15f)
        face?.let { typeface = it }
    }

    private fun divider() = View(this).apply {
        setBackgroundColor(color(R.color.card_line))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, max(1, dp(1) / 2)).apply {
            topMargin = dp(16)
            bottomMargin = dp(14)
        }
    }

    /**
     * Reads the clipboard only now, from this tap. Keeps just the 22-character key from a valid Atelier link, then clears
     * the clipboard (the link is a secret: it can send to Atelier without a tap). Neither the link nor the key is logged.
     */
    private fun pasteLink() {
        val cm = getSystemService(ClipboardManager::class.java)
        val clip = try {
            cm?.primaryClip
        } catch (_: SecurityException) {
            null
        }
        val item = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
        val result = LaunchLink.parsePairing(item?.text)
        setupNote = when (result) {
            is LaunchLink.Pairing.Ok -> {
                prefs.edit { putString(PREF_KEY, result.key) }
                try {
                    cm?.clearPrimaryClip()
                } catch (_: RuntimeException) {
                }
                R.string.pair_ok to true
            }
            LaunchLink.Pairing.Empty -> R.string.pair_empty to false
            LaunchLink.Pairing.NotLink -> R.string.pair_not_link to false
            LaunchLink.Pairing.NotAtelier -> R.string.pair_not_atelier to false
            LaunchLink.Pairing.NoKey -> R.string.pair_no_key to false
        }
        refreshSetup()
    }

    private fun unpair() {
        prefs.edit { remove(PREF_KEY) }
        setupNote = R.string.unpaired to true
        refreshSetup()
    }

    private fun assistantRoleHeld(): Boolean {
        val rm = getSystemService(RoleManager::class.java) ?: return false
        return try {
            rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && rm.isRoleHeld(RoleManager.ROLE_ASSISTANT)
        } catch (_: RuntimeException) {
            false
        }
    }

    /** The assistant role's own settings page (its "manage" intent), else the default-apps list. */
    private fun openAssistantSettings() {
        for (action in listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS)) {
            try {
                awayOnPurpose = true
                startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                toast(R.string.setup_hint)
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
        awayOnPurpose = false
    }

    private fun openAppSettings() {
        try {
            awayOnPurpose = true
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            awayOnPurpose = false
        }
    }

    // ───────────────────────── 1.0.x leftovers ─────────────────────────

    /**
     * Atelier Assist 1.0.x showed Atelier in a WebView, which kept its own Atelier sign-in (cookies, localStorage) in
     * this app's private storage. 1.1 has no WebView, so that sign-in is dead weight holding a credential: it is deleted
     * once, off the main thread, along with 1.0's preferences. (The installed Atelier app keeps its own sign-in.)
     */
    private fun dropLegacyWebData() {
        if (prefs.getBoolean(PREF_LEGACY_CLEARED, false)) return
        prefs.edit {
            putBoolean(PREF_LEGACY_CLEARED, true)
            remove("micBlocked")
            remove("setupDismissed")
        }
        val dataDir = File(applicationInfo.dataDir)
        val dirs = listOf(File(dataDir, "app_webview"), File(dataDir, "app_textures"), File(cacheDir, "WebView"), File(cacheDir, "org.chromium.android_webview"))
        Thread {
            for (d in dirs) runCatching { if (d.exists()) d.deleteRecursively() }
        }.apply { isDaemon = true }.start()
    }

    /** The card: any touch-down on it holds the countdown first, and touches it doesn't use never reach the scrim. */
    @SuppressLint("ClickableViewAccessibility", "ViewConstructor")
    private class TouchCard(context: Context) : LinearLayout(context) {
        var onTouchDown: ((MotionEvent) -> Unit)? = null

        override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
            if (ev.actionMasked == MotionEvent.ACTION_DOWN) onTouchDown?.invoke(ev)
            return super.dispatchTouchEvent(ev)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            super.onTouchEvent(event)
            return true
        }
    }

    private companion object {
        /** Always present, and their names can't be taken by another app. */
        val SYSTEM_CALLERS = setOf("android", "com.android.systemui")
        const val PREFS = "assist"
        const val PREF_KEY = "launchKey"
        const val PREF_SETUP_SEEN = "setupSeen"
        const val PREF_LEGACY_CLEARED = "legacyWebDataCleared"
        const val LATE_UNLOCK_MS = 5_000L
        const val MIC_INSTANT_MS = 600L
        const val REVIEW_MS = 1_200L
        const val OPEN_DELAY_MS = 140L
        const val TYPE_DEBOUNCE_MS = 120L
        const val MAX_CARD_DP = 420
        const val TAIL_CHARS = 150
        val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)
    }
}
