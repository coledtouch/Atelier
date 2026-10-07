package ai.ciprari.atelier.assist

/**
 * The link that opens the installed Atelier app with a request, and the one-time pairing link it is keyed from.
 *
 * Launch link (public/launch.js readLaunch reads it):
 *
 *     https://atelier.ciprari.ai/?start=<mode>&via=assist#k=<key>&send=1&q=<prompt>     (paired)
 *     https://atelier.ciprari.ai/?start=<mode>&via=assist#q=<prompt>                     (not paired)
 *
 * - `start` is one of launch.js LAUNCH_MODES (Mode.id). `via=assist` is a label only: anyone can write it.
 * - The key and `send=1` ride in the fragment, which never reaches the server, a Referer or Worker logs. Atelier sends
 *   without a tap only when the key matches the one that browser made, the owner confirmed it once, and its other gates
 *   pass (signed in, idle, empty composer, at most one keyed send per 15 s; Video also holds 4 s, cancellable). Without a key the
 *   words are only prefilled and the owner taps Send.
 * - `q` is always LAST: launch.js takes everything after `q=` verbatim and decodes its %XX runs, so &, = and # in what was
 *   said survive. Spaces are %20 (launch.js does not turn + into a space).
 *
 * Pairing link: what Atelier's Settings → Quick launch copies (the iPhone Shortcut link, or the Android "Assist link"):
 * any https://atelier.ciprari.ai URL whose fragment carries `k=` + 22 base64url characters before `q=`. Only the key is
 * kept.
 *
 * Pure Kotlin (no android.net.Uri), so it is unit-tested on the JVM (LaunchLinkTest + tools/check-launch-vectors.mjs,
 * which feeds the same vectors to the real launch.js).
 */
object LaunchLink {
    const val HOST = "atelier.ciprari.ai"
    const val ORIGIN = "https://$HOST"

    /** launch.js MAX_TEXT: longer text is cut there anyway. */
    const val MAX_PROMPT = 8000

    private val KEY = Regex("""^[A-Za-z0-9_-]{22}$""")

    fun isKey(s: String?): Boolean = s != null && KEY.matches(s)

    /** The launch URL for [mode] with [prompt]; keyed (sends without a tap) only with a well-formed [key]. */
    fun build(mode: Mode, prompt: String, key: String?): String {
        val q = clean(prompt)
        val sb = StringBuilder(ORIGIN.length + 64 + q.length * 3)
        sb.append(ORIGIN).append("/?start=").append(mode.id).append("&via=assist")
        if (q.isEmpty()) return sb.toString() // nothing to send: Atelier just opens in that mode
        sb.append('#')
        if (isKey(key)) sb.append("k=").append(key).append("&send=1&")
        sb.append("q=").append(encode(q))
        return sb.toString()
    }

    /**
     * The text as it goes into the link: C0/C1 controls removed (tab and newline kept, CR LF → LF), trimmed, and cut at
     * [MAX_PROMPT] without splitting a surrogate pair. Atelier cleans it again (launch.js cleanText) before showing it.
     */
    fun clean(prompt: String): String {
        val sb = StringBuilder(prompt.length)
        var i = 0
        while (i < prompt.length) {
            val c = prompt[i]
            when {
                c == '\r' -> {
                    sb.append('\n')
                    if (i + 1 < prompt.length && prompt[i + 1] == '\n') i++
                }
                c == '\n' || c == '\t' -> sb.append(c)
                c.code < 0x20 || c.code in 0x7F..0x9F -> Unit
                else -> sb.append(c)
            }
            i++
        }
        var out = sb.toString().trim()
        if (out.length > MAX_PROMPT) {
            out = out.substring(0, MAX_PROMPT)
            if (out.last().isHighSurrogate()) out = out.dropLast(1)
        }
        return out
    }

    private const val HEX = "0123456789ABCDEF"

    /** Percent-encodes UTF-8 bytes; only RFC 3986 unreserved characters stay as they are. */
    fun encode(s: String): String {
        val bytes = s.toByteArray(Charsets.UTF_8)
        val sb = StringBuilder(bytes.size * 3)
        for (b in bytes) {
            val c = b.toInt() and 0xFF
            val plain = c in 0x41..0x5A || c in 0x61..0x7A || c in 0x30..0x39 || c == 0x2D || c == 0x2E || c == 0x5F || c == 0x7E
            if (plain) {
                sb.append(c.toChar())
            } else {
                sb.append('%').append(HEX[c shr 4]).append(HEX[c and 0x0F])
            }
        }
        return sb.toString()
    }

    /**
     * A URL this app's TWA may open: https://atelier.ciprari.ai (any path, query or fragment), with no userinfo, other
     * port, longer host or whitespace. Anything else that arrives at the TWA opens Atelier's start page instead.
     */
    fun isAtelierUrl(url: String?): Boolean =
        url != null && url.length <= MAX_URL && url.none { it.isWhitespace() || it.code < 0x20 || it.code == 0x7F } &&
            ATELIER_PREFIX.containsMatchIn(url)

    /** Far longer than any launch link (8000 prompt characters, up to 12 bytes each when encoded). */
    private const val MAX_URL = 128 * 1024

    // ───────────────────────── pairing ─────────────────────────

    sealed interface Pairing {
        data class Ok(val key: String) : Pairing
        data object Empty : Pairing
        data object NotLink : Pairing
        data object NotAtelier : Pairing
        data object NoKey : Pairing
    }

    /** scheme://host[:port] then the end, or a path, query or fragment. Anything else (userinfo, a longer host) fails. */
    private val ATELIER_PREFIX = Regex("""^https://atelier\.ciprari\.ai(?::443)?(?=[/?#]|$)""", RegexOption.IGNORE_CASE)
    private val ANY_URL = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
    private val Q_START = Regex("""(?:^|&)q=""")

    /**
     * The launch key in a pasted pairing link, or why there isn't one. The clipboard may hold more than the link (a
     * sentence around it): the first http(s) URL in it is the one that counts. Only `k` from the fragment, before `q=`
     * (as launch.js splitHash reads it), is accepted; a `k` in the query, or after `q=` (that is prompt text), is not.
     */
    fun parsePairing(clip: CharSequence?): Pairing {
        val s = clip?.toString()?.trim().orEmpty()
        if (s.isEmpty()) return Pairing.Empty
        if (s.length > 20_000) return Pairing.NotLink
        val url = ANY_URL.find(s)?.value ?: return Pairing.NotLink
        if (!ATELIER_PREFIX.containsMatchIn(url)) return Pairing.NotAtelier
        val hash = url.indexOf('#')
        if (hash < 0) return Pairing.NoKey
        val fragment = url.substring(hash + 1)
        val head = fragment.substring(0, Q_START.find(fragment)?.range?.first ?: fragment.length)
        val k = head.split('&').firstNotNullOfOrNull { part ->
            val eq = part.indexOf('=')
            if (eq > 0 && part.substring(0, eq) == "k") part.substring(eq + 1) else null
        }
        return if (isKey(k)) Pairing.Ok(k!!) else Pairing.NoKey
    }
}
