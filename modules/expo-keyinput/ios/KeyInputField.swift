import UIKit

/// The hidden field that owns the keyboard, and the reason this module is native at all.
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
/// RN field needed to keep delete's auto-repeat alive. And `insertText`/`deleteBackward` report
/// what was typed directly, so nothing has to be recovered by diffing two states of a text box.
final class KeyInputField: UITextField {
  var onText: ((String) -> Void)?
  var onDelete: (() -> Void)?
  /// `dx` is points travelled since the drag began, positive to the right.
  var onCursor: ((CGFloat, String) -> Void)?

  /// iOS gates the delete key's auto-repeat on the first responder's `hasText`, and a terminal's
  /// field is empty even when the *line* is not. Always true, so the repeat never stops early.
  override var hasText: Bool { true }

  override func insertText(_ text: String) {
    onText?(text)
  }

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
