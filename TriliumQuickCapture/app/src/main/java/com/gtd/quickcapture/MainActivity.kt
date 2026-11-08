package com.gtd.quickcapture

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import kotlin.concurrent.thread

/**
 * 快速录入：打开即输入框，提交后把文本作为任务 li 追加到目标笔记。
 * 首次使用自动跳设置页。
 */
class MainActivity : Activity() {

    companion object {
        const val PREF = "gtd_quick"
        const val K_SERVER = "server"
        const val K_TOKEN = "token"
        const val K_NOTE = "noteId"
    }

    private var sending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 配置不完整 → 直接进设置页
        val prefs = getSharedPreferences(PREF, MODE_PRIVATE)
        if (prefs.getString(K_SERVER, "")!!.isBlank()
            || prefs.getString(K_TOKEN, "")!!.isBlank()
            || prefs.getString(K_NOTE, "")!!.isBlank()
        ) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        // 对话框主题默认 wrap_content 会缩成一小块，撑到屏宽 92%
        window.setLayout(
            (resources.displayMetrics.widthPixels * 0.92f).toInt(),
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        val input = findViewById<EditText>(R.id.input)

        // 系统分享进入：预填文本
        val shared = if (intent?.action == Intent.ACTION_SEND)
            intent.getStringExtra(Intent.EXTRA_TEXT) else null
        if (!shared.isNullOrBlank()) input.setText(shared)

        input.requestFocus()
        input.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_DONE
                || (event?.keyCode == KeyEvent.KEYCODE_ENTER
                        && event.action == KeyEvent.ACTION_DOWN)
            ) {
                submit()
                true
            } else false
        }
        findViewById<Button>(R.id.btnSend).setOnClickListener { submit() }
        findViewById<Button>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun submit() {
        if (sending) return

        val prefs = getSharedPreferences(PREF, MODE_PRIVATE)
        val server = prefs.getString(K_SERVER, "")!!.trim()
        val token = prefs.getString(K_TOKEN, "")!!.trim()
        val noteId = prefs.getString(K_NOTE, "")!!.trim()
        if (server.isBlank() || token.isBlank() || noteId.isBlank()) {
            startActivity(Intent(this, SettingsActivity::class.java))
            return
        }

        val text = findViewById<EditText>(R.id.input).text.toString().trim()
        if (text.isEmpty()) {
            toast("请输入内容")
            return
        }

        sending = true
        val btn = findViewById<Button>(R.id.btnSend)
        btn.isEnabled = false

        thread {
            try {
                TriliumApi.appendTask(server, token, noteId, text)
                runOnUiThread { toast("已收集 ✓"); finish() }
            } catch (e: Exception) {
                runOnUiThread {
                    sending = false
                    btn.isEnabled = true
                    toast("收集失败：${e.message}")
                }
            }
        }
    }
}
