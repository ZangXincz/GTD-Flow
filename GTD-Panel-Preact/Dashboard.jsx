// ============================================================
//  GTD 任务面板 · 展示模块（子笔记标题必须为：Dashboard）
// ============================================================
//  职责边界：
//    - 只放任务面板的展示，以及面板内的纯 UI 状态（拖拽 / 菜单位置）
//    - 数据与回调全部由入口通过 props 注入，不发请求
//    - PANEL_CSS 随本模块导出，由入口统一注入页面
//    - view 模块允许 import trilium:preact 的 hooks（见模板 templateView 约定）
//  注意：不要用 ?? 和 ?.
// ============================================================

import { useState, useEffect, useRef, useLayoutEffect } from "trilium:preact";

// =========================================================
// 面板样式（每次运行由入口重建注入，避免旧版本样式残留）
// =========================================================
export const PANEL_CSS = `
    .gtd-root {
        padding: 28px 32px;
        max-width: 860px;
        margin: 0 auto;
        font-family: var(--detail-font-family, "Segoe UI", sans-serif);
        font-size: 16px;
        line-height: 1.5;
        color: var(--main-text-color);
        box-sizing: border-box;
    }
    .gtd-task-check {
        flex-shrink: 0;
        width: 15px;
        height: 15px;
        margin-top: 3px;
        border: 1.5px solid var(--main-border-color, #45475a);
        border-radius: 3px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: border-color .15s, background .15s, color .15s;
        color: transparent;
        font-size: 10px;
        line-height: 1;
        user-select: none;
    }
    .gtd-task-check:hover {
        border-color: var(--main-text-color);
        background: var(--accented-background-color, #313244);
        color: var(--muted-text-color, #888);
    }
    .gtd-task-check.gtd-completing {
        border-color: var(--active-item-background-color, #a6e3a1);
        background: rgba(166, 227, 161, .15);
        color: var(--active-item-background-color, #a6e3a1);
        pointer-events: none;
    }
    .gtd-task-text {
        cursor: pointer;
        transition: color .15s;
    }
    .gtd-task-text:hover {
        color: var(--link-color, var(--main-text-color));
        text-decoration: underline;
    }
    .gtd-task-src {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--muted-text-color, #888);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
        cursor: pointer;
        border: 1px solid var(--main-border-color, #45475a);
        padding: 0 6px;
        border-radius: 8px;
    }
    .gtd-task-src:hover {
        color: var(--main-text-color);
        border-color: var(--muted-text-color, #888);
    }
    /* 标红：Today's Focus 第一条 / 已过期的未完成任务 */
    .gtd-task-text.gtd-text-alert,
    .gtd-task-text.gtd-text-alert:hover {
        color: #d32f2f;
        font-weight: 600;
    }
    .gtd-task-date {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--muted-text-color, #888);
        background: transparent;
        border: 1px solid var(--main-border-color, #45475a);
        padding: 0 6px;
        border-radius: 8px;
    }
    .gtd-task-date.gtd-task-date-today {
        color: var(--active-item-background-color, #a6e3a1);
        background: rgba(166, 227, 161, .15);
        border-color: transparent;
        font-weight: 600;
    }
    .gtd-task-date.gtd-task-date-overdue {
        color: #d32f2f;
        background: rgba(211, 47, 47, .14);
        border-color: transparent;
        font-weight: 600;
    }
    .gtd-task-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 3px 0;
        font-size: 16px;
        line-height: 1.45;
    }
    /* 完成后淡出 */
    .gtd-task-row.gtd-row-leaving {
        opacity: 0;
        transition: opacity .25s ease;
    }
    .gtd-task-handle {
        flex-shrink: 0;
        width: 10px;
        margin-top: 1px;
        color: var(--muted-text-color, #888);
        font-size: 13px;
        line-height: 1.6;
        text-align: center;
        cursor: grab;
        user-select: none;
        opacity: 0;
        transition: opacity .15s;
    }
    .gtd-task-row:hover .gtd-task-handle {
        opacity: .75;
    }
    .gtd-task-handle:active {
        cursor: grabbing;
    }
    .gtd-task-row.gtd-dragging {
        opacity: .45;
    }
    .gtd-section-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
    }
    .gtd-section {
        margin-bottom: 28px;
    }
    .gtd-section-head {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-bottom: 6px;
        font-size: 14px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .06em;
        color: var(--muted-text-color, #888);
    }
    .gtd-section-count {
        font-size: 13px;
        background: var(--accented-background-color, #313244);
        color: var(--muted-text-color, #888);
        padding: 1px 7px;
        border-radius: 10px;
    }
    .gtd-section-body {
        padding-left: 14px;
    }
    .gtd-placeholder {
        color: var(--muted-text-color, #888);
    }
    .gtd-error {
        color: #d32f2f;
        background: rgba(211, 47, 47, .08);
        padding: 12px 14px;
        border-radius: 8px;
        font-size: 15px;
    }
    .gtd-state-menu {
        position: fixed;
        z-index: 99999;
        background: var(--accented-background-color, #313244);
        border: 1px solid var(--main-border-color, #45475a);
        border-radius: 8px;
        padding: 4px;
        box-shadow: 0 4px 16px rgba(0,0,0,.4);
        min-width: 150px;
    }
    .gtd-state-menu-item {
        display: block;
        width: 100%;
        text-align: left;
        padding: 6px 10px;
        border: none;
        background: transparent;
        color: var(--main-text-color);
        font-size: 14px;
        border-radius: 5px;
        cursor: pointer;
        font-family: inherit;
    }
    .gtd-state-menu-item:hover {
        background: var(--active-item-background-color, #45475a);
    }
    /* ── Today's Focus 聚焦样式：红色淡底卡片，唯一有背景的分组 ── */
    .gtd-section-focus .gtd-section-head {
        color: #ef5350;
    }
    .gtd-section-focus .gtd-section-count {
        color: #ef5350;
        background: rgba(239, 83, 80, .12);
    }
    .gtd-section-focus .gtd-task-row {
        background: rgba(239, 83, 80, .07);
        border-left: 3px solid rgba(239, 83, 80, .55);
        border-radius: 6px;
        padding: 6px 10px;
        margin: 5px 0;
        transition: background .15s;
    }
    .gtd-section-focus .gtd-task-row:hover {
        background: rgba(239, 83, 80, .13);
    }
    /* Focus 区非首条：灰色卡片，把红色让给第一条 */
    .gtd-section-focus .gtd-task-row.gtd-focus-muted {
        background: rgba(158, 158, 158, .08);
        border-left-color: rgba(158, 158, 158, .45);
    }
    .gtd-section-focus .gtd-task-row.gtd-focus-muted:hover {
        background: rgba(158, 158, 158, .14);
    }
    /* 非焦点分组的任务文字弱化，让视线集中在 Today's Focus */
    .gtd-section:not(.gtd-section-focus) .gtd-task-text {
        color: var(--muted-text-color, #888);
    }
    .gtd-section:not(.gtd-section-focus) .gtd-task-text:hover {
        color: var(--main-text-color);
    }
    /* 非焦点任务行悬停淡背景，提示可点击 */
    .gtd-section:not(.gtd-section-focus) .gtd-task-row:hover {
        background: rgba(128, 128, 128, .08);
        border-radius: 6px;
    }
    /* Focus 首条（红色卡片）加轻微投影，强化"当前唯一重点" */
    .gtd-section-focus .gtd-task-row:not(.gtd-focus-muted) {
        background: rgba(239, 83, 80, .10);
        box-shadow: 0 1px 6px rgba(239, 83, 80, .18);
    }
`;

// =========================================================
// 任务面板
// sections / todayStr 等数据由入口注入；
// 所有写操作（完成 / 切状态 / 跳转 / 拖拽提交）都通过回调交回入口
// 状态菜单已抽出为下方 StateMenu（两个视图共用）
// =========================================================
export function Dashboard({
    sections, todayStr, completingKeys,
    onMenuOpen,
    onComplete, onOpenTask, onOpenNote,
    onDragStart, onDragOverRow, onDragEnd
}) {

    const [dragKey, setDragKey] = useState(null); // 正在拖拽的任务 key

    // ── 拖拽排序：拖动中由入口在状态里实时移动行（等价原版的 DOM 移动），──
    // ── 松手后由入口提交排位到 localStorage                              ──
    function handleDragStart(e, task) {
        setDragKey(task.key);
        onDragStart(task.key);

        const dt = e.dataTransfer;
        if (dt) {
            dt.effectAllowed = 'move';
            dt.setData('text/plain', task.key);
            // 用整行做拖拽预览，而不是只有手柄
            try {
                const row = e.currentTarget.closest('.gtd-task-row');
                if (row) dt.setDragImage(row, 20, 12);
            } catch (err) { /* 部分环境不支持 */ }
        }
    }

    function handleRowDragOver(e, task) {
        if (dragKey === null || dragKey === task.key) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        // 越过目标行中线则插到其后，否则插到其前
        const after = e.clientY > rect.top + rect.height / 2;
        onDragOverRow(dragKey, task.key, after);
    }

    function finishDrag() {
        if (dragKey === null) return;
        setDragKey(null);
        onDragEnd();
    }

    // 拖拽期间：dragend / drop 兜底收尾（拖出面板或被系统吞掉时）
    useEffect(() => {
        if (dragKey === null) return;
        const finish = () => finishDrag();
        document.addEventListener('dragend', finish);
        document.addEventListener('drop', finish);
        return () => {
            document.removeEventListener('dragend', finish);
            document.removeEventListener('drop', finish);
        };
    }, [dragKey]);

    // ── 单行任务 ──
    function renderTask(section, t, i) {
        const isFocus = section.key === 'doing';
        const first = isFocus && i === 0; // Today's Focus 的第一条（排在最前，标红）
        const completing = completingKeys.has(t.key);

        // 第一条 或 已过期未完成 → 文本标红
        const alertCls = (first || t.overdue) ? ' gtd-text-alert' : '';

        const isToday = t.date === todayStr;
        const dateCls = isToday
            ? ' gtd-task-date-today'
            : (t.overdue ? ' gtd-task-date-overdue' : '');
        const dateLabel = isToday ? '今天' : t.date;

        let rowCls = 'gtd-task-row';
        if (isFocus && !first) rowCls += ' gtd-focus-muted'; // Focus 非首条灰色卡片
        if (dragKey === t.key) rowCls += ' gtd-dragging';
        if (completing) rowCls += ' gtd-row-leaving';

        return (
            <div key={t.key} class={rowCls}>
                {isFocus && (
                    <span
                        class="gtd-task-handle"
                        draggable="true"
                        title="拖动调整顺序"
                        onDragStart={e => handleDragStart(e, t)}
                    >⠿</span>
                )}

                <span
                    class={'gtd-task-check' + (completing ? ' gtd-completing' : '')}
                    onClick={() => onComplete(t)}
                    onContextMenu={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        onMenuOpen(t, e.clientX, e.clientY);
                    }}
                >✓</span>

                {/* Preact 自动转义文本子节点，不要再手动 esc（会双重转义） */}
                <span class={'gtd-task-text' + alertCls} onClick={() => onOpenTask(t)}>
                    {t.text}
                </span>

                {t.date ? <span class={'gtd-task-date' + dateCls}>{dateLabel}</span> : null}

                <span class="gtd-task-src" onClick={() => onOpenNote(t.noteId)}>
                    {t.noteTitle}
                </span>
            </div>
        );
    }

    return (
        <div class="gtd-sections">
            {sections.map(section => {
                if (!section.tasks.length) return null;

                const isFocus = section.key === 'doing';

                return (
                    <div
                        key={section.key}
                        class={'gtd-section' + (isFocus ? ' gtd-section-focus' : '')}
                        data-key={section.key}
                    >
                        <div class="gtd-section-head">
                            <span
                                class="gtd-section-dot"
                                style={`background:${section.color};`}
                            ></span>
                            {section.label}
                            <span class="gtd-section-count">{section.tasks.length}</span>
                        </div>
                        <div
                            class="gtd-section-body"
                            style={isFocus ? undefined : `border-left:2px solid ${section.color}55;`}
                            onDragOver={e => { if (dragKey !== null) e.preventDefault(); }}
                            onDrop={e => {
                                if (dragKey !== null) { e.preventDefault(); finishDrag(); }
                            }}
                        >
                            {section.tasks.map((t, i) => renderTask(section, t, i))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// =========================================================
// 状态菜单（任务面板 / 收集箱共用）
// menu: { task, x, y } | null，由入口持有状态；
// 坐标在菜单真实尺寸出来后钳制进视口；点击/滚轮/失焦/缩放关闭
// =========================================================
export function StateMenu({ menu, items, onSelect, onClose }) {

    const [menuPos, setMenuPos] = useState(null); // 钳制后的坐标
    const menuBoxRef = useRef(null);

    useLayoutEffect(() => {
        if (!menu || !menuBoxRef.current) { setMenuPos(null); return; }
        const el = menuBoxRef.current;
        setMenuPos({
            left: Math.max(8, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8))
        });
    }, [menu]);

    // 菜单是 position: fixed，滚动或窗口变化后位置会失效，直接关掉
    useEffect(() => {
        if (!menu) return;
        document.addEventListener('click', onClose);
        document.addEventListener('wheel', onClose);
        window.addEventListener('blur', onClose);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('click', onClose);
            document.removeEventListener('wheel', onClose);
            window.removeEventListener('blur', onClose);
            window.removeEventListener('resize', onClose);
        };
    }, [menu, onClose]);

    if (!menu) return null;

    return (
        <div
            class="gtd-state-menu"
            ref={menuBoxRef}
            style={{
                left: ((menuPos && menuPos.left) || menu.x) + 'px',
                top: ((menuPos && menuPos.top) || menu.y) + 'px'
            }}
        >
            {items.map(item => (
                <button
                    key={item.label}
                    class="gtd-state-menu-item"
                    onClick={() => onSelect(item)}
                >{item.label}</button>
            ))}
        </div>
    );
}
