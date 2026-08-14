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
}
