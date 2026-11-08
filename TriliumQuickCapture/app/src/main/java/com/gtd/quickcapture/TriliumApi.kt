package com.gtd.quickcapture

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Trilium ETAPI 最小封装：
 * GET 目标笔记内容 → 拼接任务 li 插入第一个 todo-list 最前 → PUT 写回。
 * 请求走 OkHttp 原生线程（ETAPI 无 CORS 头，WebView 里调不通）。
 */
object TriliumApi {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val TEXT_PLAIN = "text/plain; charset=utf-8".toMediaTypeOrNull()

    /** HTML 转义（录入的是纯文本） */
    private fun esc(s: String) = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    /** 与 GTD 面板一致的待办 li 结构（未勾选） */
    private fun buildLi(text: String): String {
        val clean = text.replace(Regex("\\s+"), " ").trim()
        return "<li><span class=\"todo-list__label\">" +
            "<span contenteditable=\"false\">" +
            "<input type=\"checkbox\" tabindex=\"-1\"></span>" +
            "<span class=\"todo-list__label__description\">" + esc(clean) + "</span>" +
            "</span></li>"
    }

    /** 插入第一个 todo-list 开标签之后（最新在最上）；没有列表则新建一个追加到末尾 */
    private fun insertTask(content: String, li: String): String {
        val ulRe = Regex("""<ul[^>]*class="todo-list"[^>]*>""", RegexOption.IGNORE_CASE)
        val m = ulRe.find(content)
        return if (m != null) {
            val at = m.range.last + 1
            content.substring(0, at) + li + content.substring(at)
        } else {
            content.trimEnd() + "\n<ul class=\"todo-list\">" + li + "</ul>\n"
        }
    }

    /**
     * 把文本作为任务追加到目标笔记。
     * @throws IOException 网络错误或 Trilium 返回非 2xx
     */
    fun appendTask(server: String, token: String, noteId: String, text: String) {
        val url = "$server/etapi/notes/$noteId/content"

        // ── 1) 读当前内容 ──
        val content: String = client.newCall(
            Request.Builder().url(url).header("Authorization", token).build()
        ).execute().use { resp ->
            when {
                resp.code == 401 || resp.code == 403 ->
                    throw IOException("ETAPI Token 无效")
                resp.code == 404 ->
                    throw IOException("noteId 不存在，检查设置里的目标笔记 ID")
                !resp.isSuccessful ->
                    throw IOException("读取失败 HTTP ${resp.code}")
                else -> resp.body?.string().orEmpty()
            }
        }

        // ── 2) 拼接任务 li ──
        val newContent = insertTask(content, buildLi(text))

        // ── 3) 写回 ──
        client.newCall(
            Request.Builder().url(url)
                .header("Authorization", token)
                .put(newContent.toRequestBody(TEXT_PLAIN))
                .build()
        ).execute().use { resp ->
            when {
                resp.code == 401 || resp.code == 403 ->
                    throw IOException("ETAPI Token 无效")
                !resp.isSuccessful ->
                    throw IOException("写回失败 HTTP ${resp.code}")
                else -> Unit
            }
        }
    }
}
