package ai.ciprari.atelier.assist

/**
 * Atelier's six modes, in the web app's order.
 *
 * [id] is the exact `?start=` value public/launch.js accepts (its LAUNCH_MODES; note "ideas", not "idea"). [accent] is
 * the mode's dark-theme accent token from public/app.css :root (--c-ask … --c-build); the card is always warm black, so
 * the dark set is the one that reads on it. ModeParityTest checks both against the web app's files.
 *
 * Pure Kotlin (no Android types): the classifier and its JVM unit tests use it.
 */
enum class Mode(val id: String, val label: String, val accent: Int) {
    ASK("ask", "Ask", 0xFFC8F25A.toInt()),
    CODE("code", "Code", 0xFF5EE6D0.toInt()),
    IMAGE("image", "Image", 0xFFFF8A5B.toInt()),
    VIDEO("video", "Video", 0xFFFF6FA8.toInt()),
    IDEAS("ideas", "Ideas", 0xFFFFC94A.toInt()),
    BUILD("build", "Build", 0xFF9FB0FF.toInt());

    companion object {
        fun of(id: String?): Mode? = entries.firstOrNull { it.id == id }
    }
}
