package com.kopanow

import android.net.Uri
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

class HelpVideoActivity : AppCompatActivity() {

    private var player: ExoPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_help_video)

        val view = findViewById<PlayerView>(R.id.player_view)

        val exo = ExoPlayer.Builder(this).build()
        view.player = exo

        // Play bundled raw resource (offline).
        val uri = Uri.parse("android.resource://$packageName/${R.raw.help_setup}")
        exo.setMediaItem(MediaItem.fromUri(uri))
        exo.prepare()
        exo.playWhenReady = true

        player = exo
    }

    override fun onStop() {
        super.onStop()
        player?.release()
        player = null
    }
}

