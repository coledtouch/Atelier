package ai.ciprari.atelier.assist

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModeClassifierTest {

    /** mode + prompt (+ explicit when given) for each input. */
    private fun check(input: String, mode: Mode, prompt: String, explicit: Boolean? = null) {
        val c = ModeClassifier.classify(input)
        assertEquals("mode of \"$input\"", mode, c.mode)
        assertEquals("prompt of \"$input\"", prompt, c.prompt)
        if (explicit != null) assertEquals("explicit for \"$input\"", explicit, c.explicit)
    }

    private fun mode(input: String) = ModeClassifier.classify(input).mode

    @Test
    fun image_commands_drop_the_medium_and_keep_the_subject() {
        check("make an image of a red fox", Mode.IMAGE, "a red fox", true)
        check("Make an image of a red fox.", Mode.IMAGE, "a red fox.", true)
        check("hey Atelier, can you make me a picture of a cat on a skateboard", Mode.IMAGE, "a cat on a skateboard", true)
        check("please generate an image showing a lighthouse in a storm", Mode.IMAGE, "a lighthouse in a storm", true)
        check("can I get an image of a sunset over the sea", Mode.IMAGE, "a sunset over the sea", true)
        check("a picture of the northern lights over a lake", Mode.IMAGE, "the northern lights over a lake", true)
        check("draw a cat wearing a tiny hat", Mode.IMAGE, "a cat wearing a tiny hat", true)
        check("imagine a city made of glass", Mode.IMAGE, "a city made of glass", true)
    }

    @Test
    fun image_commands_keep_words_that_carry_meaning() {
        check("create a realistic photo of a lighthouse at dawn", Mode.IMAGE, "a realistic photo of a lighthouse at dawn", true)
        check("design a minimalist logo for my bakery", Mode.IMAGE, "a minimalist logo for my bakery", true)
        check("I want a poster for my band's show", Mode.IMAGE, "a poster for my band's show", true)
        check("make an app icon for a weather app", Mode.IMAGE, "an app icon for a weather app", true)
        check("make an art deco poster for a jazz night", Mode.IMAGE, "an art deco poster for a jazz night", true)
    }

    @Test
    fun video_commands() {
        check("make a video of waves crashing on rocks", Mode.VIDEO, "waves crashing on rocks", true)
        check("make a 5 second video of a dog surfing", Mode.VIDEO, "a 5 second video of a dog surfing", true)
        check("animate a paper boat sailing at sunset", Mode.VIDEO, "a paper boat sailing at sunset", true)
        check("generate a cinematic clip of a drone flying over mountains", Mode.VIDEO, "a cinematic clip of a drone flying over mountains", true)
        check("video of a cat playing the piano", Mode.VIDEO, "a cat playing the piano", true)
        check("animate", Mode.VIDEO, "", true)
    }

    @Test
    fun code_commands_keep_the_whole_request() {
        check("write a Python function that reverses a string", Mode.CODE, "write a Python function that reverses a string", true)
        check("can you write a regex for email addresses", Mode.CODE, "write a regex for email addresses", true)
        check("fix my code", Mode.CODE, "fix my code", true)
        check("explain this regex", Mode.CODE, "explain this regex", true)
        check("debug the login bug in my React app", Mode.CODE, "debug the login bug in my React app", true)
        check("write a bash script to rename files by date", Mode.CODE, "write a bash script to rename files by date", true)
        check("write a script that renames all my photos", Mode.CODE, "write a script that renames all my photos", true)
        check("give me a SQL query that finds duplicate emails", Mode.CODE, "give me a SQL query that finds duplicate emails", true)
    }

    @Test
    fun ideas_commands() {
        check("brainstorm names for my podcast", Mode.IDEAS, "names for my podcast", true)
        check("ideas for a birthday party for my five year old", Mode.IDEAS, "a birthday party for my five year old", true)
        check("give me some ideas for dinner tonight", Mode.IDEAS, "dinner tonight", true)
        check("give me 10 names for a coffee shop", Mode.IDEAS, "10 names for a coffee shop", true)
        check("suggest some taglines for a running app", Mode.IDEAS, "some taglines for a running app", true)
        check("come up with a name for my bakery", Mode.IDEAS, "come up with a name for my bakery", true)
    }

    @Test
    fun build_commands_keep_the_thing_to_build() {
        check("build me a pomodoro timer app", Mode.BUILD, "a pomodoro timer app", true)
        check("make a landing page for my bakery", Mode.BUILD, "a landing page for my bakery", true)
        check("code a snake game in JavaScript", Mode.BUILD, "a snake game in JavaScript", true)
        check("create a to-do list app with dark mode", Mode.BUILD, "a to-do list app with dark mode", true)
        check("let's build something fun for my kids", Mode.BUILD, "something fun for my kids", true)
        check("make a video game about cats", Mode.BUILD, "a video game about cats", true)
        check("make an image generator app", Mode.BUILD, "an image generator app", true)
    }

    @Test
    fun explicit_mode_words() {
        check("image: neon city at night", Mode.IMAGE, "neon city at night", true)
        check("Code - reverse a linked list", Mode.CODE, "reverse a linked list", true)
        check("video mode a timelapse of clouds", Mode.VIDEO, "a timelapse of clouds", true)
        check("ideas: rainy day activities", Mode.IDEAS, "rainy day activities", true)
        check("/img a cat", Mode.IMAGE, "a cat", true)
        check("/build a habit tracker", Mode.BUILD, "a habit tracker", true)
        check("ask what is a monad", Mode.ASK, "what is a monad", true)
        check("Ask: how tall is Everest", Mode.ASK, "how tall is Everest", true)
    }

    @Test
    fun questions_and_writing_go_to_ask_with_the_whole_text() {
        check("what's the capital of Australia", Mode.ASK, "what's the capital of Australia", true)
        check("What’s a good movie to watch tonight?", Mode.ASK, "What’s a good movie to watch tonight?", true)
        check("how do I make an image transparent", Mode.ASK, "how do I make an image transparent", true)
        check("can you explain recursion simply", Mode.ASK, "can you explain recursion simply", true)
        check("Hey Atelier, what time zone is Tokyo in", Mode.ASK, "what time zone is Tokyo in", true)
        check("why does my python loop never end", Mode.ASK, "why does my python loop never end", true)
        check("what are some app ideas", Mode.ASK, "what are some app ideas", true)
        check("write a poem about autumn", Mode.ASK, "write a poem about autumn", true)
        check("write a script for my YouTube video", Mode.ASK, "write a script for my YouTube video", true)
        check("draw up a contract for a freelance job", Mode.ASK, "draw up a contract for a freelance job")
    }

    @Test
    fun a_mode_named_at_the_end() {
        check("a red fox in the snow as an image", Mode.IMAGE, "a red fox in the snow", true)
        check("waves at sunset, make it a video", Mode.VIDEO, "waves at sunset", true)
        check("a habit tracker in build mode", Mode.BUILD, "a habit tracker", true)
    }

    @Test
    fun keywords_decide_when_nothing_is_explicit() {
        val fox = ModeClassifier.classify("red fox in the snow, watercolor")
        assertEquals(Mode.IMAGE, fox.mode)
        assertFalse(fox.explicit)
        assertEquals("red fox in the snow, watercolor", fox.prompt)
        assertTrue(fox.sure)
        assertEquals(Mode.CODE, mode("the stack trace says null pointer exception"))
        assertEquals(Mode.VIDEO, mode("drone shot over a misty forest at dawn"))
        assertEquals(Mode.IDEAS, mode("app ideas for students"))
        assertEquals(Mode.BUILD, mode("a dashboard for my sales numbers"))
        assertEquals(Mode.CODE, mode("python list comprehension with a condition"))
    }

    @Test
    fun default_is_ask_and_not_sure() {
        val c = ModeClassifier.classify("a cat playing the piano")
        assertEquals(Mode.ASK, c.mode)
        assertEquals("a cat playing the piano", c.prompt)
        assertFalse(c.explicit)
        assertFalse(c.sure)
        val empty = ModeClassifier.classify("   ")
        assertEquals(Mode.ASK, empty.mode)
        assertEquals("", empty.prompt)
        assertEquals(0f, empty.confidence)
    }

    @Test
    fun partial_transcripts_show_the_mode_as_soon_as_it_is_said() {
        assertFalse(ModeClassifier.classify("make an").sure)
        val image = ModeClassifier.classify("make an image")
        assertEquals(Mode.IMAGE, image.mode)
        assertEquals("", image.prompt)
        assertTrue(image.sure)
        assertEquals(Mode.IMAGE, mode("make an image of"))
        assertEquals("", ModeClassifier.classify("make an image of").prompt)
        assertEquals(Mode.VIDEO, mode("make a video of a"))
        assertEquals(Mode.BUILD, mode("build me a"))
    }

    @Test
    fun the_medium_word_inside_something_else_is_not_a_command() {
        assertEquals(Mode.IDEAS, mode("make some video ideas for my channel"))
        assertEquals(Mode.BUILD, mode("make a drawing app for kids"))
        assertEquals(Mode.ASK, mode("make a game plan for my week"))
    }

    @Test
    fun spoken_drops_only_the_wake_words() {
        assertEquals("make an image of a fox", ModeClassifier.spoken("Hey Atelier, make an image of a fox"))
        assertEquals("please draw a cat", ModeClassifier.spoken("please draw a cat"))
        assertEquals("", ModeClassifier.spoken("  "))
    }

    @Test
    fun short_film_and_movie_are_not_always_video() {
        // "short" is not a video noun; give me / show me + movie/film is usually a recommendation.
        assertEquals(Mode.ASK, mode("make a short story about a dragon"))
        assertEquals(Mode.ASK, mode("give me a short summary of the news"))
        assertEquals(Mode.ASK, mode("create a short bio for my Instagram"))
        assertEquals(Mode.ASK, mode("make a short list of pros and cons"))
        assertEquals(Mode.ASK, mode("give me some movie recommendations"))
        assertEquals(Mode.ASK, mode("give me a good movie to watch tonight"))
        assertEquals(Mode.ASK, mode("give me a film to watch with my kids"))
        // …and a short video keeps "a short".
        check("make a short video of waves", Mode.VIDEO, "a short video of waves", true)
        check("make a short clip of a cat jumping", Mode.VIDEO, "a short clip of a cat jumping", true)
        check("make a short film about a robot", Mode.VIDEO, "a short film about a robot", true)
    }

    @Test
    fun film_and_movie_lead_words_are_video() {
        check("film a drone flyover of the Grand Canyon", Mode.VIDEO, "a drone flyover of the Grand Canyon", true)
        check("movie of a cat chasing a laser pointer", Mode.VIDEO, "a cat chasing a laser pointer", true)
        check("a short film about a robot learning to paint", Mode.VIDEO, "a short film about a robot learning to paint", true)
        assertEquals(Mode.ASK, mode("film recommendations for a rainy day"))
    }

    @Test
    fun a_thing_for_my_app_is_not_a_build() {
        assertEquals(Mode.CODE, mode("create unit tests for my app"))
        assertEquals(Mode.CODE, mode("create a react component for my dashboard"))
        assertEquals(Mode.CODE, mode("make a SQL query for my store"))
        assertEquals(Mode.CODE, mode("generate a function for my website"))
        assertEquals(Mode.CODE, mode("create a Python script for my website"))
        assertEquals(Mode.IDEAS, mode("generate ideas for an app"))
        assertEquals(Mode.IDEAS, mode("generate names for my app"))
        assertEquals(Mode.IDEAS, mode("create some ideas for a game"))
        assertEquals(Mode.IDEAS, mode("create a tagline for my website"))
        // Still builds.
        check("make a landing page for my bakery", Mode.BUILD, "a landing page for my bakery", true)
        check("build a habit tracker app with reminders", Mode.BUILD, "a habit tracker app with reminders", true)
    }

    @Test
    fun an_app_about_images_or_video_is_a_build() {
        for (s in listOf(
            "make a photo editing app", "create an image gallery website", "make a photo collage app", "make a picture puzzle game",
            "make a video streaming site", "create a video chat app", "make a website with photos of my work",
            "make a website with a video background", "create an app with video calls", "make a game with animations",
            "make a page with a video", "make a photo gallery for my website", "make an image slider for my website",
        )) {
            assertEquals("mode of \"$s\"", Mode.BUILD, mode(s))
        }
        // The medium still wins when it is the thing.
        check("make a photo of my dog as an astronaut", Mode.IMAGE, "my dog as an astronaut", true)
        check("make a video of my dog playing games", Mode.VIDEO, "my dog playing games", true)
    }

    @Test
    fun everyday_words_are_not_code() {
        assertEquals(Mode.ASK, mode("explain my blood test results"))
        assertEquals(Mode.ASK, mode("review my test results"))
        assertEquals(Mode.ASK, mode("review the class notes for my exam"))
        assertEquals(Mode.ASK, mode("explain how to go about asking for a raise"))
        assertEquals(Mode.CODE, mode("fix the failing tests"))
        assertEquals(Mode.CODE, mode("explain this Go code"))
    }

    @Test
    fun partial_commands_are_not_sure_of_ask() {
        for (s in listOf("can you", "can you make", "can you make an", "write a", "write a python", "could you please")) {
            assertFalse("\"$s\" should not be sure", ModeClassifier.classify(s).sure)
        }
        assertEquals(Mode.IMAGE, mode("can you make an image"))
        assertEquals(Mode.CODE, mode("write a python function"))
        assertEquals(Mode.ASK, mode("can you tell me the time in Tokyo"))
        assertTrue(ModeClassifier.classify("can you help me with my homework").sure)
    }

    @Test
    fun ask_atelier_to_is_addressed_to_atelier() {
        check("ask Atelier to make an image of a red fox", Mode.IMAGE, "a red fox", true)
        check("tell Atelier to write a regex for emails", Mode.CODE, "write a regex for emails", true)
        check("ask Atelier what's the tallest building", Mode.ASK, "what's the tallest building", true)
        assertEquals("make an image of a fox", ModeClassifier.spoken("Ask Atelier to make an image of a fox"))
    }

    @Test
    fun more_image_nouns() {
        check("design a tattoo of a wolf", Mode.IMAGE, "a tattoo of a wolf", true)
        check("create a cartoon of my cat", Mode.IMAGE, "a cartoon of my cat", true)
        check("make a comic about a cat who loves lasagna", Mode.IMAGE, "a comic about a cat who loves lasagna", true)
        check("design a t-shirt with a skull on it", Mode.IMAGE, "a t-shirt with a skull on it", true)
        check("make an anime girl with blue hair", Mode.IMAGE, "an anime girl with blue hair", true)
    }

    @Test
    fun every_mode_has_its_launch_id() {
        assertEquals(listOf("ask", "code", "image", "video", "ideas", "build"), Mode.entries.map { it.id })
        assertEquals(Mode.IDEAS, Mode.of("ideas"))
        assertEquals(null, Mode.of("idea"))
    }
}
