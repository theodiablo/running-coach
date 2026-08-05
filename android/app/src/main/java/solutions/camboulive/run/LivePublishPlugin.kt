package solutions.camboulive.run

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicBoolean

// Native screen-off uploads for live run sharing (docs/live-sharing.md).
//
// Android freezes ALL WebView JS once the app is backgrounded, so the JS
// publisher goes silent exactly when a run is being recorded with the screen
// off. This plugin subscribes to the LIVE_FIX relay the patched
// background-geolocation plugin broadcasts for every fix its fold ACCEPTS
// (same gates and numbers as the lock-screen notification — never a second
// copy of them), buffers the points, and POSTs them to the live-publish edge
// function under the run's publish token every 30s.
//
// JS owns WHEN this runs (single-writer handoff): it arms on
// visibilitychange→hidden while a shared run is tracking, and disarms the
// moment JS is back — see src/geo/liveUpload.ts. Config is memory-only on
// purpose: the service dies with the process (bind-only), so after a kill
// nothing uploads until JS re-seeds, which is correct.
//
// Failure policy (the response contract of live-publish):
//   2xx {live:true}   → drop the sent batch (capped:true drops the rest too);
//   2xx {live:false}  → the broadcast is gone: soft-latch 5 min, hard-disable
//                       after 3 consecutive (a POST can land inside the JS
//                       publisher's legitimate delete-then-reinsert window at
//                       run start — one unlucky race must not kill the whole
//                       screen-off broadcast, and JS can't re-seed while frozen);
//   4xx               → the batch is poison: drop it, never retry it;
//   5xx / IOException → transient: keep the batch, retry on a later fix.
@CapacitorPlugin(name = "LivePublish")
class LivePublishPlugin : Plugin() {

    companion object {
        // Mirrors the patched plugin's LIVE_FIX_ACTION — keep the two in step.
        private const val LIVE_FIX_ACTION = "solutions.camboulive.run.LIVE_FIX"
        // Mirrors LIVE_PUBLISH_INTERVAL_MS (src/live/publisher.ts).
        private const val UPLOAD_INTERVAL_MS = 30_000L
        // Mirrors PUBLISH_MAX_POINTS (_shared/livePublish.mjs).
        private const val MAX_BATCH_POINTS = 300
        // Buffer cap ≈ 20+ min of worst-case 2s-apart fixes; past it, thin every
        // other point — the fix journal is the recovery layer and the JS re-base
        // heals fidelity, so loss here only thins what a watcher sees.
        private const val MAX_PENDING_POINTS = 600
        private const val SOFT_LATCH_MS = 5 * 60_000L
        private const val HARD_LATCH_AFTER = 3
        // Self-expiry: with no fresh seed the uploader must not outlive the
        // app's expressed intent — a crashed JS session that never sent
        // enabled:false is bounded by this, which is what keeps "location only
        // leaves the device during an active shared run" provable.
        private const val SEED_MAX_AGE_MS = 90 * 60_000L
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000
        private const val WAKE_LOCK_TIMEOUT_MS = 25_000L
    }

    // Guards config + pending buffer. NEVER held across network I/O: the
    // LIVE_FIX receiver runs on the main thread, and blocking it behind a
    // connect timeout would be an input-dispatch ANR in the foreground.
    private val uploadLock = Any()
    private var enabled = false
    private var url: String? = null
    private var anonKey: String? = null
    private var token: String? = null
    private var seedAtMs = 0L
    private var lastUploadAtMs = 0L
    private var latchedUntilMs = 0L
    private var consecutiveNotLive = 0
    // JSONArray-ready points: [lat,lng,tMs,alt|null], or JSONObject.NULL gaps.
    private val pending = ArrayDeque<Any>()
    private var lastStats: JSONObject? = null

    private val inFlight = AtomicBoolean(false)
    private var receiver: BroadcastReceiver? = null
    // Named so it is identifiable in an ANR/crash trace. Non-daemon is fine:
    // it is shut down in handleOnDestroy.
    private val executor = Executors.newSingleThreadExecutor(ThreadFactory { r ->
        Thread(r, "live-publish-upload")
    })

    override fun load() {
        super.load()
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                try {
                    onLiveFix(intent)
                } catch (e: Exception) {
                    Logger.error("LivePublish: fix handling failed", e)
                }
            }
        }
        LocalBroadcastManager.getInstance(context).registerReceiver(
            receiver!!, IntentFilter(LIVE_FIX_ACTION)
        )
    }

    override fun handleOnDestroy() {
        receiver?.let {
            try {
                LocalBroadcastManager.getInstance(context).unregisterReceiver(it)
            } catch (ignored: RuntimeException) {
            }
        }
        receiver = null
        executor.shutdown()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun setLiveUpload(call: PluginCall) {
        val on = call.getBoolean("enabled") ?: false
        synchronized(uploadLock) {
            if (on) {
                val u = call.getString("url")
                val k = call.getString("anonKey")
                val t = call.getString("token")
                if (u.isNullOrEmpty() || k.isNullOrEmpty() || t.isNullOrEmpty()) {
                    enabled = false
                } else {
                    // A re-seed (new token after a re-mint, or a fresh arm) also
                    // clears any latch: JS is telling us the broadcast is live.
                    enabled = true
                    url = u
                    anonKey = k
                    token = t
                    seedAtMs = System.currentTimeMillis()
                    latchedUntilMs = 0
                    consecutiveNotLive = 0
                }
            } else {
                // Disarm clears the buffer WITH the config: retained points
                // must never ride into a later run's broadcast.
                enabled = false
                token = null
                pending.clear()
                lastStats = null
            }
        }
        call.resolve()
    }

    // Main thread, per accepted fix. Buffer under the lock, then hand the
    // network off; nothing here may block.
    private fun onLiveFix(intent: Intent) {
        val now = System.currentTimeMillis()
        var shouldUpload = false
        synchronized(uploadLock) {
            if (!enabled) return
            if (now - seedAtMs > SEED_MAX_AGE_MS) {
                enabled = false
                pending.clear()
                return
            }
            if (intent.getBooleanExtra("gapBefore", false)) pending.addLast(JSONObject.NULL)
            val point = JSONArray()
            point.put(intent.getDoubleExtra("lat", 0.0))
            point.put(intent.getDoubleExtra("lng", 0.0))
            point.put(intent.getLongExtra("t", now))
            if (intent.hasExtra("alt")) point.put(intent.getDoubleExtra("alt", 0.0))
            else point.put(JSONObject.NULL)
            pending.addLast(point)
            // Past the cap, thin every other point (keep the newest).
            if (pending.size > MAX_PENDING_POINTS) {
                val thinned = ArrayDeque<Any>()
                var keep = false
                for (p in pending) {
                    if (p === JSONObject.NULL || keep) thinned.addLast(p)
                    keep = !keep
                }
                pending.clear()
                pending.addAll(thinned)
            }
            lastStats = buildStats(intent)
            shouldUpload = now >= latchedUntilMs &&
                now - lastUploadAtMs >= UPLOAD_INTERVAL_MS &&
                pending.isNotEmpty()
        }
        if (shouldUpload && inFlight.compareAndSet(false, true)) {
            // A timed partial wake lock covers the handoff: GNSS only holds the
            // AP awake while delivering the callback, and a device suspending
            // mid-TLS-handshake turns every screen-off upload into a timeout.
            val wakeLock = try {
                (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "run:live-publish")
                    .apply { setReferenceCounted(false); acquire(WAKE_LOCK_TIMEOUT_MS) }
            } catch (e: Exception) {
                null
            }
            try {
                executor.execute { uploadOnce(wakeLock) }
            } catch (e: Exception) {
                // shut-down executor — release everything and stand down
                try { wakeLock?.release() } catch (ignored: RuntimeException) {}
                inFlight.set(false)
            }
        }
    }

    private fun buildStats(intent: Intent): JSONObject {
        val stats = JSONObject()
        val km = intent.getDoubleExtra("km", Double.NaN)
        val durationSec = if (intent.hasExtra("durationSec")) intent.getLongExtra("durationSec", 0) else -1L
        val curPace = intent.getDoubleExtra("curPaceSecPerKm", Double.NaN)
        // Clamp non-finite before org.json ever sees it: JSONObject.put(double)
        // throws on NaN/Infinity, and avgPace at km 0 IS Infinity.
        if (km.isFinite() && km >= 0) stats.put("km", km)
        if (durationSec >= 0) stats.put("durationSec", durationSec)
        if (curPace.isFinite() && curPace > 0) stats.put("curPace", Math.round(curPace))
        if (km.isFinite() && km > 0.01 && durationSec > 0) {
            val avg = durationSec / km
            if (avg.isFinite() && avg > 0) stats.put("avgPace", Math.round(avg))
        }
        return stats
    }

    // Executor thread. Snapshot under the lock, POST outside it, then reconcile.
    private fun uploadOnce(wakeLock: PowerManager.WakeLock?) {
        try {
            val batch = JSONArray()
            var endpoint: String? = null
            var key: String? = null
            var tok: String? = null
            var stats: JSONObject? = null
            var sent = 0
            synchronized(uploadLock) {
                if (!enabled || pending.isEmpty()) return
                endpoint = url
                key = anonKey
                tok = token
                stats = lastStats
                for (p in pending) {
                    if (sent >= MAX_BATCH_POINTS) break
                    batch.put(p)
                    sent++
                }
            }
            if (endpoint == null || key == null || tok == null || batch.length() == 0) return

            val body = JSONObject()
            body.put("token", tok)
            body.put("points", batch)
            if (stats != null) body.put("stats", stats)
            val bytes = body.toString().toByteArray(Charsets.UTF_8)

            // One immediate retry on IOException: a keep-alive connection idled
            // out by the edge proxy fails on the FIRST write and is not retried
            // transparently for a POST.
            var response = try {
                post(endpoint!!, key!!, bytes)
            } catch (first: IOException) {
                post(endpoint!!, key!!, bytes)
            }

            val now = System.currentTimeMillis()
            synchronized(uploadLock) {
                when {
                    response.status in 200..299 -> {
                        lastUploadAtMs = now
                        val live = response.body?.optBoolean("live", false) == true
                        if (live) {
                            consecutiveNotLive = 0
                            repeat(minOf(sent, pending.size)) { pending.removeFirst() }
                            // capped: the server kept the broadcast fresh but
                            // skipped the concat — nothing retained here would
                            // ever land, so drop it instead of re-sending.
                            if (response.body?.optBoolean("capped", false) == true) pending.clear()
                        } else {
                            consecutiveNotLive++
                            if (consecutiveNotLive >= HARD_LATCH_AFTER) {
                                enabled = false
                                pending.clear()
                            } else {
                                latchedUntilMs = now + SOFT_LATCH_MS
                            }
                        }
                    }
                    response.status in 400..499 && response.status != 429 -> {
                        // Poison batch: never retry it. Points continue to accrue.
                        lastUploadAtMs = now
                        repeat(minOf(sent, pending.size)) { pending.removeFirst() }
                    }
                    else -> {
                        // 429/5xx: transient — keep the batch, back off a full
                        // interval before the next attempt.
                        lastUploadAtMs = now
                    }
                }
            }
        } catch (e: Exception) {
            // Network failure: keep the batch; the next accepted fix retries.
            synchronized(uploadLock) { lastUploadAtMs = System.currentTimeMillis() }
        } finally {
            try { wakeLock?.release() } catch (ignored: RuntimeException) {}
            inFlight.set(false)
        }
    }

    private class HttpResult(val status: Int, val body: JSONObject?)

    private fun post(endpoint: String, key: String, bytes: ByteArray): HttpResult {
        val conn = URL(endpoint).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        // A redirect would replay (307) or silently drop (301→GET) the body.
        conn.instanceFollowRedirects = false
        conn.doOutput = true
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("apikey", key)
        conn.setRequestProperty("Authorization", "Bearer $key")
        conn.outputStream.use { it.write(bytes) }
        val status = conn.responseCode
        // Fully drain and close, error stream included, or the connection is
        // never returned to the pool and every 30s cadence pays a fresh TLS
        // handshake — the single biggest battery cost in this file. No
        // disconnect() on the happy path for the same reason.
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        val body = try { if (text.isNotEmpty()) JSONObject(text) else null } catch (e: Exception) { null }
        return HttpResult(status, body)
    }
}
