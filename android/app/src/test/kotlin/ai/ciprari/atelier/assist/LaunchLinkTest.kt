package ai.ciprari.atelier.assist

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LaunchLinkTest {
    private val key = "AbCdEfGhIjKlMnOpQrStU_" // 22 base64url characters
    private val other = "ZZCdEfGhIjKlMnOpQrStU-"
    private val base = "https://atelier.ciprari.ai"

    @Test
    fun paired_link_carries_the_key_and_send_with_q_last() {
        assertEquals("$base/?start=image&via=assist#k=$key&send=1&q=a%20red%20fox", LaunchLink.build(Mode.IMAGE, "a red fox", key))
        assertEquals("$base/?start=ideas&via=assist#k=$key&send=1&q=x", LaunchLink.build(Mode.IDEAS, "x", key))
    }

    @Test
    fun unpaired_link_only_prefills() {
        assertEquals("$base/?start=ask&via=assist#q=what%20is%202%2B2%20%26%20why%20%3D%20%3F", LaunchLink.build(Mode.ASK, "what is 2+2 & why = ?", null))
        // A malformed key never goes out.
        for (bad in listOf("", "short", key.dropLast(1), key + "x", "AbCdEfGhIjKlMnOpQrSt=_", "AbCdEfGhIjKlMnOpQrSt+_")) {
            assertEquals(bad, "$base/?start=code&via=assist#q=x", LaunchLink.build(Mode.CODE, "x", bad))
        }
    }

    @Test
    fun empty_prompt_opens_the_mode_without_a_fragment() {
        assertEquals("$base/?start=video&via=assist", LaunchLink.build(Mode.VIDEO, "", key))
        assertEquals("$base/?start=build&via=assist", LaunchLink.build(Mode.BUILD, "  \n\t ", key))
    }

    @Test
    fun every_character_that_could_end_q_early_is_encoded() {
        for (mode in Mode.entries) {
            val url = LaunchLink.build(mode, "a&k=$other&send=0#frag q=1 %41 + plus", key)
            assertEquals(1, url.count { it == '#' })
            val fragment = url.substringAfter('#')
            val parts = fragment.split('&')
            assertEquals(listOf("k=$key", "send=1"), parts.dropLast(1))
            assertTrue(parts.last().startsWith("q="))
            assertFalse(parts.last().drop(2).any { it == '&' || it == '=' || it == '#' || it == ' ' || it == '+' })
            assertTrue(url.startsWith("$base/?start=${mode.id}&via=assist#"))
        }
    }

    @Test
    fun utf8_is_percent_encoded_byte_by_byte() {
        assertEquals("caf%C3%A9%20%E2%98%95", LaunchLink.encode("café ☕"))
        assertEquals("%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB", LaunchLink.encode("👩‍💻"))
        assertEquals("AZaz09-._~", LaunchLink.encode("AZaz09-._~"))
        assertEquals("line%0Atwo%09tab", LaunchLink.encode("line\ntwo\ttab"))
    }

    @Test
    fun clean_drops_controls_keeps_lines_and_caps_safely() {
        assertEquals("a\nb\tc", LaunchLink.clean("  a\r\nb\tc\u0000\u0007\u009B  "))
        assertEquals("x\ny", LaunchLink.clean("x\ry"))
        val long = "a".repeat(LaunchLink.MAX_PROMPT - 1) + "😀" // the emoji's high surrogate would be the last char kept
        val cut = LaunchLink.clean(long)
        assertEquals(LaunchLink.MAX_PROMPT - 1, cut.length)
        assertFalse(cut.last().isHighSurrogate())
        assertEquals(LaunchLink.MAX_PROMPT, LaunchLink.clean("b".repeat(LaunchLink.MAX_PROMPT + 50)).length)
    }

    @Test
    fun pairing_accepts_the_shortcut_link_and_the_assist_link() {
        val ok = LaunchLink.Pairing.Ok(key)
        assertEquals(ok, LaunchLink.parsePairing("$base/?start=ask#send=1&k=$key&q="))
        assertEquals(ok, LaunchLink.parsePairing("$base/?start=ask&via=assist#send=1&k=$key&q="))
        assertEquals(ok, LaunchLink.parsePairing("  Here it is: $base/?start=ask#send=1&k=$key&q= (keep it private)  "))
        assertEquals(ok, LaunchLink.parsePairing("HTTPS://ATELIER.CIPRARI.AI/#k=$key"))
        assertEquals(ok, LaunchLink.parsePairing("https://atelier.ciprari.ai:443/#k=$key&send=1"))
        assertEquals(ok, LaunchLink.parsePairing("$base#k=$key"))
        assertEquals("the first k counts, as URLSearchParams.get", ok, LaunchLink.parsePairing("$base/#k=$key&k=$other&q="))
    }

    @Test
    fun pairing_refuses_anything_else() {
        assertEquals(LaunchLink.Pairing.Empty, LaunchLink.parsePairing(null))
        assertEquals(LaunchLink.Pairing.Empty, LaunchLink.parsePairing("   "))
        assertEquals(LaunchLink.Pairing.NotLink, LaunchLink.parsePairing("hello there"))
        assertEquals(LaunchLink.Pairing.NotLink, LaunchLink.parsePairing("atelier.ciprari.ai/#k=$key"))
        for (foreign in listOf(
            "http://atelier.ciprari.ai/#k=$key",
            "https://atelier.ciprari.ai.evil.example/#k=$key",
            "https://atelier.ciprari.ai@evil.example/#k=$key",
            "https://evil.example/?next=https://atelier.ciprari.ai/#k=$key",
            "https://atelier.ciprari.ai:8443/#k=$key",
            "https://xatelier.ciprari.ai/#k=$key",
        )) {
            assertEquals(foreign, LaunchLink.Pairing.NotAtelier, LaunchLink.parsePairing(foreign))
        }
        for (keyless in listOf(
            "$base/?start=ask#send=1&q=",
            "$base/?k=$key",
            "$base/#send=1&q=hi&k=$key", // after q= it is prompt text
            "$base/#k=${key.dropLast(1)}",
            "$base/#k=${key}x",
            "$base/#k=AbCdEfGhIjKlMnOpQrSt%5F_",
            "$base",
        )) {
            assertEquals(keyless, LaunchLink.Pairing.NoKey, LaunchLink.parsePairing(keyless))
        }
    }

    /**
     * Writes what [LaunchLink.build] makes for tricky prompts to the build directory, for tools/check-launch-vectors.mjs
     * to feed to the real public/launch.js readLaunch (mode, text, key, send and via must come back as sent).
     */
    @Test
    fun writes_vectors_for_launch_js() {
        val out = System.getProperty("atelier.vectors") ?: return
        val prompts = listOf(
            "a red fox", "what is 2+2 & why = ?", "50% off #deal", "%41 stays literal", "café ☕ — “quotes”", "line one\nline two",
            "tab\tseparated", "emoji 👩‍💻 and 🇺🇸", "q=inside&k=$other&send=0", "+plus+signs+", "trailing spaces   ", "",
            "/video a dog surfing", "日本語のテキスト", "a".repeat(300),
        )
        val sb = StringBuilder("[\n")
        var first = true
        for (mode in Mode.entries) for (k in listOf(key, null)) for (p in prompts) {
            if (!first) sb.append(",\n")
            first = false
            sb.append("{\"mode\":").append(json(mode.id))
                .append(",\"prompt\":").append(json(p))
                .append(",\"key\":").append(if (k == null) "null" else json(k))
                .append(",\"url\":").append(json(LaunchLink.build(mode, p, k))).append('}')
        }
        sb.append("\n]\n")
        File(out).apply { parentFile?.mkdirs() }.writeText(sb.toString(), Charsets.UTF_8)
    }

    private fun json(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        return sb.append('"').toString()
    }
}
