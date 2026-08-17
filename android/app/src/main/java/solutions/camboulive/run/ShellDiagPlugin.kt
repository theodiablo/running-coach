package solutions.camboulive.run

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Reads back the shell diagnostics MainActivity writes (ShellDiagLog) so the
// hidden developer panel can show them. Read-only plus a clear — nothing here
// influences recording.
@CapacitorPlugin(name = "ShellDiag")
class ShellDiagPlugin : Plugin() {

    @PluginMethod
    fun getEvents(call: PluginCall) {
        val ret = JSObject()
        ret.put("events", ShellDiagLog.read(context))
        ret.put("device", ShellDiagLog.deviceLabel())
        call.resolve(ret)
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        ShellDiagLog.clear(context)
        call.resolve()
    }
}
