import Crypto
import ExpoModulesCore
import Foundation

/// One connection per app, so the session is module state rather than a shared object.
///
/// Shell bytes cross as base64 in the `onShellData` direction and as a plain string in the `send`
/// direction: output can split a UTF-8 sequence across two channel reads, so it stays bytes until
/// the emulator's decoder sees it, while input is always text the user or the key bar produced.
public class ExpoSSHModule: Module {
  private let session = SSHSession()

  public func definition() -> ModuleDefinition {
    Name("ExpoSSH")

    Events("onHostKey", "onShellData", "onShellClose")

    // Emits `onHostKey` mid-handshake and blocks until JS calls `verifyHostKey`.
    AsyncFunction("connect") { (host: String, port: Int, username: String, seedBase64: String) in
      guard let seed = Data(base64Encoded: seedBase64) else {
        throw SSHSession.Failure.badPayload
      }
      let session = self.session
      try await session.connect(host: host, port: port, username: username, seed: seed) {
        [weak self] hostKey in
        guard let self else { return false }
        self.sendEvent("onHostKey", [
          "key": hostKey.base64EncodedString(),
          "fingerprint": Self.fingerprint(hostKey),
        ])
        return await session.awaitHostKeyDecision()
      }
    }

    AsyncFunction("verifyHostKey") { (accept: Bool) in
      await self.session.resolveHostKey(accept)
    }

    // Connectionless (T16): the key screen imports before there is ever a session, so this is a
    // static call on the session type rather than something the actor's state takes part in.
    AsyncFunction("importPrivateKey") { (text: String, passphrase: String?) -> String in
      try SSHSession.importSeed(text, passphrase: passphrase).base64EncodedString()
    }

    AsyncFunction("disconnect") {
      await self.session.disconnect()
    }

    AsyncFunction("isAlive") { (timeoutMs: Int) -> Bool in
      await self.session.isAlive(timeout: .milliseconds(timeoutMs))
    }

    AsyncFunction("startShell") { (cols: Int, rows: Int, term: String) in
      let stream = try await self.session.requestPTY(cols: cols, rows: rows, term: term)
      Task { [weak self] in
        for await chunk in stream {
          self?.sendEvent("onShellData", ["data": Data(chunk).base64EncodedString()])
        }
        self?.sendEvent("onShellClose", [:])
      }
    }

    AsyncFunction("send") { (text: String) in
      try await self.session.send(text)
    }

    AsyncFunction("resize") { (cols: Int, rows: Int) in
      try await self.session.resize(cols: cols, rows: rows)
    }

    AsyncFunction("exec") { (command: String, limit: Int) -> String in
      try await self.session.run(command, limit: limit)
    }

    AsyncFunction("upload") { (dataBase64: String, path: String, directories: [String]) in
      guard let data = Data(base64Encoded: dataBase64) else {
        throw SSHSession.Failure.badPayload
      }
      try await self.session.upload([UInt8](data), to: path, creating: directories)
    }

    AsyncFunction("listDirectory") { (path: String) -> [[String: Any]] in
      try await self.session.listDirectory(path).map {
        ["name": $0.name, "isDirectory": $0.isDirectory, "size": $0.size]
      }
    }
  }

  /// The `SHA256:…` half of what OpenSSH prints — base64 of the digest, unpadded.
  private static func fingerprint(_ hostKey: Data) -> String {
    let digest = Data(SHA256.hash(data: hostKey)).base64EncodedString()
    return "SHA256:" + digest.replacingOccurrences(of: "=", with: "")
  }
}
