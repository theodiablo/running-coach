package solutions.camboulive.run

import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.PowerManager
import android.os.Build
import com.getcapacitor.Logger
import org.json.JSONArray
import org.json.JSONObject

// Durable, native-side record of what happened to the SHELL — the events the
// JS diagnostics (src/geo/trackLog.ts) can never contain, because JS is dead or
// frozen when they happen.
//
// The GPS log answers "did fixes keep arriving with the screen off". It cannot
// answer the question that outlived three attempted fixes: when a backgrounded
// recorder comes back frozen, WHAT died — the WebView renderer, or the whole app
// process? The JS log just stops in both cases, and a stopped log looks the same
// as a frozen one. So this is written from MainActivity's lifecycle callbacks and
// from onRenderProcessGone, in Java, to SharedPreferences with commit() (not
// apply(), which is asynchronous and can lose the write to the very kill it is
// describing).
//
// Read it back through ShellDiagPlugin → src/diag/shellLog.ts. The timeline it
// produces is diagnostic on its own:
//
//   stop → renderer-gone → start        the renderer was reclaimed; the process
//                                       lived, and recording carried on natively
//   stop → create (no renderer-gone)    the whole process was killed
//   stop → start (nothing between)      nothing died; JS was merely frozen
//
// **Always on, unlike the GPS log.** These events are rare (a handful per app
// lifetime) and are exactly the ones nobody thinks to enable logging for
// beforehand — the failure has to be caught the first time it happens, not the
// second. The per-fix instrumentation stays behind its flag because that one is
// per-callback and would cost every run.
object ShellDiagLog {

    private const val PREFS = "shell_diag"
    private const val KEY = "events"
    // A renderer death is the whole point of this log, so routine
    // foreground/background churn must never push one out of the ring. The two
    // classes are trimmed separately and re-merged in time order.
    private const val MAX_CRITICAL = 20
    private const val MAX_ROUTINE = 60
    const val KIND_RENDERER_GONE = "renderer-gone"

    // @JvmOverloads so the Java caller in MainActivity can omit `detail`.
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun record(context: Context?, kind: String, detail: String? = null) {
        if (context == null) return
        try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val events = parse(prefs.getString(KEY, null))
            val event = JSONObject()
            event.put("at", System.currentTimeMillis())
            event.put("kind", kind)
            if (detail != null) event.put("detail", detail)
            events.add(event)
            prefs.edit().putString(KEY, trim(events).toString()).commit()
        } catch (exception: Exception) {
            // Diagnostics must never be the thing that breaks the app.
            Logger.error("ShellDiagLog: could not record $kind", exception)
        }
    }

    // Memory state at the moment of a renderer death — the direct read on whether
    // this was a low-memory reclaim (the standing assumption behind the renderer
    // priority policy) or something else entirely. Cheap, and only ever called on
    // the rare path.
    @JvmStatic
    fun memorySnapshot(context: Context?): String {
        if (context == null) return "mem=?"
        return try {
            val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            val mb = { bytes: Long -> bytes / (1024 * 1024) }
            "avail=${mb(info.availMem)}MB total=${mb(info.totalMem)}MB " +
                "threshold=${mb(info.threshold)}MB low=${info.lowMemory}"
        } catch (exception: Exception) {
            "mem=?"
        }
    }

    // Power-management state at the moment something interesting happened.
    //
    // The WebView renderer is a SEPARATE process from the app, so the location
    // foreground service that protects the app protects nothing here — and
    // battery saver, Doze and a restricted standby bucket all make Android
    // freeze background processes harder. A frozen (SIGSTOP'd) renderer that is
    // not thawed promptly on resume looks exactly like what is being chased: a
    // stale frame, no requestAnimationFrame, and dead input, because hit-testing
    // happens in that process too.
    //
    // Recorded rather than argued about. Every read here is cheap and needs no
    // permission.
    @JvmStatic
    fun powerSnapshot(context: Context?): String {
        if (context == null) return "power=?"
        return try {
            val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val parts = mutableListOf(
                "saver=${power.isPowerSaveMode}",
                "doze=${power.isDeviceIdleMode}",
                "unrestricted=${power.isIgnoringBatteryOptimizations(context.packageName)}",
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
                if (usage != null) parts.add("bucket=${usage.appStandbyBucket}")
            }
            parts.joinToString(" ")
        } catch (exception: Exception) {
            "power=?"
        }
    }

    @JvmStatic
    fun deviceLabel(): String = "${Build.MANUFACTURER} ${Build.MODEL} / API ${Build.VERSION.SDK_INT}"

    @JvmStatic
    @Synchronized
    fun read(context: Context?): JSONArray {
        if (context == null) return JSONArray()
        return try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val array = JSONArray()
            for (event in parse(prefs.getString(KEY, null))) array.put(event)
            array
        } catch (exception: Exception) {
            JSONArray()
        }
    }

    @JvmStatic
    @Synchronized
    fun clear(context: Context?) {
        if (context == null) return
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).commit()
        } catch (exception: Exception) {
            Logger.error("ShellDiagLog: could not clear", exception)
        }
    }

    private fun parse(raw: String?): MutableList<JSONObject> {
        val out = mutableListOf<JSONObject>()
        if (raw.isNullOrEmpty()) return out
        try {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                array.optJSONObject(i)?.let { out.add(it) }
            }
        } catch (exception: Exception) {
            // Corrupt store — start a fresh log rather than lose the ability to write.
        }
        return out
    }

    private fun trim(events: MutableList<JSONObject>): JSONArray {
        val critical = events.filter { it.optString("kind") == KIND_RENDERER_GONE }
        val routine = events.filter { it.optString("kind") != KIND_RENDERER_GONE }
        val kept = (critical.takeLast(MAX_CRITICAL) + routine.takeLast(MAX_ROUTINE))
            .sortedBy { it.optLong("at") }
        val array = JSONArray()
        for (event in kept) array.put(event)
        return array
    }
}
