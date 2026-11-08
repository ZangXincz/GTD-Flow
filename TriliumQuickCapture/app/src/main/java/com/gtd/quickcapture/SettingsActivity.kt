package com.gtd.quickcapture

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.Toast

/** 配置：服务器地址 / ETAPI Token / 目标笔记 noteId，存 SharedPreferences */
class SettingsActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        // 同主窗口：撑到屏宽 92%
        window.setLayout(
            (resources.displayMetrics.widthPixels * 0.92f).toInt(),
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val prefs = getSharedPreferences(MainActivity.PREF, MODE_PRIVATE)
        val etServer = findViewById<EditText>(R.id.etServer)
        val etToken = findViewById<EditText>(R.id.etToken)
        val etNoteId = findViewById<EditText>(R.id.etNoteId)

        etServer.setText(prefs.getString(MainActivity.K_SERVER, ""))
        etToken.setText(prefs.getString(MainActivity.K_TOKEN, ""))
        etNoteId.setText(prefs.getString(MainActivity.K_NOTE, ""))

        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val server = etServer.text.toString().trim().trimEnd('/')
            val token = etToken.text.toString().trim()
            val noteId = etNoteId.text.toString().trim()
            if (server.isBlank() || token.isBlank() || noteId.isBlank()) {
                Toast.makeText(this, "三项都要填写", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            prefs.edit()
                .putString(MainActivity.K_SERVER, server)
                .putString(MainActivity.K_TOKEN, token)
                .putString(MainActivity.K_NOTE, noteId)
                .apply()
            Toast.makeText(this, "已保存 ✓", Toast.LENGTH_SHORT).show()
            finish()
        }
    }
}
