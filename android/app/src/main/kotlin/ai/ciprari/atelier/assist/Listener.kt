package ai.ciprari.atelier.assist

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/**
 * One utterance through Android's speech service ([SpeechRecognizer]): live partial text, the mic level, the final text.
 *
 * - Prefers the on-device recognizer (Android 12+, when the phone has one); if that can't serve this language or fails
 *   before it heard anything, it switches to the phone's default recognizer (usually Google's) for the rest of the
 *   process, without telling the owner. The default recognizer may use the network: that is the speech app's own
 *   connection, so this app needs no INTERNET permission.
 * - Language: the phone's current locale.
 * - Each start() is a new session with a new SpeechRecognizer; callbacks from an older session are ignored, so a late
 *   error from a cancelled one never reaches the card.
 * - Nothing said is logged or kept here: the text goes to [Events] and nowhere else.
 *
 * Main thread only (SpeechRecognizer's rule).
 */
class Listener internal constructor(private val context: Context, private val events: Events) {

    interface Events {
        /** The recognizer is ready: the owner can talk. */
        fun onListening()

        /** Mic level, 0..1 (from onRmsChanged, roughly -2..10 dB). */
        fun onLevel(level: Float)

        fun onPartial(text: String)

        /** The owner stopped talking; the final text follows (or an error). */
        fun onSpeechEnd()

        fun onFinal(text: String)

        fun onFailed(error: Failure)
    }

    enum class Failure { NO_MATCH, NETWORK, BUSY, PERMISSION, AUDIO, UNAVAILABLE, LANGUAGE, OTHER }

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null

    /** Recognizers whose destroy() is posted (never from inside their own callback); [destroy] flushes them at once. */
    private val dying = ArrayList<SpeechRecognizer>()
    private var session = 0
    private var active = false

    val listening: Boolean get() = active

    /** A speech service exists (the default one, or an on-device one). */
    fun available(): Boolean = try {
        SpeechRecognizer.isRecognitionAvailable(context) || onDeviceUsable()
    } catch (_: RuntimeException) {
        false
    }

    private fun onDeviceUsable(): Boolean = Build.VERSION.SDK_INT >= 31 && !onDeviceFailed &&
        runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }.getOrDefault(false)

    fun start(locale: Locale) {
        release()
        val id = ++session
        active = true
        val onDevice = onDeviceUsable()
        val r = try {
            if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
        } catch (_: RuntimeException) {
            null
        }
        if (r == null) {
            if (onDevice) return fallBack(locale)
            return fail(id, Failure.UNAVAILABLE)
        }
        recognizer = r
        r.setRecognitionListener(Callbacks(id, onDevice, locale))
        try {
            r.startListening(intentFor(locale))
        } catch (_: RuntimeException) {
            if (onDevice) return fallBack(locale)
            return fail(id, Failure.OTHER)
        }
        // Never stuck on "Listening" if the service doesn't answer.
        main.postDelayed({ if (id == session && active && !readySession(id)) timeoutReady(id, onDevice, locale) }, TIMERS, READY_TIMEOUT_MS)
        // One utterance at most this long: then whatever was heard is final.
        main.postDelayed({ if (id == session && active) stop() }, TIMERS, MAX_LISTEN_MS)
    }

    /** Stop listening and finish with what was heard. */
    fun stop() {
        if (!active) return
        try {
            recognizer?.stopListening()
        } catch (_: RuntimeException) {
            cancel()
        }
    }

    /** Stop listening and drop it: no final text, no error. */
    fun cancel() {
        active = false
        session++
        try {
            recognizer?.cancel()
        } catch (_: RuntimeException) {
        }
        release()
    }

    /** The card is going away: cancel, and destroy any recognizer still waiting for its posted destroy. */
    fun destroy() {
        cancel()
        main.removeCallbacksAndMessages(DYING)
        val pending = dying.toList()
        dying.clear()
        pending.forEach(::destroy)
    }

    /**
     * Drops this session's timers (only those: a recognizer's posted destroy survives, so a cancel() straight after an
     * error can't leak it) and destroys the current recognizer.
     */
    private fun release() {
        main.removeCallbacksAndMessages(TIMERS)
        val r = recognizer ?: return
        recognizer = null
        destroy(r)
    }

    /**
     * After a result or an error: this session's recognizer is destroyed on the next loop turn, never from inside its own
     * callback, and only that instance (a session started meanwhile keeps its own recognizer and timers).
     */
    private fun releaseLater() {
        main.removeCallbacksAndMessages(TIMERS)
        val r = recognizer ?: return
        recognizer = null
        dying += r
        main.postDelayed({
            if (dying.remove(r)) destroy(r)
        }, DYING, 0L)
    }

    private fun destroy(r: SpeechRecognizer) {
        try {
            r.destroy()
        } catch (_: RuntimeException) {
        }
    }

    private var readyIn = -1
    private fun readySession(id: Int) = readyIn == id

    private fun timeoutReady(id: Int, onDevice: Boolean, locale: Locale) {
        if (onDevice) fallBack(locale) else fail(id, Failure.OTHER)
    }

    /**
     * The on-device recognizer can't serve this: use the default one from now on (this process). Posted, so the old
     * recognizer is never destroyed from inside its own callback; a cancel() meanwhile wins (the session moved on).
     */
    private fun fallBack(locale: Locale) {
        onDeviceFailed = true
        val id = ++session
        main.postDelayed({ if (id == session && active) start(locale) }, TIMERS, 0L)
    }

    private fun fail(id: Int, failure: Failure) {
        if (id != session) return
        active = false
        session++
        releaseLater()
        events.onFailed(failure)
    }

    private fun finish(id: Int, text: String) {
        if (id != session) return
        active = false
        session++
        releaseLater()
        events.onFinal(text)
    }

    private fun intentFor(locale: Locale) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
        .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)

    private inner class Callbacks(private val id: Int, private val onDevice: Boolean, private val locale: Locale) : RecognitionListener {
        private var heard = ""
        private var spoke = false
        private val current get() = id == session && active

        override fun onReadyForSpeech(params: Bundle?) {
            if (!current) return
            readyIn = id
            events.onListening()
        }

        override fun onBeginningOfSpeech() {
            if (current) spoke = true
        }

        override fun onRmsChanged(rmsdB: Float) {
            if (current) events.onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
        }

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() {
            if (current) events.onSpeechEnd()
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (!current) return
            val text = first(partialResults)
            if (text.isNotBlank()) {
                heard = text
                events.onPartial(text)
            }
        }

        override fun onResults(results: Bundle?) {
            if (!current) return
            val text = first(results).ifBlank { heard }
            if (text.isBlank()) fail(id, Failure.NO_MATCH) else finish(id, text)
        }

        override fun onError(error: Int) {
            if (!current) return
            // The on-device recognizer can't do this language (or this phone's one misbehaves) before anything was heard:
            // quietly switch to the default recognizer.
            if (onDevice && heard.isBlank() && !spoke && error in ON_DEVICE_FALLBACK) {
                fallBack(locale)
                return
            }
            // Ending on a timeout or a client hiccup after words came through: those words are the answer.
            if (heard.isNotBlank() && error in KEEP_HEARD) {
                finish(id, heard)
                return
            }
            fail(id, failureOf(error))
        }

        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        private fun first(b: Bundle?): String =
            b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
    }

    private fun failureOf(error: Int): Failure = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Failure.NO_MATCH
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> Failure.NETWORK
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY, ERROR_TOO_MANY_REQUESTS -> Failure.BUSY
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> Failure.PERMISSION
        SpeechRecognizer.ERROR_AUDIO -> Failure.AUDIO
        ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE -> Failure.LANGUAGE
        else -> Failure.OTHER
    }

    private companion object {
        const val READY_TIMEOUT_MS = 6_000L

        /** Handler tokens: this session's timers (removed on release) and posted destroys (never removed by release). */
        val TIMERS = Any()
        val DYING = Any()
        const val MAX_LISTEN_MS = 45_000L

        // SpeechRecognizer constants newer than minSdk 29 (values from the platform; inlined so no API check is needed).
        const val ERROR_TOO_MANY_REQUESTS = 10
        const val ERROR_SERVER_DISCONNECTED = 11
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
        const val ERROR_CANNOT_CHECK_SUPPORT = 14
        const val ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS = 15

        val ON_DEVICE_FALLBACK = setOf(
            SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            ERROR_SERVER_DISCONNECTED, ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE, ERROR_CANNOT_CHECK_SUPPORT,
            ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS,
        )
        val KEEP_HEARD = setOf(SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_CLIENT)

        /** Process-wide: once the on-device recognizer has failed here, the default one is used until the app restarts. */
        @Volatile
        var onDeviceFailed = false
    }
}
