// Значок CarBUS.app (свой, нейтральный — без знаков canhacker.ru): синий квадрат со скруглением,
// «CAN» и две линии шины (CAN-High и CAN-Low) с перепадом. Рисует набор PNG и собирает .icns.
//   swiftc -O -sdk "$(xcrun --sdk macosx --show-sdk-path)" macos/make-icon.swift -o /tmp/make-icon
//   /tmp/make-icon macos/AppIcon.icns
import AppKit

func draw(size px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 1024                                  // всё рисуем в сетке 1024
    let body = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shape = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(starting: NSColor(srgbRed: 0.15, green: 0.45, blue: 0.95, alpha: 1),
               ending: NSColor(srgbRed: 0.04, green: 0.16, blue: 0.42, alpha: 1))!.draw(in: shape, angle: -90)

    let text = NSAttributedString(string: "CAN", attributes: [
        .font: NSFont.systemFont(ofSize: 300 * s, weight: .heavy),
        .foregroundColor: NSColor.white,
        .kern: 6 * s,
    ])
    let t = text.size()
    text.draw(at: NSPoint(x: (1024 * s - t.width) / 2, y: 520 * s))

    // CAN-High вверх, CAN-Low вниз на «доминантных» битах — как на осциллографе
    let bits: [Bool] = [false, true, true, false, true, false, false, true, false]
    func line(_ base: CGFloat, _ dominant: CGFloat, _ color: NSColor) {
        let p = NSBezierPath()
        let x0 = 190 * s, step = 644 * s / CGFloat(bits.count)
        p.move(to: NSPoint(x: x0, y: base))
        for (i, bit) in bits.enumerated() {
            let y = bit ? dominant : base
            p.line(to: NSPoint(x: x0 + CGFloat(i) * step, y: y))
            p.line(to: NSPoint(x: x0 + CGFloat(i + 1) * step, y: y))
        }
        p.lineWidth = 28 * s
        p.lineJoinStyle = .round
        p.lineCapStyle = .round
        color.setStroke()
        p.stroke()
    }
    line(345 * s, 435 * s, .white)
    line(285 * s, 195 * s, NSColor(srgbRed: 0.55, green: 0.85, blue: 1, alpha: 1))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns")
let set = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon-\(getpid()).iconset")
try? FileManager.default.removeItem(at: set)
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try draw(size: base).write(to: set.appendingPathComponent("icon_\(base)x\(base).png"))
    try draw(size: base * 2).write(to: set.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", set.path, "-o", out.path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: set)
print(iconutil.terminationStatus == 0 ? "значок: \(out.path)" : "iconutil: код \(iconutil.terminationStatus)")
exit(iconutil.terminationStatus)
