package expo.modules.pasteboard

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The Android half of the pasteboard file read — see the iOS file for why this module exists at
 * all. Here a copied file is a `content://` URI in the clip, and `ContentResolver` opens it under
 * the grant the copying app attached.
 *
 * `expo-clipboard` does reach that URI, but only by coercing it to text: `getStringAsync` returns
 * the URI *string*, which typed into a shell is nonsense. The bytes need the resolver.
 */
class ExpoPasteboardModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val clipboard: ClipboardManager
    get() = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  override fun definition() = ModuleDefinition {
    Name("ExpoPasteboard")

    /** The filename of the copied file, or `null`. Metadata only — no bytes are read. */
    AsyncFunction("peek") Coroutine { ->
      withContext(Dispatchers.IO) { fileUri()?.let { displayName(it) } }
    }

    /** `{ name, base64 }` for the copied file, or `null`. */
    AsyncFunction("read") Coroutine { ->
      withContext(Dispatchers.IO) {
        val uri = fileUri() ?: return@withContext null
        // Whole file in memory, size unguarded — the same bargain the pickers strike (§7).
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
          ?: return@withContext null
        mapOf("name" to displayName(uri), "base64" to Base64.encodeToString(bytes, Base64.NO_WRAP))
      }
    }
  }

  /**
   * The clip's URI when it points at a file. Images are left to `expo-clipboard` so the two never
   * disagree about what a copied photo is called, and a plain text clip has no URI to begin with.
   */
  private fun fileUri(): Uri? {
    val clip = clipboard.primaryClip?.takeIf { it.itemCount > 0 } ?: return null
    val mime = clipboard.primaryClipDescription?.getMimeType(0) ?: return null
    if (mime.startsWith("image/")) return null
    return clip.getItemAt(0).uri
  }

  /** The provider's own display name, or a generic one when it does not offer one. */
  private fun displayName(uri: Uri): String {
    context.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0)
      }
    return uri.lastPathSegment ?: "pasted"
  }
}
