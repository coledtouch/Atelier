package ai.ciprari.atelier.assist

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The app and the web app must agree on the six modes: the `?start=` spellings public/launch.js accepts (LAUNCH_MODES)
 * and the dark-theme accent tokens in public/app.css :root (--c-ask … --c-build). Skipped when the repo's public/ isn't
 * next to android/ (the build passes its root as the "atelier.repo" system property).
 */
class ModeParityTest {
    private fun repoFile(path: String): File? {
        val root = System.getProperty("atelier.repo") ?: return null
        return File(root, path).takeIf { it.isFile }
    }

    @Test
    fun mode_ids_match_launch_js() {
        val launch = repoFile("public/launch.js")
        assumeTrue("public/launch.js not found", launch != null)
        val m = Regex("""export const LAUNCH_MODES = \[([^\]]*)]""").find(launch!!.readText())
        assumeTrue("LAUNCH_MODES not found", m != null)
        val ids = Regex("""'([a-z]+)'""").findAll(m!!.groupValues[1]).map { it.groupValues[1] }.toList()
        assertEquals(ids, Mode.entries.map { it.id })
    }

    @Test
    fun accents_match_app_css_dark_tokens() {
        val css = repoFile("public/app.css")
        assumeTrue("public/app.css not found", css != null)
        val text = css!!.readText()
        // The first :root block is the dark theme (the light one follows inside a media query / [data-theme]).
        val root = Regex(""":root\s*\{([^}]*)}""").find(text)?.groupValues?.get(1)
        assumeTrue(":root not found", root != null)
        for (mode in Mode.entries) {
            val token = Regex("""--c-${mode.id}:\s*#([0-9a-fA-F]{6})""").find(root!!)?.groupValues?.get(1)
            assertEquals("--c-${mode.id}", token?.lowercase(), String.format("%06x", mode.accent and 0xFFFFFF))
        }
    }
}
