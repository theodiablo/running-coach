package solutions.camboulive.run

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.util.Locale

// Native guided-workout engine for screen-off runs (docs/guided-workouts.md).
//
// Android freezes ALL WebView JS once the app is backgrounded, so "rep done,
// recover now" must be decided and voiced natively. This plugin mirrors the JS
// engine (src/utils/workout.ts — keep the two in step): it consumes the same
// LIVE_FIX relay as LivePublish for cumulative distance / moving time / pace
// (one native fold, shared consumers — never a second copy of the gates), runs
// a Handler deadline for time-bound steps (a standing recovery emits no fixes),
// and on each boundary plays a tone + speaks the seeded announcement (Android
// TTS), vibrates, and re-posts its own silent "current step" notification.
//
// JS owns the truth (src/geo/workoutGuide.ts): every seed re-bases the full
// engine state — schedule, step index/anchors, cumulative km / moving sec,
// tracking/muted — and carries pre-localized strings (no i18n here). Between
// seeds this only extrapolates, so the two ends can drift at most one boundary
// and the next foreground render snaps them together. Config is memory-only on
// purpose (dies with the process; JS re-seeds on the next mount), with the same
// self-expiry safety as LivePublish so a crashed JS session can't leave a
// notification talking to itself for hours.
@CapacitorPlugin(name = "WorkoutGuide")
class WorkoutGuidePlugin : Plugin() {

    companion object {
        // Mirrors the patched plugin's LIVE_FIX_ACTION — keep the two in step.
        private const val LIVE_FIX_ACTION = "solutions.camboulive.run.LIVE_FIX"
        private const val CHANNEL_ID = "workout_guide"
        private const val NOTIFICATION_ID = 20482
        // Mirrors the JS hook's pace-cue discipline (useGuidedWorkout).
        private const val PACE_CUE_MIN_INTO_STEP_SEC = 20.0
        private const val PACE_CUE_EVERY_MS = 25_000L
        // Self-expiry: without a fresh seed the guide must not outlive the run
        // that armed it (matches the recovery buffer's live window).
        private const val SEED_MAX_AGE_MS = 6 * 3600_000L
        private const val TONE_MS = 220
    }

    private class Step(
        val kind: String,
        val m: Double?,
        val sec: Double?,
        val pace: Double?,
        val band: Double?,
        val announce: String,
        val notif: String,
    )

    // All engine state is touched on the main thread only: the receiver and
    // Handler run there, and seed/clear post onto it from the plugin executor.
    private val handler = Handler(Looper.getMainLooper())
    private var enabled = false
    private var steps: List<Step> = emptyList()
    private var loopFrom = -1
    private var idx = 0
    private var stepStartKm = 0.0
    private var stepStartSec = 0.0
    private var km = 0.0
    private var movingSec = 0.0
    private var movingAnchorWall = 0L
    private var tracking = false
    private var finished = false
    private var muted = false
    private var notifTitle = ""
    private var doneText = ""
    private var fastText = ""
    private var slowText = ""
    private var seedAtMs = 0L
    private var lastPaceCueAt = 0L
    private var lastCurPace = 0.0
    private var announcedIdx = -1

    private val deadline = Runnable { evaluate() }
    private var receiver: BroadcastReceiver? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsLang = ""
    private var toneGen: ToneGenerator? = null

    override fun load() {
        super.load()
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                try {
                    onLiveFix(intent)
                } catch (e: Exception) {
                    Logger.error("WorkoutGuide: fix handling failed", e)
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
        handler.removeCallbacks(deadline)
        try { tts?.shutdown() } catch (ignored: RuntimeException) {}
        tts = null
        try { toneGen?.release() } catch (ignored: RuntimeException) {}
        toneGen = null
        super.handleOnDestroy()
    }

    // Numbers cross the bridge as JSON: a whole number arrives as Long/Integer,
    // a fractional one as Double — read tolerantly (the patch's optNumber rule).
    private fun num(obj: JSONObject, key: String): Double? =
        (obj.opt(key) as? Number)?.toDouble()

    @PluginMethod
    fun seed(call: PluginCall) {
        val data = call.data
        handler.post {
            try {
                applySeed(data)
            } catch (e: Exception) {
                Logger.error("WorkoutGuide: seed failed", e)
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        handler.post { teardown() }
        call.resolve()
    }

    private fun applySeed(data: JSONObject) {
        val stepsJson = data.optJSONArray("steps") ?: return
        val parsed = ArrayList<Step>(stepsJson.length())
        for (i in 0 until stepsJson.length()) {
            val s = stepsJson.optJSONObject(i) ?: continue
            parsed.add(Step(
                kind = s.optString("kind"),
                m = num(s, "m"),
                sec = num(s, "sec"),
                pace = num(s, "pace"),
                band = num(s, "band"),
                announce = s.optString("announce"),
                notif = s.optString("notif"),
            ))
        }
        if (parsed.isEmpty()) return
        steps = parsed
        loopFrom = num(data, "loopFrom")?.toInt() ?: -1
        idx = num(data, "idx")?.toInt() ?: 0
        stepStartKm = num(data, "stepStartKm") ?: 0.0
        stepStartSec = num(data, "stepStartSec") ?: 0.0
        km = num(data, "km") ?: 0.0
        movingSec = num(data, "movingSec") ?: 0.0
        movingAnchorWall = System.currentTimeMillis()
        tracking = data.optBoolean("tracking", false)
        finished = data.optBoolean("finished", false)
        muted = data.optBoolean("muted", false)
        val texts = data.optJSONObject("texts")
        notifTitle = texts?.optString("notifTitle") ?: ""
        doneText = texts?.optString("done") ?: ""
        fastText = texts?.optString("fast") ?: ""
        slowText = texts?.optString("slow") ?: ""
        seedAtMs = System.currentTimeMillis()
        enabled = true
        // JS re-based the engine: it already announced this step, so don't.
        announcedIdx = idx
        ensureTts(data.optString("lang", "en"))
        armDeadline()
        postNotification()
    }

    private fun teardown() {
        enabled = false
        handler.removeCallbacks(deadline)
        try { tts?.stop() } catch (ignored: RuntimeException) {}
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(NOTIFICATION_ID)
        } catch (ignored: RuntimeException) {
        }
    }

    // Main thread, per fix the native fold ACCEPTED.
    private fun onLiveFix(intent: Intent) {
        if (!enabled || !tracking) return
        val now = System.currentTimeMillis()
        if (now - seedAtMs > SEED_MAX_AGE_MS) {
            teardown()
            return
        }
        val fixKm = intent.getDoubleExtra("km", Double.NaN)
        if (fixKm.isFinite() && fixKm >= km) km = fixKm
        if (intent.hasExtra("durationSec")) {
            movingSec = intent.getLongExtra("durationSec", 0).toDouble()
            movingAnchorWall = now
        }
        lastCurPace = intent.getDoubleExtra("curPaceSecPerKm", 0.0)
        evaluate()
    }

    private fun currentMovingSec(): Double =
        movingSec + if (tracking) (System.currentTimeMillis() - movingAnchorWall) / 1000.0 else 0.0

    private fun stepAt(i: Int): Step? {
        if (i < steps.size) return steps[i]
        if (loopFrom < 0 || loopFrom >= steps.size) return null
        val cycle = steps.size - loopFrom
        return steps[loopFrom + ((i - loopFrom) % cycle)]
    }

    // Mirror of advanceWorkout (src/utils/workout.ts): same boundary rules,
    // same conservative "anchor a time step at now off a distance boundary".
    private fun evaluate() {
        if (!enabled || !tracking || finished) return
        val nowMoving = currentMovingSec()
        var advanced = false
        while (!finished) {
            val step = stepAt(idx) ?: break
            val crossed = when {
                step.m != null -> (km - stepStartKm) * 1000.0 >= step.m - 1e-6
                step.sec != null -> nowMoving - stepStartSec >= step.sec
                else -> false
            }
            if (!crossed) break
            stepStartKm = if (step.m != null) stepStartKm + step.m / 1000.0 else km
            stepStartSec = if (step.sec != null) stepStartSec + step.sec else nowMoving
            idx += 1
            advanced = true
            if (stepAt(idx) == null) finished = true
        }
        if (advanced) {
            if (finished) {
                cue(ToneGenerator.TONE_PROP_ACK, doneText)
            } else if (announcedIdx != idx) {
                announcedIdx = idx
                stepAt(idx)?.let { cue(ToneGenerator.TONE_PROP_BEEP2, it.announce) }
                lastPaceCueAt = System.currentTimeMillis()
            }
            postNotification()
        }
        // Off-pace reminder, same discipline as the JS hook.
        val step = if (finished) null else stepAt(idx)
        if (step?.pace != null && step.band != null && lastCurPace > 0
            && nowMoving - stepStartSec >= PACE_CUE_MIN_INTO_STEP_SEC
            && System.currentTimeMillis() - lastPaceCueAt >= PACE_CUE_EVERY_MS) {
            if (lastCurPace > step.pace + step.band) {
                lastPaceCueAt = System.currentTimeMillis()
                cue(ToneGenerator.TONE_PROP_BEEP, slowText)
            } else if (lastCurPace < step.pace - step.band) {
                lastPaceCueAt = System.currentTimeMillis()
                cue(ToneGenerator.TONE_PROP_BEEP, fastText)
            }
        }
        armDeadline()
    }

    // Time-bound steps must fire with no fix to ride (stationary recovery):
    // a Handler deadline in the still-running service process. Distance-bound
    // steps need a fix by definition — nothing to arm.
    private fun armDeadline() {
        handler.removeCallbacks(deadline)
        if (!enabled || !tracking || finished) return
        val step = stepAt(idx) ?: return
        if (step.sec == null) return
        val delayMs = ((stepStartSec + step.sec - currentMovingSec()) * 1000.0).toLong()
        handler.postDelayed(deadline, maxOf(0L, delayMs) + 50L)
    }

    // ── output: tone + speech (ducking music), vibration, notification ───────
    private fun ensureTts(lang: String) {
        if (tts != null && lang == ttsLang) return
        ttsLang = lang
        if (tts == null) {
            ttsReady = false
            try {
                tts = TextToSpeech(context) { status ->
                    handler.post {
                        ttsReady = status == TextToSpeech.SUCCESS
                        applyTtsLang()
                    }
                }
            } catch (e: Exception) {
                tts = null
            }
        } else {
            applyTtsLang()
        }
    }

    private fun applyTtsLang() {
        if (!ttsReady) return
        try {
            tts?.language = Locale.forLanguageTag(ttsLang.ifEmpty { "en" })
            tts?.setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
        } catch (ignored: RuntimeException) {
        }
    }

    private fun cue(tone: Int, text: String) {
        if (muted) return
        try {
            if (toneGen == null) toneGen = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
            toneGen?.startTone(tone, TONE_MS)
        } catch (e: Exception) {
            toneGen = null
        }
        try {
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(150, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(150)
            }
        } catch (ignored: RuntimeException) {
        }
        if (text.isNotEmpty() && ttsReady) {
            try {
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "workout-cue")
            } catch (ignored: RuntimeException) {
            }
        }
    }

    // A silent, ongoing "current step" card next to the recording notification
    // — the patched service owns that one and rebuilds its message natively, so
    // the step line lives on its own channel instead of fighting it.
    private fun postNotification() {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(NotificationChannel(
                    CHANNEL_ID, notifTitle.ifEmpty { "Workout" }, NotificationManager.IMPORTANCE_LOW
                ))
            }
            val text = if (finished) doneText else stepAt(idx)?.notif ?: return
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val contentIntent = launch?.let {
                PendingIntent.getActivity(context, 0, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(context.applicationInfo.icon)
                .setContentTitle(notifTitle)
                .setContentText(text)
                .setOngoing(!finished)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .apply { contentIntent?.let { setContentIntent(it) } }
                .build()
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            // POST_NOTIFICATIONS denied or channel weirdness — cues still work.
        }
    }
}
