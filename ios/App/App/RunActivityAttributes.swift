import Foundation
import ActivityKit

// The Live Activity's data contract, compiled into BOTH the app target (which
// starts/updates the activity via LiveActivityPlugin) and the widget extension
// (which renders it) — the two must agree byte-for-byte for ActivityKit to
// decode the content state, which is why this is one shared file, not two
// copies.
//
// Same architecture as the Android lock-screen notification (see
// src/utils/runNotification.ts): the ticking duration is OS-rendered — the
// widget shows `Text(_, style: .timer)` off `startedAtMs` — so the clock keeps
// counting while the WebView's JS is throttled or suspended in the background;
// the JS seam only pushes `message` when the data (distance/pace/HR) changes.
@available(iOS 16.2, *)
struct RunActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// "Recording run" / "Run paused" — localized by the JS seam.
        var title: String
        /// "5.23 km · 5:42/km · ♥ 152" (paused: prefixed with the frozen time).
        var message: String
        /// Chronometer anchor (epoch ms, now - movingMs): the OS renders
        /// elapsed = now - startedAtMs, i.e. the run's MOVING time. Nil while
        /// paused → the widget shows a pause glyph instead of a ticking timer.
        var startedAtMs: Double?
        /// Guided-workout current step ("Rep 3/6 · 800 m · 4:35/km"),
        /// pre-localized by the JS seam. Nil on unguided runs (and from older
        /// app builds — optional keeps the contract backward-compatible).
        var step: String?
    }
}
