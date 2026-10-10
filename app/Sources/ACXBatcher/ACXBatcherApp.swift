import SwiftUI
import AppKit
import UniformTypeIdentifiers

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: Store?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let store, store.busy {
            if store.uploading { store.pause() }
            store.message = "Wait for the current operation to finish, then quit again. Your batch is saved."
            return .terminateCancel
        }
        store?.shutdown(); return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct ACXBatcherApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var store = Store()
    var body: some Scene {
        WindowGroup("ACX Batcher") {
            ContentView(store: store).onAppear { delegate.store = store }
                .frame(minWidth: 1040, minHeight: 700)
        }.defaultSize(width: 1220, height: 830)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New batch") { store.newBatch() }.keyboardShortcut("n").disabled(store.busy)
                Button("Add audio…") { store.pickFiles() }.keyboardShortcut("o").disabled(!store.editable)
            }
        }
    }
}

struct ContentView: View {
    @ObservedObject var store: Store
    @State private var showLog = false
    @State private var showExisting = false
    @State private var targeted = false
    private let accent = Color(red: 0.12, green: 0.43, blue: 0.38)
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 18) {
                Label("ACX Batcher", systemImage: "waveform").font(.title2.bold()).foregroundStyle(accent).padding(.top, 12)
                Text("YOUR UPLOADS").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                List(selection: Binding(get: {store.selectedID}, set: {store.select($0)})) {
                    ForEach(store.batches) { batch in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(batch.name).font(.headline).lineLimit(2)
                            Text("\(batch.items.count) files · \(batch.completed ? "Complete" : batch.started ? "In progress" : "Draft")")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6).tag(batch.id)
                    }
                }.listStyle(.sidebar).disabled(store.busy)
                Button(action: store.newBatch) { Label("New batch", systemImage: "plus") }.disabled(store.busy)
                Text("Local files. Your Chrome session.\nNo AI or API keys.").font(.caption).foregroundStyle(.secondary).padding(.bottom, 12)
            }.padding(.horizontal, 14).navigationSplitViewColumnWidth(230)
        } detail: {
            VStack(alignment: .leading, spacing: 18) {
                header
                project
                files
                footer
            }.padding(24).background(Color(nsColor: .windowBackgroundColor))
                .onDrop(of: [UTType.fileURL.identifier], isTargeted: $targeted, perform: importDrop)
                .overlay { if targeted && store.editable { RoundedRectangle(cornerRadius: 14).stroke(accent, style: StrokeStyle(lineWidth: 3, dash: [8])).padding(8).allowsHitTesting(false) } }
        }
        .tint(accent)
        .sheet(isPresented: $showLog) {
            VStack(alignment: .leading) {
                HStack { Text("Activity").font(.title2.bold()); Spacer(); Button("Done") { showLog = false } }
                ScrollView { Text(store.logs.joined(separator: "\n")).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding(24).frame(width: 780, height: 460)
        }
        .sheet(isPresented: $showExisting) {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Already on ACX").font(.title2.bold()); Spacer(); Button("Done") { showExisting = false } }
                Text("Sections outside this batch stay in place. New sections append after them.").foregroundStyle(.secondary)
                List(store.remote) { row in HStack { Text(row.title); Spacer(); Text(row.inPlan ? "In this batch" : "Outside this batch").foregroundStyle(.secondary) } }
            }.padding(24).frame(width: 780, height: 460)
        }
    }
    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Text("A whole book. A little less clicking.").font(.system(size: 27, weight: .semibold))
                Text("Choose your project, review the order, and let the batch run.").foregroundStyle(.secondary)
            }
            Spacer()
            Label(store.engineReady ? "Engine ready" : "Starting engine", systemImage: store.engineReady ? "checkmark.circle.fill" : "circle.dotted")
                .font(.caption).foregroundStyle(store.engineReady ? accent : .secondary).padding(.top, 8)
        }
    }
    private var project: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 14) {
                    if let cover = store.batch?.cover, !cover.isEmpty, let url = URL(string: cover) {
                        AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "book.closed") }.frame(width: 48, height: 66).clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(store.batch?.url.isEmpty == false ? store.batch?.name ?? "ACX project" : "Choose an audiobook").font(.headline)
                        Text("Open Chrome, navigate to your book’s finished-audio page, then use that project.").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Choose in Chrome", action: store.browse).disabled(store.busy || !store.engineReady)
                    Button("Use this project", action: store.captureProject).disabled(!store.editable || !store.engineReady)
                }
                HStack {
                    Image(systemName: "link").foregroundStyle(.secondary)
                    TextField("Or paste an ACX project link", text: Binding(get: {store.batch?.url ?? ""}, set: store.setURL)).textFieldStyle(.plain).disabled(!store.editable)
                }.padding(9).background(.background, in: RoundedRectangle(cornerRadius: 6))
            }.padding(10)
        } label: { Label("1  PROJECT", systemImage: "book.closed").font(.caption.bold()).foregroundStyle(.secondary) }
    }
    private var files: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("2  AUDIO FILES", systemImage: "waveform").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                Text("\(store.batch?.items.count ?? 0) files").foregroundStyle(.secondary)
                Button("Add files or folder…", action: store.pickFiles).disabled(!store.editable || !store.engineReady)
            }
            Toggle("Remove leading numbers from titles", isOn: Binding(get: {store.batch?.strip ?? true}, set: store.setStrip))
                .toggleStyle(.checkbox).disabled(!store.editable)
            if store.batch?.items.isEmpty != false {
                VStack(spacing: 14) {
                    Image(systemName: "arrow.down.doc").font(.system(size: 42, weight: .light)).foregroundStyle(accent)
                    Text("Drop your MP3s or a folder here").font(.title3.weight(.medium))
                    Text("Every MP3 is included, including credits.\nFiles arrive in natural filename order.").multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Choose audio…", action: store.pickFiles).disabled(!store.engineReady)
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.background, in: RoundedRectangle(cornerRadius: 10))
            } else {
                HStack { Text("#").frame(width: 30); Text("SOURCE FILE").frame(maxWidth: .infinity, alignment: .leading); Text("ACX TITLE").frame(maxWidth: .infinity, alignment: .leading); Text("STATUS").frame(width: 80) }
                    .font(.caption2.bold()).foregroundStyle(.secondary).padding(.horizontal, 12)
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(Array((store.batch?.items ?? []).enumerated()), id: \.element.id) { offset, item in
                            audioRow(item, offset: offset)
                        }
                    }
                }.background(.background, in: RoundedRectangle(cornerRadius: 8))
                Text(store.batch?.started == true ? "This batch has started. Titles and order are locked so it can resume reliably." : "Edit titles inline. Drag rows to reorder, or use their menu. New imports append in filename order.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxHeight: .infinity)
    }
    private func audioRow(_ item: AudioItem, offset: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(offset + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 30)
            Text(item.filename).lineLimit(1).truncationMode(.middle).help(item.file).frame(maxWidth: .infinity, alignment: .leading)
            TextField("Section title", text: Binding(get: {store.batch?.items.first(where: {$0.file == item.file})?.title ?? item.title}, set: {store.setTitle(item.file, $0)}))
                .textFieldStyle(.plain).padding(.vertical, 6).frame(maxWidth: .infinity).disabled(!store.editable)
            Text(statusLabel(store.batch?.statuses[item.file])).font(.caption).foregroundStyle(.secondary).frame(width: 80)
        }.padding(.horizontal, 12).padding(.vertical, 6)
        .background(offset.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.025))
        .draggable(item.file)
        .dropDestination(for: String.self) { values, _ in
            guard let file = values.first, store.editable else { return false }; store.move(file, before: item.file); return true
        }
        .contextMenu {
            Button("Move up") { store.move(item.file, by: -1) }.disabled(!store.editable || offset == 0)
            Button("Move down") { store.move(item.file, by: 1) }.disabled(!store.editable || offset == (store.batch?.items.count ?? 0) - 1)
            Button("Remove from batch", role: .destructive) { store.remove(item.file) }.disabled(!store.editable)
        }
    }
    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            if let error = store.error {
                HStack(alignment: .top) { Image(systemName: "exclamationmark.triangle.fill"); Text(error).textSelection(.enabled); Spacer(); Button("Dismiss") { store.error = nil } }.foregroundStyle(.red).font(.callout)
            }
            HStack {
                if store.busy { ProgressView().controlSize(.small) }
                Text(store.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer()
                Button("Activity") { showLog = true }
            }
            if store.batch?.started == true || store.checked {
                ProgressView(value: Double(store.completeCount), total: Double(max(store.batch?.items.count ?? 0, 1)))
            }
            HStack {
                Text("\(store.completeCount) of \(store.batch?.items.count ?? 0) uploaded").font(.caption).foregroundStyle(.secondary)
                if store.checked { Button("Existing sections (\(store.remote.count))") { showExisting = true } }
                Spacer()
                if store.uploading {
                    Button(store.pauseRequested ? "Pausing after this file…" : "Pause after current file", action: store.pause).disabled(store.pauseRequested)
                } else {
                    Button("Check ACX project", action: store.preflight).disabled(store.busy || !store.engineReady || store.batch?.url.isEmpty != false || store.batch?.items.isEmpty != false)
                    Button(store.batch?.started == true ? "Resume upload" : "Start upload", action: store.start).buttonStyle(.borderedProminent).disabled(store.busy || !store.checked)
                }
            }
        }
    }
    private func statusLabel(_ status: String?) -> String {
        switch status { case "uploaded": return "Uploaded"; case "skip": return "Skip"; case "uploading": return "Uploading…"; case "add": return "Add"; case "upload": return "Upload"; default: return "Ready" }
    }
    private func importDrop(_ providers: [NSItemProvider]) -> Bool {
        guard store.editable else { return false }
        let group = DispatchGroup()
        let results = DropResults()
        for provider in providers {
            group.enter()
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, _ in
                defer { group.leave() }
                if let data = value as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) { results.append(url) }
                else if let url = value as? URL { results.append(url) }
            }
        }
        group.notify(queue: .main) { store.importFiles(results.urls) }
        return true
    }
}
final class DropResults: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []
    func append(_ url: URL) { lock.lock(); defer { lock.unlock() }; storage.append(url) }
    var urls: [URL] { lock.lock(); defer { lock.unlock() }; return storage }
}
