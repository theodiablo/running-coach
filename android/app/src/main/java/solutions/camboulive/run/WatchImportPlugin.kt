package solutions.camboulive.run

import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant

// Reads finished exercise (run/walk) sessions from Android Health Connect, so a
// run recorded on a watch and synced there (e.g. by Garmin Connect on Android
// 14+) can be imported without the phone having tracked it. Everything is
// returned raw (metres, seconds, exercise-type id, ISO strings) — all
// interpretation lives in the pure TypeScript mapping layer (src/watch/mapping.ts).
//
// This is a local module plugin (not an npm package) so it lives beside the app's
// existing @pianissimoproject/capacitor-health-connect dependency without
// disturbing it — that plugin reads continuous heart rate; this one reads whole
// exercise sessions, which its record-type surface can't.
@CapacitorPlugin(name = "WatchImport")
class WatchImportPlugin : Plugin() {

    // The scopes the import genuinely needs. `granted` is measured against THIS
    // set and nothing else — the route scope below is never part of it.
    private val readPermissions = setOf(
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(ElevationGainedRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
    )

    // The GPS route scope. Spelled out because the Jetpack SDK has no constant
    // for it, and kept OUT of readPermissions because the user grants it in
    // Health Connect rather than from our sheet — gating on it would report
    // every working connection as ungranted (docs/health-integrations.md).
    private val routePermission = "android.permission.health.READ_EXERCISE_ROUTES"

    // Asked for only on Android 14+, where Health Connect is part of the platform
    // and the request contract routes through the OS permission dialog, which
    // simply denies anything it won't grant. Below 34 the contract hands the raw
    // strings to the standalone Health Connect APK, and this permission is not in
    // the Jetpack SDK's vocabulary at all (no constant, no mapping) — an older
    // APK refusing the whole batch over it would leave a first-time connect with
    // NOTHING granted, breaking watch import outright on Android 8-13. The scope
    // is documented as un-requestable anyway, so including it there is pure
    // downside; the manifest declaration is what actually offers the user the
    // toggle, on every version.
    private val requestPermissions =
        if (Build.VERSION.SDK_INT >= 34) readPermissions + routePermission else readPermissions
    private val requestContract = PermissionController.createRequestPermissionResultContract()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context)

    @PluginMethod
    fun checkAvailability(call: PluginCall) {
        val status = try { HealthConnectClient.getSdkStatus(context) }
        catch (e: Exception) { HealthConnectClient.SDK_UNAVAILABLE }
        val availability = when (status) {
            HealthConnectClient.SDK_AVAILABLE -> "Available"
            // Strictly "installed but needs an update"; mapped to NotInstalled
            // because both resolve the same way for the user (Google Play shows
            // Update instead of Install) and the TS contract only acts on
            // "Available" vs not.
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "NotInstalled"
            else -> "NotSupported"
        }
        call.resolve(JSObject().put("availability", availability))
    }

    @PluginMethod
    fun checkHealthPermissions(call: PluginCall) {
        resolveGranted(call) { emptySet() }
    }

    @PluginMethod
    fun requestHealthPermissions(call: PluginCall) {
        try {
            val intent = requestContract.createIntent(context, requestPermissions)
            startActivityForResult(call, intent, "permsResult")
        } catch (e: Exception) {
            call.reject(e.message ?: "Couldn't open Health Connect permissions")
        }
    }

    // Reports the UNION of what the sheet returned and what Health Connect says is
    // granted right now. The activity result alone is not the whole truth: the
    // route scope can only be turned on inside Health Connect, so a user who did
    // that would otherwise not be seen — and if the extra scope ever made a sheet
    // return an empty result, re-reading the controller keeps a working
    // connection from being reported as revoked.
    @ActivityCallback
    fun permsResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val fromSheet = try { requestContract.parseResult(result.resultCode, result.data) }
        catch (e: Exception) { emptySet<String>() }
        resolveGranted(call) { fromSheet }
    }

    // Health Connect's current grants, unioned with `extra` (the sheet's own
    // result, when there was one). Nothing may escape the coroutine: an uncaught
    // exception there kills the app process and leaves the JS promise unsettled
    // (docs/health-integrations.md). `client()` is the realistic thrower — it
    // fails whenever Health Connect is absent. Cancellation is rethrown rather
    // than reported as "not granted", which would clear a live grant marker.
    private fun resolveGranted(call: PluginCall, extra: () -> Set<String>) {
        scope.launch {
            val granted = try { extra() + client().permissionController.getGrantedPermissions() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { try { extra() } catch (e2: Exception) { emptySet() } }
            call.resolve(try { grantJson(granted) } catch (e: Exception) { JSObject().put("granted", false) })
        }
    }

    // `granted` stays the import's own all-or-nothing gate over readPermissions;
    // `routes` rides alongside as an independent, purely informational flag.
    private fun grantJson(granted: Set<String>): JSObject = JSObject()
        .put("granted", granted.containsAll(readPermissions))
        .put("routes", granted.contains(routePermission))

    @PluginMethod
    fun readExerciseSessions(call: PluginCall) {
        val startStr = call.getString("startTime")
        val endStr = call.getString("endTime")
        if (startStr == null || endStr == null) {
            call.reject("startTime and endTime are required")
            return
        }
        scope.launch {
            try {
                val start = Instant.parse(startStr)
                val end = Instant.parse(endStr)
                val c = client()
                val filter = TimeRangeFilter.between(start, end)
                val sessions = JSArray()
                var pageToken: String? = null
                do {
                    val resp = c.readRecords(
                        ReadRecordsRequest(
                            recordType = ExerciseSessionRecord::class,
                            timeRangeFilter = filter,
                            pageToken = pageToken,
                        ),
                    )
                    for (rec in resp.records) {
                        sessions.put(sessionJson(c, rec))
                    }
                    pageToken = resp.pageToken
                } while (pageToken != null)
                call.resolve(JSObject().put("sessions", sessions))
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't read exercise sessions")
            }
        }
    }

    // The raw per-sample heart-rate stream over a window, restricted to one data
    // origin (the app that wrote the session) so a second app syncing the same run
    // can't interleave its samples. Uses the already-granted HeartRateRecord read
    // permission (the aggregates in sessionJson already need it), so this adds no
    // new manifest scope or Play health-data declaration. Called lazily by the TS
    // import layer for NEW runs only. The GPS route is a separate lazy read —
    // see readExerciseRoute.
    //   { startTime, endTime, dataOrigin? } → { samples: [{ bpm, t(ms epoch) }] }
    @PluginMethod
    fun readHeartRateSeries(call: PluginCall) {
        val startStr = call.getString("startTime")
        val endStr = call.getString("endTime")
        if (startStr == null || endStr == null) {
            call.reject("startTime and endTime are required")
            return
        }
        val origin = call.getString("dataOrigin")
        scope.launch {
            try {
                val start = Instant.parse(startStr)
                val end = Instant.parse(endStr)
                val c = client()
                val filter = TimeRangeFilter.between(start, end)
                val origins = if (origin != null) setOf(DataOrigin(origin)) else emptySet()
                val samples = JSArray()
                var pageToken: String? = null
                do {
                    val resp = c.readRecords(
                        ReadRecordsRequest(
                            recordType = HeartRateRecord::class,
                            timeRangeFilter = filter,
                            dataOriginFilter = origins,
                            pageToken = pageToken,
                        ),
                    )
                    for (rec in resp.records) {
                        for (s in rec.samples) {
                            val o = JSObject()
                            o.put("bpm", s.beatsPerMinute.toInt())
                            o.put("t", s.time.toEpochMilli())
                            samples.put(o)
                        }
                    }
                    pageToken = resp.pageToken
                } while (pageToken != null)
                call.resolve(JSObject().put("samples", samples))
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't read heart rate series")
            }
        }
    }

    // One session's GPS route, as the [lat, lng, t, alt] tuples a recorded run
    // stores. Per-session readRecord because a route is not an independent
    // record and never comes back on the bulk sweep above. Resolves (never
    // rejects) for every "no map" outcome so an unconsented route still imports
    // the run — see docs/health-integrations.md.
    //   { id } → { status, points: [[lat, lng, t(ms epoch), alt|null], …] }
    @PluginMethod
    fun readExerciseRoute(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("id is required")
            return
        }
        scope.launch {
            try {
                val rec = client().readRecord(ExerciseSessionRecord::class, id).record
                val points = JSArray()
                val status = when (val res = rec.exerciseRouteResult) {
                    is ExerciseRouteResult.Data -> {
                        for (loc in res.exerciseRoute.route) {
                            val p = JSArray()
                            p.put(loc.latitude)
                            p.put(loc.longitude)
                            p.put(loc.time.toEpochMilli())
                            // Altitude is optional per location; keep the slot so
                            // the tuple stays positional.
                            p.put(loc.altitude?.inMeters ?: JSONObject.NULL)
                            points.put(p)
                        }
                        "data"
                    }
                    is ExerciseRouteResult.ConsentRequired -> "consent-required"
                    is ExerciseRouteResult.NoData -> "none"
                    // A future subtype is not evidence the app wrote no route.
                    else -> "unavailable"
                }
                call.resolve(JSObject().put("status", status).put("points", points))
            } catch (e: Exception) {
                call.resolve(JSObject().put("status", "unavailable").put("points", JSArray()))
            }
        }
    }

    // Map one session + its aggregated metrics to a plain JSON object. Metrics are
    // aggregated over the session's own time window, restricted to the SAME data
    // origin that wrote the session — without the origin filter a time-window
    // aggregate mixes every app's records, so two apps both syncing the same run
    // (e.g. Garmin Connect and Zepp) could double distance. A failure leaves that
    // session's numbers null rather than dropping the session.
    private suspend fun sessionJson(c: HealthConnectClient, rec: ExerciseSessionRecord): JSObject {
        val o = JSObject()
        o.put("id", rec.metadata.id)
        o.put("dataOrigin", rec.metadata.dataOrigin.packageName)
        o.put("startTime", rec.startTime.toString())
        o.put("endTime", rec.endTime.toString())
        rec.startZoneOffset?.let { o.put("startZoneOffsetSec", it.totalSeconds) }
        o.put("exerciseType", rec.exerciseType)
        rec.title?.let { o.put("title", it) }
        try {
            val agg = c.aggregate(
                AggregateRequest(
                    metrics = setOf(
                        DistanceRecord.DISTANCE_TOTAL,
                        ElevationGainedRecord.ELEVATION_GAINED_TOTAL,
                        HeartRateRecord.BPM_AVG,
                        HeartRateRecord.BPM_MAX,
                        ExerciseSessionRecord.EXERCISE_DURATION_TOTAL,
                    ),
                    timeRangeFilter = TimeRangeFilter.between(rec.startTime, rec.endTime),
                    dataOriginFilter = setOf(rec.metadata.dataOrigin),
                ),
            )
            agg[DistanceRecord.DISTANCE_TOTAL]?.let { o.put("distanceM", it.inMeters) }
            agg[ElevationGainedRecord.ELEVATION_GAINED_TOTAL]?.let { o.put("elevationGainM", it.inMeters) }
            agg[HeartRateRecord.BPM_AVG]?.let { o.put("hrAvg", it.toInt()) }
            agg[HeartRateRecord.BPM_MAX]?.let { o.put("hrMax", it.toInt()) }
            agg[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.let { o.put("activeSec", it.seconds.toDouble()) }
        } catch (e: Exception) {
            // Aggregation unavailable for this session — leave its metrics unset.
        }
        return o
    }
}
