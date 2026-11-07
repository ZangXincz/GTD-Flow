// ============================================================
//  GTD 收集箱 · 页面模块（子笔记标题必须为：Inbox）
// ============================================================
//  职责边界：
//    - 收集箱页面：按顺序列出 Inbox/Tasks 里的待处理条目
//    - 数据（status / items）由入口通过 props 注入，不发请求
//    - "处理收集箱"按钮经 onProcess 回调交回入口（功能后续接入）
//    - 行结构复用任务面板的 gtd-task-row / gtd-task-check 等类
//      （PANEL_CSS 已随入口注入，两个视图样式天然统一）
//    - 快速收集（Alt+Q）由独立启动脚本 gtdGlobalCapture 全局负责
//    - INBOX_CSS 随本模块导出，由入口与 PANEL_CSS 一同注入
//  注意：不要用 ?? 和 ?.
// ============================================================

export const INBOX_CSS = `
    /* 主行动按钮：通栏长条，占满宽度、蓝底白字居中 */
    .gtd-inbox-process-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        width: 100%;
        box-sizing: border-box;
        margin: 10px 0 36px;
        padding: 13px 20px;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        background: #2563eb;
        color: #fff;
        font-family: inherit;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: .02em;
        box-shadow: 0 2px 10px rgba(37, 99, 235, .38);
        transition: filter .15s, transform .1s;
    }
    .gtd-inbox-process-btn:hover {
        filter: brightness(1.1);
    }
    .gtd-inbox-process-btn:active {
        transform: scale(.995);
    }
    .gtd-inbox-process-icon {
        font-size: 12px;
        line-height: 1;
    }
    /* 收集箱任务文本用正文色（覆盖面板"非焦点分组文字弱化"规则） */
    .gtd-section.gtd-inbox .gtd-task-text {
        color: var(--main-text-color);
    }
    .gtd-inbox-placeholder {
        border: 1px dashed var(--main-border-color, #45475a);
        border-radius: 8px;
        padding: 40px 24px;
        text-align: center;
        color: var(--muted-text-color, #888);
    }
    .gtd-inbox-placeholder-icon { font-size: 28px; margin-bottom: 10px; }
    .gtd-inbox-placeholder-line { font-size: 13px; line-height: 1.7; word-break: break-all; }
    .gtd-inbox-placeholder-error {
        color: #d32f2f;
        border-color: rgba(211, 47, 47, .4);
    }
`;

// ── 收集箱页面 ──
// props: { status: 'loading' | 'ready' | 'error', items, errorText,
//          onProcess, onComplete(item), onMenuOpen(item, x, y),
//          onOpenTask(item) }
export function Inbox({ status, items, errorText, onProcess, onComplete, onMenuOpen, onOpenTask }) {

    // 占位框（加载中 / 空 / 出错共用）
    function placeholder(icon, lines, isError) {
        return (
            <div class={'gtd-inbox-placeholder' + (isError ? ' gtd-inbox-placeholder-error' : '')}>
                <div class="gtd-inbox-placeholder-icon">{icon}</div>
                {lines.map((line, i) => (
                    <div key={i} class="gtd-inbox-placeholder-line">{line}</div>
                ))}
            </div>
        );
    }

    if (status === 'loading') return placeholder('⏳', ['正在加载收集箱…']);

    if (status === 'error') return placeholder('✗', ['加载收集箱失败', errorText], true);

    if (!items || items.length === 0) {
        return placeholder('📥', [
            '收集箱是空的',
            '任意页面按 Alt+Q 随时快速收集'
        ]);
    }

    return (
        <div class="gtd-section gtd-inbox">
            {/* 主行动按钮：通栏长条，独占一行（后续接处理流程） */}
            <button class="gtd-inbox-process-btn" onClick={onProcess}>
                <span class="gtd-inbox-process-icon">▶</span>
                处理收集箱（{items.length}）
            </button>

            {/* 行结构与面板一致：check + 文本 + 时间 pill（复用 gtd-task-* 样式） */}
            <div class="gtd-section-body">
                {items.map(item => {
                    // 快速收集的条目自带 'YYYY-MM-DD HH:mm ' 时间前缀，拆进日期 pill
                    const m = item.text.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+)$/);
                    const time = m ? m[1] : null;
                    const text = m ? m[2] : item.text;
                    return (
                        <div class="gtd-task-row" key={item.checkboxIndex}>
                            {/* 左键完成 / 右键状态菜单，行为与面板一致 */}
                            <span
                                class="gtd-task-check"
                                onClick={() => onComplete(item)}
                                onContextMenu={e => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onMenuOpen(item, e.clientX, e.clientY);
                                }}
                            >✓</span>
                            {/* 点击文本跳转到笔记任务位置（定位闪烁逻辑与面板一致） */}
                            <span class="gtd-task-text" onClick={() => onOpenTask(item)}>{text}</span>
                            {time ? <span class="gtd-task-date">{time}</span> : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
