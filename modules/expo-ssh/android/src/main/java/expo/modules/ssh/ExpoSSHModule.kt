package expo.modules.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Placeholder. T3 fills this in with sshj against the API the iOS module fixed
 * (see `../../../../../../src/ExpoSSHModule.ts`); until then every call fails as unimplemented,
 * which is what an empty definition already does.
 */
class ExpoSSHModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoSSH")

    Events("onHostKey", "onShellData", "onShellClose")
  }
}
