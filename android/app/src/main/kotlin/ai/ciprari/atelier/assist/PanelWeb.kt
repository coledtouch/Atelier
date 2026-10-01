package ai.ciprari.atelier.assist

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.math.hypot

/** What the WebView needs from the activity. */
internal interface PanelHost {
    fun onProgress(percent: Int)
    fun onMainFrameError()
    fun onPageVisible()
    fun requestMic(request: PermissionRequest)
    fun cancelMic(request: PermissionRequest)
    fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean
    fun openExternal(uri: Uri)
    fun onDownload(url: String, mimeType: String?)
    fun onBridgeMessage(message: JSONObject, reply: JavaScriptReplyProxy)
    fun onBridgeBytes(bytes: ByteArray)

    /** The renderer went away ([crashed] false: Android reclaimed it, usually while the panel was out of sight). */
    fun onRendererGone(crashed: Boolean)
}

/**
 * The WebView that shows Atelier, locked to https://atelier.ciprari.ai:
 * - top-level navigation elsewhere goes to the browser (or mail/phone app); intent:, file:, content: and the like are
 *   dropped; popups (window.open, target=_blank) never show in the panel, their destination opens outside;
 * - shouldOverrideUrlLoading never sees POST navigations (a <form method=post> in a reply, say), so every main-frame
 *   request that leaves Atelier is also stopped before it reaches the network (shouldInterceptRequest), and anything
 *   from another site that still commits as the main frame is stopped and backed out at once (onPageStarted);
 * - the page gets the microphone only (never camera or location), and only for Atelier's own origin;
 * - files are reachable only through the system picker; no file:// or content:// access;
 * - window.AtelierAssist (postMessage bridge) is injected into Atelier's top frame only.
 */
internal class PanelWeb(private val context: Context, private val host: PanelHost, private val container: FrameLayout, background: Int) {
    val view: WebView = WebView(context)
    private val popups = mutableListOf<WebView>()
    private val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    private var destroyed = false
    var bridge = false
        private set
    val binaryBridge: Boolean get() = bridge && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)

    /** When the owner last tapped the page (finger down and up without scrolling), SystemClock.elapsedRealtime(). */
    var lastTapAt = 0L
        private set

    init {
        view.setBackgroundColor(background)
        configure(view.settings)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { url, _, _, mimeType, _ -> host.onDownload(url, mimeType) }
        watchTaps()
        installBridge()
        container.addView(view, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    /** Downloads need a real tap (see AssistActivity.onDownload). The listener only watches; the WebView gets every touch. */
    @SuppressLint("ClickableViewAccessibility")
    private fun watchTaps() {
        val slop = ViewConfiguration.get(context).scaledTouchSlop
        var downX = 0f
        var downY = 0f
        var tap = false
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.x
                    downY = e.y
                    tap = true
                }
                MotionEvent.ACTION_MOVE -> if (tap && hypot(e.x - downX, e.y - downY) > slop) tap = false
                MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> tap = false
                MotionEvent.ACTION_UP -> if (tap) lastTapAt = SystemClock.elapsedRealtime()
            }
            false
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // Atelier is a JavaScript app; navigation is locked to its origin
    private fun configure(s: WebSettings) {
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.setSupportMultipleWindows(true) // so window.open reaches onCreateWindow (and leaves the app) instead of replacing Atelier
        s.javaScriptCanOpenWindowsAutomatically = false // popups only from a tap
        s.setGeolocationEnabled(false)
        s.mediaPlaybackRequiresUserGesture = false // dictation's level meter and Read aloud after a voice launch
        s.safeBrowsingEnabled = true
        s.setSupportZoom(false)
        s.userAgentString = s.userAgentString + " AtelierAssist/1"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false) // Atelier has its own dark theme
        }
    }

    private fun installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, Atelier.BRIDGE, setOf(Atelier.ORIGIN)) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || !Atelier.isAtelier(sourceOrigin)) return@addWebMessageListener
            when (message.type) {
                WebMessageCompat.TYPE_STRING -> {
                    val data = message.data ?: return@addWebMessageListener
                    if (data.length > MAX_MESSAGE_CHARS) return@addWebMessageListener
                    val json = try { JSONObject(data) } catch (_: Exception) { return@addWebMessageListener }
                    host.onBridgeMessage(json, reply)
                }
                WebMessageCompat.TYPE_ARRAY_BUFFER -> host.onBridgeBytes(message.arrayBuffer)
            }
        }
        bridge = true
    }

    fun load(url: String) = view.loadUrl(url)
    fun canGoBack() = view.canGoBack()
    fun goBack() = view.goBack()
    fun onPause() = view.onPause()
    fun onResume() = view.onResume()
    fun evaluate(js: String) = view.evaluateJavascript(js, null)

    fun destroy() {
        destroyed = true
        popups.toList().forEach { closePopup(it) }
        (view.parent as? ViewGroup)?.removeView(view)
        view.stopLoading()
        view.setDownloadListener(null)
        view.destroy()
    }

    private fun closePopup(w: WebView) {
        if (!popups.remove(w)) return
        w.stopLoading()
        container.post { w.destroy() }
    }

    // onRenderProcessGone is overridden below; lint's MissingOnRenderProcessGone check misses Kotlin overrides.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class Client : WebViewClient() {
        // GET navigations. Not called for POST: shouldInterceptRequest and onPageStarted below cover those.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false // frames inside Atelier (Build previews) stay put
            val url = request.url
            if (Atelier.isAtelier(url)) return false
            host.openExternal(url)
            return true
        }

        // Runs on a WebView background thread. A main-frame request for another site gets here only when the check above
        // was skipped (a POST, or a redirect it didn't see): it never reaches the network, and a 204 is not committed, so
        // Atelier stays on screen. A POST target is not handed to the browser either (it would arrive there as a GET).
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (request.isForMainFrame && !Atelier.isAtelier(request.url)) noContent() else null

        // The backstop: anything from another site that still commits as the main frame is stopped at once, and the panel
        // goes back to Atelier (the page before it, else a fresh start page).
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url == null || Atelier.isAtelier(url.toUri())) return
            view.stopLoading()
            view.post {
                if (destroyed) return@post
                if (view.canGoBack()) view.goBack() else view.loadUrl(Atelier.startUrl("ask"))
            }
        }

        override fun onPageCommitVisible(view: WebView, url: String?) = host.onPageVisible()

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // Only Atelier's own pages show the "Can't reach Atelier" screen (not a foreign request stopped above).
            if (request.isForMainFrame && Atelier.isAtelier(request.url)) host.onMainFrameError()
        }

        override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) {
            callback.backToSafety(true)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            host.onRendererGone(detail.didCrash())
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
            if (!wantsMic || !Atelier.isAtelier(request.origin)) {
                request.deny()
                return
            }
            host.requestMic(request)
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) = host.cancelMic(request)

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
            host.showFileChooser(filePathCallback, fileChooserParams)

        override fun onProgressChanged(view: WebView, newProgress: Int) = host.onProgress(newProgress)

        // Release builds keep the page's console out of logcat.
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = !debuggable

        // No grey "play" placeholder over a video before it starts.
        override fun getDefaultVideoPoster(): Bitmap = createBitmap(1, 1)

        /**
         * window.open / target=_blank from a tap: hand the page an invisible WebView so its script keeps working
         * (Atelier writes "Sending to Canva…" into the window it opens, then points it somewhere), and send the first
         * real http(s) page it navigates to out to the browser (an Atelier page to the installed app).
         */
        @SuppressLint("MissingOnRenderProcessGone") // the popup's client overrides it too (see below)
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = WebView(context)
            var handed = false
            fun handOff(w: WebView, uri: Uri?) {
                if (handed) return
                handed = true
                if (uri != null) host.openExternal(uri)
                closePopup(w)
            }
            popup.settings.apply {
                javaScriptEnabled = false
                allowFileAccess = false
                allowContentAccess = false
            }
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.isForMainFrame) handOff(view, request.url)
                    return true
                }

                // The popup never loads anything itself (it is invisible and only hands its destination on): no request of
                // its own reaches the network. A GET destination goes out as above (Atelier's own popups only ever
                // navigate with location.href / replace); a POST target is dropped with the popup, as in the main frame.
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    if (request.isForMainFrame) {
                        val uri = if (request.method.equals("GET", ignoreCase = true)) request.url else null
                        container.post { handOff(view, uri) }
                    }
                    return noContent()
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    val uri = url?.toUri() ?: return
                    if (uri.scheme == "https" || uri.scheme == "http") {
                        view.stopLoading()
                        handOff(view, uri)
                    }
                }

                // All of the app's WebViews share one renderer: when it dies, every one of them must say it's handled.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    handed = true
                    closePopup(view)
                    return true
                }
            }
            popup.webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) = closePopup(window)
            }
            popup.visibility = View.GONE
            popups += popup
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }
    }

    private companion object {
        const val MAX_MESSAGE_CHARS = 64 * 1024

        /** An empty 204 for a blocked request (a fresh stream each time: WebView reads and closes it). */
        fun noContent() = WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
