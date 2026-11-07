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

import { useState } from "trilium:preact";

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
    /* ── 处理收集箱（引导式）── */
    .gtd-proc-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 18px;
    }
    .gtd-proc-head-title {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        font-size: 16px;
        font-weight: 600;
    }
    .gtd-proc-remaining {
        font-size: 12px;
        font-weight: 600;
        color: #2563eb;
        background: rgba(37, 99, 235, .13);
        padding: 2px 9px;
        border-radius: 10px;
    }
    .gtd-proc-head-right {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
    }
    .gtd-proc-skip {
        border: 1px solid var(--main-border-color, #45475a);
        background: transparent;
        color: var(--muted-text-color, #888);
        border-radius: 8px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
        font-family: inherit;
    }
    .gtd-proc-skip:hover:enabled { color: var(--main-text-color); }
    .gtd-proc-close {
        border: none;
        background: transparent;
        color: var(--muted-text-color, #888);
        font-size: 20px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
    }
    .gtd-proc-close:hover {
        color: var(--main-text-color);
        background: rgba(128, 128, 128, .15);
    }
    .gtd-proc-card {
        background: var(--accented-background-color, #313244);
        border: 1px solid var(--main-border-color, #45475a);
        border-radius: 12px;
        padding: 26px 28px 20px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .22);
    }
    .gtd-proc-title-line {
        text-align: center;
        font-size: 18px;
        font-weight: 600;
        line-height: 1.5;
        word-break: break-all;
    }
    .gtd-proc-sub {
        text-align: center;
        font-size: 13px;
        color: var(--muted-text-color, #888);
        margin-top: 8px;
        word-break: break-all;
    }
    .gtd-proc-field { margin-top: 20px; }
    .gtd-proc-label {
        font-size: 13px;
        color: var(--muted-text-color, #888);
        margin-bottom: 6px;
    }
    .gtd-proc-input {
        width: 100%;
        box-sizing: border-box;
        background: var(--main-background-color, #1e1e2e);
        border: 1px solid var(--main-border-color, #45475a);
        border-radius: 8px;
        color: var(--main-text-color);
        font-family: inherit;
        font-size: 15px;
        line-height: 1.5;
        padding: 9px 12px;
        outline: none;
    }
    .gtd-proc-input:focus {
        border-color: var(--active-item-background-color, #a6e3a1);
    }
    .gtd-proc-textarea {
        resize: vertical;
        min-height: 68px;
    }
    .gtd-proc-question {
        margin-top: 24px;
        font-size: 15px;
        font-weight: 600;
    }
    .gtd-proc-question-sub {
        font-size: 12px;
        color: var(--muted-text-color, #888);
        margin: 3px 0 10px;
    }
    /* 第一层选项卡：自适应等分占满行宽（窄面板自动换行，每行仍占满） */
    .gtd-proc-opts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
        gap: 8px;
    }
    .gtd-proc-opt {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--main-border-color, #45475a);
        background: var(--main-background-color, #1e1e2e);
        color: var(--main-text-color);
        font-size: 14px;
        font-family: inherit;
        cursor: pointer;
        transition: border-color .15s, background .15s, color .15s;
    }
    .gtd-proc-opt:hover:enabled {
        border-color: var(--active-item-background-color, #a6e3a1);
    }
    .gtd-proc-opt:disabled {
        opacity: .5;
        cursor: default;
    }
    .gtd-proc-opt.gtd-opt-active {
        background: #2563eb;
        border-color: #2563eb;
        color: #fff;
    }
    .gtd-proc-opt.gtd-opt-done {
        background: #16a34a;
        border-color: #16a34a;
        color: #fff;
        font-weight: 600;
    }
    .gtd-proc-opt.gtd-opt-done:hover:enabled { filter: brightness(1.08); }
    .gtd-proc-proj {
        max-width: 100%;
        word-break: break-all;
        text-align: left;
    }
    .gtd-proc-tip {
        margin-top: 14px;
        font-size: 13px;
        color: #d9a441;
    }
    .gtd-proc-error {
        margin-top: 14px;
        font-size: 13px;
        color: #d32f2f;
        background: rgba(211, 47, 47, .08);
        border-radius: 8px;
        padding: 10px 12px;
        word-break: break-all;
    }
    .gtd-proc-busy {
        margin-top: 14px;
        font-size: 13px;
        color: var(--muted-text-color, #888);
    }
    .gtd-proc-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 18px;
        padding: 14px 4px 0;
        border-top: 1px solid var(--main-border-color, #45475a);
    }
    .gtd-proc-foot-hint {
        font-size: 12px;
        color: var(--muted-text-color, #888);
    }
    .gtd-proc-next-btn {
        flex-shrink: 0;
        border: none;
        border-radius: 8px;
        padding: 10px 26px;
        background: #2563eb;
        color: #fff;
        font-size: 15px;
        font-weight: 700;
        font-family: inherit;
        cursor: pointer;
        transition: filter .15s;
    }
    .gtd-proc-next-btn:hover:enabled { filter: brightness(1.1); }
    .gtd-proc-next-btn:disabled {
        opacity: .4;
        cursor: default;
    }
    /* 通栏大按钮（2 分钟判定 / 下一步是什么）：flex 等分占满，
       2 个按钮各占一半，3 个按钮各占三分之一 */
    .gtd-proc-wide {
        display: flex;
        gap: 10px;
    }
    .gtd-proc-wide-btn {
        flex: 1 1 0;
        min-width: 0;
    }
    .gtd-proc-wide-btn {
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid var(--main-border-color, #45475a);
        background: var(--main-background-color, #1e1e2e);
        color: var(--main-text-color);
        font-family: inherit;
        font-size: 14px;
        cursor: pointer;
        transition: border-color .15s, background .15s, color .15s;
    }
    .gtd-proc-wide-btn:hover:enabled {
        border-color: var(--active-item-background-color, #a6e3a1);
    }
    .gtd-proc-wide-btn:disabled {
        opacity: .5;
        cursor: default;
    }
    .gtd-proc-wide-btn.gtd-wide-active {
        background: #2563eb;
        border-color: #2563eb;
        color: #fff;
        font-weight: 600;
    }
    .gtd-proc-wide-btn.gtd-wide-done {
        background: #16a34a;
        border-color: #16a34a;
        color: #fff;
        font-weight: 600;
    }
    .gtd-proc-wide-btn.gtd-wide-done:hover:enabled { filter: brightness(1.08); }
    /* 项目下拉：去掉原生箭头，只保留自定义的单个 chevron
       （避免 Trilium 主题箭头 + 原生箭头出现两个小三角） */
    .gtd-proc-select {
        width: 100%;
        box-sizing: border-box;
        background: var(--main-background-color, #1e1e2e);
        border: 1px solid var(--main-border-color, #45475a);
        border-radius: 8px;
        color: var(--main-text-color);
        font-family: inherit;
        font-size: 14px;
        padding: 9px 30px 9px 12px;
        outline: none;
        cursor: pointer;
        -webkit-appearance: none;
        appearance: none;
        background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 11px center;
    }
    .gtd-proc-select:focus {
        border-color: var(--active-item-background-color, #a6e3a1);
    }
    /* 日期快捷按钮 */
    .gtd-proc-date-quick {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
    }
    .gtd-proc-date-quick button {
        border: 1px solid var(--main-border-color, #45475a);
        background: transparent;
        color: var(--muted-text-color, #888);
        border-radius: 14px;
        padding: 3px 11px;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
    }
    .gtd-proc-date-quick button:hover {
        color: var(--main-text-color);
        border-color: var(--active-item-background-color, #a6e3a1);
    }
`;

// ── 收集箱页面 ──
// props: { status: 'loading' | 'ready' | 'error', items, errorText,
//          onProcess, onComplete(item), onMenuOpen(item, x, y),
//          onOpenTask(item) }
export function Inbox({ status, items, errorText, onProcess, onComplete, onMenuOpen, onOpenTask }) {

    // ── 右键任务文本：复制到剪贴板（成功短暂变色提示，与面板一致）──
    function copyTaskText(e, text) {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        navigator.clipboard.writeText(text).then(() => {
            el.classList.add('gtd-copied');
            setTimeout(() => el.classList.remove('gtd-copied'), 600);
        }).catch(err => console.error('复制失败：', err));
    }

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

            {/* 行结构与面板一致：check + 文本（复用 gtd-task-* 样式） */}
            <div class="gtd-section-body">
                {items.map(item => {
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
                            {/* 左键进入任务；右键复制文本 */}
                            <span
                                class="gtd-task-text"
                                onClick={() => onOpenTask(item)}
                                onContextMenu={e => copyTaskText(e, item.text)}
                            >{item.text}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// =========================================================
// 处理收集箱（引导式）
// 逐条：标题 / 描述可编辑 → 是否可执行 → 2 分钟内能完成吗
//   → 已完成 | 需要更长时间（可选日期 → 我来做 / 委派他人）
//   →（可选）归入项目；只有点底部「下一步」才真正处理并前进
// 组件用 key 重挂载，换条目时内部选择自动重置
// =========================================================

// 拆分已废弃：快速收集不再加时间前缀，收集箱条目直接显示原文

// 本地日期 yyyy-mm-dd（快捷日期用）
function dateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// props: { item, remaining, busy, errorText,
//          projects, projectsLoading, projectError,
//          onExit, onSkip, onSubmit(choice) }
//   choice = { mode: 'done', title, desc }
//          | { mode: 'move', title, desc, date, delegate, projectId }
//          | { mode: 'delete' }
//          | { mode: 'maybe' }
//          | { mode: 'snooze', date }
export function InboxProcess({
    item, remaining, busy, errorText,
    projects, projectsLoading, projectError,
    onExit, onSkip, onSubmit
}) {

    const [title, setTitle] = useState(item ? item.text : '');
    const [desc, setDesc] = useState('');
    const [canAct, setCanAct] = useState(false);    // 已选「是的，可执行」
    const [exec, setExec] = useState(null);         // done | more
    const [date, setDate] = useState('');           // 安排日期（可选）
    const [who, setWho] = useState(null);           // me | other（委派 → 等待中）
    const [projectId, setProjectId] = useState(''); // '' = 不归入项目
    const [tip, setTip] = useState('');

    // 条目用尽时入口层会自动退出处理模式（这里不渲染任何东西）
    if (!item) return null;

    // ── 选择「是否可执行」或「删除」（切换时重置下层选择）──
    function pickCanAct() {
        setCanAct(true);
        setExec(null);
        setWho(null);
        setDate('');
        setProjectId('');
        setTip('');
    }

    function pickDelete() {
        setCanAct(false);   // 独占选项：不再属于「可执行」路线
        setExec('delete');
        setWho(null);
        setDate('');
        setProjectId('');
        setTip('');
    }

    function pickMaybe() {
        setCanAct(false);
        setExec('maybe');
        setWho(null);
        setDate('');
        setProjectId('');
        setTip('');
    }

    function pickSnooze() {
        setCanAct(false);
        setExec('snooze');
        setWho(null);
        setDate('');
        setProjectId('');
        setTip('');
    }

    function pickNotReady() {
        setTip('该处理方式暂未接入，先试试「是的，可执行」');
    }

    // ── 设为项目：用任务文本作项目名，模板实例化到项目文件夹下，任务移入 ──
    function pickMakeProject() {
        const cleanTitle = String(title).trim();
        if (!cleanTitle) { setTip('项目名称不能为空'); return; }
        setTip('');
        onSubmit({ mode: 'makeProject', title: cleanTitle, desc: String(desc).trim() });
    }

    // ── 底部主按钮：应用当前选择并处理本条 ──
    function submit() {

        const cleanTitle = String(title).trim();
        const unary = exec === 'delete' || exec === 'maybe' || exec === 'snooze';

        if (!canAct && !unary) { setTip('请先选择处理方式'); return; }
        if (exec === 'delete') {
            // 删除：保留原文，状态标记为已取消，移入 Quick Tasks
            onSubmit({ mode: 'delete' });
            return;
        }
        if (exec === 'maybe') {
            // 将来/也许：保留原文，状态标记为待定，移入指定文件
            onSubmit({ mode: 'maybe' });
            return;
        }
        if (exec === 'snooze') {
            // 择日再看：任务留在原地（不移入），文本后追加 #yyyy-mm-dd，
            // 日期不到时收集箱不显示；今天及以前没有意义，禁止选择
            if (!date) { setTip('请选择日期'); return; }
            if (date <= dateOffset(0)) { setTip('请选择今天之后的日期'); return; }
            onSubmit({ mode: 'snooze', date: date });
            return;
        }
        if (!cleanTitle) { setTip('标题不能为空'); return; }
        if (exec === 'done') {
            onSubmit({ mode: 'done', title: cleanTitle, desc: String(desc).trim() });
            return;
        }
        if (exec !== 'more') { setTip('请先选择「已完成」或「需要更长时间」'); return; }
        if (!who) { setTip('请选择「我来做」还是「委派他人」'); return; }

        onSubmit({
            mode: 'move',
            title: cleanTitle,
            desc: String(desc).trim(),
            date: date,
            delegate: who === 'other',
            projectId: projectId || null
        });
    }

    // 独占选项（删除/将来也许/择日再看）与「可执行」路线互斥
    const unary = exec === 'delete' || exec === 'maybe' || exec === 'snooze';
    const canSubmit = !busy && (
        (unary && (exec !== 'snooze' || !!date)) ||
        (canAct && !!String(title).trim() && (
            exec === 'done' ||
            (exec === 'more' && !!who)
        ))
    );

    return (
        <div class="gtd-proc">
            <div class="gtd-proc-head">
                <div class="gtd-proc-head-title">
                    📋 处理事项
                    <span class="gtd-proc-remaining">{remaining} 项剩余</span>
                </div>
                <div class="gtd-proc-head-right">
                    <button class="gtd-proc-skip" onClick={onSkip} disabled={busy}>跳过 →</button>
                    <button class="gtd-proc-close" onClick={onExit} title="退出处理">×</button>
                </div>
            </div>

            <div class="gtd-proc-card">

                <div class="gtd-proc-title-line">
                    {String(title).trim() ? title : item.text}
                </div>
                <div class="gtd-proc-sub">
                    检查详情，选择处理结果，然后继续处理下一条。
                </div>

                {/* 标题 / 描述：可编辑；描述一行一项，作为任务子内容写入 */}
                <div class="gtd-proc-field">
                    <div class="gtd-proc-label">标题</div>
                    <input
                        class="gtd-proc-input"
                        value={title}
                        onInput={e => setTitle(e.target.value)}
                    />
                </div>

                <div class="gtd-proc-field">
                    <div class="gtd-proc-label">描述</div>
                    <textarea
                        class="gtd-proc-input gtd-proc-textarea"
                        placeholder="一行一项，作为任务的子内容…"
                        value={desc}
                        onInput={e => setDesc(e.target.value)}
                    ></textarea>
                </div>

                {/* 第一层：是否可执行 */}
                <div class="gtd-proc-question">是否可执行？</div>
                <div class="gtd-proc-question-sub">你可以对此采取具体行动吗？</div>
                <div class="gtd-proc-opts">
                    <button
                        class={'gtd-proc-opt' + (canAct ? ' gtd-opt-active' : '')}
                        disabled={busy}
                        onClick={pickCanAct}
                    >✓ 是的，可执行</button>
                    <button
                        class={'gtd-proc-opt' + (exec === 'delete' ? ' gtd-opt-active' : '')}
                        disabled={busy}
                        onClick={pickDelete}
                    >🗑 删除</button>
                    <button
                        class={'gtd-proc-opt' + (exec === 'maybe' ? ' gtd-opt-active' : '')}
                        disabled={busy}
                        onClick={pickMaybe}
                    >💭 将来/也许</button>
                    <button
                        class={'gtd-proc-opt' + (exec === 'snooze' ? ' gtd-opt-active' : '')}
                        disabled={busy}
                        onClick={pickSnooze}
                    >📅 择日再看</button>
                    <button class="gtd-proc-opt" disabled={busy} onClick={pickNotReady}>📄 参考资料</button>
                </div>

                {/* 择日再看：只选日期（无时间），任务留原地，到期才重新显示 */}
                {canAct && exec === 'snooze' && (
                    <div>
                        <div class="gtd-proc-question">哪天再看？</div>
                        <div class="gtd-proc-question-sub">
                            任务留在收集箱原处，文本追加 #日期，到期当天才会重新显示。
                        </div>
                        <div class="gtd-proc-field">
                            <input
                                type="date"
                                class="gtd-proc-input"
                                min={dateOffset(1)}
                                value={date}
                                onInput={e => setDate(e.target.value)}
                            />
                            <div class="gtd-proc-date-quick">
                                <button onClick={() => setDate(dateOffset(1))}>明天</button>
                                <button onClick={() => setDate(dateOffset(3))}>+3 天</button>
                                <button onClick={() => setDate(dateOffset(7))}>下周</button>
                                <button onClick={() => setDate(dateOffset(30))}>一个月</button>
                                <button onClick={() => setDate('')}>无日期</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 第二层：2 分钟内能完成吗（只记录选择，不立即执行；独占选项不显示） */}
                {canAct && (
                    <div>
                        <div class="gtd-proc-question">2 分钟内能完成吗？</div>
                        <div class="gtd-proc-question-sub">
                            独立任务移入本年 Quick Tasks，完成/取消的移入 Archive。
                        </div>
                        <div class="gtd-proc-wide">
                            <button
                                class={'gtd-proc-wide-btn' + (exec === 'done' ? ' gtd-wide-done' : '')}
                                disabled={busy}
                                onClick={() => { setExec('done'); setTip(''); }}
                            >✓ 已完成！</button>
                            <button
                                class={'gtd-proc-wide-btn' + (exec === 'more' ? ' gtd-wide-active' : '')}
                                disabled={busy}
                                onClick={() => { setExec('more'); setTip(''); }}
                            >需要更长时间</button>
                        </div>
                    </div>
                )}

                {/* 第三层：需要更长时间 → 日期 / 下一步是什么 / 项目（可选） */}
                {canAct && exec === 'more' && (
                    <div>
                        <div class="gtd-proc-field">
                            <div class="gtd-proc-label">安排日期（可选）</div>
                            <input
                                type="date"
                                class="gtd-proc-input"
                                value={date}
                                onInput={e => setDate(e.target.value)}
                            />
                            <div class="gtd-proc-date-quick">
                                <button onClick={() => setDate(dateOffset(0))}>今天</button>
                                <button onClick={() => setDate(dateOffset(1))}>明天</button>
                                <button onClick={() => setDate(dateOffset(3))}>+3 天</button>
                                <button onClick={() => setDate(dateOffset(7))}>下周</button>
                                <button onClick={() => setDate('')}>无日期</button>
                            </div>
                        </div>

                        <div class="gtd-proc-question">下一步是什么？</div>
                        <div class="gtd-proc-question-sub">是你自己做，还是委派给他人？</div>
                        <div class="gtd-proc-wide">
                            <button
                                class={'gtd-proc-wide-btn' + (who === 'me' ? ' gtd-wide-active' : '')}
                                disabled={busy}
                                onClick={() => { setWho('me'); setTip(''); }}
                            >→ 我来做</button>
                            <button
                                class={'gtd-proc-wide-btn' + (who === 'other' ? ' gtd-wide-active' : '')}
                                disabled={busy}
                                onClick={() => { setWho('other'); setTip(''); }}
                            >👤 委派他人</button>
                            <button
                                class="gtd-proc-wide-btn"
                                disabled={busy}
                                onClick={pickMakeProject}
                            >📁 设为项目</button>
                        </div>

                        <div class="gtd-proc-field">
                            <div class="gtd-proc-label">项目（可选）</div>
                            <select
                                class="gtd-proc-select"
                                value={projectId}
                                onChange={e => setProjectId(e.target.value)}
                            >
                                <option value="">不归入项目（移入本年 Quick Tasks）</option>
                                {projects.map(p => (
                                    <option key={p.noteId} value={p.noteId}>{p.title}</option>
                                ))}
                            </select>

                            {projectsLoading ? (
                                <div class="gtd-proc-question-sub">正在加载项目…</div>
                            ) : null}

                            {projectError ? (
                                <div class="gtd-proc-error">✗ {projectError}</div>
                            ) : null}

                            {!projectsLoading && !projectError && projects.length === 0 ? (
                                <div class="gtd-proc-question-sub">
                                    项目清单为空，请检查 gtdCore 的 NOTES.projectsRoot / 排斥清单
                                </div>
                            ) : null}

                            {who === 'other' ? (
                                <div class="gtd-proc-question-sub">委派的任务会标记为「等待中」。</div>
                            ) : null}
                        </div>
                    </div>
                )}

                {tip ? <div class="gtd-proc-tip">{tip}</div> : null}
                {errorText ? <div class="gtd-proc-error">✗ {errorText}</div> : null}
                {busy ? <div class="gtd-proc-busy">处理中…</div> : null}

                <div class="gtd-proc-foot">
                    <div class="gtd-proc-foot-hint">点击「下一步」应用当前选择并处理本条。</div>
                    <button
                        class="gtd-proc-next-btn"
                        disabled={!canSubmit}
                        onClick={submit}
                    >下一步 →</button>
                </div>
            </div>
        </div>
    );
}
