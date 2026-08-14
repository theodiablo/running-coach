package solutions.camboulive.run

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
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
// a JS timer that the background is about to stop.
class IndoorSessionService : Service() {

    companion object {
        const val ACTION_START = "solutions.camboulive.run.INDOOR_START"
        const val ACTION_STOP = "solutions.camboulive.run.INDOOR_STOP"
        const val EXTRA_STARTED_AT_MS = "startedAtMs"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        private const val CHANNEL_ID = "indoor_session"
        private const val NOTIFICATION_ID = 4711
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Indoor session"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
        // Epoch ms of the session start, already normalised by the plugin (a
        // bridge Number reaches Kotlin as a Double, not a Long).
        val startedAtMs = intent?.getLongExtra(EXTRA_STARTED_AT_MS, 0L) ?: 0L

        try {
            startForegroundCompat(buildNotification(title, text, startedAtMs))
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

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(title: String, text: String, startedAtMs: Long): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, title, NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }

        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val contentIntent = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
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
