// ============================================================
//  GTD 全局快速收集 · 独立启动脚本（与 Render bundle 无关）
// ============================================================
//  安装：新建 Code 笔记（语言 JavaScript Frontend），把本文件全文贴入，
//        再给它加标签 #run=frontendStartup —— Trilium 每次前端启动自动执行，
//        之后在任意页面按 Alt+Q 都能呼出快速收集输入框。
//
//  快捷键说明：
//    原定 Ctrl+K 与 TriliumNext 内置快捷键冲突，改用 Alt+Q；
//    如需换键改 bindGlobalShortcut('alt+q', ...) 这一处即可。
//
//  ⚠ 本脚本独立运行，访问不到 Render bundle 的 gtdCore / gtdBackend，
//    所以下面的配置与写入逻辑是复制的一份，改动时两边要同步。
// ============================================================

// ── 配置：与 gtdCore 保持一致 ──
const INBOX_NOTE_ID = 'yAaUbAqVYu3S';
const INBOX_TASKS_TITLES = ['Tasks'];

(function () {

    // 防重复安装（脚本可能被多次执行，如切换窗口重新加载）
    if (window.__gtdGlobalCaptureInstalled) return;
    window.__gtdGlobalCaptureInstalled = true;

    let mask = null;
    let input = null;
    let errorBox = null;
    let docKeyHandler = null; // 浮层打开期间的全局按键处理
    let busy = false;

    // ── 样式（类名与面板浮层一致，规则为脚本自带副本）──
    function ensureStyles() {
        if (document.getElementById('gtd-global-capture-styles')) return;

        const style = document.createElement('style');
        style.id = 'gtd-global-capture-styles';
        style.textContent = [
            '.gtd-capture-mask { position:fixed; left:0; top:0; right:0; bottom:0;',
            '  z-index:100000; background:rgba(0,0,0,.35); display:flex;',
            '  align-items:flex-start; justify-content:center; padding-top:18vh; }',
            '.gtd-capture-box { width:min(560px,86vw);',
            '  background:var(--accented-background-color,#313244);',
            '  border:1px solid var(--main-border-color,#45475a); border-radius:10px;',
            '  box-shadow:0 8px 32px rgba(0,0,0,.45); padding:12px 14px; }',
            '.gtd-capture-hint { display:flex; justify-content:space-between;',
            '  font-size:12px; color:var(--muted-text-color,#888); margin-bottom:8px; }',
            '.gtd-capture-input { width:100%; box-sizing:border-box;',
            '  background:var(--main-background-color,#1e1e2e);',
            '  border:1px solid var(--main-border-color,#45475a); border-radius:8px;',
            '  color:var(--main-text-color); font-family:inherit; font-size:15px;',
            '  padding:9px 12px; outline:none; }',
            '.gtd-capture-input:focus {',
            '  border-color:var(--active-item-background-color,#a6e3a1); }',
            '.gtd-capture-error { display:none; margin-top:8px; font-size:13px;',
            '  color:#e0868c; word-break:break-all; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    function close() {
        if (docKeyHandler) {
            document.removeEventListener('keydown', docKeyHandler, true);
            docKeyHandler = null;
        }
        if (mask) mask.remove();
        mask = null;
        input = null;
        errorBox = null;
        busy = false;
    }

    function showError(msg) {
        if (!errorBox) return;
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
    }

    // ── 时间前缀：'YYYY-MM-DD HH:mm '（与 gtdCore.capturePrefix 一致，
    //    刻意不用 #日期 格式，避免被任务面板解析成 Calendar 日历任务）──
    function capturePrefix(now) {
        const p = n => String(n).padStart(2, '0');
        return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
            + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ' ';
    }

    // ── 写入 Inbox 下属 Tasks 笔记（gtdBackend.captureToInbox 的自带副本，
    //    runOnBackend 函数体在后端执行，必须自包含）──
    async function writeToTasks(text) {
        const prefix = capturePrefix(new Date());

        await api.runOnBackend((text, inboxNoteId, childTitles, prefix) => {

            const parent = api.getNote(inboxNoteId);
            if (!parent) throw new Error('未找到 Inbox 笔记（检查脚本顶部 INBOX_NOTE_ID）');

            const wanted = (childTitles || []).map(t => String(t).trim().toLowerCase());
            let target = null;
            for (const child of parent.getChildNotes()) {
                const t = String(child.title || '').trim().toLowerCase();
                if (wanted.indexOf(t) >= 0) { target = child; break; }
            }
            if (!target) {
                throw new Error('Inbox 下未找到 Tasks 子笔记（候选标题：'
                    + (childTitles || []).join(' / ') + '）');
            }

            const safe = String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

            const li = '<li><label class="todo-list__label">'
                + '<input type="checkbox">'
                + '<span class="todo-list__label__description">' + prefix + safe + '</span>'
                + '</label></li>';

            let content = String(target.getContent());

            const listMatch = content.match(/<(ul|ol)\b[^>]*>/i);
            if (listMatch) {
                const at = listMatch.index + listMatch[0].length;
                content = content.slice(0, at) + li + content.slice(at);
            } else {
                content = content.replace(/<p>(&nbsp;|\s)*<\/p>/gi, '').trim();
                content = content + '<ul class="todo-list">' + li + '</ul>';
            }

            target.setContent(content);

        }, [text, INBOX_NOTE_ID, INBOX_TASKS_TITLES, prefix]);
    }

    // ── 提交 ──
    async function submit() {
        const text = input.value.trim();
        if (!text || busy) return;

        // 配置守卫：Electron 里原生 alert 可能被吞，错误一律显示在浮层内
        if (!INBOX_NOTE_ID || String(INBOX_NOTE_ID).indexOf('填写') >= 0) {
            showError('请先在脚本顶部填写 INBOX_NOTE_ID（Inbox 笔记 ID）');
            return;
        }

        busy = true;
        input.disabled = true;
        if (errorBox) { errorBox.textContent = ''; errorBox.style.display = 'none'; }

        try {
            await writeToTasks(text);
            close();
        } catch (e) {
            console.error('[gtd] 快速收集失败', e);
            showError('保存失败：' + ((e && e.message) || e));
            busy = false;
            if (input) { input.disabled = false; input.focus(); }
        }
    }

    // ── 自带浮层 ──
    function open() {
        if (mask) { input.focus(); return; }

        ensureStyles();

        mask = document.createElement('div');
        mask.className = 'gtd-capture-mask';

        const box = document.createElement('div');
        box.className = 'gtd-capture-box';

        const hint = document.createElement('div');
        hint.className = 'gtd-capture-hint';
        hint.innerHTML = '<span>⚡ 快速收集</span><span>Enter 保存 · Esc 取消</span>';

        input = document.createElement('input');
        input.className = 'gtd-capture-input';
        input.placeholder = '想到什么就记下来…';

        errorBox = document.createElement('div');
        errorBox.className = 'gtd-capture-error';

        // 键盘处理绑定在 document 捕获阶段：即使焦点被 CKEditor 异步抢走，
        // Enter / Esc 依然生效；排除输入法组词阶段的 Enter（isComposing）
        docKeyHandler = e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
            }
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                e.stopPropagation();
                submit();
            }
        };
        document.addEventListener('keydown', docKeyHandler, true);

        // 点遮罩关闭，点输入框本身不关
        mask.addEventListener('mousedown', e => {
            if (e.target === mask) close();
        });

        box.appendChild(hint);
        box.appendChild(input);
        box.appendChild(errorBox);
        mask.appendChild(box);
        document.body.appendChild(mask);

        input.focus();
        // 对抗 CKEditor 的异步焦点回收，稍后再补一次
        setTimeout(() => { if (input) input.focus(); }, 60);
    }

    // ── 全局快捷键：Alt+Q 呼出快速收集 ──
    api.bindGlobalShortcut('alt+q', open);

})();
