package expo.modules.webguard

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of the responder guard — see the iOS file for why this module exists. Android's
 * focused EditText survives an outside touch and never blurs on it (measured, and the reason
 * `keybar.tsx` needs no re-aim there), so there is nothing to guard: the flag is accepted and
 * dropped.
 */
class ExpoWebGuardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoWebGuard")

    AsyncFunction("setHold") { (_: Boolean) -> {} }
  }
}
