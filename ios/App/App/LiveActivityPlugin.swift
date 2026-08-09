import Foundation
import Capacitor
import ActivityKit

// The iOS half of the lock-screen live run stats seam
// (src/geo/liveNotification.ts): starts / updates / ends the run's Live
// Activity (lock screen + Dynamic Island). Mirrors the Android patched
// updateNotification contract:
//   - push({title, message, chronometerStartMs?}) → {updated: boolean} —
//     starts the activity if none is running, else updates it in place. false
//     when Live Activities are unavailable (iOS < 16.2, user-disabled, or the
//     OS refused the request) so the JS seam retries rather than assuming the
//     push landed.
//   - end() — ends and dismisses the activity (run stopped/discarded).
// The ticking clock is OS-rendered off chronometerStartMs (see
// RunActivityAttributes) — this plugin is only called when DATA changes.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "push", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    // The single in-flight activity (one run at a time). Typed accessors wrap
    // an untyped store because Swift forbids @available on stored properties.
    private static var _current: Any?
    @available(iOS 16.2, *)
    private static var current: Activity<RunActivityAttributes>? {
        get { _current as? Activity<RunActivityAttributes> }
        set { _current = newValue }
    }

    @objc func push(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve(["updated": false])
            return
        }
        guard let title = call.getString("title"), let message = call.getString("message") else {
            call.reject("title and message are required")
            return
        }
        let state = RunActivityAttributes.ContentState(
            title: title,
            message: message,
            startedAtMs: call.getDouble("chronometerStartMs"),
            step: call.getString("step")
        )
        let content = ActivityContent(state: state, staleDate: nil)
        Task {
            if let activity = Self.current, activity.activityState == .active {
                await activity.update(content)
                call.resolve(["updated": true])
                return
            }
            // No live activity yet (first push of a run, or the user/system
            // dismissed the previous one) — request a fresh one. Requesting is
            // only allowed with Live Activities enabled and the app foregrounded;
            // both hold on the Start tap, and a false here is retried by the seam.
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                call.resolve(["updated": false])
                return
            }
            do {
                Self.current = try Activity.request(
                    attributes: RunActivityAttributes(),
                    content: content
                )
                call.resolve(["updated": true])
            } catch {
                call.resolve(["updated": false])
            }
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve()
            return
        }
        Task {
            // End every activity of our type, not just the tracked one — a
            // relaunched app (crash recovery) loses the static reference but the
            // OS may still be showing the old card.
            for activity in Activity<RunActivityAttributes>.activities {
                await activity.end(activity.content, dismissalPolicy: .immediate)
            }
            Self.current = nil
            call.resolve()
        }
    }
}
