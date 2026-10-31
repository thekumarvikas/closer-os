package com.closeros.poc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Result of one in-app recording attempt. Loudness is MediaRecorder's 0–32767 scale. */
data class TestRecording(
    val file: File,
    val source: String,
    val seconds: Long,
    val peak: Int,
    val avgLoudness: Int,
)

/**
 * Experiment: can a normal app record a phone call through the microphone?
 * Records while the rep is on a call, and measures loudness so silence is detectable.
 */
class RecorderService : Service() {

    companion object {
        val sources = linkedMapOf(
            "MIC" to MediaRecorder.AudioSource.MIC,
            "VOICE_RECOGNITION" to MediaRecorder.AudioSource.VOICE_RECOGNITION,
            "VOICE_COMMUNICATION" to MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        )
        @Volatile var isRecording = false; private set
        @Volatile var liveLoudness = 0; private set
        @Volatile var lastError: String? = null; private set
        val results = mutableListOf<TestRecording>()
        var onChange: (() -> Unit)? = null

        fun start(ctx: Context, source: String) {
            ctx.startForegroundService(Intent(ctx, RecorderService::class.java).putExtra("source", source))
        }
        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, RecorderService::class.java).setAction("stop"))
        }
    }

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var source = "MIC"
    private var startedAt = 0L
    private var peak = 0
    private var sum = 0L
    private var samples = 0
    private val handler = Handler(Looper.getMainLooper())
    private val sampler = object : Runnable {
        override fun run() {
            val amp = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
            liveLoudness = amp
            peak = maxOf(peak, amp); sum += amp; samples++
            onChange?.invoke()
            if (isRecording) handler.postDelayed(this, 300)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { finish(); return START_NOT_STICKY }
        if (isRecording) return START_NOT_STICKY
        source = intent?.getStringExtra("source") ?: "MIC"
        goForeground()
        try {
            val dir = File(getExternalFilesDir(null), "test-recordings").apply { mkdirs() }
            val name = "test_${source}_" + SimpleDateFormat("ddMM_HHmmss", Locale.US).format(Date()) + ".m4a"
            file = File(dir, name)
            recorder = (if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()).apply {
                setAudioSource(sources.getValue(source))
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1)
                setAudioSamplingRate(44100)
                setAudioEncodingBitRate(64000)
                setOutputFile(file!!.absolutePath)
                prepare()
                start()
            }
            startedAt = System.currentTimeMillis(); peak = 0; sum = 0; samples = 0
            isRecording = true; lastError = null
            handler.post(sampler)
        } catch (e: Exception) {
            lastError = "Could not start recording with $source: ${e.message}"
            recorder?.release(); recorder = null
            stopSelf()
        }
        onChange?.invoke()
        return START_NOT_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("rec", "Test recording", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, RecorderService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, "rec")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Closer OS test recording is ON")
            .setContentText("Make your call now. Tap Stop when the call ends.")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this, 7, n,
            if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        )
    }

    private fun finish() {
        if (isRecording) {
            isRecording = false
            handler.removeCallbacks(sampler)
            runCatching { recorder?.stop() }
            recorder?.release(); recorder = null
            file?.let {
                results.add(0, TestRecording(it, source, (System.currentTimeMillis() - startedAt) / 1000,
                    peak, if (samples == 0) 0 else (sum / samples).toInt()))
            }
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        onChange?.invoke()
    }

    override fun onDestroy() { if (isRecording) finish(); super.onDestroy() }
}
