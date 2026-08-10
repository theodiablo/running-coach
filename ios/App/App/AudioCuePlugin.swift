import Foundation
import Capacitor
import AVFoundation

// Guided-workout cue audio for iOS (docs/guided-workouts.md). The JS engine
// keeps running under background location, but WKWebView audio does not play
// with the screen locked — so cues route here: synthesized tones (mirroring
// src/cues/web.ts patterns) + AVSpeechSynthesizer, on an AVAudioSession that
// DUCKS the runner's music for the moment of the prompt and releases it after.
// `schedule` arms one native one-shot for a time boundary that no GPS fix will
// wake JS for (a standing recovery); JS re-arms/cancels it as it re-evaluates.
// Everything is best-effort: a cue failure must never affect recording.
@objc(AudioCuePlugin)
public class AudioCuePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "AudioCuePlugin"
    public let jsName = "AudioCue"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prime", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "schedule", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelScheduled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise),
    ]

    private let synth = AVSpeechSynthesizer()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var scheduled: DispatchWorkItem?
    private var deactivateItem: DispatchWorkItem?

    // [frequency Hz, duration s, gap-before s] — keep in step with the web
    // PATTERNS (src/cues/web.ts) so the two platforms sound the same.
    private static let patterns: [String: [(Double, Double, Double)]] = [
        "step": [(880, 0.15, 0), (1175, 0.22, 0.08)],
        "done": [(880, 0.15, 0), (1046, 0.15, 0.06), (1318, 0.3, 0.06)],
        "slow": [(660, 0.12, 0), (880, 0.2, 0.06)],
        "fast": [(1175, 0.12, 0), (784, 0.2, 0.06)],
    ]

    public override func load() {
        synth.delegate = self
    }

    // Category set up front (from the Start tap); activation happens per cue so
    // the runner's music is only ducked for the moment of a prompt.
    @objc func prime(_ call: CAPPluginCall) {
        configureSession()
        call.resolve()
    }

    @objc func play(_ call: CAPPluginCall) {
        let tone = call.getString("tone") ?? "step"
        let text = call.getString("text")
        let lang = call.getString("lang") ?? "en"
        DispatchQueue.main.async { [weak self] in
            self?.cue(tone: tone, text: text, lang: lang)
        }
        call.resolve()
    }

    @objc func schedule(_ call: CAPPluginCall) {
        let inMs = call.getDouble("inMs") ?? 0
        let tone = call.getString("tone") ?? "step"
        let text = call.getString("text")
        let lang = call.getString("lang") ?? "en"
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled?.cancel()
            let item = DispatchWorkItem { [weak self] in
                self?.scheduled = nil
                self?.cue(tone: tone, text: text, lang: lang)
            }
            self.scheduled = item
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, inMs) / 1000, execute: item)
        }
        call.resolve()
    }

    @objc func cancelScheduled(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.scheduled?.cancel()
            self?.scheduled = nil
        }
        call.resolve()
    }

    @objc func release(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled?.cancel()
            self.scheduled = nil
            self.synth.stopSpeaking(at: .immediate)
            self.deactivateNow()
        }
        call.resolve()
    }

    // ── output ───────────────────────────────────────────────────────────────

    private func configureSession() {
        // .voicePrompt = navigation-style prompts; duck (not stop) other audio.
        try? AVAudioSession.sharedInstance().setCategory(
            .playback, mode: .voicePrompt, options: [.mixWithOthers, .duckOthers])
    }

    private func cue(tone: String, text: String?, lang: String) {
        configureSession()
        deactivateItem?.cancel()
        deactivateItem = nil
        try? AVAudioSession.sharedInstance().setActive(true)
        let pattern = Self.patterns[tone] ?? Self.patterns["step"]!
        playTones(pattern)
        if let text, !text.isEmpty {
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: lang)
            // Give the tone a head start so the voice doesn't talk over it.
            utterance.preUtteranceDelay = pattern.reduce(0.1) { $0 + $1.1 + $1.2 }
            synth.speak(utterance) // delegate's didFinish releases the session
        } else {
            let total = pattern.reduce(0.4) { $0 + $1.1 + $1.2 }
            deactivateSoon(after: total)
        }
    }

    // Synthesized sine beeps — no bundled assets, same envelope as the web.
    private func playTones(_ pattern: [(Double, Double, Double)]) {
        let sampleRate = 44100.0
        let total = pattern.reduce(0.05) { $0 + $1.1 + $1.2 }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total * sampleRate))
        else { return }
        buffer.frameLength = buffer.frameCapacity
        guard let data = buffer.floatChannelData?[0] else { return }
        for i in 0..<Int(buffer.frameLength) { data[i] = 0 }
        var t = 0.0
        for (freq, dur, gap) in pattern {
            t += gap
            let start = Int(t * sampleRate)
            let count = Int(dur * sampleRate)
            for i in 0..<count where start + i < Int(buffer.frameLength) {
                let x = Double(i) / sampleRate
                let env = max(0, min(1, min(x / 0.02, (dur - x) / 0.03)))
                data[start + i] = Float(sin(2 * .pi * freq * x) * 0.35 * env)
            }
            t += dur
        }
        if engine == nil {
            let e = AVAudioEngine()
            let p = AVAudioPlayerNode()
            e.attach(p)
            e.connect(p, to: e.mainMixerNode, format: format)
            engine = e
            player = p
        }
        guard let engine, let player else { return }
        if !engine.isRunning {
            do { try engine.start() } catch { return }
        }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
        player.play()
    }

    private func deactivateSoon(after: TimeInterval) {
        deactivateItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.deactivateNow() }
        deactivateItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + after, execute: item)
    }

    private func deactivateNow() {
        deactivateItem?.cancel()
        deactivateItem = nil
        player?.stop()
        engine?.stop()
        // notifyOthersOnDeactivation un-ducks the runner's music.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in self?.deactivateSoon(after: 0.2) }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in self?.deactivateSoon(after: 0) }
    }
}
