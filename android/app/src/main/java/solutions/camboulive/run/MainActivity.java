package solutions.camboulive.run;

import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    // Static so it survives the activity being torn down and relaunched below —
    // an instance field would reset on every restart and never see a loop.
    private static final long RENDERER_RESTART_MIN_INTERVAL_MS = 10_000;
    private static long lastRendererRestartMs = 0;

    // A renderer died while we were in the background and the rebuild is owed to
    // the next foreground. Static for the same reason as above: onRenderProcessGone
    // can be followed by an activity recreation before onStart runs.
    private static boolean rendererRebuildPending = false;

    // Whether this activity is between onStart and onStop, i.e. has a visible
    // window. Tracked by hand rather than read off getLifecycle(): the AndroidX
    // lifecycle classes are not otherwise used by the app or by Capacitor, and
    // nothing in PR CI compiles this file (the APK build is opt-in via the `apk`
    // label), so a transitive-dependency gamble here would only surface at
    // release. A boolean flipped in the two callbacks says the same thing.
    private boolean started = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins. Must be registered before super.onCreate so the bridge
        // picks them up: WatchImport (post-run exercise import from Health Connect),
        // RunPermissions (POST_NOTIFICATIONS for the recording-run notification),
        // LivePublish (screen-off live-share uploads), WorkoutGuide (screen-off
        // guided-workout cues) and IndoorSession (the foreground service that
        // holds the process while an indoor session records).
        registerPlugin(WatchImportPlugin.class);
        registerPlugin(RunPermissionsPlugin.class);
        registerPlugin(LivePublishPlugin.class);
        registerPlugin(WorkoutGuidePlugin.class);
        registerPlugin(IndoorSessionPlugin.class);
        registerPlugin(ShellDiagPlugin.class);
        super.onCreate(savedInstanceState);

        // Shell diagnostics (ShellDiagLog). Always on, unlike the GPS log: these
        // events are rare, and they are the ones nobody thinks to enable logging
        // for before the failure they explain. `savedInstanceState == null` marks
        // a genuine cold boot — a create with no preceding renderer-gone is how a
        // killed PROCESS is told apart from a reclaimed renderer.
        ShellDiagLog.record(this, "create",
            savedInstanceState == null ? "cold" : "restored");

        // Recover instead of showing a frozen app when Android reclaims the
        // WebView renderer of a backgrounded recording session
        // (docs/indoor-sessions.md). Returning true tells the OS we handled it;
        // returning false kills the app process — which would take the recording
        // down with it, so this must always return true.
        //
        // Null when the device has no usable WebView: BridgeActivity.onCreate
        // bails to the no_webview layout before it builds the bridge.
        if (bridge != null) {
            // Keep the renderer off the low-memory killer's doorstep. A foreground
            // service raises the importance of the APP process, but the WebView
            // renderer is a separate sandboxed process, and the default policy
            // WAIVES its priority as soon as the WebView stops being visible —
            // exactly when a session is recording with the screen off, which is why
            // IndoorSessionService alone did not stop the freeze
            // (docs/indoor-sessions.md).
            WebView webView = bridge.getWebView();
            if (webView != null)
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                        boolean crashed = detail.didCrash();
                        Logger.error("WebView renderer gone (didCrash=" + crashed + ")");
                        // Recorded BEFORE anything else, with the memory state at
                        // the moment of death: whether this was a low-memory
                        // reclaim is exactly the question three attempted fixes
                        // have assumed the answer to.
                        ShellDiagLog.record(getApplicationContext(),
                            ShellDiagLog.KIND_RENDERER_GONE,
                            "didCrash=" + crashed + " foreground=" + started + " "
                                + ShellDiagLog.memorySnapshot(getApplicationContext()));
                        // A dead renderer can never be revived and the platform
                        // forbids reusing its WebView, so detaching and destroying
                        // it is not optional — only the timing of the rebuild is.
                        ViewGroup parent = (ViewGroup) webView.getParent();
                        if (parent != null) parent.removeView(webView);
                        webView.destroy();

                        // Relaunching a renderer that dies on every page load would
                        // loop forever. A reclaim (didCrash false) is what we are
                        // here to recover and never repeats immediately; a crash
                        // that recurs inside the window is the app failing to boot,
                        // so stop and leave the dead screen — recoverable by hand,
                        // rather than a loop the user can't escape.
                        long now = SystemClock.elapsedRealtime();
                        boolean looping = now - lastRendererRestartMs < RENDERER_RESTART_MIN_INTERVAL_MS;
                        lastRendererRestartMs = now;
                        if (crashed && looping) {
                            Logger.error("Renderer crashed again within "
                                + RENDERER_RESTART_MIN_INTERVAL_MS + "ms — not restarting again");
                            ShellDiagLog.record(getApplicationContext(),
                                "renderer-loop-guard", "not restarting again");
                            return true;
                        }

                        // A reclaim happens in the BACKGROUND, which is the one
                        // place this must NOT relaunch. Two reasons, and both cost
                        // the runner their run:
                        //
                        //  • Since Android 10 a background app cannot start an
                        //    activity (a foreground service is not an exemption),
                        //    so the launch below is silently blocked and the user
                        //    returns to an activity with no WebView in it — dead
                        //    until a force-quit.
                        //  • Tearing this activity down destroys the plugins with
                        //    it, and BackgroundGeolocation.handleOnDestroy stops
                        //    the location service. Recording would END, in the
                        //    background, without anyone being told.
                        //
                        // Leaving it alone costs nothing: the process, the
                        // foreground service and the native fold all keep running,
                        // so fixes keep landing in the notification and the fix
                        // journal exactly as they do while JS is merely frozen. The
                        // UI is dead, but nobody is looking at it. Rebuild on the
                        // next foreground instead, where starting an activity is
                        // allowed and the runner is present to see the recovery.
                        if (!started) {
                            rendererRebuildPending = true;
                            Logger.error("Renderer gone in the background — rebuilding on next foreground");
                            ShellDiagLog.record(getApplicationContext(),
                                "rebuild-deferred", "waiting for foreground");
                            return true;
                        }

                        relaunch();
                        return true;
                    }
                }
            );
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        started = true;
        // The rebuild owed by a background reclaim. Here we have a visible window,
        // so the activity start is permitted; recording stops as the old activity
        // goes down, and the cold boot picks the run back up from the recovery
        // buffer plus the fix journal — which by now holds every point the service
        // recorded while the WebView was dead.
        ShellDiagLog.record(this, "foreground", ShellDiagLog.powerSnapshot(this));
        if (rendererRebuildPending) {
            rendererRebuildPending = false;
            ShellDiagLog.record(this, "rebuild", "relaunching after background reclaim");
            relaunch();
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        started = false;
        // The anchor every later event is read against: a renderer-gone or a
        // cold create AFTER this one says what died while the app was away.
        ShellDiagLog.record(this, "background", ShellDiagLog.powerSnapshot(this));
    }

    private void relaunch() {
        Intent restart = new Intent(getApplicationContext(), MainActivity.class);
        restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(restart);
    }
}
