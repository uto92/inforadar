import AVFoundation
import SwiftUI
import UIKit

/// 検出対象の symbology。Codabar 以外も検出対象に含めることで、
/// 対象外コードを「読めない」ではなく「対象外です」と明示的に返せる。
let scanTargetTypes: [AVMetadataObject.ObjectType] = [
    .codabar, .qr, .code128, .ean13, .ean8, .code39, .itf14, .pdf417,
]

/// AVCaptureMetadataOutput によるバーコード読取ビュー（外部SDK不使用）。
struct CameraScannerView: UIViewRepresentable {
    var onDetect: (String, AVMetadataObject.ObjectType) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onDetect: onDetect)
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        context.coordinator.start(preview: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onDetect = onDetect
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onDetect: (String, AVMetadataObject.ObjectType) -> Void
        private let session = AVCaptureSession()
        private let sessionQueue = DispatchQueue(label: "wvs.capture-session")
        private var configured = false

        init(onDetect: @escaping (String, AVMetadataObject.ObjectType) -> Void) {
            self.onDetect = onDetect
        }

        func start(preview: PreviewView) {
            preview.previewLayer.session = session
            preview.previewLayer.videoGravity = .resizeAspectFill
            sessionQueue.async { [self] in
                configureIfNeeded()
                if !session.isRunning {
                    session.startRunning()
                }
            }
        }

        func stop() {
            sessionQueue.async { [self] in
                if session.isRunning {
                    session.stopRunning()
                }
            }
        }

        private func configureIfNeeded() {
            guard !configured else { return }
            configured = true
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            session.sessionPreset = .high
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            let available = Set(output.availableMetadataObjectTypes)
            output.metadataObjectTypes = scanTargetTypes.filter { available.contains($0) }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            for object in metadataObjects {
                guard let code = object as? AVMetadataMachineReadableCodeObject,
                      let value = code.stringValue else {
                    continue
                }
                onDetect(value, code.type)
                break
            }
        }
    }
}
