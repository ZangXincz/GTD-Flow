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
    /* 右键复制成功后的短暂提示色 */
    .gtd-task-text.gtd-copied,
    .gtd-task-text.gtd-copied:hover {
        color: var(--active-item-background-color, #a6e3a1) !important;
        text-decoration: none;
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
    /* 重复任务徽章：只显示 🔁，完整规则放悬停提示 */
    .gtd-task-repeat {
        flex-shrink: 0;
        font-size: 11px;
        line-height: 1;
        cursor: default;
        user-select: none;
    }
    /* 日期胶囊可点击编辑：复用来源笔记胶囊（gtd-task-src）的悬浮交互 */
    .gtd-task-date.gtd-date-editable {
        cursor: pointer;
        transition: color .15s, border-color .15s;
    }
    .gtd-task-date.gtd-date-editable:hover {
        color: var(--main-text-color);
        border-color: var(--muted-text-color, #888);
    }
    .gtd-date-edit {
        position: fixed;
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: var(--main-background-color, #1e1e2e);
        border: 1px solid var(--main-border-color, #45475a);
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, .35);
    }
    .gtd-date-edit-label {
        font-size: 12px;
        color: var(--muted-text-color, #888);
        white-space: nowrap;
    }
    .gtd-date-edit-input {
        font-size: 13px;
        padding: 2px 4px;
        color: var(--main-text-color);
        background: transparent;
        border: none;
        outline: none;
    }
    .gtd-date-edit-clear {
        font-size: 12px;
        color: #d32f2f;
        background: transparent;
        border: none;
        cursor: pointer;
        white-space: nowrap;
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
    /* 可折叠分组（等待中/日历）：标题可点击，箭头指示展开/收起 */
    .gtd-section-head.gtd-head-toggle {
        cursor: pointer;
        user-select: none;
    }
    .gtd-section-head.gtd-head-toggle:hover {
        color: var(--main-text-color);
    }
    .gtd-collapse-arrow {
        font-size: 11px;
        opacity: .7;
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
    /* ── Today's Focus 聚焦：轻量卡片 + 左侧色条，比普通分组略突出但不突兀 ── */
    .gtd-section-focus {
        background: rgba(239, 83, 80, .028);
        border: 1px solid rgba(239, 83, 80, .13);
        border-left: 3px solid rgba(239, 83, 80, .55);
        border-radius: 10px;
        padding: 10px 14px 6px;
        margin-bottom: 28px;
    }
    .gtd-section-focus .gtd-section-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 0;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(128, 128, 128, .12);
        font-size: 14px;
        color: #ef5350;
    }
    .gtd-section-focus .gtd-section-count {
        color: #ef5350;
        background: rgba(239, 83, 80, .12);
    }
    .gtd-section-focus .gtd-section-body {
        padding-left: 0;
    }
    /* 行：占位略大 + 发丝线分隔，无独立卡片底 */
    .gtd-section-focus .gtd-task-row {
        background: transparent;
        border: none;
        border-top: 1px solid rgba(128, 128, 128, .12);
        border-radius: 8px;
        padding: 9px 6px;
        margin: 0;
        font-size: 16px;
        line-height: 1.5;
        transition: background .15s;
    }
    .gtd-section-focus .gtd-task-row:first-child {
        border-top: none;
    }
    .gtd-section-focus .gtd-task-row:hover {
        background: rgba(239, 83, 80, .06);
    }
    /* 非首条不再灰化：统一用完整文本，仅首条标红强调 */
    .gtd-section-focus .gtd-task-row.gtd-focus-muted {
        background: transparent;
    }
    .gtd-section-focus .gtd-task-row.gtd-focus-muted:hover {
        background: rgba(239, 83, 80, .06);
    }
    .gtd-section-focus .gtd-task-text {
        font-weight: 500;
    }
    /* 卡片内的红色文字与色条同色系，避免深红/浅红两种红互相打架；
       字重 600：红色在浅底上对比度低、视觉偏细，加一档与其他行
       （500 + 深色）达到视觉一致；悬浮态一并钉死防跳变 */
    .gtd-section-focus .gtd-task-text.gtd-text-alert,
    .gtd-section-focus .gtd-task-text.gtd-text-alert:hover {
        color: #e05252;
        font-weight: 600;
    }
    /* Focus 区圆形勾选框，略大更好点 */
    .gtd-section-focus .gtd-task-check {
        width: 17px;
        height: 17px;
        margin-top: 2px;
        border-width: 2px;
        border-radius: 50%;
        font-size: 11px;
    }
    .gtd-section-focus .gtd-task-handle {
        margin-top: 2px;
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
    /* Focus 首条不再单独铺底色：与其余行共用卡片底，
       仅靠红色文字表达"当前唯一重点"，避免叠加出突兀色带 */
`;

// =========================================================
// 任务面板
// sections / todayStr 等数据由入口注入；
// 所有写操作（完成 / 切状态 / 跳转 / 拖拽提交）都通过回调交回入口
// 状态菜单已抽出为下方 StateMenu（两个视图共用）
// =========================================================
export function Dashboard({
    sections, todayStr, completingKeys, repeatLabel,
    onMenuOpen,
    onComplete, onOpenTask, onOpenNote, onEditDate,
    onDragStart, onDragOverRow, onDragEnd
}) {

    const [dragKey, setDragKey] = useState(null); // 正在拖拽的任务 key

    // ── 等待中 / 日历分组默认折叠：不持久化，每次数据刷新重置为折叠，
    //    展开只是临时态（点分组标题切换）──
    const [collapsed, setCollapsed] = useState(() => ({ waiting: true, calendar: true }));
    useEffect(() => {
        setCollapsed({ waiting: true, calendar: true });
    }, [sections]);

    // ── 日期胶囊编辑：点击胶囊弹出浮层，选择即写回任务文本的 #日期 ──
    const [dateEdit, setDateEdit] = useState(null); // { task, x, y } | null
    const dateBoxRef = useRef(null);
    const [dateBoxPos, setDateBoxPos] = useState(null); // 钳制后的坐标

    // 浮层尺寸出来后钳制进视口（同 StateMenu 的做法）
    useLayoutEffect(() => {
        if (!dateEdit || !dateBoxRef.current) { setDateBoxPos(null); return; }
        const el = dateBoxRef.current;
        setDateBoxPos({
            left: Math.max(8, Math.min(dateEdit.x, window.innerWidth - el.offsetWidth - 8)),
            top: Math.max(8, Math.min(dateEdit.y, window.innerHeight - el.offsetHeight - 8))
        });
    }, [dateEdit]);

    // 点击浮层外关闭（延迟绑定，避免打开浮层的同一次点击立即关闭）
    useEffect(() => {
        if (!dateEdit) return;
        const onDocClick = e => {
            if (dateBoxRef.current && dateBoxRef.current.contains(e.target)) return;
            setDateEdit(null);
        };
        const t = setTimeout(() => document.addEventListener('click', onDocClick), 0);
        return () => {
            clearTimeout(t);
            document.removeEventListener('click', onDocClick);
        };
    }, [dateEdit]);

    function openDateEdit(e, task) {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setDateEdit({ task, x: r.left, y: r.bottom + 4 });
    }

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

    // ── 右键任务文本：复制到剪贴板（成功短暂变色提示）──
    function copyTaskText(e, text) {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        navigator.clipboard.writeText(text).then(() => {
            el.classList.add('gtd-copied');
            setTimeout(() => el.classList.remove('gtd-copied'), 600);
        }).catch(err => console.error('复制失败：', err));
    }

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
            <div
                key={t.key}
                class={rowCls}
                onDragOver={e => handleRowDragOver(e, t)}
                onDrop={e => { e.preventDefault(); finishDrag(); }}
            >
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

                {/* 左键进入任务；右键复制文本 */}
                <span
                    class={'gtd-task-text' + alertCls}
                    onClick={() => onOpenTask(t)}
                    onContextMenu={e => copyTaskText(e, t.text)}
                >
                    {t.text}
                </span>

                {/* 重复任务徽章（t.repeat 由入口用 gtdRepeat 解析注入） */}
                {t.repeat ? (
                    <span
                        class="gtd-task-repeat"
                        title={repeatLabel ? ('重复：' + repeatLabel(t.repeat)) : t.repeat}
                    >🔁</span>
                ) : null}

                {t.date ? (
                    <span
                        class={'gtd-task-date gtd-date-editable' + dateCls}
                        onClick={e => openDateEdit(e, t)}
                    >{dateLabel}</span>
                ) : null}

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
                // 等待中 / 日历默认折叠：标题可点击切换
                const isCollapsible = section.key === 'waiting' || section.key === 'calendar';
                const isCollapsed = isCollapsible && collapsed[section.key];

                return (
                    <div
                        key={section.key}
                        class={'gtd-section' + (isFocus ? ' gtd-section-focus' : '')}
                        data-key={section.key}
                    >
                        <div
                            class={'gtd-section-head'
                                + (isCollapsible ? ' gtd-head-toggle' : '')}
                            onClick={isCollapsible
                                ? () => setCollapsed(c => ({
                                    ...c, [section.key]: !c[section.key]
                                }))
                                : undefined}
                        >
                            <span
                                class="gtd-section-dot"
                                style={`background:${section.color};`}
                            ></span>
                            {section.label}
                            <span class="gtd-section-count">{section.tasks.length}</span>
                            {isCollapsible && (
                                <span class="gtd-collapse-arrow">
                                    {isCollapsed ? '▸' : '▾'}
                                </span>
                            )}
                        </div>
                        {!isCollapsed && (
                            <div
                                class="gtd-section-body"
                                style={isFocus
                                    ? undefined
                                    : `border-left:2px solid ${section.color}55;`}
                                onDragOver={e => { if (dragKey !== null) e.preventDefault(); }}
                                onDrop={e => {
                                    if (dragKey !== null) { e.preventDefault(); finishDrag(); }
                                }}
                            >
                                {section.tasks.map((t, i) => renderTask(section, t, i))}
                            </div>
                        )}
                    </div>
                );
            })}

            {/* 日期胶囊编辑浮层：选日期立即写回，点击浮层外取消 */}
            {dateEdit && (
                <div
                    class="gtd-date-edit"
                    ref={dateBoxRef}
                    style={dateBoxPos
                        ? { left: dateBoxPos.left + 'px', top: dateBoxPos.top + 'px' }
                        : { visibility: 'hidden' }}
                >
                    <span class="gtd-date-edit-label">📅 任务日期</span>
                    <input
                        type="date"
                        class="gtd-date-edit-input"
                        value={dateEdit.task.date || ''}
                        onChange={e => {
                            onEditDate(dateEdit.task, e.target.value || null);
                            setDateEdit(null);
                        }}
                    />
                    <button class="gtd-date-edit-clear" onClick={() => {
                        onEditDate(dateEdit.task, null);
                        setDateEdit(null);
                    }}>清除</button>
                </div>
            )}
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
