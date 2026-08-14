package solutions.camboulive.run

import android.content.Intent
import android.os.Build
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Starts/stops IndoorSessionService, the foreground service that holds the app
// process while an indoor session records (docs/indoor-sessions.md).
//
// JS owns WHEN this runs, and starts it only while a live BLE heart-rate source
// is streaming — see src/indoor/session.ts for why the declared
// `connectedDevice` type depends on that.
@CapacitorPlugin(name = "IndoorSession")
class IndoorSessionPlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        // getDouble, not getLong: an epoch-ms value crossing the bridge is a
        // Number, and PluginCall.getLong returns its default for one — the same
        // trap the live-run notification hit (docs/live-tracking.md).
        val startedAt = call.getDouble("startedAtMs") ?: 0.0
        val intent = Intent(context, IndoorSessionService::class.java)
            .setAction(IndoorSessionService.ACTION_START)
            .putExtra(IndoorSessionService.EXTRA_STARTED_AT_MS, startedAt.toLong())
            .putExtra(IndoorSessionService.EXTRA_TITLE, call.getString("title") ?: "Indoor session")
            .putExtra(IndoorSessionService.EXTRA_TEXT, call.getString("text") ?: "")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        } catch (exception: Exception) {
            // Android 12+ refuses a foreground-service start from the background.
            // Recording continues without the service, exactly as before it
            // existed, so this is logged and swallowed rather than surfaced.
            Logger.error("Could not start the indoor session service", exception)
        }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            context.stopService(Intent(context, IndoorSessionService::class.java))
        } catch (exception: Exception) {
            Logger.error("Could not stop the indoor session service", exception)
        }
        call.resolve()
    }
}
