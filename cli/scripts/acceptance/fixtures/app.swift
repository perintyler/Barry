import AppKit

// A real AppKit process, with durable observable lifecycle events and no user data.
let path = CommandLine.arguments[1]
func record(_ event: String) {
    let line = "\(event) \(ProcessInfo.processInfo.processIdentifier)\n".data(using: .utf8)!
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    let handle = try! FileHandle(forWritingTo: URL(fileURLWithPath: path))
    handle.seekToEndOfFile(); handle.write(line); handle.closeFile()
}
final class Delegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) { record("ready") }
    func applicationWillTerminate(_ notification: Notification) { record("terminated") }
}
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { NSApplication.shared.terminate(nil) }
termination.resume()
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
