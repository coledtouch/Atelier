package ai.ciprari.atelier.assist

import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.SystemClock
import android.view.View
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Atelier's "A", hovering and pulsing with the voice.
 *
 * - Hover: a slow vertical bob (±2.5 dp, 2.8 s).
 * - Pulse: while listening, the mark grows (up to ~12%) and a soft glow and a thin ring swell with the mic level
 *   ([level], smoothed: quick to rise, slow to fall, so it breathes with the voice instead of flickering).
 * - The glow is the current mode's accent; a change of mode cross-fades to the new colour.
 * - [Look.THINKING] breathes on its own; [Look.OPENING] blooms; [Look.ERROR] goes still and dim.
 * - Reduced motion (Settings → Accessibility → Remove animations, i.e. animator duration scale 0): no bob, no pulse, no
 *   frame loop; the mark and a still glow only.
 *
 * Draws only while attached and visible; the frame loop stops in [Look.ERROR] and [Look.STILL].
 *
 * Never clipped: [MarkGeometry] keeps the glow, the ring and the grown A inside the view at any level, bob and density
 * (1.1.0 let the glow and ring reach the view's edge, so the bob pushed them past it and the pulse was cut flat).
 */
internal class MarkView(context: Context) : View(context) {

    enum class Look { IDLE, LISTENING, THINKING, OPENING, ERROR, STILL }

    private val density = resources.displayMetrics.density
    private val mark: Drawable = requireNotNull(context.getDrawable(R.drawable.atelier_mark)).mutate()
    private var motion = ValueAnimator.areAnimatorsEnabled()

    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = MarkGeometry.RING_STROKE_DP * density
    }
    private val shaderMatrix = Matrix()
    private var glowShader: RadialGradient? = null
    private var shaderColor = 0

    private val born = SystemClock.uptimeMillis()
    private var lastFrame = 0L
    private var lookSince = born

    private var target = 0f
    private var level = 0f

    private var colorFrom = Mode.ASK.accent
    private var colorTo = Mode.ASK.accent
    private var colorSince = 0L
    private val argb = ArgbEvaluator()

    var look: Look = Look.IDLE
        set(value) {
            if (field == value) return
            field = value
            lookSince = SystemClock.uptimeMillis()
            if (value != Look.LISTENING) target = 0f
            invalidate()
        }

    /** The mic level, 0..1 (raw; smoothed here). */
    fun setLevel(raw: Float) {
        target = raw.coerceIn(0f, 1f)
        if (!motion) return
        if (look == Look.LISTENING) postInvalidateOnAnimation()
    }

    /** Glow colour (the mode's accent); cross-fades over 250 ms (switches at once with reduced motion). */
    fun setAccent(color: Int) {
        val now = SystemClock.uptimeMillis()
        if (color == colorTo) return
        if (motion) {
            colorFrom = currentColor(now)
            colorSince = now
        } else {
            // Reduced motion: no frame loop finishes a cross-fade, so the new colour is drawn at once.
            colorFrom = color
            colorSince = 0L
        }
        colorTo = color
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        motion = ValueAnimator.areAnimatorsEnabled()
        if (!motion) {
            colorFrom = colorTo
            colorSince = 0L
        }
        lastFrame = 0L
    }

    private fun currentColor(now: Long): Int {
        val t = ((now - colorSince) / COLOR_MS).coerceIn(0f, 1f)
        return if (t >= 1f) colorTo else argb.evaluate(t, colorFrom, colorTo) as Int
    }

    private fun shaderFor(color: Int): RadialGradient {
        val existing = glowShader
        if (existing != null && shaderColor == color) return existing
        val core = Color.argb(255, Color.red(color), Color.green(color), Color.blue(color))
        val mid = Color.argb(90, Color.red(color), Color.green(color), Color.blue(color))
        val edge = Color.argb(0, Color.red(color), Color.green(color), Color.blue(color))
        // Unit circle at the origin; placed and sized per frame with the local matrix.
        return RadialGradient(0f, 0f, 1f, intArrayOf(core, mid, edge), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP).also {
            glowShader = it
            shaderColor = color
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val now = SystemClock.uptimeMillis()
        val dt = if (lastFrame == 0L) 0.016f else ((now - lastFrame) / 1000f).coerceIn(0f, 0.1f)
        lastFrame = now
        val t = (now - born) / 1000f

        // Quick to rise (~60 ms), slow to fall (~260 ms).
        val tau = if (target > level) 0.06f else 0.26f
        level += (target - level) * (1f - exp(-dt / tau))

        val energy = if (!motion) {
            when (look) {
                Look.LISTENING, Look.OPENING -> 0.35f
                Look.THINKING -> 0.3f
                Look.ERROR -> 0.06f
                else -> 0.18f
            }
        } else {
            when (look) {
                Look.LISTENING -> 0.12f + 0.88f * level
                Look.THINKING -> 0.3f + 0.22f * wave(t, 1.3f)
                Look.IDLE -> 0.12f + 0.08f * wave(t, 3.2f)
                Look.OPENING -> 0.55f + 0.45f * ((now - lookSince) / 260f).coerceIn(0f, 1f)
                Look.ERROR -> 0.06f
                Look.STILL -> 0.18f
            }
        }
        val moving = motion && look != Look.ERROR && look != Look.STILL
        val bob = if (moving) MarkGeometry.bob(sin(2 * PI * t / BOB_PERIOD_S).toFloat(), density) else 0f

        // Everything stays within r of the bobbing centre, and r leaves room for the bob: nothing reaches the edge.
        val cx = width / 2f
        val cy = height / 2f + bob
        val r = MarkGeometry.radius(width, height, density)
        val color = currentColor(now)

        // Glow.
        val glowR = MarkGeometry.glowRadius(r, energy)
        val shader = shaderFor(color)
        shaderMatrix.setScale(glowR, glowR)
        shaderMatrix.postTranslate(cx, cy)
        shader.setLocalMatrix(shaderMatrix)
        glowPaint.shader = shader
        glowPaint.alpha = (255 * (0.16f + 0.5f * energy)).roundToInt().coerceIn(0, 255)
        canvas.drawCircle(cx, cy, glowR, glowPaint)

        // Ring.
        if (look != Look.ERROR) {
            val ringR = MarkGeometry.ringRadius(r, energy, ringPaint.strokeWidth)
            ringPaint.color = color
            ringPaint.alpha = (255 * (0.12f + 0.3f * (1f - energy))).roundToInt().coerceIn(0, 255)
            canvas.drawCircle(cx, cy, ringR, ringPaint)
        }

        // The A.
        val grow = when (look) {
            Look.LISTENING -> 0.12f * level
            Look.THINKING -> 0.03f * wave(t, 1.3f)
            Look.OPENING -> 0.12f * ((now - lookSince) / 260f).coerceIn(0f, 1f)
            else -> 0f
        }
        val b = MarkGeometry.markBounds(cx, cy, MarkGeometry.markHalf(density, if (motion) grow else 0f, r))
        mark.setBounds(b[0], b[1], b[2], b[3])
        mark.alpha = if (look == Look.ERROR) 150 else 255
        mark.draw(canvas)

        val settling = (now - colorSince) < COLOR_MS || kotlin.math.abs(target - level) > 0.004f
        if (isAttachedToWindow && windowVisibility == VISIBLE && (moving || (motion && settling))) postInvalidateOnAnimation()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility == VISIBLE) {
            lastFrame = 0L
            invalidate()
        }
    }

    private fun wave(t: Float, period: Float): Float = 0.5f + 0.5f * sin(2 * PI * t / period).toFloat()

    private companion object {
        const val BOB_PERIOD_S = 2.8
        const val COLOR_MS = 250f
    }
}
