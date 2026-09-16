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
 *
 * TEMPORARY DIAGNOSTIC: every keyboard event that reaches `handleKeyUIEvent:` (and every
 * `.presses` event that reaches `sendEvent:`) is also handed to JS as `onKeyDebug`, carrying
 * the private fields it actually has. Remove once the on-device shape is known.
 */
public class ExpoHwKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHwKeys")

    OnCreate {
      KeyTap.module = self
      KeyTap.install()
    }

    Events("onKey", "onKeyDebug")

    AsyncFunction("setMode") { (mode: String) in
      DispatchQueue.main.async {
        KeyTap.mode = mode
        KeyTap.debug("mode", ["mode": mode, "install": KeyTap.installStatus])
      }
    }
  }
}

/// The intercept state. `mode` is read from the main thread only (key events arrive there), and
/// the swizzle is installed once, at module creation.
private final class KeyTap {
  static weak var module: ExpoHwKeysModule?
  static var mode: String = "off"
  static var installStatus: String = "not-run"
  private static var installed = false

  /// Diagnostic only: the raw shape of one keyboard event, back to JS.
  static func debug(_ name: String, _ info: [String: Any?]) {
    var body = info
    body["debug"] = name
    module?.sendEvent("onKeyDebug", body)
  }

  static func install() {
    guard !installed else { return }
    installed = true
    // `handleKeyUIEvent:` is private UIKit — resolve the selector by name, the way React Native's
    // dev-build `RCTKeyCommands` swizzles the same point. It must not be declared as a method of
    // this extension: a Swift extension compiles to an ObjC category, and a category method with
    // the same selector *replaces* the private implementation the moment the binary loads, before
    // the swizzle ever runs.
    let keySelector = NSSelectorFromString("handleKeyUIEvent:")
    let sendSelector = NSSelectorFromString("sendEvent:")
    let originalKey = class_getInstanceMethod(UIApplication.self, keySelector)
    let swizzledKey = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.hwKeysHandleKeyUIEvent(_:)))
    let originalSend = class_getInstanceMethod(UIApplication.self, sendSelector)
    let swizzledSend = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.hwKeysSendEvent(_:)))

    if let originalKey, let swizzledKey {
      method_exchangeImplementations(originalKey, swizzledKey)
    }
    if let originalSend, let swizzledSend {
      method_exchangeImplementations(originalSend, swizzledSend)
    }
    installStatus = "handleKey=\(originalKey != nil)/\(swizzledKey != nil) send=\(originalSend != nil)/\(swizzledSend != nil)"
    debug("install", ["status": installStatus])
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

  /// The mode decides what is taken; everything else goes on to the field.
  static func intercept(code: Int, modifiers: UIKeyModifierFlags, keyDown: Bool) -> Bool {
    guard mode != "off" else { return false }
    guard keyDown else { return false }
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

  static func emit(code: Int, modifiers: UIKeyModifierFlags, characters: String, baseCharacter: String) {
    module?.sendEvent("onKey", [
      "platform": "ios",
      "keyCode": code,
      "character": characters,
      "baseCharacter": baseCharacter,
      "shiftKey": modifiers.contains(.shift),
      "ctrlKey": modifiers.contains(.control),
      "altKey": modifiers.contains(.alternate),
      "metaKey": modifiers.contains(.command),
      "repeat": false,
    ])
  }

  /// KVC only where the selector exists — `value(forKey:)` raises for a key the object lacks.
  static func value(_ object: NSObject, _ key: String) -> Any? {
    let selector = NSSelectorFromString(key)
    guard object.responds(to: selector) else { return nil }
    return object.value(forKey: key)
  }

  static func isKeyDown(_ event: UIEvent) -> Bool {
    if let number = value(event, "_isKeyDown") as? NSNumber {
      return number.boolValue
    }
    if let presses = event as? UIPressesEvent {
      for press in presses.allPresses {
        switch press.phase {
        case .began, .changed: return true
        case .ended, .cancelled, .stationary: return false
        @unknown default: break
        }
      }
    }
    return true
  }

  static func phaseName(_ phase: UIPress.Phase) -> String {
    switch phase {
    case .began: return "began"
    case .changed: return "changed"
    case .stationary: return "stationary"
    case .ended: return "ended"
    case .cancelled: return "cancelled"
    @unknown default: return "unknown"
    }
  }

  static func describe(_ event: UIEvent) -> [String: Any?] {
    var info: [String: Any?] = [
      "class": NSStringFromClass(type(of: event)),
      "type": event.type.rawValue,
      "presses": (event as? UIPressesEvent)?.allPresses.count ?? -1,
    ]
    for key in ["_isKeyDown", "_keyCode", "_modifierFlags", "_gsModifierFlags", "_modifiedInput", "_unmodifiedInput", "_inputFlags"] {
      info[key] = value(event, key) ?? "absent"
    }
    if let presses = event as? UIPressesEvent {
      var keys: [[String: Any?]] = []
      for press in presses.allPresses {
        var entry: [String: Any?] = ["phase": phaseName(press.phase)]
        if let key = press.key {
          entry["code"] = Int(key.keyCode.rawValue)
          entry["chars"] = key.characters
          entry["base"] = key.charactersIgnoringModifiers
          entry["mods"] = Int(key.modifierFlags.rawValue)
        } else {
          entry["key"] = "nil"
        }
        keys.append(entry)
      }
      info["keys"] = keys
    }
    return info
  }
}

private extension UIApplication {
  @objc func hwKeysHandleKeyUIEvent(_ event: UIEvent) {
    KeyTap.debug("handleKey", KeyTap.describe(event))
    let down = KeyTap.isKeyDown(event)
    if let presses = event as? UIPressesEvent {
      for press in presses.allPresses {
        guard let key = press.key else { continue }
        let code = Int(key.keyCode.rawValue)
        if KeyTap.intercept(code: code, modifiers: key.modifierFlags, keyDown: down) {
          KeyTap.emit(code: code, modifiers: key.modifierFlags, characters: key.characters, baseCharacter: key.charactersIgnoringModifiers)
          return // consumed: the field never sees it
        }
      }
    }
    // Fallback: the private surface React Native and WebKit read, in case `allPresses` is empty.
    if let number = KeyTap.value(event, "_keyCode") as? NSNumber {
      let code = number.intValue
      let rawModifiers = (KeyTap.value(event, "_modifierFlags") as? NSNumber)?.intValue ?? 0
      let modifiers = UIKeyModifierFlags(rawValue: max(0, rawModifiers))
      let characters = KeyTap.value(event, "_modifiedInput") as? String ?? ""
      let base = KeyTap.value(event, "_unmodifiedInput") as? String ?? ""
      if KeyTap.intercept(code: code, modifiers: modifiers, keyDown: down) {
        KeyTap.emit(code: code, modifiers: modifiers, characters: characters, baseCharacter: base)
        return
      }
    }
    hwKeysHandleKeyUIEvent(event) // the original, after the swap
  }

  @objc func hwKeysSendEvent(_ event: UIEvent) {
    if event.type == .presses || NSStringFromClass(type(of: event)).contains("Keyboard") {
      KeyTap.debug("sendEvent", KeyTap.describe(event))
    }
    hwKeysSendEvent(event) // the original, after the swap
  }
}
