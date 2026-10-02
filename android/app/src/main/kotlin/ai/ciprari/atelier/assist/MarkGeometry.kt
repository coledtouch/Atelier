package ai.ciprari.atelier.assist

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Where [MarkView] draws: the glow, the ring and the "A", for any pulse, mic level, bob and density.
 *
 * Everything is measured from one radius budget, [radius]: half the view's short side minus the bob's travel and a 1 dp
 * anti-aliasing edge. The glow never grows past it, the ring (with its stroke) stays inside it, and the A at its largest
 * (+12%) is far smaller. Since the bob only moves the centre by [BOB_DP], nothing ever reaches the view's edge, so no
 * parent clip can cut the pulse off whatever the mic level, display size or font size.
 *
 * The view is [VIEW_DP] square but takes only a [SLOT_DP] slot in the card's top row (negative margins of [OVERHANG_DP]
 * on each side; its parents don't clip children), so the card's layout is the same as 1.1.0's 72 dp slot while the
 * pulse gets room to swell.
 *
 * Pure Kotlin: [MarkGeometryTest] checks the bounds on the JVM.
 */
internal object MarkGeometry {
    /** The view's size. */
    const val VIEW_DP = 80f

    /** The space it takes in the top row (1.1.0's mark slot). */
    const val SLOT_DP = 72f

    /** How far the view hangs over its slot on each side: (VIEW_DP − SLOT_DP) / 2. */
    const val OVERHANG_DP = 4

    /** The A at rest. */
    const val MARK_DP = 38f

    /** The A's largest pulse: +12%. */
    const val MAX_GROW = 0.12f

    /** Vertical hover: ± this. */
    const val BOB_DP = 2.5f

    /** Kept clear at the view's edge for anti-aliasing and rounding to whole pixels. */
    const val EDGE_DP = 1f

    const val RING_STROKE_DP = 1.25f

    /** The radius everything is drawn within, around the (bobbing) centre. */
    fun radius(widthPx: Int, heightPx: Int, density: Float): Float =
        max(0f, min(widthPx, heightPx) / 2f - (BOB_DP + EDGE_DP) * density)

    fun glowRadius(r: Float, energy: Float): Float = r * (0.5f + 0.5f * energy.coerceIn(0f, 1f))

    /** The ring's centre line; with half its stroke outside it, it still stays within [r]. */
    fun ringRadius(r: Float, energy: Float, strokePx: Float): Float =
        (r * (0.62f + 0.3f * energy.coerceIn(0f, 1f))).coerceAtMost(r - strokePx / 2f).coerceAtLeast(0f)

    /** Half the A's side at pulse [grow] (0 … [MAX_GROW]); never more than [r]. */
    fun markHalf(density: Float, grow: Float, r: Float): Float =
        min(MARK_DP * density * (1f + grow.coerceIn(0f, MAX_GROW)) / 2f, r)

    /** The vertical bob for a sine value in −1 … 1. */
    fun bob(sine: Float, density: Float): Float = sine.coerceIn(-1f, 1f) * BOB_DP * density

    /** The A's pixel bounds, as MarkView sets them on the drawable: left, top, right, bottom. */
    fun markBounds(cx: Float, cy: Float, half: Float): IntArray =
        intArrayOf((cx - half).roundToInt(), (cy - half).roundToInt(), (cx + half).roundToInt(), (cy + half).roundToInt())

    /**
     * Everything drawn in one frame, as left, top, right, bottom (px), for a view of [widthPx] × [heightPx].
     * Used by the tests: it must stay within 0 … width and 0 … height.
     */
    fun drawnBounds(widthPx: Int, heightPx: Int, density: Float, energy: Float, grow: Float, bobSine: Float, ring: Boolean): FloatArray {
        val r = radius(widthPx, heightPx, density)
        val cx = widthPx / 2f
        val cy = heightPx / 2f + bob(bobSine, density)
        val stroke = RING_STROKE_DP * density
        var reach = glowRadius(r, energy)
        if (ring) reach = max(reach, ringRadius(r, energy, stroke) + stroke / 2f)
        val m = markBounds(cx, cy, markHalf(density, grow, r))
        return floatArrayOf(
            min(cx - reach, m[0].toFloat()),
            min(cy - reach, m[1].toFloat()),
            max(cx + reach, m[2].toFloat()),
            max(cy + reach, m[3].toFloat()),
        )
    }
}
