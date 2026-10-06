import SwiftUI

// Proves two things at once: the sideloaded watch app launches, and it can make its own HTTPS
// request (the path the terminal viewer would use) without the iPhone app running.
@main
struct WatchProbeWatchApp: App {
  var body: some Scene {
    WindowGroup { ProbeView() }
  }
}

struct ProbeView: View {
  @State private var status = "fetching…"

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        Text("WatchProbe").font(.headline)
        Text(status).font(.system(size: 12, design: .monospaced))
        Button("Retry") { Task { await fetch() } }
      }
    }
    .task { await fetch() }
  }

  private func fetch() async {
    status = "fetching…"
    let url = URL(string: "https://www.apple.com/library/test/success.html")!
    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      let code = (response as? HTTPURLResponse)?.statusCode ?? -1
      status = "HTTP \(code), \(data.count) bytes\n\(Date().formatted(date: .omitted, time: .standard))"
    } catch {
      status = "error: \(error.localizedDescription)"
    }
  }
}
