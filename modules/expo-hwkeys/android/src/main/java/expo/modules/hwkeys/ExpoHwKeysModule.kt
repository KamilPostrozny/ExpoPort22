package expo.modules.hwkeys

import android.os.Looper
import android.view.KeyEvent
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of the physical-keyboard seam — the same rule as the iOS file (see there for
 * the whole why): the 1×1 field does useful work only with plain printables, Return, Backspace
 * and Space, so those pass through and every other key-down is consumed and handed to JS.
 *
 * The seam is the window's key dispatch: the system calls `Activity.dispatchKeyEvent`, which
 * hands the key to the window, whose callback is the activity itself. We wrap that callback once
 * (after the activity attached it — the first `setMode` from JS is late enough) and intercept
 * before view dispatch. Everything not intercepted delegates to the original callback untouched,
 * so the Back key, the volume keys the activity owns, and the field's own typing all behave
 * exactly as before the module existed.
 *
 * The callback is the long-lived single activity's; this app never re-creates it.
 */
class ExpoHwKeysModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoHwKeys")

    Events("onKey")

    AsyncFunction("setMode") { mode: String ->
      install(mode)
    }
  }

  /** Touched on the UI thread only: `install` runs there and key events arrive there. */
  private var mode = "off"
  private var wrapped: Window.Callback? = null

  /** Plain (no modifier) keys the field does nothing useful with. */
  private val plain: Set<Int> =
    setOf(
      KeyEvent.KEYCODE_ESCAPE,
      KeyEvent.KEYCODE_TAB,
      KeyEvent.KEYCODE_FORWARD_DEL,
      KeyEvent.KEYCODE_MOVE_HOME,
      KeyEvent.KEYCODE_MOVE_END,
      KeyEvent.KEYCODE_PAGE_UP,
      KeyEvent.KEYCODE_PAGE_DOWN,
      KeyEvent.KEYCODE_DPAD_UP,
      KeyEvent.KEYCODE_DPAD_DOWN,
      KeyEvent.KEYCODE_DPAD_RIGHT,
      KeyEvent.KEYCODE_DPAD_LEFT,
    ) + (KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12)

  /** With Ctrl or Alt held, the keys worth typing: the letter/digit chords of `controlByte`, the
   *  layout keys behind @ _ ^ \ [ ], Return, and the nav keys. */
  private val chords: Set<Int> =
    buildSet {
      addAll(KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z)
      addAll(KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9)
      add(KeyEvent.KEYCODE_AT)
      add(KeyEvent.KEYCODE_LEFT_BRACKET)
      add(KeyEvent.KEYCODE_RIGHT_BRACKET)
      add(KeyEvent.KEYCODE_BACKSLASH)
      add(KeyEvent.KEYCODE_CARET)
      add(KeyEvent.KEYCODE_UNDERSCORE)
      add(KeyEvent.KEYCODE_ENTER)
      add(KeyEvent.KEYCODE_DPAD_UP)
      add(KeyEvent.KEYCODE_DPAD_DOWN)
      add(KeyEvent.KEYCODE_DPAD_RIGHT)
      add(KeyEvent.KEYCODE_DPAD_LEFT)
      add(KeyEvent.KEYCODE_MOVE_HOME)
      add(KeyEvent.KEYCODE_MOVE_END)
    }.toSet()

  private fun intercept(event: KeyEvent): Boolean {
    if (mode == "off" || event.action != KeyEvent.ACTION_DOWN) return false
    val ctrl = event.isCtrlPressed
    val alt = event.isAltPressed
    val meta = event.isMetaPressed
    if (mode == "switcher") {
      // Only Escape: it closes the switcher, and the search field keeps every other key.
      return event.keyCode == KeyEvent.KEYCODE_ESCAPE && !ctrl && !alt && !meta
    }
    if (meta) return true
    if (ctrl || alt) return chords.contains(event.keyCode)
    return plain.contains(event.keyCode)
  }

  private fun emit(event: KeyEvent) {
    sendEvent(
      "onKey",
      mapOf(
        "platform" to "android",
        "keyCode" to event.keyCode,
        "character" to charOf(event.unicode),
        "baseCharacter" to charOf(event.getUnicodeChar(0)),
        "shiftKey" to event.isShiftPressed,
        "ctrlKey" to event.isCtrlPressed,
        "altKey" to event.isAltPressed,
        "metaKey" to event.isMetaPressed,
        "repeat" to event.isRepeat,
      ),
    )
  }

  private fun charOf(code: Int): String = if (code == 0) "" else code.toChar().toString()

  private fun install(newMode: String) {
    val activity = appContext.currentActivity
    if (Looper.myLooper() != Looper.getMainLooper()) {
      // `setMode` arrives on the JS thread; the window belongs to the UI thread.
      activity?.runOnUiThread { install(newMode) }
      return
    }
    mode = newMode
    if (wrapped != null) return
    val window = activity?.window ?: return
    val original = window.callback ?: return
    wrapped = window.callback
    window.callback =
      object : Window.Callback by original {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
          if (intercept(event)) {
            emit(event)
            return true
          }
          return original.dispatchKeyEvent(event)
        }
      }
  }
}
