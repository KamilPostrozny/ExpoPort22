import ExpoModulesCore
import UIKit

/**
 * The physical-keyboard seam.
 *
 * The terminal's 1×1 `TextInput` owns the software keyboard, and a hardware keyboard is just a
 * faster way to feed the same responder chain — but the field only ever does useful work with
 * plain printables, Return, Backspace and Space. Everything else a Bluetooth or USB key throws
 * at it (Esc, Tab, arrows, Home/End, PgUp/Dn, Delete, F-keys, Ctrl/Alt chords, Cmd+V) either
 * moves the caret, jumps focus, or is dropped by the field and by the activity alike.
 *
 * So this module sits in front of the OS's own key pipeline — `-[UIApplication
 * handleKeyUIEvent:]`, the same swizzle point React Native itself uses (in dev builds only, see
 * `RCTKeyCommands.m`) — and applies the pass-through rule: a key with no Ctrl/Alt/Cmd that
 * produces a character, or a plain Return/Space/Backspace, goes on to the field untouched; every
 * other key-down is consumed here and handed to JS as one raw event, which `src/hwkeys-model.ts`
 * turns into PTY bytes or an app action. Nothing else is touched: with the mode `'off'` the
 * swizzle is a straight pass-through, and the app behaves exactly as before the module existed.
 *
 * The mode is JS-driven on purpose — the same reason the web guard's hold flag lives in JS: only
 * the app knows when the terminal's field is focused and the switcher is closed, and that is the
 * only moment intercepting is right.
 */
public class ExpoHwKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHwKeys")

    OnCreate {
      KeyTap.module = self
      KeyTap.install()
    }

    Events("onKey")

    AsyncFunction("setMode") { (mode: String) in
      DispatchQueue.main.async {
        KeyTap.mode = mode
      }
    }
  }
}

/// The intercept state. `mode` is read from the main thread only (key events arrive there), and
/// the swizzle is installed once, at module creation.
private final class KeyTap {
  static weak var module: ExpoHwKeysModule?
  static var mode: String = "off"
  private static var installed = false

  static func install() {
    guard !installed else { return }
    installed = true
    // `handleKeyUIEvent(_:)` is private UIKit (declared below only for the selector — the real
    // implementation is the one UIApplication already carries, the way React Native's dev-build
    // `RCTKeyCommands` swizzles the same point):
    guard
      let original = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.handleKeyUIEvent(_:))),
      let swizzled = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.hwKeysHandleKeyUIEvent(_:)))
    else { return }
    method_exchangeImplementations(original, swizzled)
  }

  /// The keys a mode intercepts, by HID usage (the values `UIKeyboardHidUsage` copies 1:1).
  /// Plain (no modifier) versions of these are the ones the field does nothing useful with; the
  /// modifier versions are handled in `intercept` — with Ctrl/Alt only letter/digit/@/[]\/^_ keys
  /// are chords worth typing, and Cmd intercepts everything so Cmd+V can paste.
  private static let plain: Set<Int> = [
    0x29, // escape
    0x2b, // tab
    0x87, // delete forward
    0x89, // home
    0x8a, // end
    0x8b, // page up
    0x8c, // page down
    0x52, // arrow left
    0x53, // arrow right
    0x54, // arrow down
    0x55, // arrow up
  ]
  private static let fKeys: Set<Int> = Set([0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x45, 0x46])
  private static let chords: Set<Int> = {
    // a–z, 1–9, 0
    var set = Set<Int>(0x04...0x1d)
    set.formUnion(0x1e...0x27)
    // - = [ ] \ — the keys carrying @ _ ^ \ and [ ] in the US layout, the rest of `controlByte`'s set
    set.formUnion([0x2d, 0x2e, 0x2f, 0x30, 0x31])
    // Enter (Ctrl/Alt + Return) and the nav keys, Ctrl'd, are worth routing too
    set.formUnion([0x28, 0x52, 0x53, 0x54, 0x55, 0x89, 0x8a])
    return set
  }()

  /// A per-key-down subevent of the physical event. Typed as the public `UIEvent` on purpose:
  /// the concrete class is private UIKit, and a Swift declaration of it would be a *sibling*
  /// class in the ObjC runtime (different class object, same superclass), so an `as?` cast to a
  /// stub would always fail. Name checks and KVC touch it without declaring it.
  static func intercept(subevent: UIEvent, modifiers: UIKeyModifierFlags, keyDown: Bool) -> Bool {
    guard mode != "off" else { return false }
    guard keyDown else { return false }
    guard NSStringFromClass(type(of: subevent)) == "UIKeyboardInput" else { return false }
    // The fields are private too — KVC keeps this free of any ABI assumption about their types.
    // A missing key reads as a number of zero, which is not in any intercept set.
    let code = Int((subevent.value(forKey: "keyCode") as? NSNumber)?.intValue ?? 0)
    let ctrl = modifiers.contains(.control)
    let alt = modifiers.contains(.alternate)
    let meta = modifiers.contains(.command)
    if mode == "switcher" {
      // Only Escape: it closes the switcher, and the search field keeps every other key.
      return code == 0x29 && !ctrl && !alt && !meta
    }
    if meta { return true }
    if ctrl || alt { return chords.contains(code) }
    return plain.contains(code) || fKeys.contains(code)
  }

  static func emit(subevent: UIEvent, modifiers: UIKeyModifierFlags) {
    module?.sendEvent("onKey", [
      "platform": "ios",
      "keyCode": Int((subevent.value(forKey: "keyCode") as? NSNumber)?.intValue ?? 0),
      "character": subevent.value(forKey: "characters") as? String ?? "",
      "baseCharacter": subevent.value(forKey: "charactersIgnoringModifiers") as? String ?? "",
      "shiftKey": modifiers.contains(.shift),
      "ctrlKey": modifiers.contains(.control),
      "altKey": modifiers.contains(.alternate),
      "metaKey": modifiers.contains(.command),
      "repeat": false,
    ])
  }
}

private extension UIApplication {
  /** Private UIKit: declared for the `#selector` above and nothing else. */
  @objc func handleKeyUIEvent(_ event: UIEvent) {}

  @objc func hwKeysHandleKeyUIEvent(_ event: UIEvent) {
    // `UIKeyboardEvent` is the public base of the private `UIPhysicalKeyboardEvent`, so the cast
    // is a normal one — no name lookup. Touch events are not keyboard events, so this is the
    // only kind that reaches the loop.
    if let keyboard = event as? UIKeyboardEvent {
      // Key up/down per event: the private flag React Native reads for exactly this. If it ever
      // disappears the answer is "pass everything through" (a no-op), never a doubled key.
      let keyDown = (keyboard.value(forKey: "_isKeyDown") as? Bool) ?? false
      let modifiers = keyboard.allKeys
      for subevent in keyboard.subevents ?? [] {
        if KeyTap.intercept(subevent: subevent, modifiers: modifiers, keyDown: keyDown) {
          KeyTap.emit(subevent: subevent, modifiers: modifiers)
          return // consumed: the field never sees it
        }
      }
    }
    hwKeysHandleKeyUIEvent(event) // the original, after the swap
  }
}
