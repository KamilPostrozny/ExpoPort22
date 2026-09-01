import ExpoModulesCore
import UniformTypeIdentifiers

/**
 * The file on the pasteboard — the one thing `expo-clipboard` cannot reach.
 *
 * Package check (AGENTS.md): `expo-clipboard` 57.0.1 exposes strings, an iOS URL item and images,
 * and `@react-native-clipboard/clipboard` 1.16.3 the same set (`getString`, `getImagePNG`,
 * `hasURL`, `hasNumber`) — neither has an arbitrary pasteboard item. A PDF copied in Files lands
 * as `com.adobe.pdf` bytes with no URL item at all: `getUrlAsync()` measured `null` on device
 * (iPhone, 2026-09-01), so reading the URI and fetching it with `expo-file-system` cannot work
 * either. This module is the remaining answer, and it is 40 lines rather than a dependency.
 *
 * `read` is the only call that touches the bytes — and on iOS 16+ the only one that shows the
 * paste banner. `peek` reads `types` and the item's suggested name, both metadata, so the popover
 * can offer the row without spending a banner to draw it.
 */
public class ExpoPasteboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPasteboard")

    /** The filename of the copied file, or `nil` when the pasteboard holds no file. Metadata only. */
    AsyncFunction("peek") { () -> String? in
      guard let type = Self.fileType() else { return nil }
      return Self.filename(for: type)
    }

    /** `{ name, base64 }` for the copied file, or `nil`. This is the read that costs the banner. */
    AsyncFunction("read") { () -> [String: String]? in
      guard let type = Self.fileType(),
            let data = UIPasteboard.general.data(forPasteboardType: type) else { return nil }
      return ["name": Self.filename(for: type), "base64": data.base64EncodedString()]
    }
  }

  /// The first pasteboard type that is a file rather than a rendition of text. Text flavours are
  /// what Paste types; images are `expo-clipboard`'s job and are left to it, so that the two never
  /// disagree about what a copied photo is called.
  private static func fileType() -> String? {
    return UIPasteboard.general.types.first { identifier in
      guard let type = UTType(identifier) else { return false }
      return type.conforms(to: .data)
        && !type.conforms(to: .text)
        && !type.conforms(to: .url)
        && !type.conforms(to: .image)
    }
  }

  /// `suggestedName` is the name the copying app put on the item ("spec"); the UTI carries the
  /// extension. Either half can be missing, and the fallbacks keep the result a usable filename.
  private static func filename(for type: String) -> String {
    let base = UIPasteboard.general.itemProviders.first?.suggestedName ?? "pasted"
    guard let ext = UTType(type)?.preferredFilenameExtension else { return base }
    return base.hasSuffix(".\(ext)") ? base : "\(base).\(ext)"
  }
}
