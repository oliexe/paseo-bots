/** macOS helper, built once in the host's plugin data directory. No listener or clipboard access. */
export const DESKTOP_HELPER_SOURCE = String.raw`
import AppKit
import ScreenCaptureKit
import ApplicationServices
import Darwin

// A signal handler only flips a scalar. Input loops observe it at safe points;
// their defer blocks release held keys/buttons before the helper exits.
var desktopCancellation: sig_atomic_t = 0
func checkCancellation() throws {
  if desktopCancellation != 0 { try fail("Desktop session expired. Connect again to continue.") }
}

struct DesktopFailure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw DesktopFailure(message: message) }
func emit(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text) }
}
func displays() -> [CGDirectDisplayID] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 32)
  var count: UInt32 = 0
  CGGetActiveDisplayList(32, &ids, &count)
  return Array(ids.prefix(Int(count)))
}
func status() -> [String: Any] {
  let items: [[String: Any]] = displays().enumerated().map { index, id in
    let b = CGDisplayBounds(id)
    return ["id": id, "name": "Display \(index + 1)\(id == CGMainDisplayID() ? " (main)" : "")", "width": b.width, "height": b.height]
  }
  return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "displays": items]
}
@main struct DesktopHelper {
  static func main() async {
    signal(SIGTERM) { _ in desktopCancellation = 1 }
    do {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let action = request["action"] as? String else { try fail("Invalid desktop request.") }
      if action == "status" { emit(status()); return }
      if action == "requestAccess" {
        let control = (request["access"] as? String) == "control"
        if control {
          let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
          _ = AXIsProcessTrustedWithOptions(options)
        } else { _ = CGRequestScreenCaptureAccess() }
        let pane = control ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + pane) { NSWorkspace.shared.open(url) }
        emit(status()); return
      }
      guard let number = request["displayId"] as? NSNumber, displays().contains(number.uint32Value) else { try fail("That display is no longer connected. Refresh the display list.") }
      let displayId = number.uint32Value
      if action == "capture" {
        guard CGPreflightScreenCaptureAccess() else { try fail("Allow Screen Recording for the app macOS identifies (Paseo or Paseo Helper) in System Settings → Privacy & Security, then reopen the desktop.") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayId }) else { try fail("That display is unavailable.") }
        let maximum = min(2560, max(640, (request["maxDimension"] as? Int) ?? 1600))
        let scale = min(1, Double(maximum) / Double(max(display.width, display.height)))
        let config = SCStreamConfiguration()
        config.width = max(1, Int(Double(display.width) * scale))
        config.height = max(1, Int(Double(display.height) * scale))
        config.showsCursor = true
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let image = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { try fail("Could not encode the desktop image.") }
        emit(["image": "data:image/jpeg;base64," + image.base64EncodedString(), "width": cgImage.width, "height": cgImage.height])
        return
      }
      guard action == "input", AXIsProcessTrusted() else { try fail("Allow Accessibility for the app macOS identifies (Paseo or Paseo Helper) in System Settings → Privacy & Security to control the host.") }
      try checkCancellation()
      guard let input = request["input"] as? [String: Any], let kind = input["kind"] as? String else { try fail("Invalid desktop input.") }
      let bounds = CGDisplayBounds(displayId)
      func point(_ x: String = "x", _ y: String = "y") -> CGPoint {
        CGPoint(x: bounds.minX + min(1, max(0, (input[x] as? Double) ?? 0)) * max(0, bounds.width - 1), y: bounds.minY + min(1, max(0, (input[y] as? Double) ?? 0)) * max(0, bounds.height - 1))
      }
      let source = CGEventSource(stateID: .hidSystemState)
      func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, _ count: Int64 = 1) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: count)
        event?.post(tap: .cghidEventTap)
      }
      switch kind {
      case "click":
        let right = (input["button"] as? String) == "right"
        let p = point()
        let count = min(2, max(1, (input["count"] as? Int) ?? 1))
        for n in 1...count {
          try checkCancellation()
          // AppKit can collapse clicks posted in the same event-loop turn.
          // Give every down/up pair time to arrive, staying well within the
          // system's double-click interval. Always release on cancellation.
          do {
            mouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, Int64(n))
            defer { mouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, Int64(n)) }
            try await Task.sleep(nanoseconds: 30_000_000)
            try checkCancellation()
          }
          if n < count { try await Task.sleep(nanoseconds: 60_000_000) }
        }
        try await Task.sleep(nanoseconds: 20_000_000)
      case "scroll":
        mouse(.mouseMoved, point())
        CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32((input["delta"] as? Int) ?? 0), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
      case "drag":
        let start = point(), end = point("toX", "toY")
        var current = start
        mouse(.leftMouseDown, start)
        defer { mouse(.leftMouseUp, current) }
        try await Task.sleep(nanoseconds: 20_000_000)
        for n in 1...12 {
          try checkCancellation()
          let fraction = Double(n) / 12
          current = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
          mouse(.leftMouseDragged, current)
          try await Task.sleep(nanoseconds: 12_000_000)
        }
      case "text":
        let chars = Array(((input["text"] as? String) ?? "").utf16)
        // Keep surrogate pairs intact at chunk boundaries.
        var offset = 0
        while offset < chars.count {
          try checkCancellation()
          var end = min(offset + 20, chars.count)
          if end < chars.count && chars[end - 1] >= 0xD800 && chars[end - 1] <= 0xDBFF { end -= 1 }
          let chunk = Array(chars[offset..<end])
          func unicodeEvent(_ down: Bool) {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            // Literal text must not inherit a previous shortcut's modifiers.
            event?.flags = []
            event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            event?.post(tap: .cghidEventTap)
          }
          do {
            unicodeEvent(true)
            defer { unicodeEvent(false) }
            try await Task.sleep(nanoseconds: 20_000_000)
            try checkCancellation()
          }
          // Keep long text under the helper timeout while allowing AppKit to
          // consume each Unicode packet before the next one is posted.
          try await Task.sleep(nanoseconds: 10_000_000)
          offset = end
        }
      case "key":
        let keys: [String: CGKeyCode] = ["return":36,"tab":48,"escape":53,"space":49,"delete":51,"forwardDelete":117,"up":126,"down":125,"left":123,"right":124,"home":115,"end":119,"pageUp":116,"pageDown":121,"a":0,"c":8,"v":9,"x":7,"z":6,"l":37,"r":15,"f":3,"w":13,"t":17,"s":1,"q":12]
        guard let key = keys[(input["key"] as? String) ?? ""] else { try fail("Unsupported key.") }
        var flags: CGEventFlags = []
        for modifier in (input["modifiers"] as? [String]) ?? [] {
          switch modifier { case "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "control": flags.insert(.maskControl); default: break }
        }
        do {
          let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
          event?.flags = flags
          event?.post(tap: .cghidEventTap)
          defer {
            let release = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
            // No physical modifier was pressed: release this synthetic chord
            // so the next text or pointer event cannot inherit Command/Shift.
            release?.flags = []
            release?.post(tap: .cghidEventTap)
          }
          try await Task.sleep(nanoseconds: 30_000_000)
          try checkCancellation()
        }
        // AppKit briefly tracks/highlights a menu shortcut (for example ⌘A).
        // Text posted during that transition can be discarded by its menu loop.
        try await Task.sleep(nanoseconds: flags.contains(.maskCommand) ? 150_000_000 : 20_000_000)
      default: try fail("Unsupported desktop input.")
      }
      try checkCancellation()
      emit(["ok": true])
    } catch {
      emit(["error": (error as? DesktopFailure)?.message ?? error.localizedDescription])
      exit(1)
    }
  }
}
`;
