import UIKit

/// The hidden field that owns the keyboard, and the reason this module is native at all.
///
/// It lives in the SSH pod, which is not where it belongs and is not a choice. A second pod
/// alongside this one damages the generated Pods project — xcodebuild dies loading an
/// `XCSwiftPackageProductDependency`, the object CocoaPods writes for `ExpoSSH.podspec`'s Citadel
/// Swift package, and every module map in the build then goes missing. Measured, not assumed: the
/// commit before this one built green, adding an empty-but-for-this pod failed on Xcode 26.6 and
/// 26.5 alike, and stripping that podspec to nothing (no `static_framework`, no `DEFINES_MODULE`)
/// failed the same way. So the app has one pod and this shares it.
///
/// The ladder in AGENTS.md was walked before writing it. `TextInput` was the keyboard owner up to
/// here and does everything except the one thing this exists for: iOS's hold-space trackpad. React
/// Native surfaces no floating-cursor API — `FloatingCursor` appears nowhere in `react-native` or
/// `@expo/*` — and there is no maintained package for it either; what exists under that name is
/// floating *label* inputs, a different thing. The only seam RN does expose, `onSelectionChange`,
/// was built on first (it is still the Android path, where Gboard's spacebar slide arrives as an
/// `InputConnection.setSelection` and nothing else) and it cannot be made to feel right on iOS:
/// the caret is parked at a document edge on grab and again on release, it chatters between
/// neighbours when the finger hovers on a boundary, and `setSelection` is ignored while the
/// floating cursor is live, so none of that can be corrected from JS. See T12 in TESTS.md.
///
/// `UITextInput`'s floating-cursor methods are the API iOS actually provides for this: they hand a
/// first responder the drag in **points**, with no caret and no text positions involved. That is
/// what a terminal wants — points divided by the cell width are columns.
///
/// Two other hacks fall out of owning the field. `hasText` is `true` outright, which is how the
/// reference app does it (Port22's TerminalHostView.swift:226) and retires the 512-space pad the
/// RN field needed to keep delete's auto-repeat alive — device log: a held backspace repeats every
/// ~150ms indefinitely against a field holding nothing. And keys are reported as they are struck,
/// so nothing has to be recovered by diffing two states of a text box.
final class KeyInputField: UITextField {
  /// Overriding `insertText` was the first attempt and it never fired once: a UITextField does its
  /// editing through an internal field editor rather than by calling its own `insertText`, so the
  /// keyboard came up on device and not a keystroke reached JS. Everything arrives by the delegate
  /// below instead, which is the path UIKit always offers an insertion to. Both were carried for
  /// one build with a tag saying which fired; every key came back `delegate`, so the other went —
  /// along with the same-string guard that had deduplicated them, which would have swallowed the
  /// second `l` of `hello` typed inside 50ms.
  var onText: ((String) -> Void)?
  var onDelete: (() -> Void)?
  /// `dx` is points travelled since the drag began, positive to the right.
  var onCursor: ((CGFloat, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("KeyInputField is created in code, never from a nib")
  }

  /// iOS gates the delete key's auto-repeat on the first responder's `hasText`, and a terminal's
  /// field is empty even when the *line* is not. Always true, so the repeat never stops early.
  override var hasText: Bool { true }

  override func deleteBackward() {
    onDelete?()
  }

  /* --- the hold-space trackpad --- */

  private var origin: CGPoint = .zero

  override func beginFloatingCursor(at point: CGPoint) {
    origin = point
    onCursor?(0, "begin")
  }

  override func updateFloatingCursor(at point: CGPoint) {
    onCursor?(point.x - origin.x, "move")
  }

  override func endFloatingCursor() {
    onCursor?(0, "end")
  }

  /// Nothing may draw, select, or offer a menu here: the field is a keyboard, not a text box.
  override func caretRect(for position: UITextPosition) -> CGRect { .zero }
  override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
}

/// The path UIKit always takes for a UITextField, and the one that actually fires: every insertion
/// the keyboard makes is offered here first. The answer is always `false` — the field holds no
/// text, it only reports what was aimed at it — so the caret never moves and nothing accumulates.
///
/// Deletes are not read from here. An empty replacement is a backspace, but a *held* backspace
/// repeats against a field with nothing left in it, and UIKit stops offering the change once there
/// is nothing to change; `deleteBackward` keeps being called either way, so that is where deletes
/// come from and this ignores them rather than counting them twice.
extension KeyInputField: UITextFieldDelegate {
  func textField(
    _ textField: UITextField,
    shouldChangeCharactersIn range: NSRange,
    replacementString string: String
  ) -> Bool {
    if !string.isEmpty { onText?(string) }
    return false
  }

  /// Return sends, and never dismisses the keyboard — the terminal is still there to type at.
  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    onText?("\n")
    return false
  }
}
