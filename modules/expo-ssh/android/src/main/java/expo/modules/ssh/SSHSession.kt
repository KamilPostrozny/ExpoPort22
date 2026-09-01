package expo.modules.ssh

import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.Ed25519KeyFactory
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.sftp.FileAttributes
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.KeyPair
import java.security.PublicKey
import java.security.Security
import java.util.EnumSet
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The sshj wrapper: connect, ed25519 auth, one PTY, short-lived exec channels, SFTP. The same
 * behavioural contract as `ios/SSHSession.swift`; nothing above this sees an sshj type.
 *
 * Library choice (AGENTS.md: name what you looked at) — **sshj 0.40.0** over Apache MINA
 * sshd-client, both read at source before deciding:
 * - sshj covers every requirement in-tree, verified at tag v0.40.0: `HostKeyVerifier.verify` is a
 *   synchronous boolean callback we can block until JS answers the TOFU prompt;
 *   `Ed25519KeyFactory.getPrivateKey` takes exactly our raw 32-byte seed;
 *   `SessionChannel` has `allocatePTY(term, cols, rows, …)`, `startShell`,
 *   `changeWindowDimensions` and `exec` with an exit status; `SFTPEngine.makeDir(path, attrs)`
 *   takes the 0700 mode that `SFTPClient.mkdir` drops; `RemoteFile.write` writes bytes at an
 *   offset; `RemoteResourceInfo` carries name/type/size.
 * - MINA sshd covers the list too, but as an async server+client framework — its own IO reactor,
 *   futures graph, a multi-artifact split, and ed25519 only through *optional* dependencies
 *   (docs/dependencies.md at sshd-2.15.0). A lot of machinery for one blocking connection per
 *   app. sshj is client-only, blocking and small; sshj's own test suite runs MINA as the
 *   throwaway server.
 */
class SSHSession {
  companion object {
    init {
      // Android registers a stripped BouncyCastle under the same "BC" name (no Ed25519
      // KeyFactory), and sshj's SecurityUtils resolves algorithms through that name. Swap in the
      // full bcprov this module bundles; appended last, so nothing else's provider order moves.
      if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)?.javaClass != BouncyCastleProvider::class.java) {
        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
        Security.addProvider(BouncyCastleProvider())
      }
    }
  }

  data class RemoteEntry(val name: String, val isDirectory: Boolean, val size: Double)

  @Volatile private var client: SSHClient? = null
  @Volatile private var shellSession: Session? = null
  @Volatile private var shell: Session.Shell? = null

  private val hostKeyLock = Object()
  private var hostKeyAnswer: Boolean? = null

  /** `onHostKey` receives the host key in SSH wire format — the bytes the JS side fingerprints
   *  and pins. It fires on sshj's transport thread mid-handshake, and the handshake then blocks
   *  in [awaitHostKeyDecision] until [resolveHostKey] answers — that block is what holds the
   *  connection open while a human reads the fingerprint. */
  fun connect(host: String, port: Int, username: String, seed: ByteArray, onHostKey: (ByteArray) -> Unit) {
    synchronized(hostKeyLock) { hostKeyAnswer = null }
    val keyPair = keyPairFromSeed(seed)
    val client = SSHClient(DefaultConfig())
    client.addHostKeyVerifier(object : HostKeyVerifier {
      override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        onHostKey(Buffer.PlainBuffer().putPublicKey(key).compactData)
        return awaitHostKeyDecision()
      }

      override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
    })
    try {
      client.connect(host, port)
      client.authPublickey(username, KeyPairWrapper(keyPair))
    } catch (failure: Exception) {
      runCatching { client.disconnect() }
      throw failure
    }
    this.client = client
  }

  /** sshj's own factory wraps a 32-byte seed into the PKCS#8 form the JCA wants; the public half
   *  comes from BouncyCastle's lightweight curve math, which bcprov already ships. */
  private fun keyPairFromSeed(seed: ByteArray): KeyPair {
    val publicKey = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    return KeyPair(Ed25519KeyFactory.getPublicKey(publicKey), Ed25519KeyFactory.getPrivateKey(seed))
  }

  // MARK: - Host key answer

  /** The answer can beat the question: a pinned key is matched in JS the moment `onHostKey`
   *  lands, which can be before the verifier blocks here. So an early answer is kept, not
   *  dropped — same contract as the iOS actor. */
  private fun awaitHostKeyDecision(): Boolean {
    synchronized(hostKeyLock) {
      try {
        while (hostKeyAnswer == null) hostKeyLock.wait()
      } catch (_: InterruptedException) {
        return false
      }
      val answer = hostKeyAnswer == true
      hostKeyAnswer = null
      return answer
    }
  }

  fun resolveHostKey(accept: Boolean) {
    synchronized(hostKeyLock) {
      hostKeyAnswer = accept
      hostKeyLock.notifyAll()
    }
  }

  // MARK: - PTY

  /** Opens the one PTY this app ever needs. Output lands in [onData] until the channel dies,
   *  then [onClose] fires once — remote hangup and our own [disconnect] look the same. */
  fun startShell(cols: Int, rows: Int, term: String, onData: (ByteArray) -> Unit, onClose: () -> Unit) {
    val client = client ?: throw IllegalStateException("Not connected")
    val session = client.startSession()
    session.allocatePTY(term, cols, rows, 0, 0, emptyMap())
    val shell = session.startShell()
    shellSession = session
    this.shell = shell
    // With a PTY there is no separate stderr; everything the remote prints is on this one stream.
    thread(name = "expo-ssh-shell", isDaemon = true) {
      val input = shell.inputStream
      val chunk = ByteArray(32 * 1024)
      try {
        while (true) {
          val read = input.read(chunk)
          if (read < 0) break
          if (read > 0) onData(chunk.copyOf(read))
        }
      } catch (_: IOException) {
        // A dead channel is a finished stream; the JS reconnect state machine decides what next.
      }
      onClose()
    }
  }

  fun send(text: String) {
    val shell = shell ?: throw IllegalStateException("Not connected")
    val output = shell.outputStream
    output.write(text.toByteArray(Charsets.UTF_8))
    output.flush() // ChannelOutputStream buffers until flushed
  }

  fun resize(cols: Int, rows: Int) {
    val shell = shell ?: throw IllegalStateException("Not connected")
    shell.changeWindowDimensions(cols, rows, 0, 0)
  }

  // MARK: - Exec

  /** Runs one command on its own short-lived exec channel and returns what it printed.
   *
   *  Nothing here touches the PTY: the tmux side-channel commands must not reach the attached
   *  shell, which would echo them into the grid the user is looking at. Capped, because
   *  `capture-pane` on a pane with a long line is unbounded otherwise. A non-zero exit throws,
   *  like Citadel's `executeCommand` on iOS — the callers treat that the same as empty output. */
  fun exec(command: String, limit: Int): String {
    val client = client ?: throw IllegalStateException("Not connected")
    client.startSession().use { session ->
      val channel = session.exec(command)
      val output = readCapped(channel.inputStream, limit)
      channel.join()
      val status = channel.exitStatus
      if (status != null && status != 0) throw IOException("Command exited $status")
      return String(output, Charsets.UTF_8)
    }
  }

  private fun readCapped(input: InputStream, limit: Int): ByteArray {
    val collected = ByteArrayOutputStream()
    val chunk = ByteArray(8 * 1024)
    while (true) {
      val read = input.read(chunk)
      if (read < 0) break
      // Past the cap the stream still drains, so the channel closes and hands over the exit code.
      val keep = minOf(read, limit - collected.size())
      if (keep > 0) collected.write(chunk, 0, keep)
    }
    return collected.toByteArray()
  }

  /** Whether the far end is still there — asked, not assumed. `isConnected` is local channel
   *  state, so a half-open TCP (phone slept, Wi-Fi roamed, no FIN ever arrives) reads healthy
   *  forever. A round trip is the only test a half-open socket cannot fake: it swallows the
   *  request and says nothing, and saying nothing is the answer. */
  fun isAlive(timeoutMs: Long): Boolean {
    if (client?.isConnected != true) return false
    // ponytail: a timed-out probe leaves its pool thread blocked until the connection dies —
    // same as the iOS raced task; a cancellable channel would be the upgrade if it ever matters.
    val roundTrip = CompletableFuture.supplyAsync { runCatching { exec("true", 64) }.isSuccess }
    return try {
      roundTrip.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      false
    }
  }

  // MARK: - SFTP

  /** One file onto the host over the connection's SFTP subsystem. Off the PTY, like [exec]:
   *  nothing here is echoed into the grid.
   *
   *  `directories` is the mkdir chain for the path, shallowest first — SFTP mkdir has no `-p`.
   *  Each level is tried and ignored: it fails whenever it is already there, and SFTP has no test
   *  that is cheaper than trying. `SFTPClient.mkdir` drops the mode, hence the engine call. */
  fun upload(data: ByteArray, path: String, directories: List<String>) {
    val client = client ?: throw IllegalStateException("Not connected")
    client.newSFTPClient().use { sftp ->
      val mode = FileAttributes.Builder().withPermissions(448).build() // 0700
      for (directory in directories) {
        runCatching { sftp.sftpEngine.makeDir(directory, mode) }
      }
      sftp.open(path, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC)).use { file ->
        // One WRITE packet per call — sshj's RemoteFile.write does not chunk, so we do, at the
        // 32 KB every server accepts.
        var offset = 0
        while (offset < data.size) {
          val length = minOf(32 * 1024, data.size - offset)
          file.write(offset.toLong(), data, offset, length)
          offset += length
        }
      }
    }
  }

  /** The listing behind the upload destination browser. Read-only: this module never removes or
   *  downloads anything. sshj keys `isDirectory` off the readdir attributes and never exposes
   *  `longname`, so the iOS fallback for servers that omit attributes has no equivalent here. */
  fun listDirectory(path: String): List<RemoteEntry> {
    val client = client ?: throw IllegalStateException("Not connected")
    client.newSFTPClient().use { sftp ->
      return sftp.ls(path).map {
        RemoteEntry(it.name, it.isDirectory, it.attributes.size.toDouble())
      }
    }
  }

  // MARK: - Teardown

  fun disconnect() {
    resolveHostKey(false) // unblocks a handshake still waiting on the prompt
    runCatching { shellSession?.close() }
    runCatching { client?.disconnect() }
    shell = null
    shellSession = null
    client = null
  }
}
