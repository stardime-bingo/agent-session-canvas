import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 2 else {
    fputs("usage: generate_icon.swift <iconset-dir>\n", stderr)
    exit(2)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let variants: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, alpha: CGFloat = 1) -> CGColor {
    CGColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

func drawIcon(pixels: Int) throws -> Data {
    let size = CGFloat(pixels)
    let scale = size / 64
    guard let context = CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw NSError(domain: "IconRenderer", code: 1)
    }

    context.setFillColor(color(21, 94, 239))
    context.addPath(CGPath(
        roundedRect: CGRect(x: 0, y: 0, width: size, height: size),
        cornerWidth: 14 * scale,
        cornerHeight: 14 * scale,
        transform: nil
    ))
    context.fillPath()

    func card(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, fill: CGColor) {
        let rect = CGRect(
            x: x * scale,
            y: (64 - y - height) * scale,
            width: width * scale,
            height: height * scale
        )
        context.setFillColor(fill)
        context.addPath(CGPath(
            roundedRect: rect,
            cornerWidth: 4 * scale,
            cornerHeight: 4 * scale,
            transform: nil
        ))
        context.fillPath()
    }

    card(12, 13, 18, 15, fill: color(255, 255, 255))
    card(36, 13, 16, 15, fill: color(185, 208, 255))
    card(12, 36, 16, 15, fill: color(185, 208, 255))
    card(34, 34, 18, 17, fill: color(255, 255, 255))

    context.setStrokeColor(color(255, 255, 255))
    context.setLineWidth(3 * scale)
    context.setLineCap(.round)
    func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) {
        context.move(to: CGPoint(x: x1 * scale, y: (64 - y1) * scale))
        context.addLine(to: CGPoint(x: x2 * scale, y: (64 - y2) * scale))
    }
    line(29, 21, 36, 21)
    line(21, 28, 21, 36)
    line(44, 28, 44, 34)
    line(28, 44, 34, 44)
    context.strokePath()

    guard let image = context.makeImage() else {
        throw NSError(domain: "IconRenderer", code: 2)
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw NSError(domain: "IconRenderer", code: 3)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "IconRenderer", code: 4)
    }
    return data as Data
}

for (name, pixels) in variants {
    try drawIcon(pixels: pixels).write(to: output.appendingPathComponent(name))
}
