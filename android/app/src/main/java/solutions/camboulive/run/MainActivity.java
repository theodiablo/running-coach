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
        super.onCreate(savedInstanceState);

        // Restart instead of showing a frozen app when Android reclaims the
        // WebView renderer — the indoor session's failure mode, which runs no
        // foreground service to hold the process (docs/indoor-sessions.md).
        // Returning true tells the OS we handled it; returning false kills the
        // app process. A dead WebView can't be revived, so it is detached and
        // destroyed and the activity relaunched.
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
                            return true;
                        }

                        Intent restart = new Intent(getApplicationContext(), MainActivity.class);
                        restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                        startActivity(restart);
                        return true;
                    }
                }
            );
        }
    }
}
