import ExpoModulesCore
import UIKit

/// The view that holds `KeyInputField`. Invisible and untouchable — focus is asked for, never
/// tapped for — so it carries no layout of its own beyond the frame Yoga gives it.
final class ExpoKeyInputView: ExpoView {
  let onKey = EventDispatcher()
  let onCursor = EventDispatcher()

  private let field = KeyInputField()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false // the keys of the bar are under it; focus comes from JS

    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartDashesType = .no
    field.smartQuotesType = .no
    field.smartInsertDeleteType = .no
    field.keyboardType = .asciiCapable
    field.returnKeyType = .default
    field.alpha = 0
    field.frame = bounds
    field.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(field)

    field.onText = { [weak self] text in
      // Return arrives here as a newline; the PTY wants a carriage return.
      self?.onKey(["text": text == "\n" ? "\r" : text])
    }
    field.onDelete = { [weak self] in
      self?.onKey(["delete": true])
    }
    field.onCursor = { [weak self] dx, phase in
      self?.onCursor(["dx": dx, "phase": phase])
    }
  }

  func setKeyboardAppearance(dark: Bool) {
    field.keyboardAppearance = dark ? .dark : .light
    if field.isFirstResponder { field.reloadInputViews() }
  }

  func focusField() {
    field.becomeFirstResponder()
  }

  func blurField() {
    field.resignFirstResponder()
  }
}

/// §4.2's keyboard owner on iOS. Android keeps React Native's `TextInput`: its keyboards move the
/// cursor by setting the selection, which RN already reports, and no floating-cursor API exists
/// there to match this one.
public class ExpoKeyInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoKeyInput")

    View(ExpoKeyInputView.self) {
      Events("onKey", "onCursor")

      Prop("keyboardAppearance") { (view: ExpoKeyInputView, dark: Bool) in
        view.setKeyboardAppearance(dark: dark)
      }

      AsyncFunction("focus") { (view: ExpoKeyInputView) in
        view.focusField()
      }

      AsyncFunction("blur") { (view: ExpoKeyInputView) in
        view.blurField()
      }
    }
  }
}
