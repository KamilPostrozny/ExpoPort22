import ExpoModulesCore
import UIKit
import WebKit

/**
 * The one thing neither the page nor React Native can decide for this app: while the key bar's
 * field holds the keyboard, a tap in the terminal must stay a click the pane gets and the keys
 * must stay up (the iOS build's behaviour, user 2026-09-14: tap-to-hide is gone entirely).
 *
 * Package check (AGENTS.md): nothing on the SDK or npm side reaches this. The dismiss is not in
 * React Native (no auto-resign on outside touch), not in react-native-keyboard-controller (no
 * touch gesture), and not in the page (xterm's helper textarea is disabled, and WebKit's own
 * gesture for tap-dismiss, bugs.webkit 277551, sits behind an internal setting this app cannot
 * set). It is WebKit itself: a touch in WKWebView content makes its internal view become first
 * responder so key events route to the page, and the keyboard goes with it — which the
 * `onHide` trace in `keybar.tsx` measured on device as a hide with NO blur and no
 * `Keyboard.dismiss` anywhere in the tree. The only lever left is the responder chain, and the
 * chain is UIKit's.
 *
 * So: a swizzle of `-[UIResponder becomeFirstResponder]` that refuses the become while the bar
 * holds the keys and the responder would land inside a WKWebView. Everything else passes
 * through untouched, and with the guard disarmed (keys down) WebKit behaves exactly as before —
 * long-press selection, tap routing, everything the page measured.
 */
public class ExpoWebGuardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoWebGuard")

    OnCreate {
      Guard.install()
    }

    /** While true, no view inside a WKWebView may become first responder. */
    AsyncFunction("setHold") { (hold: Bool) in
      Guard.hold = hold
    }
  }
}

private final class Guard {
  static var hold = false
  private static var installed = false

  static func install() {
    guard !installed else { return }
    installed = true
    guard
      let original = class_getInstanceMethod(UIResponder.self, #selector(UIResponder.becomeFirstResponder)),
      let swizzled = class_getInstanceMethod(UIResponder.self, #selector(UIResponder.wgBecomeFirstResponder))
    else { return }
    method_exchangeImplementations(original, swizzled)
  }
}

private extension UIResponder {
  @objc func wgBecomeFirstResponder() -> Bool {
    if Guard.hold, let view = self as? UIView, view.isInsideWebView {
      NSLog("[webguard] blocked becomeFirstResponder on \(type(of: view)) while the bar holds the keys")
      return false
    }
    return wgBecomeFirstResponder() // the original, after the swap
  }

  /** Up the chain, so it holds across WebKit's internal renames — `WKWebView` is public and stable. */
  var isInsideWebView: Bool {
    var node: UIView? = self as? UIView
    var depth = 0
    while let view = node, depth < 40 {
      if view is WKWebView { return true }
      node = view.superview
      depth += 1
    }
    return false
  }
}
