import SwiftUI
import AppKit
import UniformTypeIdentifiers

@MainActor final class Store: ObservableObject {
    @Published var batches: [Batch] = []
    @Published var selectedID: String?
    @Published var busy = false
    @Published var uploading = false
    @Published var pauseRequested = false
    @Published var checked = false
    @Published var message = "Choose an ACX project, then add your audio."
    @Published var error: String?
    @Published var logs: [String] = []
    @Published var remote: [RemoteSection] = []
    @Published var engineReady = false
    let support: URL
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var stderr: Pipe?
    private var buffer = Data()
    private var activity: NSObjectProtocol?
    private var actions: [String: String] = [:]

    init() {
        support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ACXBatcher", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            let file = support.appendingPathComponent("batches.json")
            if FileManager.default.fileExists(atPath: file.path) {
                batches = try JSONDecoder().decode([Batch].self, from: Data(contentsOf: file))
            }
        } catch { self.error = "Could not load saved batches: \(error.localizedDescription)" }
        if batches.isEmpty { batches = [Batch()] }
        selectedID = batches.first?.id
        launchEngine()
    }
    var index: Int? { batches.firstIndex { $0.id == selectedID } }
    var batch: Batch? { index.map { batches[$0] } }
    var editable: Bool { !busy && !(batch?.started ?? false) }
    var completeCount: Int { batch?.items.filter { batch?.statuses[$0.file] == "uploaded" || batch?.statuses[$0.file] == "skip" }.count ?? 0 }

    func save() {
        do { try JSONEncoder().encode(batches).write(to: support.appendingPathComponent("batches.json"), options: .atomic) }
        catch { self.error = "Could not save batches: \(error.localizedDescription)" }
    }
    func changed() { checked = false; remote = []; save() }
    func select(_ id: String?) { guard !busy else { return }; selectedID = id; checked = false; remote = [] }
    func newBatch() {
        guard !busy else { return }
        let item = Batch(); batches.insert(item, at: 0); selectedID = item.id; changed()
    }
    func setTitle(_ file: String, _ title: String) {
        guard editable, let i = index, let j = batches[i].items.firstIndex(where: {$0.file == file}) else { return }
        batches[i].items[j].title = title; changed()
    }
    func setURL(_ url: String) {
        guard editable, let i = index else { return }
        batches[i].url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        batches[i].name = "ACX project"; batches[i].cover = ""; changed()
    }
    func setStrip(_ strip: Bool) {
        guard editable, let i = index else { return }
        batches[i].strip = strip
        for j in batches[i].items.indices {
            let stem = URL(fileURLWithPath: batches[i].items[j].file).deletingPathExtension().lastPathComponent
            batches[i].items[j].title = strip ? stem.replacingOccurrences(of: #"^\d+\s*[-–—_.]\s*"#, with: "", options: .regularExpression) : stem
        }
        changed()
    }
    func remove(_ file: String) { guard editable, let i = index else { return }; batches[i].items.removeAll {$0.file == file}; changed() }
    func move(_ file: String, before target: String) {
        guard editable, let i = index, let from = batches[i].items.firstIndex(where: {$0.file == file}), file != target else { return }
        let item = batches[i].items.remove(at: from)
        let to = batches[i].items.firstIndex(where: {$0.file == target}) ?? batches[i].items.count
        batches[i].items.insert(item, at: to); changed()
    }
    func move(_ file: String, by delta: Int) {
        guard editable, let i = index, let j = batches[i].items.firstIndex(where: {$0.file == file}) else { return }
        let dest = j + delta
        guard batches[i].items.indices.contains(dest) else { return }
        batches[i].items.swapAt(j, dest); changed()
    }
    func pickFiles() {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true; panel.prompt = "Add audio"; panel.message = "Select MP3 files or a folder. All MP3s in the folder will be included."
        if panel.runModal() == .OK { importFiles(panel.urls) }
    }
    func importFiles(_ urls: [URL]) {
        guard editable else { return }
        send("import", ["paths": urls.map(\.path), "strip": batch?.strip ?? true])
    }
    func browse() { send("browse", ["url": batch?.url ?? ""]) }
    func captureProject() { send("project") }
    func preflight() { guard let batch else { return }; sendPlan("preflight", batch) }
    func start() {
        guard checked, let batch else { return }
        pauseRequested = false; sendPlan("start", batch)
    }
    func pause() { pauseRequested = true; send("pause", exclusive: false) }
    private func sendPlan(_ action: String, _ batch: Batch) {
        do {
            let plan = try JSONSerialization.jsonObject(with: JSONEncoder().encode(batch.plan))
            send(action, ["plan": plan, "batchID": batch.id])
        } catch { self.error = error.localizedDescription }
    }
    func send(_ action: String, _ arguments: [String: Any] = [:], exclusive: Bool = true) {
        guard engineReady, let input else { error = "The upload engine is not available. Restart the app."; return }
        if exclusive && busy { return }
        let id = UUID().uuidString
        var payload = arguments; payload["id"] = id; payload["action"] = action
        do {
            var data = try JSONSerialization.data(withJSONObject: payload); data.append(10)
            actions[id] = action
            if exclusive { busy = true; error = nil }
            try input.fileHandleForWriting.write(contentsOf: data)
        } catch { busy = false; self.error = error.localizedDescription }
    }
    private func launchEngine() {
        let environment = ProcessInfo.processInfo.environment
        let root = environment["ACX_ENGINE_DIR"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL?.appendingPathComponent("engine")
        guard let root, FileManager.default.fileExists(atPath: root.appendingPathComponent("desktop-engine.mjs").path) else {
            error = "Engine missing. Build the app with scripts/build-app.sh."; return
        }
        let candidates = [environment["ACX_NODE"], Bundle.main.resourceURL?.appendingPathComponent("runtime/node").path, "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap {$0}
        guard let node = candidates.first(where: {FileManager.default.isExecutableFile(atPath: $0)}) else {
            error = "Node.js 20 or later is required for this development build."; return
        }
        let process = Process(), input = Pipe(), output = Pipe(), stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [root.appendingPathComponent("desktop-engine.mjs").path, support.path]
        process.currentDirectoryURL = root
        process.standardInput = input; process.standardOutput = output; process.standardError = stderr
        self.process = process; self.input = input; self.output = output; self.stderr = stderr
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { Task { @MainActor in self?.receive(data) } }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if let text = String(data: data, encoding: .utf8), !text.isEmpty { Task { @MainActor in self?.appendLog(text) } }
        }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self else { return }; self.engineReady = false; self.busy = false; self.uploading = false; self.endActivity()
                if process.terminationStatus != 0 { self.error = "Upload engine stopped. See the activity log; saved progress will be checked on resume." }
            }
        }
        do { try process.run() } catch { self.error = "Could not launch engine: \(error.localizedDescription)" }
    }
    private func receive(_ data: Data) {
        buffer.append(data)
        while let end = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            handle(object)
        }
    }
    private func handle(_ event: [String: Any]) {
        let type = event["type"] as? String ?? ""
        if type == "ready" { engineReady = true; return }
        if type == "log" { appendLog(event["message"] as? String ?? ""); return }
        if type == "started" {
            uploading = true; if let i = index { batches[i].started = true }; save()
            activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Uploading audiobook files")
            message = "Uploading one file at a time. You can pause after the current file."; return
        }
        if type == "item", let file = event["file"] as? String, let status = event["status"] as? String, let i = index {
            batches[i].statuses[file] = status; save(); return
        }
        if type == "pauseRequested" { message = "Will pause after the current file finishes."; return }
        if type == "paused" { message = "Paused. Check the project to resume."; return }
        guard type == "result" || type == "error" else { return }
        let action = event["action"] as? String ?? actions[event["id"] as? String ?? ""] ?? ""
        actions.removeValue(forKey: event["id"] as? String ?? "")
        busy = false
        if action == "start" { uploading = false; endActivity(); checked = false }
        if type == "error" { error = event["message"] as? String ?? "Unknown error"; appendLog(error!); return }
        if action == "import", let data = event["data"], let i = index {
            do {
                let added = try JSONDecoder().decode([AudioItem].self, from: JSONSerialization.data(withJSONObject: data))
                let existing = Set(batches[i].items.map(\.file))
                batches[i].items.append(contentsOf: added.filter {!existing.contains($0.file)})
                changed(); message = "Added \(added.filter {!existing.contains($0.file)}.count) files. Review titles and order before uploading."
            } catch { self.error = error.localizedDescription }
        }
        if action == "browse" { message = "In Chrome, open the book’s finished-audio page. Then click Use this project." }
        if action == "project", let data = event["data"] as? [String: Any], let i = index {
            batches[i].url = data["url"] as? String ?? ""; batches[i].name = data["title"] as? String ?? "ACX project"; batches[i].cover = data["cover"] as? String ?? ""
            changed(); message = "Project selected. Add or review your audio files."
        }
        if action == "preflight", let data = event["data"] as? [String: Any], let i = index {
            if let project = data["project"] as? [String: Any] {
                batches[i].name = project["title"] as? String ?? batches[i].name
                batches[i].cover = project["cover"] as? String ?? ""
            }
            let items = data["items"] as? [[String: Any]] ?? []
            for item in items { if let file = item["file"] as? String, let status = item["status"] as? String { batches[i].statuses[file] = status } }
            remote = (data["existing"] as? [[String: Any]] ?? []).map { RemoteSection(title: $0["title"] as? String ?? "", inPlan: $0["inPlan"] as? Bool ?? false) }
            checked = true; save()
            let skipped = items.filter { $0["status"] as? String == "skip" }.count
            message = "Ready: \(items.count - skipped) files to upload, \(skipped) already uploaded. \(data["unrelated"] as? Int ?? 0) existing sections are outside this batch."
        }
        if action == "start", let data = event["data"] as? [String: Any], let i = index {
            let paused = data["paused"] as? Bool ?? false
            batches[i].completed = !paused; save()
            message = paused ? "Paused safely. Check the project when you’re ready to resume." : "Uploads complete and verified. Review the audiobook in ACX; it has not been submitted."
        }
    }
    private func appendLog(_ text: String) { logs.append(text); if logs.count > 250 { logs.removeFirst(logs.count - 250) } }
    private func endActivity() { if let activity { ProcessInfo.processInfo.endActivity(activity) }; activity = nil }
    func shutdown() { if engineReady { send("shutdown", exclusive: false) } }
}
