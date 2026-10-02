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
import androidx.core.content.ContextCompat
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor

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
// Status callouts and heart-rate warnings mirror src/utils/callout.ts; the
// live bpm comes from the patched BLE plugin's HR_SAMPLE relay.
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
        // Mirrors the patched BLE plugin's HR_RELAY_ACTION.
        private const val HR_SAMPLE_ACTION = "solutions.camboulive.run.HR_SAMPLE"
        // Mirror src/utils/callout.ts and HR_STALE_MS (src/utils/hr.ts).
        private const val CALLOUT_MIN_INTO_STEP_SEC = 20.0
        private const val HR_WARN_EVERY_SEC = 45.0
        private const val HR_STALE_MS = 12_000L
        private const val PACE_FRESH_MS = 10_000L
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
        val hrLo: Double?,
        val hrHi: Double?,
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
    private var texts: JSONObject = JSONObject()
    private var decimalSep = "."
    private var freqSec = 60.0
    private var sayPace = true
    private var sayHr = true
    private var sayDist = false
    private var sayLeft = true
    private var hrWarn = 0.0
    private var seedAtMs = 0L
    private var lastCurPace = 0.0
    private var lastFixWall = 0L
    // Callout clock, native-owned like the announcement dedupe: JS never
    // speaks on Android, so only a fresh run resets it.
    private var lastCalloutSec = 0.0
    private var lastCalloutKm = 0
    private var lastHrWarnSec = Double.NEGATIVE_INFINITY
    private var lastBpm = 0
    private var lastBpmAt = 0L
    // Announcement dedupe is NATIVE state: JS never speaks on Android (its
    // playCue no-ops here), so a seed can't mean "already announced". It
    // survives re-seeds (pause/resume/mute are same-idx) and resets only on
    // teardown or when the engine went backwards (a fresh run).
    private var announcedIdx = -1
    private var doneCued = false

    private val deadline = Runnable { evaluate() }
    private var receiver: BroadcastReceiver? = null
    private var hrReceiver: BroadcastReceiver? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsLang = ""
    // Spoken once TTS finishes initializing — a cold engine must not swallow
    // the run's opening announcement (or a preview).
    private var pendingSpeech: String? = null
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
        val hr = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val bpm = intent.getIntExtra("bpm", 0)
                val t = intent.getLongExtra("t", 0L)
                if (bpm > 0 && t >= lastBpmAt) {
                    lastBpm = bpm
                    lastBpmAt = t
                }
            }
        }
        try {
            ContextCompat.registerReceiver(context, hr, IntentFilter(HR_SAMPLE_ACTION),
                ContextCompat.RECEIVER_NOT_EXPORTED)
            hrReceiver = hr
        } catch (e: Exception) {
            Logger.error("WorkoutGuide: HR relay unavailable", e)
        }
    }

    override fun handleOnDestroy() {
        // Full teardown, notification included: an activity swiped away
        // mid-run must not leave an ongoing "current step" card with no
        // engine behind it (the next mount's JS has no idea it exists).
        teardown()
        receiver?.let {
            try {
                LocalBroadcastManager.getInstance(context).unregisterReceiver(it)
            } catch (ignored: RuntimeException) {
            }
        }
        receiver = null
        hrReceiver?.let {
            try { context.unregisterReceiver(it) } catch (ignored: RuntimeException) {}
        }
        hrReceiver = null
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

    // "Hear it" in the audio-guidance sheet: one sample, spoken the way a run's
    // callouts will be (same TTS, same ducking), whatever the engine state.
    @PluginMethod
    fun preview(call: PluginCall) {
        val text = call.getString("text") ?: ""
        val lang = call.getString("lang") ?: "en"
        handler.post {
            ensureTts(lang)
            speakNow(text)
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
                hrLo = num(s, "hrLo"),
                hrHi = num(s, "hrHi"),
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
        texts = data.optJSONObject("texts") ?: JSONObject()
        notifTitle = texts.optString("notifTitle")
        doneText = texts.optString("done")
        decimalSep = data.optString("decimalSep", ".").ifEmpty { "." }
        val callout = data.optJSONObject("callout")
        freqSec = callout?.let { num(it, "freqSec") } ?: 60.0
        hrWarn = callout?.let { num(it, "hrWarn") } ?: 0.0
        val say = callout?.optJSONObject("say")
        sayPace = say?.optBoolean("pace", true) ?: true
        sayHr = say?.optBoolean("hr", true) ?: true
        sayDist = say?.optBoolean("dist", false) ?: false
        sayLeft = say?.optBoolean("left", true) ?: true
        seedAtMs = System.currentTimeMillis()
        val wasEnabled = enabled
        enabled = true
        // Dedupe and callout clock survive every re-seed (pause/resume, audio
        // toggle, a JS re-base that trails this fold); only teardown resets them.
        // First seed of a run (or a recovered one): per-km callouts count from here.
        if (!wasEnabled) lastCalloutKm = floor(km).toInt()
        if (!finished) doneCued = false
        ensureTts(data.optString("lang", "en"))
        // Announce the step the seed landed on if nothing has voiced it yet —
        // the opening warm-up right after Go, and a foreground transition
        // where the JS re-base beat the LIVE_FIX broadcast to the boundary.
        if (tracking && !finished && idx > announcedIdx) {
            announcedIdx = idx
            stepAt(idx)?.let { cue(ToneGenerator.TONE_PROP_BEEP2, it.announce) }
            lastCalloutSec = currentMovingSec()
        }
        if (finished && !doneCued) {
            doneCued = true
            cue(ToneGenerator.TONE_PROP_ACK, doneText)
        }
        armDeadline()
        postNotification()
    }

    private fun resetCalloutClock() {
        lastCalloutSec = 0.0
        lastCalloutKm = 0
        lastHrWarnSec = Double.NEGATIVE_INFINITY
    }

    private fun teardown() {
        enabled = false
        announcedIdx = -1
        resetCalloutClock()
        lastCurPace = 0.0
        lastFixWall = 0L
        doneCued = false
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
        lastFixWall = now
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
                doneCued = true
                cue(ToneGenerator.TONE_PROP_ACK, doneText)
            } else if (idx > announcedIdx) {
                announcedIdx = idx
                stepAt(idx)?.let { cue(ToneGenerator.TONE_PROP_BEEP2, it.announce) }
                lastCalloutSec = nowMoving
            }
            postNotification()
        } else if (!finished) {
            stepAt(idx)?.let { callouts(it, nowMoving) }
        }
        armDeadline()
    }

    // ── status callouts + HR warning (mirror src/utils/callout.ts) ───────────
    private fun liveBpm(): Int? =
        if (lastBpm > 0 && System.currentTimeMillis() - lastBpmAt <= HR_STALE_MS) lastBpm else null

    private fun callouts(step: Step, nowMoving: Double) {
        if (muted) return
        val bpm = liveBpm()
        if (hrWarn >= 0 && step.hrHi != null && bpm != null && bpm > step.hrHi + hrWarn
            && nowMoving - lastHrWarnSec >= HR_WARN_EVERY_SEC) {
            lastHrWarnSec = nowMoving
            lastCalloutSec = nowMoving
            cue(ToneGenerator.TONE_PROP_BEEP, fill("hrHigh", "bpm" to bpm.toString()))
            return
        }
        val perKm = freqSec <= 0
        val due = if (perKm) floor(km).toInt() > lastCalloutKm
            else nowMoving - lastCalloutSec >= freqSec && nowMoving - stepStartSec >= CALLOUT_MIN_INTO_STEP_SEC
        if (!due) return
        lastCalloutSec = nowMoving
        lastCalloutKm = floor(km).toInt()
        val text = calloutText(step, nowMoving, bpm, perKm)
        if (text.isNotEmpty()) cue(ToneGenerator.TONE_PROP_ACK, text)
    }

    private fun calloutText(step: Step, nowMoving: Double, bpm: Int?, perKm: Boolean): String {
        val parts = ArrayList<String>()
        if (sayDist || perKm) parts.add(fill("distDone", "km" to oneDecimal(km)))
        // A standing runner emits no fixes: their last pace is not their pace now.
        val freshPace = System.currentTimeMillis() - lastFixWall <= PACE_FRESH_MS
        if (sayPace && lastCurPace > 0 && freshPace) {
            val pace = spokenPace(lastCurPace)
            val p = step.pace
            val b = step.band
            parts.add(when {
                p == null || b == null -> fill("paceIs", "pace" to pace)
                lastCurPace > p + b -> fill("slowBy", "pace" to pace, "target" to spokenPace(p))
                lastCurPace < p - b -> fill("fastBy", "pace" to pace, "target" to spokenPace(p))
                else -> fill("onPace", "pace" to pace)
            })
        }
        if (sayHr && bpm != null) parts.add(fill("heart", "bpm" to bpm.toString()))
        if (sayLeft) {
            if (step.m != null) {
                val leftM = maxOf(0L, Math.round(step.m - (km - stepStartKm) * 1000.0))
                parts.add(if (leftM >= 1000) fill("leftKm", "km" to oneDecimal(leftM / 1000.0))
                    else fill(if (leftM == 1L) "leftMOne" else "leftMOther", "n" to leftM.toString()))
            } else if (step.sec != null) {
                val leftSec = maxOf(0L, ceil(step.sec - (nowMoving - stepStartSec)).toLong())
                parts.add(when {
                    leftSec > 90 -> fill("leftMinOther", "n" to Math.round(leftSec / 60.0).toString())
                    leftSec == 1L -> fill("leftSecOne", "n" to "1")
                    else -> fill("leftSecOther", "n" to leftSec.toString())
                })
            }
        }
        return parts.joinToString(" ")
    }

    private fun fill(key: String, vararg values: Pair<String, String>): String {
        var out = texts.optString(key)
        for ((k, v) in values) out = out.replace("{$k}", v)
        return out
    }

    private fun spokenPace(secPerKm: Double): String {
        val p = Math.round(secPerKm)
        return fill("pace", "min" to (p / 60).toString(), "sec" to (p % 60).toString().padStart(2, '0'))
    }

    private fun oneDecimal(v: Double): String =
        String.format(Locale.ROOT, "%.1f", v).replace(".", decimalSep)

    // Time-bound steps and time-based callouts must fire with no fix to ride
    // (a stationary recovery): a Handler deadline in the still-running service
    // process. Distance boundaries and per-km callouts need a fix by definition.
    private fun armDeadline() {
        handler.removeCallbacks(deadline)
        if (!enabled || !tracking || finished) return
        val step = stepAt(idx) ?: return
        var nextSec = Double.POSITIVE_INFINITY
        if (step.sec != null) nextSec = stepStartSec + step.sec
        if (!muted && freqSec > 0) {
            nextSec = minOf(nextSec, maxOf(lastCalloutSec + freqSec, stepStartSec + CALLOUT_MIN_INTO_STEP_SEC))
        }
        if (nextSec.isInfinite()) return
        val delayMs = ((nextSec - currentMovingSec()) * 1000.0).toLong()
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
                        pendingSpeech?.let { speakNow(it) }
                        pendingSpeech = null
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
        speakNow(text)
    }

    private fun speakNow(text: String) {
        if (text.isEmpty()) return
        if (!ttsReady) { pendingSpeech = text; return }
        try {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "workout-cue")
        } catch (ignored: RuntimeException) {
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
