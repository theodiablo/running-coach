import Foundation
import Capacitor
import Speech
import AVFoundation
import UIKit

// Dictation for the coach composer and the beta feedback sheet
// (docs/voice-and-feedback.md). SFSpeechRecognizer with
// `requiresOnDeviceRecognition = true`, so nothing spoken here leaves the
// phone — which is what lets the UI copy say "your phone turns this into text"
// and mean it.
//
// The JS side never touches this directly: it goes through the speech seam
// (src/speech/source.ts), which returns null off native, so the web build has
// no path in here at all.
//
// Everything is defensive. A recognizer that cannot start must degrade to
// "type it instead" — never to a dead button, and never to a throw.
@objc(SpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechPlugin"
    public let jsName = "Speech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var activatedSession = false

    @objc func available(_ call: CAPPluginCall) {
        // On-device recognition is per-locale: a device with no downloaded model
        // for this language should say so rather than silently falling back to
        // Apple's servers, which the privacy copy does not cover.
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: call.getString("lang") ?? "en-GB"))
        let ok = recognizer?.isAvailable == true && recognizer?.supportsOnDeviceRecognition == true
        call.resolve(["available": ok])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        // Two separate grants: transcription and the microphone itself. Both are
        // requested on first tap, never on a screen's load.
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.resolve(["granted": false])
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                call.resolve(["granted": granted])
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "en-GB"
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.teardown()
            do {
                guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)),
                      recognizer.isAvailable else {
                    self.emitError("recognizer_unavailable")
                    call.reject("recognizer unavailable")
                    return
                }
                self.recognizer = recognizer

                // .playAndRecord, NOT .record: `duckOthers` is only settable on
                // playAndRecord/playback/multiRoute, so pairing it with .record
                // throws and dictation never starts at all. Ducking keeps a
                // runner's music quiet for the moment rather than stopping it,
                // the same courtesy AudioCuePlugin extends for its cues.
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .measurement,
                                        options: [.duckOthers, .allowBluetooth, .defaultToSpeaker])
                try session.setActive(true, options: .notifyOthersOnDeactivation)
                self.activatedSession = true

                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = true
                // The whole privacy claim rests on this line.
                request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
                self.request = request

                let input = self.engine.inputNode
                input.removeTap(onBus: 0)
                input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                    request.append(buffer)
                }

                self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    guard let self else { return }
                    // This handler's queue is not guaranteed, and AVAudioEngine
                    // is not thread-safe — every other mutation of engine/task/
                    // request is confined to main, so teardown must be too.
                    if let result {
                        let text = result.bestTranscription.formattedString
                        if result.isFinal {
                            self.notifyListeners("final", data: ["text": text])
                            DispatchQueue.main.async { self.teardown() }
                        } else {
                            // Rendered live in the composer: without it, several
                            // seconds of silence reads as a broken button.
                            self.notifyListeners("partial", data: ["text": text])
                        }
                    } else if error != nil {
                        self.emitError("speech_failed")
                        DispatchQueue.main.async { self.teardown() }
                    }
                }

                self.engine.prepare()
                try self.engine.start()
                call.resolve()
            } catch {
                self.teardown()
                self.emitError("speech_start_failed")
                call.reject("speech start failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        // Never rejects: stopping something already stopped is the caller tidying
        // up, not an error, and a sheet closing must not throw.
        DispatchQueue.main.async { [weak self] in
            self?.teardown()
            call.resolve()
        }
    }

    // A sheet closed mid-utterance, or an app backgrounded, must not leave the
    // microphone indicator lit.
    public override func load() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main,
        ) { [weak self] _ in self?.teardown() }
    }

    private func emitError(_ message: String) {
        notifyListeners("error", data: ["message": message])
    }

    private func teardown() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        recognizer = nil
        // Hand the session back only if we took it: AudioCuePlugin owns one too,
        // and deactivating its session under a playing cue would cut the cue off.
        if activatedSession {
            activatedSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
