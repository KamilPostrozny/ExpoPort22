package expo.modules.ssh

import android.util.Base64
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/**
 * One connection per app, so the session is module state rather than a shared object. The API —
 * names, arguments, event payloads — is fixed by the iOS module (`../../ios/ExpoSSHModule.swift`)
 * and `src/ExpoSSHModule.ts`; this file only translates it into Kotlin.
 *
 * Every sshj call blocks, and suspend bodies run on the module queue's single thread — so all
 * session work moves to `Dispatchers.IO`. Not optional: `connect` blocks on the host-key answer
 * that `verifyHostKey` delivers, and on one thread that would deadlock the handshake.
 *
 * Shell bytes cross as base64 in the `onShellData` direction and as a plain string in the `send`
 * direction: output can split a UTF-8 sequence across two channel reads, so it stays bytes until
 * the emulator's decoder sees it, while input is always text the user or the key bar produced.
 */
class ExpoSSHModule : Module() {
  private val session = SSHSession()

  override fun definition() = ModuleDefinition {
    Name("ExpoSSH")

    Events("onHostKey", "onShellData", "onShellClose")

    // Emits `onHostKey` mid-handshake and blocks until JS calls `verifyHostKey`.
    AsyncFunction("connect") Coroutine { host: String, port: Int, username: String, seedBase64: String ->
      val seed = Base64.decode(seedBase64, Base64.DEFAULT)
      withContext(Dispatchers.IO) {
        session.connect(host, port, username, seed) { hostKey ->
          sendEvent(
            "onHostKey",
            mapOf(
              "key" to Base64.encodeToString(hostKey, Base64.NO_WRAP),
              "fingerprint" to fingerprint(hostKey),
            ),
          )
        }
      }
    }

    AsyncFunction("verifyHostKey") { accept: Boolean ->
      session.resolveHostKey(accept)
    }

    // Connectionless (T16): the key screen imports before there is ever a session, so this is a
    // companion call rather than session state. Still on `Dispatchers.IO` — bcrypt-pbkdf on an
    // encrypted key is deliberately slow, and the module queue is one thread.
    AsyncFunction("importPrivateKey") Coroutine { text: String, passphrase: String? ->
      withContext(Dispatchers.IO) {
        Base64.encodeToString(SSHSession.importSeed(text, passphrase), Base64.NO_WRAP)
      }
    }

    AsyncFunction("disconnect") Coroutine { ->
      withContext(Dispatchers.IO) { session.disconnect() }
    }

    AsyncFunction("isAlive") Coroutine { timeoutMs: Int ->
      withContext(Dispatchers.IO) { session.isAlive(timeoutMs.toLong()) }
    }

    AsyncFunction("startShell") Coroutine { cols: Int, rows: Int, term: String ->
      withContext(Dispatchers.IO) {
        session.startShell(
          cols,
          rows,
          term,
          onData = { chunk ->
            sendEvent("onShellData", mapOf("data" to Base64.encodeToString(chunk, Base64.NO_WRAP)))
          },
          onClose = { sendEvent("onShellClose") },
        )
      }
    }

    AsyncFunction("send") Coroutine { text: String ->
      withContext(Dispatchers.IO) { session.send(text) }
    }

    AsyncFunction("resize") Coroutine { cols: Int, rows: Int ->
      withContext(Dispatchers.IO) { session.resize(cols, rows) }
    }

    AsyncFunction("exec") Coroutine { command: String, limit: Int ->
      withContext(Dispatchers.IO) { session.exec(command, limit) }
    }

    AsyncFunction("upload") Coroutine { dataBase64: String, path: String, directories: List<String> ->
      val data = Base64.decode(dataBase64, Base64.DEFAULT)
      withContext(Dispatchers.IO) { session.upload(data, path, directories) }
    }

    AsyncFunction("listDirectory") Coroutine { path: String ->
      withContext(Dispatchers.IO) {
        session.listDirectory(path).map {
          mapOf("name" to it.name, "isDirectory" to it.isDirectory, "size" to it.size)
        }
      }
    }
  }

  /** The `SHA256:…` half of what OpenSSH prints — base64 of the digest, unpadded. Must match the
   *  iOS module byte for byte: the JS side compares and pins these. */
  private fun fingerprint(hostKey: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(hostKey)
    return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
  }
}
