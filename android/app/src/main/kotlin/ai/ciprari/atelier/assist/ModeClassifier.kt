package ai.ciprari.atelier.assist

/**
 * What [ModeClassifier] made of a request: the [mode], the [prompt] to send in it, how sure it is ([confidence], 0..1),
 * and whether the words named the mode outright ([explicit]: "make an image of…", "image: …", "write a function…").
 */
data class Classification(val mode: Mode, val prompt: String, val confidence: Float, val explicit: Boolean) {
    /** Sure enough to show this mode's own chip while the words are still coming in. */
    val sure: Boolean get() = confidence >= ModeClassifier.SHOW
}

/**
 * Picks Atelier's mode for a spoken or typed request, and trims a pure command off the front of the prompt
 * ("make an image of a red fox" → Image, "a red fox").
 *
 * Order (first hit wins):
 * 1. An explicit mode word: "image: …", "code mode …", "/video …", "ask …".
 * 2. A command at the start, after filler ("hey Atelier", "please", "can you", "I want", "let's"…): make an image /
 *    a video / an app; write a function; fix my code; brainstorm; ideas for; suggest names… A command whose object only
 *    names the medium is dropped ("make an image of" → the subject); one that carries meaning stays ("a minimalist logo
 *    for my bakery", "write a Python function that…", "a pomodoro timer app").
 * 3. A question or a writing task at the start (what, why, how, can, explain…; write, draft, rewrite…) → Ask.
 * 4. A mode named at the end: "… as an image", "… in video mode", "… make it a video".
 * 5. Strong keywords anywhere (photorealistic, video, regex, landing page, ideas…), weighted; a close call is "contested".
 * 6. Otherwise Ask.
 *
 * English only: other languages fall through to Ask with the full text (the chip lets the owner pick). Pure Kotlin, so
 * it is unit-tested on the JVM (ModeClassifierTest). Nothing here logs or keeps what was said.
 */
object ModeClassifier {
    const val EXPLICIT = 0.95f
    const val QUESTION = 0.85f
    const val SUFFIX = 0.9f
    const val KEYWORD = 0.7f
    const val CONTESTED = 0.55f
    const val SHOW = 0.5f
    const val DEFAULT = 0.3f

    fun classify(input: String): Classification {
        val all = Text.of(input.trim())
        if (all.raw.isEmpty()) return Classification(Mode.ASK, "", 0f, false)
        val spoken = all.dropLead(WAKE, 1).dropLead(ASK_ATELIER, 1)
        val rest = spoken.dropLead(PREAMBLE, 6)

        explicitWord(rest)?.let { return it }
        for (rule in RULES) rule.apply(rest)?.let { return it }
        // A partial that is only a command so far ("can you make", "write a", "write a python"): no mode yet.
        if (INCOMPLETE.containsMatchIn(rest.low) || INCOMPLETE.containsMatchIn(spoken.low)) {
            return Classification(Mode.ASK, tidy(spoken.raw), DEFAULT, false)
        }
        // "Can you …" is a question only when no command follows it ("can you make a …" is a request, not Ask).
        val politeQuestion = QUESTION_LEAD.containsMatchIn(spoken.low) && !COMMAND_VERB.containsMatchIn(rest.low)
        if (QUESTION_LEAD.containsMatchIn(rest.low) || politeQuestion || WRITING.containsMatchIn(rest.low)) {
            return Classification(Mode.ASK, tidy(spoken.raw), QUESTION, true)
        }
        suffix(spoken)?.let { return it }
        keywords(spoken)?.let { return it }
        return Classification(Mode.ASK, tidy(spoken.raw), DEFAULT, false)
    }

    /** The request without a leading "hey Atelier": what is sent when the owner picks a mode the classifier didn't. */
    fun spoken(input: String): String = tidy(Text.of(input.trim()).dropLead(WAKE, 1).dropLead(ASK_ATELIER, 1).raw)

    /** "Hey Atelier," / "OK Atelier" / "Atelier:" at the very start. */
    private val WAKE = Regex("""^(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?atelier\b[\s,.!:;\-]*""")

    /** "Ask Atelier to …" / "tell Atelier to …": addressed to Atelier, so the rest is classified ("… make an image of"). */
    private val ASK_ATELIER = Regex("""^(?:ask|tell)\s+atelier\b[\s,:]*(?:to\s+)?""")

    /** Filler and politeness before the request itself; dropped (up to 6 in a row) before looking for a command. */
    private val PREAMBLE = Regex(
        """^(?:(?:hey|hi|hello|ok|okay|so|um+|uh+|er+|erm|hmm+|alright|right|now|and|also|oh|well|yeah|yes)\b[\s,.!]*""" +
            """|please\b[\s,]*""" +
            """|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:just\s+)?""" +
            """|(?:can|could|may)\s+(?:i|we)\s+(?:please\s+)?(?:get|have|see)\s+""" +
            """|(?:i\s+want|i\s+wanna|i'd\s+like|i\s+would\s+like|i'd\s+love|i\s+would\s+love|i\s+need|i'm\s+looking\s+for|im\s+looking\s+for)\s+(?:you\s+)?(?:to\s+)?""" +
            """|(?:let's|lets|let\s+us)\s+""" +
            """|help\s+me\s+(?:to\s+)?""" +
            """|(?:quickly|just)\s+)""",
    )

    // ───────────────────────── text with a lower-case twin of the same length ─────────────────────────

    /** [low] is [raw] lower-cased char by char (same length, curly apostrophes made straight) so indexes line up. */
    private class Text(val raw: String, val low: String) {
        fun from(i: Int) = Text(raw.substring(i), low.substring(i))

        fun dropLead(re: Regex, times: Int): Text {
            var t = this
            repeat(times) {
                val m = re.find(t.low) ?: return t
                val end = m.range.last + 1
                if (m.range.first != 0 || end <= 0) return t
                t = t.from(end)
            }
            return t
        }

        companion object {
            fun of(s: String): Text {
                val low = CharArray(s.length) { i ->
                    when (val c = s[i]) {
                        '’', '‘', 'ʼ' -> '\''
                        else -> c.lowercaseChar()
                    }
                }
                return Text(s, String(low))
            }
        }
    }

    private fun tidy(s: String): String =
        s.trim().trimStart(',', ':', ';', '-', '–', '—', ' ').trimEnd(',', ':', ';', '-', '–', '—', ' ').trim()

    // ───────────────────────── 1. explicit mode words ─────────────────────────

    private val WORD_MODE = mapOf(
        "ask" to Mode.ASK,
        "code" to Mode.CODE, "coding" to Mode.CODE,
        "image" to Mode.IMAGE, "images" to Mode.IMAGE, "img" to Mode.IMAGE, "picture" to Mode.IMAGE, "pictures" to Mode.IMAGE,
        "photo" to Mode.IMAGE, "photos" to Mode.IMAGE,
        "video" to Mode.VIDEO, "videos" to Mode.VIDEO, "vid" to Mode.VIDEO, "clip" to Mode.VIDEO, "clips" to Mode.VIDEO,
        "idea" to Mode.IDEAS, "ideas" to Mode.IDEAS, "brainstorm" to Mode.IDEAS,
        "build" to Mode.BUILD, "app" to Mode.BUILD,
    )

    private val EXPLICIT_WORDS = listOf(
        // "image: a red fox", "code - reverse a string", "/video: waves"
        Regex("""^/?(ask|code|coding|images?|img|pictures?|photos?|videos?|vid|clips?|ideas?|brainstorm|build|app)\s*(?:mode)?\s*[:\-–—]+\s*"""),
        // "image mode a red fox", "switch to code mode"
        Regex("""^(?:switch\s+to\s+|use\s+|go\s+to\s+|open\s+|in\s+)?(ask|code|image|video|ideas?|build)\s+mode\b[\s,:.;\-–—]*"""),
        // typed "/img cat" (the web app's own slash prefixes)
        Regex("""^/(ask|code|img|image|vid|video|idea|ideas|build|app)\b\s*"""),
    )
    private val ASK_LEAD = Regex("""^ask\b[\s,:]*(?:atelier\b[\s,:]*)?""")

    private fun explicitWord(t: Text): Classification? {
        for (re in EXPLICIT_WORDS) {
            val m = re.find(t.low) ?: continue
            val mode = WORD_MODE[m.groupValues[1]] ?: continue
            return Classification(mode, tidy(t.raw.substring(m.range.last + 1)), EXPLICIT, true)
        }
        val ask = ASK_LEAD.find(t.low) ?: return null
        return Classification(Mode.ASK, tidy(t.raw.substring(ask.range.last + 1)), EXPLICIT, true)
    }

    // ───────────────────────── 2. commands at the start ─────────────────────────

    /** How a matched command becomes the prompt. */
    private enum class Take {
        /** Everything after the match ("make an image of " + "a red fox"). */
        AFTER,

        /** From group 1 to the end ("design " + "a minimalist logo for my bakery"). */
        KEEP,

        /** The whole request, filler dropped ("write a Python function that…"). */
        REST,

        /** Image/video: AFTER when group 2 (words before the medium) is blank, else KEEP ("a realistic photo of…"). */
        PHRASE,
    }

    private class Rule(val mode: Mode, pattern: String, val take: Take) {
        val re = Regex(pattern)

        fun apply(t: Text): Classification? {
            val m = re.find(t.low) ?: return null
            val after = m.range.last + 1
            val prompt = when (take) {
                Take.AFTER -> t.raw.substring(after)
                Take.REST -> t.raw
                Take.KEEP -> m.groups[1]?.let { t.raw.substring(it.range.first) } ?: t.raw.substring(after)
                Take.PHRASE -> {
                    val words = m.groups[2]?.value.orEmpty()
                    val phrase = m.groups[1]
                    if (words.isBlank() || phrase == null) t.raw.substring(after) else t.raw.substring(phrase.range.first)
                }
            }
            return Classification(mode, tidy(prompt), EXPLICIT, true)
        }
    }

    private const val ME = """(?:(?:me|us)\s+)?"""
    private const val ART = """(?:an?\s+|the\s+|some\s+|one\s+|another\s+|\d+\s+|two\s+|three\s+|four\s+|a\s+few\s+|a\s+couple\s+(?:of\s+)?)?"""

    private const val IMG_VERB = """(?:make|create|generate|draw|paint|render|design|produce|sketch|craft|give\s+me|show\s+me|get\s+me|do|imagine|whip\s+up|dream\s+up)"""
    // Not a bare "art": "make an art deco poster" is a poster, not "deco poster".
    private const val GENERIC = """(?:images?|pictures?|photos?|photographs?|pics?|renders?|renderings?|artworks?|art\s*pieces?|ai\s+art)"""
    private const val SPECIFIC = """(?:logos?|posters?|icons?|wallpapers?|portraits?|paintings?|drawings?|illustrations?|sketch(?:es)?|banners?|thumbnails?|stickers?|avatars?|profile\s+pic(?:ture)?s?|album\s+covers?|book\s+covers?|cover\s+art|mockups?|infographics?|memes?|emojis?|tattoos?(?:\s+designs?)?|flyers?|headshots?|mascots?|cartoons?|comics?|comic\s+strips?|caricatures?|t[\s-]?shirt\s+designs?|t[\s-]?shirts?|(?:greeting|birthday|holiday|christmas)\s+cards?|anime\s+(?:girls?|boys?|characters?|versions?)|(?:cartoon|anime|comic)\s+(?:versions?|characters?))"""

    /** One optional word between the medium and what it belongs to ("photo editing app"), never "of", "for"… */
    private const val SKIP1 = """(?:\s+(?!(?:of|for|with|about|showing|depicting|featuring|where|that|in|on|from)\b)[\w'-]+)?"""

    /** A word before the medium; never a preposition ("a website with photos of my work" is not a photo). */
    private const val FILL = """(?:(?!(?:with|for|about|of|to|on|in|into|from|ideas?|names?)\b)[\w'-]+\s+)"""

    /** "image generator", "drawing app", "image ideas": the medium word is part of something else. */
    private const val NOT_THING = """(?!$SKIP1\s+(?:apps?|applications?|games?|tools?|websites?|sites?|web\s*pages?|pages?|programs?|software|generators?|editors?|makers?|creators?|ideas?|names?|prompts?|galler(?:y|ies)|sliders?|carousels?|uploaders?|viewers?)\b)"""


    private const val VID_VERB = """(?:make|create|generate|render|produce|give\s+me|show\s+me|shoot|film|do|animate|craft|whip\s+up)"""
    // Not "cinematic" (the adjective in "a cinematic clip of …") and not "short" ("a short story", "a short summary").
    private const val VID_NOUN = """(?:videos?|clips?|animations?|films?|movies?|reels?|gifs?|footage|time[\s-]?lapses?|trailers?|teasers?)"""

    /** "video game", "video ideas", "video script", "video editor": not a video to generate. */
    private const val NOT_VIDEO = """(?!$SKIP1\s+(?:games?|ideas?|scripts?|titles?|names?|edit(?:or|ing)?s?|players?|apps?|applications?|tools?|sites?|websites?|platforms?|services?|recommendations?|suggestions?|reviews?|lists?|nights?|theaters?|theatres?|tickets?|trivia|quotes?|quiz(?:zes)?|calls?|chats?|conferenc(?:e|es|ing)|backgrounds?|summar(?:y|ies)|plots?)\b)(?!\s+(?:to|i\s+(?:should|could|can)|we\s+(?:should|could|can)|for\s+(?:me|us)\s+to)\s+watch\b)"""

    private const val BUILD_VERB = """(?:build|make|create|code|develop|design|generate|spin\s+up|put\s+together|whip\s+up|prototype|set\s+up|scaffold|program|craft|ship)"""
    private const val BUILD_NOUN = """(?:(?:photo|image|picture)\s+(?:galler(?:y|ies)|sliders?|carousels?|uploaders?|viewers?)|apps?|applications?|web\s*apps?|websites?|web\s*sites?|sites?|landing\s+pages?|web\s*pages?|home\s*pages?|pages?|tools?|games?|dashboards?|calculators?|trackers?|timers?|widgets?|prototypes?|portfolios?|forms?|quiz(?:zes)?|extensions?|plugins?|bots?|chatbots?|clones?|uis?|user\s+interfaces?|planners?|generators?|editors?|simulators?|simulations?|visuali[sz]ers?|configurators?|to-?do\s+lists?|blogs?|stores?|shops?|storefronts?|pwas?|mvps?|saas|platforms?|portals?|crms?|kanbans?)"""

    /** "app ideas", "game plan", "website logo", "app trailer": about the thing, not building it. */
    private const val NOT_BUILD = """(?!\s+(?:ideas?|names?|plans?|logos?|icons?|posters?|images?|pictures?|photos?|videos?|trailers?|mockups?|concepts?|titles?|scripts?)\b)"""

    private const val CODE_THING = """(?:code|codebase|functions?|scripts?|bugs?|class(?:es)?(?!\s+(?:notes?|schedules?|trips?|reunions?|assignments?|materials?|presentations?|discussions?|readings?|projects?|syllabus|rank|rings?|photos?))|methods?|regex(?:es)?|quer(?:y|ies)|components?|modules?|programs?|errors?|stack\s*traces?|exceptions?|loops?|algorithms?|endpoints?|apis?|sql|css|html|javascript|python|typescript|kotlin|java|swift|rust|golang|go\s+(?:code|programs?|functions?|modules?)|php|ruby|c\+\+|c#|shell|bash|powershell|unit\s+tests?|tests?(?!\s+(?:results?|scores?|grades?|questions?|answers?|prep|dates?|anxiety|day|papers?|drives?|kits?|strips?))|pull\s+requests?|prs?|commits?|diffs?|repos?|repository|implementation)"""
    private const val LANG_ADJ = """(?:python|javascript|js|typescript|ts|kotlin|java|swift|rust|go|golang|c\+\+|c#|c|bash|shell|sql|powershell|ruby|php|html|css|react|vue|svelte|node|regex|unit|recursive|simple|quick|small|async|generic|helper|utility|reusable|custom|sorting|search|binary|fast|efficient|pure)"""
    private const val CODE_NOUN = """(?:functions?|regex(?:es)?|regular\s+expressions?|class(?:es)?|methods?|programs?|snippets?|quer(?:y|ies)|code|algorithms?|unit\s+tests?|tests?\s+(?:for|that)|components?|modules?|endpoints?|apis?|clis?|command[\s-]line\s+(?:tools?|apps?)|one[\s-]liners?|hooks?|decorators?|structs?|interfaces?|enums?|loops?|lambdas?|macros?|shaders?|migrations?|schemas?|dockerfiles?|makefiles?|types?|parsers?|validators?|middleware|handlers?)"""
    private const val SCRIPT_LANG = """(?:python|bash|shell|powershell|node|nodejs|js|javascript|typescript|ts|sql|ruby|php|perl|lua|kotlin|swift|go|golang|rust|applescript|batch|vba|excel|google\s+sheets|apps\s+script|autohotkey|zsh|fish)"""

    private const val IDEA_COUNT = """(?:\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty|a\s+hundred|a\s+few|some|several|a\s+bunch\s+of|a\s+list\s+of)"""
    private const val IDEA_THING = """(?:ideas?|names?|titles?|taglines?|slogans?|suggestions?|themes?|concepts?|options|ways|alternatives|hooks?|angles?|prompts?|topics?|gifts?)"""

    private val RULES = listOf(
        // Image: "make an image of …" (the medium alone is dropped; "a realistic photo of …" keeps its words).
        Rule(Mode.IMAGE, """^$IMG_VERB\s+$ME($ART($FILL{0,2}?)$GENERIC\b$NOT_THING)(?:\s+(?:of|showing|depicting|that\s+shows|where|with|in\s+which|for|about|featuring)\b)?[\s:,\-]*""", Take.PHRASE),
        // Image with a meaningful object: "design a minimalist logo for my bakery".
        Rule(Mode.IMAGE, """^$IMG_VERB\s+$ME($ART(?:(?!(?:with|for|about|of|to|on|in|into|from|ideas?|names?)\b)[\w'&-]+\s+){0,3}?$SPECIFIC\b$NOT_THING)""", Take.KEEP),
        // Video: "make a video of …", "make a 5 second clip of …" (words before the medium are kept).
        Rule(Mode.VIDEO, """^$VID_VERB\s+$ME($ART($FILL{0,3}?)$VID_NOUN\b$NOT_VIDEO)(?:\s+(?:of|about|showing|where|with|for|that\s+shows|in\s+which|depicting|featuring)\b)?[\s:,\-]*""", Take.PHRASE),
        Rule(Mode.VIDEO, """^animate\b\s*(?:(?:this|it|that)\b\s*)?(.*)""", Take.KEEP),
        // "film a drone flyover of …": the verb alone (not "film recommendations", "film school").
        Rule(Mode.VIDEO, """^film\s+$ME(?!(?:recommendations?|suggestions?|ideas?|reviews?|critics?|schools?|festivals?|industry|noir|history|genres?|titles?|names?|cameras?|photography|stocks?|rolls?|developing|terms?|quotes?|trivia|scores?|music|club)\b)""", Take.AFTER),
        // Build: "build me a pomodoro timer app", "make a landing page for my bakery", "code a snake game".
        Rule(Mode.BUILD, """^$BUILD_VERB\s+(?:(?:me|us|myself)\s+)?((?:an?\s+|the\s+|my\s+|our\s+|some\s+|this\s+|one\s+)?(?:(?!(?:for|with|about|of|to|on|in|into|from)\b)[\w'/+&.-]+\s+){0,4}?$BUILD_NOUN\b$NOT_BUILD)""", Take.KEEP),
        // Code: "fix my code", "explain this function", "debug the login bug".
        Rule(Mode.CODE, """^(?:fix|debug|refactor|optimi[sz]e|review|lint|test|port|convert|translate|rewrite|explain|clean\s+up|speed\s+up|document|comment|profile|benchmark)\s+(?:(?:my|this|the|a|an|some|our|that|these|those)\s+)?(?:(?!(?:how|to|about|what|why|when|where|who|which|if|whether)\b)[\w'.+#-]+\s+){0,2}?$CODE_THING(?![\w])""", Take.REST),
        // Code: "write a Python function that …", "give me a regex for …".
        Rule(Mode.CODE, """^(?:write|create|make|generate|give\s+me|show\s+me|implement|code(?:\s+up)?|draft|build)\s+$ME(?:(?:an?|the|some)\s+)?(?:$LANG_ADJ\s+){0,3}$CODE_NOUN\b""", Take.REST),
        Rule(Mode.CODE, """^(?:write|create|make|generate|give\s+me|show\s+me|code(?:\s+up)?|draft)\s+$ME(?:(?:an?|some)\s+)?$SCRIPT_LANG\s+(?:scripts?|code|programs?|functions?|snippets?|formulas?|macros?|commands?|one[\s-]liners?)\b""", Take.REST),
        Rule(Mode.CODE, """^(?:write|create|make|code(?:\s+up)?)\s+$ME(?:an?\s+)?scripts?\s+(?:that|to|which)\b""", Take.REST),
        // Image: "draw a cat wearing a hat" (but not "draw up a contract", "imagine if …").
        Rule(Mode.IMAGE, """^(?:draw|paint|sketch|illustrate|imagine|visuali[sz]e|doodle)\s+$ME(?!(?:if|that|how|what|why|when|where|you|we|i|it|up)\b)(.+)""", Take.KEEP),
        // Image / video named first: "a picture of a red fox", "a logo for my bakery", "a video of waves".
        Rule(Mode.IMAGE, """^(?:an?\s+|the\s+)?$GENERIC\s+(?:of|showing|depicting|where|in\s+which|featuring)\s+""", Take.AFTER),
        Rule(Mode.IMAGE, """^((?:an?\s+|the\s+)?(?:[\w'-]+\s+){0,2}?$SPECIFIC\s+(?:of|for|showing|with|that|where|featuring|depicting)\b)""", Take.KEEP),
        Rule(Mode.VIDEO, """^((?:an?\s+|the\s+)?((?:[\w'-]+\s+)?)(?:videos?|clips?|animations?|footage|reels?|films?|movies?))\s+(?:of|showing|about|where|in\s+which|depicting|featuring)\s+""", Take.PHRASE),
        // Ideas: "brainstorm names for my cat", "ideas for a birthday party", "10 names for my podcast", "suggest …".
        Rule(Mode.IDEAS, """^brainstorm(?:ing)?\b\s*$ME(?:(?:some|a\s+few|more)\s+)?(?:ideas?\s+)?(?:(?:for|about|on|around|of)\b\s*)?""", Take.AFTER),
        Rule(Mode.IDEAS, """^(?:(?:give\s+me|get\s+me|share|list|any|got\s+any|need|want|show\s+me|generate|create|make|come\s+up\s+with|think\s+of)\s+)?(?:(?:some|a\s+few|a\s+couple(?:\s+of)?|more|new|fresh|good|creative|fun|cool|unique|great|wild|clever|quick)\s+)?(?:ideas?|suggestions|inspiration)\s+(?:for|about|on|to|of|around|regarding)\s+""", Take.AFTER),
        Rule(Mode.IDEAS, """^(?:(?:give\s+me|list|share|come\s+up\s+with|think\s+of|suggest)\s+)?($IDEA_COUNT\s+(?:[\w'-]+\s+){0,2}?$IDEA_THING\b)""", Take.KEEP),
        Rule(Mode.IDEAS, """^(?:suggest|come\s+up\s+with|think\s+(?:of|up)|pitch|dream\s+up|recommend|generate|create)\s+$ME(?:(?:some|a\s+few|a|an|\d+|more)\s+)?(?:[\w'-]+\s+){0,2}?(?:names?|titles?|ideas?|taglines?|slogans?|themes?|concepts?|options|gifts?|ways|activities|places|recipes|plots?|stories|hooks?|angles?|topics?|alternatives|strategies|things|captions?|hashtags?)\b""", Take.REST),
        // Bare leads: "build something fun", "code …".
        Rule(Mode.BUILD, """^build\b\s*$ME(.*)""", Take.KEEP),
        Rule(Mode.CODE, """^code\b""", Take.REST),
    )

    // ───────────────────────── 3. questions and writing → Ask ─────────────────────────

    private val QUESTION_LEAD = Regex(
        """^(?:what|what's|whats|what're|why|why's|how|how's|who|who's|whom|whose|when|when's|where|where's|which|is|isn't|are|aren't|am|was|wasn't|were|can|can't|could|couldn't|should|shouldn't|would|wouldn't|will|won't|do|don't|does|doesn't|did|didn't|has|hasn't|have|haven't|had|explain|tell\s+me|define|describe|compare|calculate|teach\s+me|walk\s+me\s+through|remind\s+me|give\s+me\s+(?:a\s+|an\s+)?(?:summary|definition|explanation|overview|rundown|breakdown|recap))\b""",
    )
    /** The verbs that start a command: after "can you …" they make it a request, not a question. */
    private val COMMAND_VERB = Regex("""^(?:make|create|generate|draw|paint|render|design|produce|sketch|build|code|develop|animate|film|shoot|brainstorm|suggest|come\s+up\s+with|write|draft|imagine|illustrate|craft|whip\s+up|spin\s+up|put\s+together|give\s+me|show\s+me|get\s+me)\b""")

    /** Only a command so far, with nothing to tell the mode by: "can you", "make", "write a", "write a python". */
    private val INCOMPLETE = Regex(
        """^(?:(?:can|could|would|will)\s+you(?:\s+please)?|(?:make|create|generate|draw|paint|render|design|produce|sketch|build|code|develop|write|draft|craft|give\s+me|show\s+me|get\s+me|whip\s+up|come\s+up\s+with)(?:\s+(?:me|us))?(?:\s+(?:an?|the|some|one|another))?(?:\s+$LANG_ADJ)*)[\s,.]*$""",
    )
    private val WRITING = Regex("""^(?:write|draft|compose|rewrite|edit|proofread|reword|rephrase|paraphrase|translate|summari[sz]e|outline)\b""")

    // ───────────────────────── 4. a mode named at the end ─────────────────────────

    private val SUFFIX_MODE = mapOf(
        "image" to Mode.IMAGE, "picture" to Mode.IMAGE, "photo" to Mode.IMAGE, "drawing" to Mode.IMAGE,
        "illustration" to Mode.IMAGE, "painting" to Mode.IMAGE,
        "video" to Mode.VIDEO, "clip" to Mode.VIDEO, "animation" to Mode.VIDEO,
        "app" to Mode.BUILD, "webapp" to Mode.BUILD, "web app" to Mode.BUILD, "website" to Mode.BUILD, "game" to Mode.BUILD,
        "build" to Mode.BUILD,
        "code" to Mode.CODE, "idea" to Mode.IDEAS, "ideas" to Mode.IDEAS, "a list of ideas" to Mode.IDEAS, "ask" to Mode.ASK,
    )
    private val SUFFIXES = listOf(
        Regex("""(?s)^(.*?\S)[\s,.;:!?\-]*\s(?:as|in\s+the\s+form\s+of)\s+(?:an?\s+)?(images?|pictures?|photos?|drawings?|illustrations?|paintings?|videos?|clips?|animations?|apps?|web\s*apps?|websites?|games?|code|a\s+list\s+of\s+ideas|ideas?)\s*[.!?]*$"""),
        Regex("""(?s)^(.*?\S)[\s,.;:!?\-]*\s(?:in|using)\s+(ask|code|image|video|ideas?|build)\s+mode\s*[.!?]*$"""),
        Regex("""(?s)^(.*?\S)[\s,.;:!?\-]*\s(?:make|turn)\s+(?:it|that|this)\s+(?:into\s+)?(?:an?\s+)?(images?|pictures?|photos?|videos?|clips?|animations?|apps?|websites?|games?)\s*[.!?]*$"""),
    )

    private fun suffix(t: Text): Classification? {
        for (re in SUFFIXES) {
            val m = re.find(t.low) ?: continue
            val word = m.groupValues[2].replace(Regex("""\s+"""), " ").let { if (it.endsWith("s") && it !in SUFFIX_MODE) it.dropLast(1) else it }
            val mode = SUFFIX_MODE[word] ?: SUFFIX_MODE[word.replace(" ", "")] ?: continue
            val prefix = m.groups[1] ?: continue
            return Classification(mode, tidy(t.raw.substring(prefix.range.first, prefix.range.last + 1)), SUFFIX, true)
        }
        return null
    }

    // ───────────────────────── 5. keywords anywhere ─────────────────────────

    private class Cue(val mode: Mode, pattern: String, val weight: Int) {
        val re = Regex(pattern)
    }

    private val CUES = listOf(
        Cue(Mode.IDEAS, """\b(?:ideas?|brainstorm(?:ing)?|suggestions?|inspiration|names\s+for|name\s+ideas|taglines?|slogans?)\b""", 3),
        Cue(Mode.IMAGE, """\b(?:images?|pictures?|photos?|photographs?|illustrations?|drawings?|paintings?|logos?|posters?|wallpapers?|artwork)\b$NOT_THING""", 2),
        Cue(Mode.IMAGE, """\b(?:photo-?realistic|hyper-?realistic|watercolou?r|oil\s+painting|digital\s+art|pixel\s+art|concept\s+art|line\s+art|3d\s+render|octane|unreal\s+engine|studio\s+ghibli|anime(?:\s+style)?|cartoons?|cartoony|comic\s+(?:style|book\s+style|strips?)|in\s+the\s+style\s+of|cinematic\s+lighting|bokeh|8k|4k|isometric|vector\s+art|low\s+poly|portrait\s+of)\b""", 2),
        Cue(Mode.VIDEO, """\b(?:videos?(?!\s+games?)|clips?|animations?|animated|reels?|footage|slow[\s-]motion|time[\s-]?lapse|drone\s+shot|tracking\s+shot|dolly\s+zoom|b-roll|tiktoks?|camera\s+(?:pans|zooms|orbits|tracks)|veo|runway)\b""", 2),
        Cue(Mode.CODE, """\b(?:functions?|regex|regular\s+expressions?|bugs?|stack\s*traces?|exceptions?|compil(?:e|er|ing)|syntax\s+errors?|null\s+pointer|python|javascript|typescript|kotlin|golang|sql|json|yaml|bash|powershell|css|html|react|npm|git|github|refactor|debug(?:ging)?|apis?|endpoints?|algorithms?|unit\s+tests?|code|coding|variables?|arrays?|async|dockerfile|docker|kubernetes)\b""", 2),
        Cue(Mode.CODE, """(?<![\w])(?:java|rust|swift|ruby|c\+\+|c#)(?![\w])""", 1),
        Cue(Mode.BUILD, """\b(?:apps?|web\s*apps?|websites?|landing\s+pages?|web\s*pages?|dashboards?|games?(?!\s+plans?)|prototypes?|portfolio\s+sites?|browser\s+extensions?|chrome\s+extensions?|calculators?|to-?do\s+apps?|pwa|mvp|saas|frontend|front-end)\b""", 2),
        Cue(Mode.BUILD, """\b(?:tools?|sites?)\b""", 1),
    )

    /** Ties go to the more specific mode, in this order. */
    private val TIE_ORDER = listOf(Mode.IDEAS, Mode.BUILD, Mode.CODE, Mode.VIDEO, Mode.IMAGE)

    private fun keywords(t: Text): Classification? {
        val score = HashMap<Mode, Int>()
        for (cue in CUES) {
            val n = cue.re.findAll(t.low).count().coerceAtMost(3)
            if (n > 0) score[cue.mode] = (score[cue.mode] ?: 0) + n * cue.weight
        }
        val ranked = score.entries.sortedWith(compareByDescending<Map.Entry<Mode, Int>> { it.value }.thenBy { TIE_ORDER.indexOf(it.key) })
        val best = ranked.firstOrNull() ?: return null
        if (best.value < 2) return null
        val second = ranked.getOrNull(1)?.value ?: 0
        val confidence = if (best.value - second >= 2) KEYWORD else CONTESTED
        return Classification(best.key, tidy(t.raw), confidence, false)
    }
}
