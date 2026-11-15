package solutions.camboulive.run

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

// Google Play's own update flow, and where this copy came from (docs/release.md, "Store prompts").
// Every Play call is a Task with a failure listener, and each body is wrapped:
// an exception escaping here would kill the process, not reject the call.
@CapacitorPlugin(name = "StoreBridge")
class StoreBridgePlugin : Plugin() {

    private var updates: AppUpdateManager? = null

    private val installListener = InstallStateUpdatedListener { state ->
        try {
            val ret = JSObject()
            ret.put("status", statusName(state.installStatus()))
            ret.put("bytesDownloaded", state.bytesDownloaded())
            ret.put("totalBytes", state.totalBytesToDownload())
            notifyListeners("updateState", ret)
        } catch (_: Exception) { }
    }

    override fun load() {
        try {
            updates = AppUpdateManagerFactory.create(context).also { it.registerListener(installListener) }
        } catch (_: Exception) { updates = null }
    }

    override fun handleOnDestroy() {
        try { updates?.unregisterListener(installListener) } catch (_: Exception) { }
        super.handleOnDestroy()
    }

    // Rejects when Play can't answer (a sideloaded or debug install): the JS
    // side then falls back to app_config and the store link.
    @PluginMethod
    fun getUpdateInfo(call: PluginCall) {
        val mgr = updates ?: return call.reject("unavailable")
        try {
            mgr.appUpdateInfo
                .addOnSuccessListener { info ->
                    try {
                        val ret = JSObject()
                        ret.put("available", info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE)
                        ret.put("inProgress", info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS)
                        ret.put("versionCode", info.availableVersionCode())
                        ret.put("stalenessDays", info.clientVersionStalenessDays() ?: 0)
                        ret.put("flexibleAllowed", info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE))
                        ret.put("immediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE))
                        ret.put("status", statusName(info.installStatus()))
                        call.resolve(ret)
                    } catch (e: Exception) { call.reject(e.message ?: "info failed") }
                }
                .addOnFailureListener { e -> call.reject(e.message ?: "info failed") }
        } catch (e: Exception) { call.reject(e.message ?: "info failed") }
    }

    // Opens Play's flow. Resolves with what the runner chose ("accepted",
    // "declined", "failed"); a flexible download then reports via updateState.
    @PluginMethod
    fun startUpdate(call: PluginCall) {
        val mgr = updates ?: return call.reject("unavailable")
        val act = activity ?: return call.reject("no activity")
        val type = if (call.getBoolean("immediate", false) == true) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
        try {
            // An AppUpdateInfo starts one flow only, so always fetch a fresh one.
            mgr.appUpdateInfo
                .addOnSuccessListener { info ->
                    try {
                        val resumable = info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
                        if ((info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE && !resumable)
                            || !info.isUpdateTypeAllowed(type)) {
                            return@addOnSuccessListener call.reject("not allowed")
                        }
                        mgr.startUpdateFlow(info, act, AppUpdateOptions.newBuilder(type).build())
                            .addOnSuccessListener { code ->
                                val ret = JSObject()
                                ret.put("outcome", when (code) {
                                    android.app.Activity.RESULT_OK -> "accepted"
                                    android.app.Activity.RESULT_CANCELED -> "declined"
                                    else -> "failed"
                                })
                                call.resolve(ret)
                            }
                            .addOnFailureListener { e -> call.reject(e.message ?: "flow failed") }
                    } catch (e: Exception) { call.reject(e.message ?: "flow failed") }
                }
                .addOnFailureListener { e -> call.reject(e.message ?: "info failed") }
        } catch (e: Exception) { call.reject(e.message ?: "flow failed") }
    }

    // Installs a downloaded flexible update; Play restarts the app.
    @PluginMethod
    fun completeUpdate(call: PluginCall) {
        val mgr = updates ?: return call.reject("unavailable")
        try {
            mgr.completeUpdate()
                .addOnSuccessListener { call.resolve() }
                .addOnFailureListener { e -> call.reject(e.message ?: "complete failed") }
        } catch (e: Exception) { call.reject(e.message ?: "complete failed") }
    }

    // Whether Play installed this copy: only then can the runner post a public review.
    @PluginMethod
    fun getInstallInfo(call: PluginCall) {
        try {
            val pm = context.packageManager
            val installer = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                pm.getInstallSourceInfo(context.packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                pm.getInstallerPackageName(context.packageName)
            }
            val ret = JSObject()
            ret.put("fromStore", installer == "com.android.vending")
            call.resolve(ret)
        } catch (e: Exception) { call.reject(e.message ?: "install info failed") }
    }

    private fun statusName(status: Int): String = when (status) {
        InstallStatus.PENDING -> "pending"
        InstallStatus.DOWNLOADING -> "downloading"
        InstallStatus.DOWNLOADED -> "downloaded"
        InstallStatus.INSTALLING -> "installing"
        InstallStatus.INSTALLED -> "installed"
        InstallStatus.FAILED -> "failed"
        InstallStatus.CANCELED -> "canceled"
        else -> "unknown"
    }
}
