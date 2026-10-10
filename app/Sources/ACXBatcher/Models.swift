import Foundation

struct AudioItem: Codable, Identifiable, Equatable {
    var file: String
    var title: String
    var bytes: Double
    var mtimeMs: Double
    var id: String { file }
    var filename: String { URL(fileURLWithPath: file).lastPathComponent }
}
struct UploadPlan: Codable { var version = 1; var url: String; var items: [AudioItem] }
struct Batch: Codable, Identifiable {
    var id = UUID().uuidString
    var name = "Untitled batch"
    var url = ""
    var cover = ""
    var strip = true
    var items: [AudioItem] = []
    var statuses: [String: String] = [:]
    var started = false
    var completed = false
    var plan: UploadPlan { UploadPlan(url: url, items: items) }
}
struct RemoteSection: Identifiable {
    var title: String
    var inPlan: Bool
    var id: String { title }
}
