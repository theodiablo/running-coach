package solutions.camboulive.run

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

// Local plugin for run-recording runtime permissions that neither
// @capacitor/geolocation nor @capacitor-community/background-geolocation requests:
//
//  • POST_NOTIFICATIONS (Android 13+): the background-geolocation foreground service
//    shows an ongoing "recording run" notification, silently suppressed on 13+
//    unless this is granted, so the user gets no visible sign a run is recording.
//
//  • ACCESS_BACKGROUND_LOCATION ("Allow all the time"): lets the foreground service
//    keep receiving GPS fixes with the screen off, which the "while using the app"
//    grant does not reliably do on every device. Declared in the main manifest and
//    shipped to all users (requires the Google Play background-location declaration).
//    The declared() guard stays as defensive code — it reports declared:false and
//    no-ops on any build/platform that does NOT declare the permission (e.g. a
//    future flavor that drops it), so the request path can never crash.
@CapacitorPlugin(
    name = "RunPermissions",
    permissions = [
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
        Permission(alias = "backgroundLocation", strings = [Manifest.permission.ACCESS_BACKGROUND_LOCATION]),
    ],
)
class RunPermissionsPlugin : Plugin() {

    // Below Android 13 there is no POST_NOTIFICATIONS runtime permission — the
    // foreground-service notification shows without one, so treat it as granted.
    private fun hasNotifications(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    @PluginMethod
    fun checkNotifications(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasNotifications()))
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (hasNotifications()) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback")
    }

    @PermissionCallback
    private fun notificationsCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasNotifications()))
    }

    // True if ACCESS_BACKGROUND_LOCATION is in THIS build's merged manifest. It is
    // now in the main manifest (shipped to all users), so this is true on Android;
    // the check remains as a guard so a build that ever drops the permission
    // short-circuits the request to a no-op instead of throwing.
    private fun isBackgroundLocationDeclared(): Boolean =
        try {
            context.packageManager
                .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions
                ?.contains(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == true
        } catch (e: Exception) { false }

    // Before Android 10 (Q) there is no separate background-location permission —
    // holding foreground location already covers background use.
    private fun hasBackgroundLocation(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    @PluginMethod
    fun checkBackgroundLocation(call: PluginCall) {
        val declared = isBackgroundLocationDeclared()
        call.resolve(
            JSObject()
                .put("declared", declared)
                .put("granted", declared && hasBackgroundLocation())
        )
    }

    @PluginMethod
    fun requestBackgroundLocation(call: PluginCall) {
        if (!isBackgroundLocationDeclared()) {
            call.resolve(JSObject().put("declared", false).put("granted", false))
            return
        }
        if (hasBackgroundLocation()) {
            call.resolve(JSObject().put("declared", true).put("granted", true))
            return
        }
        // Android 11+ routes this to a Settings screen ("Allow all the time"); the
        // caller only invokes it after foreground location is already granted, the
        // OS precondition for the request to be offered.
        requestPermissionForAlias("backgroundLocation", call, "backgroundLocationCallback")
    }

    @PermissionCallback
    private fun backgroundLocationCallback(call: PluginCall) {
        call.resolve(JSObject().put("declared", true).put("granted", hasBackgroundLocation()))
    }

    // Battery optimization can kill the recording app mid-run. Exposed so the
    // tracker can nudge once toward the exemption; reports "exempt" on any
    // failure so the nudge never nags when the answer is unknowable.
    @PluginMethod
    fun checkBatteryOptimization(call: PluginCall) {
        val ignoring = try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(context.packageName)
        } catch (e: Exception) { true }
        call.resolve(JSObject().put("ignoringOptimizations", ignoring))
    }

    // Opens the OS battery-optimization LIST screen (the user picks the app
    // there). Deliberately not the direct per-app request dialog, which needs
    // the Play-restricted REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission.
    @PluginMethod
    fun openBatteryOptimizationSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open battery optimization settings")
        }
    }
}
