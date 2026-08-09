// Curve25519.Signing.PrivateKey is not Sendable, and Citadel's auth method is a @Sendable closure.
@preconcurrency import Crypto
import Foundation
// Citadel's own dependency — `withSFTP` takes a Logger, and the default one prints the paths it opens.
import Logging
import NIOCore
import NIOSSH

// Citadel's TTYStdinWriter and TTYOutput predate strict concurrency and are not marked Sendable.
@preconcurrency import Citadel

/// The Citadel wrapper: connect, ed25519 auth, one PTY, short-lived exec channels, SFTP.
/// Ported from the reference app's `Port22Core/SSHSession.swift`; nothing above this sees a NIO type.
actor SSHSession {
  enum Failure: Error {
    case notConnected
    case hostKeyRejected
    case badPayload
  }

  struct RemoteEntry: Sendable {
    let name: String
    let isDirectory: Bool
    let size: Int
  }

  private var client: SSHClient?
  private var writer: TTYStdinWriter?
  private var ptyTask: Task<Void, Never>?
  private var ptyWaiters: [CheckedContinuation<Void, Never>] = []
  private var hostKeyWaiter: CheckedContinuation<Bool, Never>?
  private var hostKeyAnswer: Bool?

  /// `verify` receives the host key in SSH wire format — the bytes the JS side fingerprints and pins.
  /// Returning false aborts the handshake. It is async because the answer may be a human tapping
  /// Trust, and the handshake has to wait for that without parking an event loop thread.
  func connect(
    host: String,
    port: Int,
    username: String,
    seed: Data,
    verify: @escaping @Sendable (Data) async -> Bool
  ) async throws {
    let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    hostKeyAnswer = nil
    client = try await SSHClient.connect(
      to: SSHClientSettings(
        host: host,
        port: port,
        authenticationMethod: { .ed25519(username: username, privateKey: privateKey) },
        hostKeyValidator: .custom(HostKeyCallback(verify: verify))
      )
    )
  }

  // MARK: - Host key answer

  /// The answer can beat the question: a pinned key is matched in JS the moment `onHostKey` lands,
  /// which can be before the handshake gets here. So an early answer is kept rather than dropped.
  func awaitHostKeyDecision() async -> Bool {
    if let answer = hostKeyAnswer {
      hostKeyAnswer = nil
      return answer
    }
    return await withCheckedContinuation { hostKeyWaiter = $0 }
  }

  func resolveHostKey(_ accept: Bool) {
    guard let waiter = hostKeyWaiter else {
      hostKeyAnswer = accept
      return
    }
    hostKeyWaiter = nil
    waiter.resume(returning: accept)
  }

  // MARK: - PTY

  /// Opens the one PTY this app ever needs and streams its output. The stream finishes when the
  /// remote side closes the channel or `disconnect()` runs.
  func requestPTY(cols: Int, rows: Int, term: String) async throws -> AsyncStream<[UInt8]> {
    guard let client else { throw Failure.notConnected }

    let request = SSHChannelRequestEvent.PseudoTerminalRequest(
      wantReply: true,
      term: term,
      terminalCharacterWidth: cols,
      terminalRowHeight: rows,
      terminalPixelWidth: 0,
      terminalPixelHeight: 0,
      terminalModes: SSHTerminalModes([:])
    )

    let (stream, continuation) = AsyncStream<[UInt8]>.makeStream()

    // Citadel scopes a PTY to a closure, so the closure stays parked for the life of the session.
    // The writer it hands out is stashed on the actor; the task ends when the channel does.
    ptyTask = Task { [weak self] in
      do {
        try await client.withPTY(request) { inbound, outbound in
          await self?.ptyOpened(outbound)
          for try await output in inbound {
            switch output {
            case .stdout(let buffer), .stderr(let buffer):
              continuation.yield(Array(buffer.readableBytesView))
            }
          }
        }
      } catch {
        // A dead channel is a finished stream; the JS reconnect state machine decides what next.
      }
      continuation.finish()
      await self?.ptyClosed()
    }

    await waitForPTY()
    guard writer != nil else { throw Failure.notConnected }
    return stream
  }

  func send(_ text: String) async throws {
    guard let writer else { throw Failure.notConnected }
    try await writer.write(ByteBuffer(string: text))
  }

  func resize(cols: Int, rows: Int) async throws {
    guard let writer else { throw Failure.notConnected }
    try await writer.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
  }

  // MARK: - Exec

  /// Runs one command on its own short-lived exec channel and returns what it printed.
  ///
  /// Nothing here touches the PTY: the tmux side-channel commands must not reach the attached
  /// shell, which would echo them into the grid the user is looking at. Capped, because
  /// `capture-pane` on a pane with a long line is unbounded otherwise.
  func run(_ command: String, limit: Int) async throws -> String {
    guard let client else { throw Failure.notConnected }
    let output = try await client.executeCommand(command, maxResponseSize: limit)
    return String(decoding: output.readableBytesView, as: UTF8.self)
  }

  /// Whether the far end is still there — asked, not assumed. Citadel's `isConnected` is local
  /// channel state, so a half-open TCP (phone slept, Wi-Fi roamed, no FIN ever arrives) reads
  /// healthy forever. A round trip is the only test a half-open socket cannot fake: it swallows
  /// the request and says nothing, and saying nothing is the answer.
  func isAlive(timeout: Duration) async -> Bool {
    guard client != nil else { return false }
    return await withTaskGroup(of: Bool.self) { group in
      group.addTask { (try? await self.run("true", limit: 64)) != nil }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return false
      }
      let answered = await group.next() ?? false
      group.cancelAll()
      return answered
    }
  }

  // MARK: - SFTP

  /// One file onto the host over the connection's SFTP subsystem. Off the PTY, like `run`: nothing
  /// here is echoed into the grid. An exec channel could not do this at all — `executeCommandStream`
  /// exposes stdout and stderr only, so there is no stdin to pipe the bytes into.
  ///
  /// `directories` is the mkdir chain for the path, shallowest first — SFTP mkdir has no `-p`. Each
  /// one is tried and ignored: it fails whenever the level is already there, and SFTP has no test
  /// that is cheaper than trying.
  func upload(_ data: [UInt8], to path: String, creating directories: [String]) async throws {
    guard let client else { throw Failure.notConnected }
    try await client.withSFTP(logger: Self.chatty) { sftp in
      var attributes = SFTPFileAttributes()
      attributes.permissions = 0o700
      for directory in directories {
        try? await sftp.createDirectory(atPath: directory, attributes: attributes)
      }
      try await sftp.withFile(filePath: path, flags: [.write, .create, .truncate]) { file in
        // Citadel chunks this at 32 KB itself; nothing here has to know the message limit.
        try await file.write(ByteBuffer(bytes: data))
      }
    }
  }

  /// The listing behind the upload destination browser. Read-only: this module never removes or
  /// downloads anything.
  func listDirectory(_ path: String) async throws -> [RemoteEntry] {
    guard let client else { throw Failure.notConnected }
    return try await client.withSFTP(logger: Self.chatty) { sftp in
      try await sftp.listDirectory(atPath: path).flatMap(\.components).map { component in
        RemoteEntry(
          name: component.filename,
          isDirectory: Self.isDirectory(component),
          size: Int(component.attributes.size ?? 0)
        )
      }
    }
  }

  /// `permissions` is optional in the protocol; `longname` is `ls -l` output, whose first character
  /// is the file type, and every server that omits attributes still sends it.
  private static func isDirectory(_ component: SFTPPathComponent) -> Bool {
    if let permissions = component.attributes.permissions {
      return permissions & 0xF000 == 0x4000  // S_IFDIR
    }
    return component.longname.hasPrefix("d")
  }

  /// Citadel's SFTP client announces every path it opens at `.info`. That used to be silenced;
  /// PLAN.md §7 now says log freely, so it talks. This lands in the device console rather than
  /// Metro (`idevicesyslog`), and it is the only view into an upload that fails inside the
  /// subsystem rather than at the call. `SFTPFile` inherits it.
  private static var chatty: Logger {
    var logger = Logger(label: "port22.sftp")
    logger.logLevel = .debug
    return logger
  }

  // MARK: - Teardown

  func disconnect() async {
    resolveHostKey(false)
    try? await client?.close()
    ptyTask?.cancel()
    await ptyTask?.value
    ptyTask = nil
    writer = nil
    client = nil
  }

  // MARK: - PTY readiness

  private func ptyOpened(_ writer: TTYStdinWriter) {
    self.writer = writer
    resumeWaiters()
  }

  private func ptyClosed() {
    writer = nil
    resumeWaiters()
  }

  private func resumeWaiters() {
    let waiters = ptyWaiters
    ptyWaiters = []
    for waiter in waiters { waiter.resume() }
  }

  private func waitForPTY() async {
    guard writer == nil else { return }
    await withCheckedContinuation { ptyWaiters.append($0) }
  }
}

/// Bridges Citadel's host key check to the JS callback. It hands over the wire-format key and
/// nothing else — no logging, ever.
private struct HostKeyCallback: NIOSSHClientServerAuthenticationDelegate {
  let verify: @Sendable (Data) async -> Bool

  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    var buffer = ByteBuffer()
    hostKey.write(to: &buffer)
    let key = Data(buffer.readableBytesView)
    // Off the event loop: the answer may be a human tapping Trust.
    Task {
      if await verify(key) {
        validationCompletePromise.succeed(())
      } else {
        validationCompletePromise.fail(SSHSession.Failure.hostKeyRejected)
      }
    }
  }
}
