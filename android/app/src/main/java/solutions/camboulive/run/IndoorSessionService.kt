package solutions.camboulive.run

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.Logger

// Foreground service that holds the app process for the duration of an INDOOR
// session (docs/indoor-sessions.md).
//
// A GPS run is held by the background-geolocation plugin's location service. An
// indoor session runs no geo watch, so nothing held it: a few minutes in the
// background was enough for Android to reclaim the WebView renderer, leaving the
// recorder painted on screen with its clock and heart rate frozen and every
// control dead.
//
// The declared type is `connectedDevice`, not `health`: what has to survive is
// the GATT link to the heart-rate strap and its notification stream, and the
// BLUETOOTH_CONNECT/BLUETOOTH_SCAN permissions that type requires are already
// held. `health` would mean adding ACTIVITY_RECOGNITION or BODY_SENSORS — a new
// runtime prompt and a new Data Safety entry — to describe the same thing less
// accurately. JS therefore starts this ONLY while a live BLE source is actually
// streaming (src/indoor/session.ts); a strapless session has no connected device
// and would be claiming a type it doesn't earn.
//
// The elapsed time is an OS-rendered chronometer anchored at the session start,
// so it keeps ticking natively while the WebView's JS is frozen — the same rule
// the run notification follows (docs/live-tracking.md): never push a clock from
// a JS timer that the background is about to stop. Heart rate follows the same
// rule, and by the same route as the run notification's: the patched
// bluetooth-le plugin broadcasts every beat straight from its GATT callback, so
// what is on the lock screen doesn't depend on JS being awake to push it.
class IndoorSessionService : Service() {

    companion object {
        const val ACTION_START = "solutions.camboulive.run.INDOOR_START"
        const val ACTION_STOP = "solutions.camboulive.run.INDOOR_STOP"
        const val EXTRA_STARTED_AT_MS = "startedAtMs"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        private const val CHANNEL_ID = "indoor_session"
        private const val NOTIFICATION_ID = 4711

        // The live HR relay, sent by the patched bluetooth-le plugin. Mirrored
        // in BluetoothLe.kt and BackgroundGeolocation.java — keep the three in
        // step. The two staleness/rate constants match the run notification's,
        // so a strap reads the same on either screen's notification.
        private const val HR_SAMPLE_ACTION = "solutions.camboulive.run.HR_SAMPLE"
        private const val HR_STALE_MS = 90000L
        private const val HR_RENDER_MIN_MS = 5000L
    }

    private var title = "Indoor session"
    private var text = ""
    private var startedAtMs = 0L
    private var hrBpm = 0
    private var hrAtMs = 0L
    private var hrRenderedAt = 0L
    private var shown: String? = null
    private var hrReceiver: BroadcastReceiver? = null
    // Cached, never rebuilt: FLAG_CANCEL_CURRENT on a re-posting notification
    // invalidates the record every holder points at, SystemUI included, so the
    // notification cancels its own tap target (see CLAUDE.md).
    private var contentIntent: PendingIntent? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        title = intent?.getStringExtra(EXTRA_TITLE) ?: title
        text = intent?.getStringExtra(EXTRA_TEXT) ?: text
        // Epoch ms of the session start, already normalised by the plugin (a
        // bridge Number reaches Kotlin as a Double, not a Long).
        startedAtMs = intent?.getLongExtra(EXTRA_STARTED_AT_MS, 0L) ?: 0L

        try {
            shown = liveText()
            startForegroundCompat(buildNotification(shown!!))
            registerHrReceiver()
        } catch (exception: Exception) {
            // A foreground start refused (no notification permission, or an
            // Android 12+ background-start restriction) must never take the
            // session down with it — recording continues in the WebView exactly
            // as it did before this service existed.
            Logger.error("Indoor session service could not start in foreground", exception)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        hrReceiver?.let {
            try { unregisterReceiver(it) } catch (ignored: RuntimeException) { /* never registered */ }
        }
        hrReceiver = null
        super.onDestroy()
    }

    // A framework broadcast rather than a LocalBroadcastManager one: the sender
    // is another plugin's module, which doesn't depend on that library.
    // NOT_EXPORTED plus the sender's setPackage keeps it inside the app.
    private fun registerHrReceiver() {
        if (hrReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                try {
                    onHrSample(intent?.getIntExtra("bpm", 0) ?: 0, intent?.getLongExtra("t", 0L) ?: 0L)
                } catch (exception: Exception) {
                    // A display failure must never cost us anything else.
                    Logger.error("Failed to fold live HR", exception)
                }
            }
        }
        ContextCompat.registerReceiver(this, receiver, IntentFilter(HR_SAMPLE_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        hrReceiver = receiver
    }

    // Never trusts a beat older than the one it holds (the relay and the JS
    // stream are two clocks on one sensor), and re-renders at most every
    // HR_RENDER_MIN_MS — the reading moves one digit and nothing else on this
    // notification changes, so a 1-2Hz strap would otherwise re-post per beat.
    private fun onHrSample(bpm: Int, t: Long) {
        if (bpm <= 0 || t <= 0 || t < hrAtMs) return
        hrBpm = bpm
        hrAtMs = t
        if (t - hrRenderedAt < HR_RENDER_MIN_MS) return
        hrRenderedAt = t
        render()
    }

    private fun render() {
        val message = liveText()
        if (message == shown) return
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(message))
            shown = message
        } catch (exception: Exception) {
            // Best-effort: the session matters, its notification's bpm doesn't.
            Logger.error("Failed to update indoor notification", exception)
        }
    }

    // The session line plus " · ♥ 152" while the reading is still trustworthy —
    // the same suffix, and the same staleness rule, as the run notification's
    // liveMessage (BackgroundGeolocation.java).
    private fun liveText(): String {
        val fresh = hrAtMs > 0 && System.currentTimeMillis() - hrAtMs < HR_STALE_MS
        return if (hrBpm > 0 && fresh) "$text · ♥ $hrBpm" else text
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(message: String): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, title, NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }

        if (contentIntent == null) {
            val open = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            contentIntent = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(message)
            // The app's own icon, not a framework one: a notification without a
            // valid app icon opens app settings when tapped instead of the app
            // (the same note the background-geolocation patch carries).
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        // `when` IS the chronometer base and stays in the System.currentTimeMillis
        // timebase — the same contract the run notification's chronometer uses
        // (chronometerStartMs in the background-geolocation patch). Do not
        // convert to elapsedRealtime here.
        if (startedAtMs > 0) {
            builder.setWhen(startedAtMs).setUsesChronometer(true).setShowWhen(true)
        }
        return builder.build()
    }
}
