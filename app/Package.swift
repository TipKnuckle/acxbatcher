// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ACXBatcher", platforms: [.macOS(.v14)], products: [.executable(name: "ACXBatcher", targets: ["ACXBatcher"])], targets: [.executableTarget(name: "ACXBatcher")])
