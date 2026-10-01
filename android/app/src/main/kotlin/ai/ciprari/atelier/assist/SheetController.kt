package ai.ciprari.atelier.assist

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import androidx.core.view.WindowInsetsCompat
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The bottom sheet's geometry: rest height (~70% of the window), expanded height (up to just under the status bar),
 * the slide-in / slide-out animations, and the drag on the header.
 *
 * The sheet's layout height is only changed at the ends of a gesture: while a finger moves, the sheet is a full-height
 * view slid down with translationY, so the WebView inside is not resized every frame. The sheet's bottom padding is the
 * navigation bar or the keyboard, whichever is taller; with the keyboard up the sheet always uses the full height.
 */
internal class SheetController(
    private val root: ViewGroup,
    private val scrim: View,
    private val sheet: View,
    dragArea: View,
    private val maxWidth: Int,
    private val onDismissed: () -> Unit,
) {
    private val density = root.resources.displayMetrics.density
    private val gap = (8 * density).roundToInt()
    private val flingVelocity = 1000 * density
    private val touchSlop = ViewConfiguration.get(root.context).scaledTouchSlop

    private var topInset = 0
    private var imeVisible = false
    private var height = 0 // the layout height we asked for (sheet.height lags a frame behind)
    private var shown = false
    private var dismissing = false
    private var anim: ValueAnimator? = null

    var expanded = false
        private set
    var onExpandedChanged: ((Boolean) -> Unit)? = null

    init {
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) root.post { onRootResized() }
        }
        attachDrag(dragArea)
    }

    private fun full(): Int = max(0, root.height - topInset - gap)
    private fun half(): Int = min((root.height * REST_FRACTION).roundToInt(), full())
    private fun rest(): Int = if (imeVisible) full() else half()
    private fun target(): Int = if (expanded || imeVisible) full() else half()

    private fun setHeight(px: Int) {
        if (px == height && sheet.layoutParams.height == px) return
        height = px
        val lp = sheet.layoutParams
        lp.height = px
        sheet.layoutParams = lp
    }

    /** Insets arrive before the first layout and whenever the bars, cutout or keyboard change. */
    fun applyInsets(insets: WindowInsetsCompat) {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        topInset = bars.top
        val wasIme = imeVisible
        imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > 0
        sheet.setPadding(0, 0, 0, max(bars.bottom, ime.bottom))
        val lp = sheet.layoutParams as FrameLayout.LayoutParams
        if (lp.leftMargin != bars.left || lp.rightMargin != bars.right) {
            lp.leftMargin = bars.left
            lp.rightMargin = bars.right
            sheet.layoutParams = lp
        }
        if (root.height == 0 || !shown || dismissing) return
        if (imeVisible != wasIme || height > full()) snap()
    }

    private fun onRootResized() {
        if (root.height == 0 || dismissing) return
        val lp = sheet.layoutParams as FrameLayout.LayoutParams
        val width = min(root.width - lp.leftMargin - lp.rightMargin, maxWidth)
        if (lp.width != width) {
            lp.width = width
            sheet.layoutParams = lp
        }
        if (!shown) enter() else snap()
    }

    /** Straight to the resting geometry for the current state, no animation. */
    private fun snap() {
        anim?.cancel()
        setHeight(target())
        sheet.translationY = 0f
        scrim.alpha = 1f
    }

    private fun enter() {
        shown = true
        setHeight(target())
        sheet.translationY = height.toFloat()
        scrim.alpha = 0f
        animate(0f, 1f, ENTER_MS, EMPHASIZED_DECELERATE) {}
    }

    /** Slide away, then [onDismissed]. Safe to call twice. */
    fun dismiss() {
        if (dismissing) return
        dismissing = true
        if (!shown || root.height == 0) {
            onDismissed()
            return
        }
        animate(height.toFloat(), 0f, EXIT_MS, EMPHASIZED_ACCELERATE) { onDismissed() }
    }

    /** A new launch arrived while the sheet was sliding away: bring it back. */
    fun cancelDismiss() {
        if (!dismissing) return
        dismissing = false
        settle(expanded)
    }

    fun toggle() = settle(!expanded)

    fun setExpanded(value: Boolean) {
        if (!dismissing && shown) settle(value)
    }

    /** Animate to the rest or expanded height from wherever the sheet is now. */
    private fun settle(toFull: Boolean) {
        val changed = expanded != toFull
        expanded = toFull
        if (root.height == 0 || !shown) return
        val tgt = target()
        if (height < tgt) {
            // growing: give the sheet its final height first, slid down so nothing jumps, then slide it up
            val visible = height - sheet.translationY
            setHeight(tgt)
            sheet.translationY = max(0f, tgt - visible)
        }
        animate(max(0f, (height - tgt).toFloat()), 1f, SETTLE_MS, EMPHASIZED) {
            if (height != tgt) {
                setHeight(tgt)
                sheet.translationY = 0f
            }
        }
        if (changed) onExpandedChanged?.invoke(expanded)
    }

    private fun animate(toY: Float, toAlpha: Float, ms: Long, curve: PathInterpolator, end: () -> Unit) {
        anim?.cancel()
        val fromY = sheet.translationY
        val fromAlpha = scrim.alpha
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = ms
            interpolator = curve
            addUpdateListener {
                val f = it.animatedValue as Float
                sheet.translationY = fromY + (toY - fromY) * f
                scrim.alpha = fromAlpha + (toAlpha - fromAlpha) * f
            }
            addListener(object : AnimatorListenerAdapter() {
                private var cancelled = false
                override fun onAnimationCancel(animation: Animator) { cancelled = true }
                override fun onAnimationEnd(animation: Animator) { if (!cancelled) end() }
            })
            start()
        }
    }

    // ───────────── drag on the header: up to expand, down to shrink or close; a tap toggles ─────────────
    // A second tap within the double-tap timeout doesn't toggle back: a double-tap (an easy habit on a handle) ends where
    // the first tap was going, instead of bouncing up and back down. TalkBack's double-tap is one click and isn't affected.

    private val doubleTapMs = ViewConfiguration.getDoubleTapTimeout().toLong()
    private var lastTapUp = Long.MIN_VALUE / 2
    private var downY = 0f
    private var startVisible = 0f
    private var dragging = false
    private var velocity: VelocityTracker? = null

    @SuppressLint("ClickableViewAccessibility") // a tap still goes to performClick(); the header has a click listener
    private fun attachDrag(area: View) {
        area.setOnTouchListener { v, e ->
            if (dismissing || !shown) return@setOnTouchListener true
            // Raw coordinates: the view itself moves under the finger.
            val ev = MotionEvent.obtain(e).apply { setLocation(e.rawX, e.rawY) }
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    anim?.cancel()
                    velocity?.recycle()
                    velocity = VelocityTracker.obtain().also { it.addMovement(ev) }
                    downY = e.rawY
                    startVisible = height - sheet.translationY
                    dragging = false
                }
                MotionEvent.ACTION_MOVE -> {
                    velocity?.addMovement(ev)
                    val dy = e.rawY - downY
                    if (!dragging && abs(dy) > touchSlop) {
                        dragging = true
                        v.parent?.requestDisallowInterceptTouchEvent(true)
                    }
                    if (dragging) dragTo(startVisible - dy)
                }
                MotionEvent.ACTION_UP -> {
                    val vt = velocity
                    vt?.addMovement(ev)
                    vt?.computeCurrentVelocity(1000)
                    val vy = vt?.yVelocity ?: 0f
                    if (dragging) {
                        release(vy)
                    } else {
                        val quick = e.eventTime - lastTapUp < doubleTapMs
                        lastTapUp = e.eventTime
                        // this tap's ACTION_DOWN stopped the first tap's animation: finish that move instead of reversing it
                        if (quick) settle(expanded) else v.performClick()
                    }
                    vt?.recycle()
                    velocity = null
                    dragging = false
                }
                MotionEvent.ACTION_CANCEL -> {
                    if (dragging) release(0f)
                    velocity?.recycle()
                    velocity = null
                    dragging = false
                }
            }
            ev.recycle()
            true
        }
    }

    private fun dragTo(visibleWanted: Float) {
        val full = full()
        val visible = visibleWanted.coerceIn(0f, full.toFloat())
        if (visible > height) setHeight(full) // pulled above the current height: full height, slid down
        sheet.translationY = max(0f, height - visible)
        scrim.alpha = (visible / max(1, rest())).coerceIn(0f, 1f)
    }

    private fun release(vy: Float) {
        val rest = rest().toFloat()
        val full = full().toFloat()
        val visible = height - sheet.translationY
        when {
            (visible < rest * DISMISS_FRACTION && vy >= 0f) || (vy > flingVelocity && visible <= rest + touchSlop) -> dismiss()
            imeVisible -> settle(expanded)
            vy < -flingVelocity -> settle(true)
            vy > flingVelocity -> settle(false)
            else -> settle(visible > (rest + full) / 2f)
        }
    }

    private companion object {
        const val REST_FRACTION = 0.70f
        const val DISMISS_FRACTION = 0.75f // let go below 75% of the rest height (pulled down a quarter) to close
        const val ENTER_MS = 300L
        const val SETTLE_MS = 260L
        const val EXIT_MS = 200L
        val EMPHASIZED = PathInterpolator(0.2f, 0f, 0f, 1f)
        val EMPHASIZED_DECELERATE = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
        val EMPHASIZED_ACCELERATE = PathInterpolator(0.3f, 0f, 0.8f, 0.15f)
    }
}
