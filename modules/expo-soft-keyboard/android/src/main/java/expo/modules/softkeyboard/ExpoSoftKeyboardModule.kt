package expo.modules.softkeyboard

import android.content.Context
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The terminal's page owns the keyboard: the key bar's up-swipe focuses xterm's helper textarea.
 * WebKit raises the iPhone keyboard from that focus; Chrome-for-Android does not, because a
 * native-view gesture is not document user activation (issues.md I17). The page focus lands, the
 * IME never shows. This module is the missing half: it shows the IME for the webview itself, the
 * same `showSoftInput` a native field's tap ends in.
 *
 * The page focus arrives over the bridge a few frames after this call, and the webview only
 * reports itself a text editor once the renderer tells it an editable element is focused, so the
 * show waits for that (a show without it opens a keyboard that types nowhere).
 */
class ExpoSoftKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoSoftKeyboard")

    AsyncFunction("show") { show() }.runOnQueue(Queues.MAIN)
  }

  private fun show() {
    val activity = appContext.currentActivity ?: return
    val web = largestShownWebView(activity.window.decorView)
    if (web == null) {
      Log.w(TAG, "show: no webview on screen")
      return
    }
    if (!web.hasFocus()) web.requestFocus()
    val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    var frames = 0
    val attempt = object : Runnable {
      override fun run() {
        if (web.onCheckIsTextEditor()) {
          val shown = imm.showSoftInput(web, 0)
          Log.i(TAG, "show: after $frames frames, accepted=$shown")
        } else if (++frames < MAX_FRAMES) {
          web.postOnAnimation(this)
        } else {
          Log.w(TAG, "show: the page never focused an editable element")
        }
      }
    }
    web.post(attempt)
  }

  /** The terminal is the one full-screen webview; any other (none today) is smaller. */
  private fun largestShownWebView(root: View): WebView? {
    var best: WebView? = null
    fun walk(view: View) {
      if (!view.isShown) return
      if (view is WebView) {
        if (best == null || area(view) > area(best!!)) best = view
        return
      }
      if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
    }
    walk(root)
    return best
  }

  private fun area(view: View) = view.width.toLong() * view.height

  private companion object {
    const val TAG = "ExpoSoftKeyboard"

    /** ~1s at 60 Hz: far past a bridge round trip, short enough not to raise a stale request. */
    const val MAX_FRAMES = 60
  }
}
