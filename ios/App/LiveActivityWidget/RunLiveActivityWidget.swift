import ActivityKit
import WidgetKit
import SwiftUI

// The run Live Activity's UI: lock-screen banner + Dynamic Island. Renders
// RunActivityAttributes.ContentState (shared with the app target). The ticking
// clock is `Text(_, style: .timer)` — rendered and advanced by the OS itself,
// no updates from any process — anchored at startedAtMs (now - movingMs, so it
// shows moving time). While paused, startedAtMs is nil and the frozen time is
// already part of `message` (same convention as the Android notification).
//
// Palette matches the app: dark slate background (#0f172a), orange-500 accents.
struct RunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            // Lock-screen / banner presentation.
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: context.state.startedAtMs == nil ? "pause.fill" : "figure.run")
                        .foregroundStyle(.orange)
                    Text(context.state.title)
                        .font(.headline)
                    Spacer()
                    timer(context.state)
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                }
                Text(context.state.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let step = context.state.step, !step.isEmpty {
                    Text(step)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
            .padding()
            .activityBackgroundTint(Color(red: 0.06, green: 0.09, blue: 0.16))
            .activitySystemActionForegroundColor(.orange)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack {
                        Image(systemName: "figure.run").foregroundStyle(.orange)
                        Text(context.state.title).font(.caption)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    timer(context.state)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.message).font(.caption)
                        if let step = context.state.step, !step.isEmpty {
                            Text(step).font(.caption.weight(.semibold)).foregroundStyle(.orange)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "figure.run").foregroundStyle(.orange)
            } compactTrailing: {
                timer(context.state)
                    .monospacedDigit()
                    .frame(maxWidth: 56)
            } minimal: {
                Image(systemName: "figure.run").foregroundStyle(.orange)
            }
        }
    }

    // OS-ticked count-up timer while tracking; a pause glyph while paused (the
    // frozen duration is in the message text).
    @ViewBuilder
    private func timer(_ state: RunActivityAttributes.ContentState) -> some View {
        if let ms = state.startedAtMs {
            Text(Date(timeIntervalSince1970: ms / 1000), style: .timer)
        } else {
            Image(systemName: "pause.fill").foregroundStyle(.orange)
        }
    }
}
