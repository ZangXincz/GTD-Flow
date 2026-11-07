// ============================================================
//  GTD 任务面板 · 入口（Render 笔记内容本身）
// ============================================================
//  多文件结构（子笔记标题 = 全局模块名，必须一字不差）：
//    gtdCore     纯逻辑：常量配置 + 纯函数（解析 / 过滤 / 排位表 / 页面路由）
//    gtdBackend  唯一后端桥接：runOnBackend + SQL
//    Dashboard   任务面板视图（PANEL_CSS 随之导出）
//    Inbox       收集箱视图（任务列表 + 处理收集箱按钮；快速收集由全局启动脚本负责）
//
//  双视图机制（同 TriliumNext-GTD 模式，不是选项卡）：
//    一套代码 bundle，多个宿主 Render 笔记共用；
//    宿主 Render 笔记用标签声明自己渲染哪个视图：
//      #gtdPage=dashboard → 任务面板（默认，无标签也渲染这个）
//      #gtdPage=inbox     → 收集箱
//    入口通过 bundle 注入的全局 originEntity 读取宿主标签并路由。
//
//  安装步骤：
//    1. 新建一个 Render 笔记，把本文件全文贴进内容；正下方（直接子级）
//       新建 4 个 Code 笔记（JavaScript Frontend），标题一字不差：
//         gtdCore / gtdBackend / Dashboard / Inbox
//       对应 .jsx 文件全文贴入 —— 这套是「代码宿主」
//    2. 「任务面板」Render 笔记：加标签 #gtdPage=dashboard，
//       用 ~renderNote 关系指向代码宿主（或直接复制一套代码）
//    3. 「收集箱」Render 笔记：加标签 #gtdPage=inbox，同样指向代码宿主
//
//  依赖规则（星型结构，本入口是唯一中心）：
//    - 子模块之间不能互相引用，一切通信经本入口中转
//    - 只有本入口 import 官方包（trilium:preact / trilium:api）
//    - 后端函数体自包含（见 gtdBackend）
//    - 禁用 ?? 与 ?. （编译器不注入 helper，用了直接加载失败）
//
//  ── 功能说明（与原 gtd-task-panel.js 一致）──
//  状态识别：TriliumNext 原生 data-trilium-task-state
//    doing → Today's Focus；(无属性) → Next Actions；waiting → Waiting For
//    #yyyy-mm-dd → Calendar（可与上面多分组同时出现）
//    日期为今天/已过期未完成 → 额外进入 Today's Focus
//    Today's Focus 第一条文本标红；maybe/cancelled/checked 不显示
//  流程模式：#flowMode=sequential 的清单按序列规则过滤（见 gtdCore）
//  交互：
//    左键复选框 → 完成任务；右键复选框 → 状态菜单
//    点击任务文本 → 打开来源笔记并闪烁定位；点击来源名 → 打开笔记
//    拖动手柄 → 调整 Today's Focus 顺序（localStorage，仅本机）
//  刷新：操作后静默重渲染；切回页面/笔记自动刷新；持续可见 1 分钟自动同步
// ============================================================

import { useState, useEffect, useRef } from "trilium:preact";
// Render 笔记里 runOnBackend 不是全局变量，必须从 "trilium:api" 导入；
// 只有入口能 import 官方包，所以再把它注入给 gtdBackend 使用
import { activateNote, runOnBackend } from "trilium:api";

// ── 宿主（被渲染的）笔记 —— render bundle 运行时注入全局 originEntity ──
const hostNote = (typeof originEntity !== 'undefined' && originEntity) ? originEntity : null;

// ── 子笔记模块存在性检查（缺失/标题不符时报出可读的错误，
//    否则解构 undefined 会让加载失败信息难以定位）──
if (typeof gtdCore === 'undefined' || typeof gtdBackend === 'undefined'
    || typeof Dashboard === 'undefined' || typeof Inbox === 'undefined') {
    throw new Error('GTD 面板加载失败：缺少子笔记模块。'
        + '请检查 gtdCore / gtdBackend / Dashboard / Inbox 四个子笔记是否存在，'
        + '标题是否与全局模块名一字不差。');
}

// ── 从各模块取能力（子笔记标题即全局变量名）──
const {
    SCOPE, EXCLUDE, SORTABLE_SECTION, STATE_MENU, ORDER_STEP,
    todayStr, normText, extractTaskText, DATE_GLOBAL_RE,
    parseNotes, computeSeqHidden, buildSections, readPageKey,
    INBOX_NOTE_ID, INBOX_TASKS_TITLES, parseInboxItems,
    loadOrderMap, saveOrderMap, pruneOrderMap, applyStoredOrder
} = gtdCore;

const { collectTasks, writeTaskState, collectInboxTasks } = gtdBackend;

const dashboardMod = Dashboard;
const { Dashboard: DashboardView, PANEL_CSS, StateMenu } = dashboardMod;

const inboxMod = Inbox;
const { Inbox: InboxView, INBOX_CSS } = inboxMod;

// ── 自动刷新策略（与原版一致）──
const REFRESH_MIN_GAP = 5000;     // 两次自动刷新之间的最小间隔
const REFRESH_IDLE_GAP = 60000;   // 面板一直可见时，数据超过 1 分钟同步一次
const POINTER_COOLDOWN = 800;     // 松手后多久内不刷新（让点击/拖拽收尾完成）
const STUCK_POINTER_MS = 10000;   // 指针事件丢失时，超过该时长强制复位
const WATCH_INTERVAL = 1000;      // 可见性检查间隔

const sleep = ms => new Promise(r => setTimeout(r, ms));

// =========================================================
// 编辑器定位与高亮浮层（操作面板之外的编辑器 DOM，模块级实现）
// 不修改编辑器 DOM，用独立 fixed 浮层闪烁，避免 CKEditor 重建节点
// =========================================================
let hiliteEl = null;
let openToken = 0; // 连续点击多个任务时，只有最后一次定位/闪烁生效

function ensureHilite() {
    if (!hiliteEl) {
        hiliteEl = document.createElement('div');
        hiliteEl.style.cssText = [
            'position:fixed', 'pointer-events:none', 'z-index:9998',
            'border-radius:4px', 'outline-offset:1px', 'display:none',
            'background-color:rgba(249, 226, 175, .36)',
            'outline:2px solid rgba(249, 226, 175, .95)'
        ].join(';');
        document.body.appendChild(hiliteEl);
    }
    return hiliteEl;
}

function paintHilite(el) {
    const r = el.getBoundingClientRect();

    // 元素不可见（折叠/隐藏的列表）时不绘制
    if (r.width === 0 && r.height === 0) { hideHilite(); return; }

    const h = ensureHilite();
    h.style.display = 'block';
    h.style.left = r.left + 'px';
    h.style.top = r.top + 'px';
    h.style.width = r.width + 'px';
    h.style.height = r.height + 'px';
}

function hideHilite() { if (hiliteEl) hiliteEl.style.display = 'none'; }
function clearHilite() { if (hiliteEl) { hiliteEl.remove(); hiliteEl = null; } }

// 读取编辑器中某个 checkbox 对应的任务文本（用于校验定位是否准确）
// 面板里的任务文本已剥离 #日期，这里同样剥离后再比较，否则永远失配
function editorTaskText(input) {
    return normText(
        extractTaskText(input, input.closest('li')).replace(DATE_GLOBAL_RE, ''));
}

// 在已打开的编辑器里定位第 cbIndex 个 checkbox 所在的 li
// 优先级：可见 + 文本匹配 > 文本匹配；只按文本定位，不做"可见兜底"，
// 定位不到总比定错位置安全
function locateTaskElement(cbIndex, taskText) {

    if (!Number.isInteger(cbIndex) || cbIndex < 0) return null;

    const wanted = normText(taskText);
    let textMatchOnly = null;

    for (const editor of document.querySelectorAll('.ck-content')) {

        const inputs = editor.querySelectorAll('input[type="checkbox"]');
        if (cbIndex >= inputs.length) continue;

        const input = inputs[cbIndex];
        const visible = editor.getBoundingClientRect().width > 0;
        const el = input.closest('li') || input;

        if (editorTaskText(input) === wanted) {
            if (visible) return el;                 // 最优：可见且文本一致
            if (!textMatchOnly) textMatchOnly = el; // 次优：文本一致但编辑器不可见
        }
    }

    return textMatchOnly;
}

async function openTaskAtPosition(noteId, cbIndex, taskText) {

    const token = ++openToken;
    clearHilite();

    try {
        await activateNote(noteId);
    } catch (e) {
        console.error(e);
        return;
    }

    // 1) 等待编辑器渲染出目标元素（最多 4 秒）
    const deadline = Date.now() + 4000;
    let target = null;

    while (!target && Date.now() < deadline) {
        if (token !== openToken) return; // 已有更新的点击
        target = locateTaskElement(cbIndex, taskText);
        if (!target) await sleep(100);
    }
    if (!target) return;

    target.scrollIntoView({ behavior: 'auto', block: 'center' });

    // 2) 闪烁（亮 260ms / 灭 260ms，共 4 个来回），前 600ms 顺带纠正滚动位置
    await new Promise(resolve => {
        const start = performance.now();
        const STEP = 260;          // 单个相位时长（亮或灭）
        const ROUNDS = 4;          // 亮灭来回次数
        const TOTAL = STEP * 2 * ROUNDS;
        const SCROLL_WINDOW = 600; // 只在前 600ms 内纠正滚动，避免干扰用户
        let lastScrollAt = 0;
        let el = target; // 复用已定位的元素，避免每帧全量查询 DOM

        const step = now => {
            if (token !== openToken) { // 已被更新的点击接管
                resolve();
                return;
            }

            // 编辑器重建节点后 isConnected 会变 false，此时重新定位
            if (!el || !el.isConnected) el = locateTaskElement(cbIndex, taskText);

            const elapsed = now - start;

            if (el && el.isConnected) {
                // 编辑器异步渲染可能重置滚动位置，前 600ms 内持续纠正
                if (elapsed < SCROLL_WINDOW && now - lastScrollAt >= 100) {
                    lastScrollAt = now;
                    el.scrollIntoView({ behavior: 'auto', block: 'center' });
                }

                // 偶数相位 = 亮，奇数相位 = 灭
                if (Math.floor(elapsed / STEP) % 2 === 0) paintHilite(el);
                else hideHilite();
            }

            if (elapsed < TOTAL) requestAnimationFrame(step);
            else resolve();
        };

        requestAnimationFrame(step);
    });

    if (token === openToken) clearHilite();
}

// =========================================================
// 入口组件：状态管理 + 数据加载 + 全部回调 + 自动刷新循环
// =========================================================
export default function GtdMain() {

    const [status, setStatus] = useState('loading'); // loading | ready | empty | error | config
    const [errorText, setErrorText] = useState('');
    const [sections, setSections] = useState([]);

    // ── 页面路由：宿主 Render 笔记的 #gtdPage 标签决定渲染哪个视图 ──
    // dashboard=任务面板（默认） | inbox=收集箱；页面身份在挂载时确定，不变
    const [page] = useState(() => readPageKey(hostNote));

    const [completingKeys, setCompletingKeys] = useState(() => new Set());
    const [menu, setMenu] = useState(null); // { task, x, y } | null

    // ── 收集箱视图数据（page === 'inbox' 时使用）──
    const [inboxStatus, setInboxStatus] = useState('loading'); // loading | ready | error
    const [inboxItems, setInboxItems] = useState([]);
    const [inboxError, setInboxError] = useState('');
    const inboxSeqRef = useRef(0);
    const lastInboxLoadAtRef = useRef(0);
    const inboxNoteRef = useRef(null); // Tasks 子笔记 ID（勾选完成写回时用）

    const rootRef = useRef(null);

    // 长生命周期 / 跨闭包状态用 ref 存，避免异步回调读到旧值
    const loadSeqRef = useRef(0);          // 并发 load 时只允许最新一次写入
    const lastLoadAtRef = useRef(0);       // 上次成功加载时间
    const refreshingRef = useRef(false);
    const pointerDownAtRef = useRef(0);
    const lastPointerUpAtRef = useRef(0);
    const dragActiveRef = useRef(false);
    const menuRef = useRef(menu);
    const pageRef = useRef(page);
    const sectionsRef = useRef(sections);
    const completingRef = useRef(new Set());

    useEffect(() => { menuRef.current = menu; }, [menu]);
    useEffect(() => { pageRef.current = page; }, [page]);
    useEffect(() => { sectionsRef.current = sections; }, [sections]);

    // ── 数据加载（seq 防并发覆盖，逻辑与原版一致）──
    async function load(silent) {

        const seq = ++loadSeqRef.current;

        if (SCOPE.length === 0) {
            setStatus('config');
            return;
        }

        if (!silent) setStatus('loading');

        try {

            // ── Backend：收集范围内的未完成任务 ──
            const rawNotes = (await collectTasks(runOnBackend, SCOPE, EXCLUDE)) || [];

            // 已有更新的加载发起，丢弃本次结果
            if (seq !== loadSeqRef.current) return;

            // ── Frontend：解析任务与状态 ──
            const today = todayStr();
            const allTasks = parseNotes(rawNotes, today);
            const seqHidden = computeSeqHidden(allTasks);
            const nextSections = buildSections(allTasks, today, seqHidden);

            // 检索范围内没有任何任务时直接提示
            // （此时不动存储，避免异常空结果误清排序）
            if (allTasks.length === 0) {
                if (seq === loadSeqRef.current) {
                    setSections(nextSections);
                    setStatus('empty');
                    lastLoadAtRef.current = Date.now();
                }
                return;
            }

            // Today's Focus：先按当前任务清理失效排位，再应用自定义排序
            const doingSection = nextSections.find(s => s.key === SORTABLE_SECTION);
            if (doingSection) {
                const map = pruneOrderMap(
                    loadOrderMap(), doingSection.tasks.map(t => t.key));
                doingSection.tasks = applyStoredOrder(doingSection.tasks, map);
            }

            if (seq !== loadSeqRef.current) return;

            setSections(nextSections);
            setStatus('ready');
            lastLoadAtRef.current = Date.now();

        } catch (err) {

            console.error(err);

            // 失败也进入冷却期，避免自动刷新反复打后端
            lastLoadAtRef.current = Date.now();

            if (seq === loadSeqRef.current) {
                setErrorText(String((err && err.message) || err));
                setStatus('error');
            }
        }
    }

    // ── 完成任务：先写后端，淡出动画结束后静默刷新 ──
    async function handleComplete(task) {

        if (completingRef.current.has(task.key)) return;
        completingRef.current.add(task.key);
        setCompletingKeys(new Set(completingRef.current));

        try {

            // Backend：标记完成（勾选 input + 移除 li 上的状态属性）
            await writeTaskState(runOnBackend, task.noteId, task.checkboxIndex, 'done', null);

            // UI：等淡出动画结束后静默刷新（任务可能同时出现在多个分组）
            setTimeout(() => {
                completingRef.current.delete(task.key);
                setCompletingKeys(new Set(completingRef.current));
                load(true);
            }, 250);

        } catch (err) {
            console.error(err);
            completingRef.current.delete(task.key);
            setCompletingKeys(new Set(completingRef.current));
        }
    }

    // ── 右键菜单选择状态（任务面板 / 收集箱共用）──
    async function handleMenuSelect(item) {

        const current = menuRef.current;
        setMenu(null);
        if (!current) return;

        try {
            await writeTaskState(
                runOnBackend,
                current.task.noteId, current.task.checkboxIndex, item.value, item.label);

            // 按当前视图刷新对应数据（收集箱设为待定/已取消后条目会消失）
            if (pageRef.current === 'inbox') await loadInbox(true);
            else await load(true);
        } catch (err) {
            console.error(err);
            alert('切换状态失败：' + ((err && err.message) || err));
        }
    }

    // ── 点击任务文本：打开笔记并闪烁定位 ──
    function handleOpenTask(task) {
        openTaskAtPosition(task.noteId, task.checkboxIndex, task.text);
    }

    // ── 点击来源笔记名：打开笔记 ──
    function handleOpenNote(noteId) {
        activateNote(noteId).catch(e => console.error(e));
    }

    // ── 拖拽排序：拖动中实时预览（在状态里移动行），松手提交排位 ──
    function handleDragStart() {
        dragActiveRef.current = true;
    }

    function handleDragOverRow(dragKey, targetKey, after) {
        setSections(prevSections => prevSections.map(s => {
            if (s.key !== SORTABLE_SECTION) return s;

            const tasks = s.tasks.slice();
            const from = tasks.findIndex(t => t.key === dragKey);
            const to = tasks.findIndex(t => t.key === targetKey);
            if (from < 0 || to < 0 || from === to) return s;

            const moved = tasks.splice(from, 1)[0];
            const idx = tasks.findIndex(t => t.key === targetKey);
            tasks.splice(after ? idx + 1 : idx, 0, moved);

            return Object.assign({}, s, { tasks });
        }));
    }

    function handleDragEnd() {
        dragActiveRef.current = false;

        // HTML5 拖拽期间可能收不到 pointerup，这里手动复位交互状态
        pointerDownAtRef.current = 0;
        lastPointerUpAtRef.current = performance.now();

        commitDoingOrder();
    }

    // 按当前 Today's Focus 顺序重排排位；
    // 顺序真的变了才写盘并重渲染（让"首条标红"跟到新的第一行）
    function commitDoingOrder() {

        const doing = sectionsRef.current.find(s => s.key === SORTABLE_SECTION);
        if (!doing) return;

        const map = {};
        doing.tasks.forEach((t, i) => { map[t.key] = (i + 1) * ORDER_STEP; });

        const previous = loadOrderMap();
        const changed = Object.keys(map).length !== Object.keys(previous).length
            || Object.keys(map).some(key => previous[key] !== map[key]);

        if (changed) {
            saveOrderMap(map);
            load(true);
        }
    }

    // ── 收集箱数据加载（page === 'inbox' 时使用）──
    async function loadInbox(silent) {

        const seq = ++inboxSeqRef.current;

        if (!INBOX_NOTE_ID || INBOX_NOTE_ID.indexOf('填写') >= 0) {
            setInboxStatus('error');
            setInboxError('请先在 gtdCore 顶部配置 INBOX_NOTE_ID（Inbox 笔记 ID）');
            return;
        }

        if (!silent) setInboxStatus('loading');

        try {
            const raw = await collectInboxTasks(runOnBackend, INBOX_NOTE_ID, INBOX_TASKS_TITLES);
            if (seq !== inboxSeqRef.current) return;
            inboxNoteRef.current = raw.noteId;
            setInboxItems(parseInboxItems(raw.content));
            setInboxStatus('ready');
            lastInboxLoadAtRef.current = Date.now();
        } catch (err) {
            console.error(err);
            lastInboxLoadAtRef.current = Date.now(); // 失败也进入冷却期
            if (seq === inboxSeqRef.current) {
                setInboxError(String((err && err.message) || err));
                setInboxStatus('error');
            }
        }
    }

    // ── 收集箱"处理收集箱"按钮（功能后续接入）──
    function handleInboxProcess() {
        alert('处理收集箱：功能开发中');
    }

    // ── 收集箱勾选完成：与面板左键完成同一写回出口，写后静默刷新 ──
    async function handleInboxComplete(item) {

        const noteId = inboxNoteRef.current;
        if (!noteId) return;

        try {
            await writeTaskState(runOnBackend, noteId, item.checkboxIndex, 'done', null);
            await loadInbox(true);
        } catch (err) {
            console.error(err);
            alert('完成收集箱任务失败：' + ((err && err.message) || err));
        }
    }

    // ── 面板是否真的在页面上且可见：切走的笔记通常被 display:none 隐藏 ──
    function isPanelVisible() {
        const el = rootRef.current;
        if (!el || !document.contains(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // ── 自动刷新（所有打断条件与原版一致）──
    async function autoRefresh() {

        if (refreshingRef.current) return;

        // ── 收集箱视图：回到页面 / 定期同步时刷新收集箱列表 ──
        if (pageRef.current === 'inbox') {
            if (menuRef.current) return; // 状态菜单打开中
            if (Date.now() - lastInboxLoadAtRef.current < REFRESH_MIN_GAP) return;
            refreshingRef.current = true;
            try {
                await loadInbox(true);
            } catch (e) {
                console.error(e);
            } finally {
                refreshingRef.current = false;
            }
            return;
        }

        if (dragActiveRef.current) return;                     // 拖拽中不打断

        // 切笔记 / 拖到窗口外时 pointerup 可能丢失，超时就当作已松开
        if (pointerDownAtRef.current
            && performance.now() - pointerDownAtRef.current > STUCK_POINTER_MS) {
            pointerDownAtRef.current = 0;
        }

        if (pointerDownAtRef.current) return;                  // 点击/拖拽进行中
        if (performance.now() - lastPointerUpAtRef.current < POINTER_COOLDOWN) return;
        if (menuRef.current) return;                           // 状态菜单打开中
        if (!isPanelVisible()) return;                         // 面板不可见（在别的笔记里）
        if (Date.now() - lastLoadAtRef.current < REFRESH_MIN_GAP) return; // 刚刷新过

        refreshingRef.current = true;
        try {
            await load(true);
        } catch (e) {
            console.error(e);
        } finally {
            refreshingRef.current = false;
        }
    }

    // ── 样式注入（每次运行都重建，避免旧版本样式残留导致新增规则不生效）──
    useEffect(() => {
        const old = document.getElementById('gtd-task-styles');
        if (old) old.remove();

        const style = document.createElement('style');
        style.id = 'gtd-task-styles';
        style.textContent = PANEL_CSS + INBOX_CSS;
        document.head.appendChild(style);
    }, []);

    // ── 文档级指针松开（点击 / 拖拽收尾）──
    useEffect(() => {
        const onUp = () => {
            if (pointerDownAtRef.current) lastPointerUpAtRef.current = performance.now();
            pointerDownAtRef.current = 0;
        };
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        return () => {
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
        };
    }, []);

    // ── 回到页面自动刷新：可见性 / 焦点 / 每秒轮询兜底 ──
    useEffect(() => {
        let panelWasVisible = isPanelVisible();

        // 从其他窗口/标签页切回来
        const onVisibility = () => {
            if (document.visibilityState === 'visible') autoRefresh();
            else panelWasVisible = false;
        };
        const onFocus = () => autoRefresh();

        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', onFocus);

        // 同一窗口内切换笔记不会触发 focus / visibilitychange，
        // 用每秒一次的可见性检查兜底：不可见 → 可见即视为"回到页面"
        const timer = setInterval(() => {

            if (document.visibilityState !== 'visible') {
                panelWasVisible = false;
                return;
            }

            const visible = isPanelVisible();

            if (visible && !panelWasVisible) {
                panelWasVisible = true;
                autoRefresh(); // 刚回到页面
                return;
            }
            panelWasVisible = visible;

            // 一直开着也要定期同步
            if (visible && pageRef.current === 'dashboard'
                && Date.now() - lastLoadAtRef.current >= REFRESH_IDLE_GAP) {
                autoRefresh();
            }
        }, WATCH_INTERVAL);

        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', onFocus);
        };
    }, []);

    // ── 挂载后按页面身份加载对应数据 ──
    useEffect(() => {
        if (page === 'dashboard') load(false);
        else loadInbox(false);
    }, []);

    return (
        <div
            class="gtd-root"
            ref={rootRef}
            onPointerDown={() => { pointerDownAtRef.current = performance.now(); }}
        >
            {page === 'dashboard' && (
                status === 'loading'
                    ? <p class="gtd-placeholder">⏳ 正在加载任务…</p>
                    : status === 'config'
                    ? (
                        <p class="gtd-placeholder">
                            ⚙ 请在 gtdCore 顶部 <b>SCOPE</b> 列表中配置要检索的笔记 ID。<br />
                            <span style={{ fontSize: '13px' }}>
                                'noteId' → 仅该笔记；'noteId/' → 该笔记及其全部子笔记
                            </span>
                        </p>
                    )
                    : status === 'error'
                    ? (
                        <div class="gtd-error">
                            ✗ 加载任务失败<br /><br />{errorText}
                        </div>
                    )
                    : status === 'empty'
                    ? <p class="gtd-placeholder">✓ 检索范围内没有未完成任务。</p>
                    : (
                        <DashboardView
                            sections={sections}
                            todayStr={todayStr()}
                            completingKeys={completingKeys}
                            onMenuOpen={(task, x, y) => setMenu({ task, x, y })}
                            onComplete={handleComplete}
                            onOpenTask={handleOpenTask}
                            onOpenNote={handleOpenNote}
                            onDragStart={handleDragStart}
                            onDragOverRow={handleDragOverRow}
                            onDragEnd={handleDragEnd}
                        />
                    )
            )}

            {page === 'inbox' && (
                <InboxView
                    status={inboxStatus}
                    items={inboxItems}
                    errorText={inboxError}
                    onProcess={handleInboxProcess}
                    onComplete={handleInboxComplete}
                    onMenuOpen={(item, x, y) => setMenu({
                        task: {
                            noteId: inboxNoteRef.current,
                            checkboxIndex: item.checkboxIndex,
                            text: item.text
                        },
                        x, y
                    })}
                    onOpenTask={item => handleOpenTask({
                        noteId: inboxNoteRef.current,
                        checkboxIndex: item.checkboxIndex,
                        text: item.text
                    })}
                />
            )}

            {/* 状态菜单：两个视图共用（右键任务勾选框呼出） */}
            <StateMenu
                menu={menu}
                items={STATE_MENU}
                onSelect={handleMenuSelect}
                onClose={() => setMenu(null)}
            />
        </div>
    );
}
