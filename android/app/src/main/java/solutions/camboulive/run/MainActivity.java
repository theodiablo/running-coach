package solutions.camboulive.run;

import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Logger;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins. Must be registered before super.onCreate so the bridge
        // picks them up: WatchImport (post-run exercise import from Health Connect),
        // RunPermissions (POST_NOTIFICATIONS for the recording-run notification),
        // LivePublish (screen-off live-share uploads) and WorkoutGuide
        // (screen-off guided-workout cues).
        registerPlugin(WatchImportPlugin.class);
        registerPlugin(RunPermissionsPlugin.class);
        registerPlugin(LivePublishPlugin.class);
        registerPlugin(WorkoutGuidePlugin.class);
        super.onCreate(savedInstanceState);

        // Recover from a dead WebView renderer instead of showing a frozen app.
        //
        // Android kills the renderer process of a backgrounded app under memory
        // pressure. A GPS run survives it because the location foreground service
        // holds the process, but an INDOOR session runs no service at all
        // (docs/indoor-sessions.md), so it is the likely victim. The WebView then
        // keeps painting its last frame — the recorder still on screen, clock and
        // heart rate frozen at their final values — while no JS runs at all, so
        // Pause and Finish do nothing and only a force-quit clears it.
        //
        // Returning true tells the OS we handled it (returning false kills the
        // app process). The dead WebView can never be revived, so it is detached
        // and destroyed and the activity restarted: the app cold-boots, and the
        // interrupted session is offered by the recovery buffer the recorder
        // persisted on the way to the background.
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    Logger.error("WebView renderer gone (didCrash=" + detail.didCrash() + ") — restarting");
                    ViewGroup parent = (ViewGroup) webView.getParent();
                    if (parent != null) parent.removeView(webView);
                    webView.destroy();

                    Intent restart = new Intent(getApplicationContext(), MainActivity.class);
                    restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    startActivity(restart);
                    finish();
                    return true;
                }
            }
        );
    }
}
