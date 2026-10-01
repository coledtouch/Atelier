package ai.ciprari.atelier.assist

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Saves what Atelier offers as a download (generated images and videos, exports) to Downloads/Atelier through
 * MediaStore: no storage permission on Android 10+, and only files this app wrote are touched.
 */
internal object Downloads {
    const val MAX_BYTES = 64 * 1024 * 1024

    private val ALLOWED = Regex("^(image|video|audio)/[a-z0-9.+-]+$|^(text/plain|text/markdown|text/csv|text/html|application/json|application/pdf|application/zip)$")

    private fun mimeForExt(ext: String): String? = when (ext) {
        "md", "markdown" -> "text/markdown"
        "json" -> "application/json"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }

    private fun extForMime(mime: String): String = when (mime) {
        "text/markdown" -> "md"
        "application/json" -> "json"
        else -> MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: mime.substringAfter('/').substringBefore('+').take(8)
    }

    /**
     * The (display name, type) to save under, or null when the type isn't one Atelier produces (media, text, JSON,
     * PDF, ZIP). An untyped file is judged by its suggested name's extension; the name always ends in the type's
     * extension, so a file can't be saved as one thing and opened as another.
     */
    fun resolve(suggested: String?, mime: String?): Pair<String, String>? {
        val clean = suggested.orEmpty()
            .substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\u0000-\\u001f\\u007f\"*:<>?|]"), "")
            .trim().trimStart('.')
            .take(100)
        val nameExt = clean.substringAfterLast('.', "").lowercase()
        var m = mime?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        if (!ALLOWED.matches(m) && nameExt.isNotEmpty()) m = mimeForExt(nameExt).orEmpty()
        if (!ALLOWED.matches(m)) return null
        val base = clean.ifEmpty { "atelier-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) }
        val name = if (nameExt.isNotEmpty() && mimeForExt(nameExt) == m) base else "$base.${extForMime(m)}"
        return name to m
    }

    /** "data:[mime][;base64],payload" → (mime, bytes), or null when it isn't one or is too large. */
    fun decodeDataUrl(url: String): Pair<String, ByteArray>? {
        if (!url.startsWith("data:", ignoreCase = true)) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val meta = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        if (payload.length > MAX_BYTES / 3 * 4 + 4) return null
        val parts = meta.split(';')
        val mime = parts.firstOrNull().orEmpty().ifEmpty { "text/plain" }
        val bytes = try {
            if (parts.any { it.equals("base64", ignoreCase = true) }) Base64.decode(payload, Base64.DEFAULT)
            else Uri.decode(payload).toByteArray(Charsets.UTF_8)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return mime to bytes
    }

    /** Blocking (call off the main thread). Returns the new item's Uri, or null. */
    fun save(context: Context, bytes: ByteArray, mime: String, name: String): Uri? {
        if (bytes.isEmpty() || bytes.size > MAX_BYTES) return null
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Atelier")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = try {
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } catch (_: RuntimeException) {
            null
        } ?: return null
        return try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("no stream")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        } catch (_: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            null
        }
    }
}
