package solutions.camboulive.run

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

// Dictation for the coach composer and the beta feedback sheet, using the
// recognizer built into Android. Free, unlimited, and on-device from API 33
// where an offline recognizer exists (docs/voice-and-feedback.md).
//
// The JS side never touches this directly — it goes through the speech seam
// (src/speech/source.ts), which returns null off native so the web build has
// no path in here at all.
//
// SpeechRecognizer is MAIN-THREAD ONLY: every call into it, and the listener
// callbacks it makes, must be on the main looper or it throws. Everything here
// therefore hops through `activity.runOnUiThread` rather than a coroutine, and
// every native entry point catches — an exception escaping into the bridge
// takes the whole process down with no overlay and no rejected promise, which
// on this screen would mean losing whatever the user had typed so far.
@CapacitorPlugin(
    name = "Speech",
    permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])],
)
class SpeechPlugin : Plugin() {

    private var recognizer: SpeechRecognizer? = null

    override fun handleOnDestroy() {
        // The activity can be torn down mid-utterance (a renderer rebuild, a
        // rotation). Leaving a recognizer holding the mic would keep the
        // microphone indicator lit over an app that is gone.
        activity?.runOnUiThread { destroyRecognizer() }
    }

    private fun destroyRecognizer() {
        try {
            recognizer?.stopListening()
            recognizer?.destroy()
        } catch (_: Throwable) {
            // Already gone, or never started. Nothing to release.
        }
        recognizer = null
    }

    @PluginMethod
    fun available(call: PluginCall) {
        try {
            call.resolve(JSObject().put("available", SpeechRecognizer.isRecognitionAvailable(context)))
        } catch (t: Throwable) {
            // Unavailable is the honest answer to "can this device do it?" when
            // asking crashed. The UI hides the mic and offers typing.
            call.resolve(JSObject().put("available", false))
        }
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        try {
            if (hasMicPermission()) {
                call.resolve(JSObject().put("granted", true))
                return
            }
            requestPermissionForAlias("microphone", call, "micPermissionResult")
        } catch (t: Throwable) {
            call.resolve(JSObject().put("granted", false))
        }
    }

    @PermissionCallback
    private fun micPermissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasMicPermission()))
    }

    private fun hasMicPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    @PluginMethod
    fun start(call: PluginCall) {
        val lang = call.getString("lang") ?: "en-GB"
        if (!hasMicPermission()) {
            call.reject("microphone permission not granted")
            return
        }
        val host = activity
        if (host == null) {
            call.reject("no activity")
            return
        }
        host.runOnUiThread {
            try {
                destroyRecognizer()
                val next = SpeechRecognizer.createSpeechRecognizer(context)
                next.setRecognitionListener(listener)
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    // Prefer a local model where the platform has one. Advisory:
                    // devices without one fall back to the network recognizer
                    // rather than failing, which is why the UI's privacy copy
                    // says "your phone" only on the strength of the OS default.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                    }
                }
                recognizer = next
                next.startListening(intent)
                call.resolve()
            } catch (t: Throwable) {
                destroyRecognizer()
                emitError(t.message ?: "speech_start_failed")
                call.reject(t.message ?: "speech_start_failed")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.resolve()
            return
        }
        host.runOnUiThread {
            // Never rejects: stopping something already stopped is the caller
            // tidying up, not an error, and a sheet closing must not throw.
            try {
                recognizer?.stopListening()
            } catch (_: Throwable) {
            }
            destroyRecognizer()
            call.resolve()
        }
    }

    private fun emitError(message: String) {
        notifyListeners("error", JSObject().put("message", message))
    }

    private fun firstResult(results: Bundle?): String =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private val listener = object : RecognitionListener {
        override fun onPartialResults(partialResults: Bundle?) {
            // Rendered live in the composer: without it, several seconds of
            // silence while someone talks reads as a broken button.
            notifyListeners("partial", JSObject().put("text", firstResult(partialResults)))
        }

        override fun onResults(results: Bundle?) {
            notifyListeners("final", JSObject().put("text", firstResult(results)))
            destroyRecognizer()
        }

        override fun onError(error: Int) {
            emitError("speech_error_$error")
            destroyRecognizer()
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}
