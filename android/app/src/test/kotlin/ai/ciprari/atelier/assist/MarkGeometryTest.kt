package ai.ciprari.atelier.assist

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

/**
 * The pulsing A is never cut off: at every mic level, pulse, bob position and density (display size changes the density
 * too; font size doesn't touch the mark), everything MarkView draws stays inside the view.
 */
class MarkGeometryTest {
    // ldpi … xxxhdpi, plus Samsung's display-size steps in between (e.g. 2.625, 2.8125, 3.5).
    private val densities = listOf(0.75f, 1f, 1.5f, 2f, 2.625f, 2.75f, 2.8125f, 3f, 3.5f, 4f, 4.5f)
    private val steps = (0..20).map { it / 20f }

    private fun px(dp: Float, density: Float) = (dp * density).roundToInt() // what AssistActivity.dp() gives

    @Test
    fun nothing_drawn_leaves_the_view_at_any_level_bob_or_density() {
        for (d in densities) {
            val size = px(MarkGeometry.VIEW_DP, d)
            for (energy in steps) for (g in steps) for (bob in listOf(-1f, -0.5f, 0f, 0.5f, 1f)) for (ring in listOf(true, false)) {
                val grow = g * MarkGeometry.MAX_GROW
                val b = MarkGeometry.drawnBounds(size, size, d, energy, grow, bob, ring)
                val where = "density $d, energy $energy, grow $grow, bob $bob"
                assertTrue("left ${b[0]} < 0 ($where)", b[0] >= 0f)
                assertTrue("top ${b[1]} < 0 ($where)", b[1] >= 0f)
                assertTrue("right ${b[2]} > $size ($where)", b[2] <= size)
                assertTrue("bottom ${b[3]} > $size ($where)", b[3] <= size)
            }
        }
    }

    @Test
    fun out_of_range_input_is_clamped_not_drawn_bigger() {
        val d = 3f
        val size = px(MarkGeometry.VIEW_DP, d)
        val b = MarkGeometry.drawnBounds(size, size, d, energy = 5f, grow = 1f, bobSine = 3f, ring = true)
        assertTrue(b[0] >= 0f && b[1] >= 0f && b[2] <= size && b[3] <= size)
    }

    @Test
    fun a_taller_or_wider_view_keeps_it_inside_too() {
        for (d in densities) {
            val s = px(MarkGeometry.VIEW_DP, d)
            for ((w, h) in listOf(s to s + px(30f, d), s + px(30f, d) to s)) {
                val b = MarkGeometry.drawnBounds(w, h, d, 1f, MarkGeometry.MAX_GROW, 1f, true)
                assertTrue(b[0] >= 0f && b[1] >= 0f && b[2] <= w && b[3] <= h)
                val up = MarkGeometry.drawnBounds(w, h, d, 1f, MarkGeometry.MAX_GROW, -1f, true)
                assertTrue(up[1] >= 0f && up[3] <= h)
            }
        }
    }

    @Test
    fun the_pulse_still_looks_like_1_1_0() {
        // 1.1.0's 72 dp view drew the glow up to 36 dp and the A up to 38 dp × 1.12. Same or a touch more now.
        for (d in densities) {
            val size = px(MarkGeometry.VIEW_DP, d)
            val r = MarkGeometry.radius(size, size, d)
            assertTrue("glow at full level ${r / d} dp", MarkGeometry.glowRadius(r, 1f) / d >= 35.5f)
            assertEquals(38f * 1.12f / 2f, MarkGeometry.markHalf(d, MarkGeometry.MAX_GROW, r) / d, 0.01f)
        }
        assertEquals(MarkGeometry.VIEW_DP, MarkGeometry.SLOT_DP + 2 * MarkGeometry.OVERHANG_DP, 0f)
    }
}
