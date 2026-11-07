// ============================================================
//  GTD 任务面板 · 纯逻辑模块（子笔记标题必须为：gtdCore）
// ============================================================
//  职责边界：
//    - 常量配置 + 纯函数：不发请求、不操作页面 DOM、不用 hooks
//    - parseNotes 用 DOMParser 解析笔记 HTML（不接触页面文档）
//  注意：
//    - 不要 import 任何东西（包括官方包）
//    - 不要用 ?? 和 ?.
// ============================================================

// ── 配置：检索范围（在此填写笔记 ID）──
//   'noteId'   → 仅检索该笔记
//   'noteId/'  → 检索该笔记及其全部子笔记
export const SCOPE = [
    'kfU2z6nbGrEe/'
];

// ── 配置：排斥列表（优先级高于 SCOPE），逻辑同 SCOPE ──
export const EXCLUDE = [
    '88QGFwlEXVz2/',
    'quUL4mbpZIda/'
];

// ── 配置：收集箱 ──
// Inbox 笔记 ID；收集箱视图与快速收集的目标是其下属的 Tasks 子笔记
// （gtdGlobalCapture 启动脚本里有一份同样的配置，改动时两边同步）
export const INBOX_NOTE_ID = 'yAaUbAqVYu3S';

// Tasks 子笔记标题候选（按顺序匹配，大小写不敏感）
export const INBOX_TASKS_TITLES = ['Tasks'];

// 可拖拽排序的分组（只有 Today's Focus 支持）
export const SORTABLE_SECTION = 'doing';

// 右键菜单可切换的状态（value 与 Trilium 原生属性值一致）
export const STATE_MENU = [
    { value: 'doing',     label: '进行中' },
    { value: null,        label: '待办（清除状态）' },
    { value: 'waiting',   label: '等待中' },
    { value: 'maybe',     label: '待定' },
    { value: 'cancelled', label: '已取消' }
];

// ── Today's Focus 自定义排序（localStorage 持久化，仅本机生效）──
// 存储结构：{ "noteId::任务文本": 排位 }，排位小的在前
// 只保存"当前确实在 Today's Focus 里"的任务；状态变动 / 完成 / 文本改动
// 后不再匹配的键会在下次渲染时被自动清理，不会持续累积
export const ORDER_STORAGE_KEY = 'gtd.taskOrder.doing';
export const ORDER_STEP = 100; // 排位步长，留出插入空间

export const DATE_RE = /#(\d{4}-\d{2}-\d{2})/;
export const DATE_GLOBAL_RE = /#\d{4}-\d{2}-\d{2}/g;

// 归一化文本（压缩空白），任务提取与编辑器定位共用
export function normText(s) {
    return String(s).replace(/\s+/g, ' ').trim();
}

// 今天（本地时区）yyyy-mm-dd
export function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 从 checkbox 所在结构里取任务文本（兼容 label 包裹 / 无 label / 纯 li 三种写法）
export function extractTaskText(input, li) {

    // 1) Trilium 标准结构：<label class="todo-list__label"><input><span class="todo-list__label__description">
    const label = input.closest('label');
    const desc = label && label.querySelector('.todo-list__label__description');
    if (desc) return desc.textContent;

    // 2) 退一步：紧跟 checkbox 的兄弟元素（子列表不算，否则会把子任务文本拼进来）
    const sibling = input.nextElementSibling;
    if (sibling && sibling.tagName !== 'UL' && sibling.tagName !== 'OL'
        && sibling.textContent.trim()) {
        return sibling.textContent;
    }

    // 3) 兜底：整个 li，剔除子列表与 checkbox
    const host = li || input.closest('li');
    if (!host) return '';

    const clone = host.cloneNode(true);
    clone.querySelectorAll('ul, ol, input').forEach(node => node.remove());
    return clone.textContent;
}

// =========================================================
// 解析后端返回的笔记 → 任务数组
// today: yyyy-mm-dd，用于计算 overdue
// =========================================================
export function parseNotes(rawNotes, today) {

    const allTasks = [];
    const keyCounter = new Map(); // 同笔记内重名任务需要区分排序键
    const parser = new DOMParser();

    for (const row of rawNotes) {

        if (!row.content) continue;

        // DOMParser 解析，不接触页面文档；原生 DOM 解析比正则可靠
        const doc = parser.parseFromString(String(row.content), 'text/html');
        const inputs = doc.body.querySelectorAll('input[type="checkbox"]');
        let cbIndex = 0; // 笔记内所有 checkbox 的全局序号（与写回逻辑对应）

        // 顺序模式用：各层最近一个任务对象，用于建立父子链接
        const depthStack = [];

        for (const input of inputs) {

            const idx = cbIndex++;

            // 已勾选 = done，不显示
            if (input.checked) continue;

            const li = input.closest('li');
            const rawState = ((li && li.getAttribute('data-trilium-task-state')) || 'todo')
                .toLowerCase();

            // 待定 / 已取消 / 已完成（属性残留但未勾选）：不显示
            if (rawState === 'maybe' || rawState === 'cancelled' || rawState === 'done') continue;

            // 未知状态按普通待办处理，避免任务凭空消失
            const state = (rawState === 'doing' || rawState === 'waiting') ? rawState : 'todo';

            const text = normText(extractTaskText(input, li));
            if (!text) continue;

            const dateMatch = text.match(DATE_RE);
            const date = dateMatch ? dateMatch[1] : null;

            // 文本中的 #日期 由日期标签统一展示，这里从文本中全部移除，避免重复
            const displayText = date
                ? (normText(text.replace(DATE_GLOBAL_RE, '')) || date)
                : text;

            // 排序键：noteId + 文本，重名时追加序号
            const keyBase = row.noteId + '::' + displayText;
            const dupCount = (keyCounter.get(keyBase) || 0) + 1;
            keyCounter.set(keyBase, dupCount);
            const key = dupCount > 1 ? keyBase + '#' + dupCount : keyBase;

            // 嵌套深度：li 之上还有几层 li（顺序模式父子判定用）
            let depth = 0;
            if (li) {
                for (let p = li.parentElement; p && p !== doc.body; p = p.parentElement) {
                    if (p.tagName === 'LI') depth++;
                }
            }

            // 父任务 = 文档顺序中最近的一个上级任务（父任务已完成/无文本时不参与链接）
            const parent = depth > 0 ? (depthStack[depth - 1] || null) : null;

            const task = {
                noteId: row.noteId,
                noteTitle: row.title,
                text: displayText,
                checkboxIndex: idx,
                state,
                date,
                overdue: !!date && date < today,
                key,
                flowMode: row.flowMode,
                parent
            };
            allTasks.push(task);

            // 压栈：截断更深层残留，记录本层最近任务
            depthStack.length = depth;
            depthStack[depth] = task;
        }
    }

    return allTasks;
}

// =========================================================
// 收集箱：解析 Tasks 笔记内容 → 待处理条目（按文档顺序）
// 跳过已勾选条目；checkboxIndex 是笔记内所有 checkbox 的序号，
// 与写回端 writeTaskState 的定位口径一致，供后续"处理"操作使用
// =========================================================
export function parseInboxItems(content) {

    if (!content) return [];

    const doc = new DOMParser().parseFromString(String(content), 'text/html');
    const items = [];
    let cbIndex = 0;

    for (const input of doc.body.querySelectorAll('input[type="checkbox"]')) {
        const idx = cbIndex++;

        if (input.checked) continue; // 已处理的不列出

        const li = input.closest('li');

        // 待定 / 已取消视为已处理完毕，不再列出（与面板可见性规则呼应）
        const rawState = ((li && li.getAttribute('data-trilium-task-state')) || '').toLowerCase();
        if (rawState === 'maybe' || rawState === 'cancelled') continue;

        const text = normText(extractTaskText(input, li));
        if (!text) continue;

        items.push({ checkboxIndex: idx, text });
    }

    return items;
}

// =========================================================
// 顺序模式核心过滤（#flowMode=sequential，按清单=笔记独立生效）
// 输入：一个顺序清单内按文档顺序排列的任务
// 输出：focusTasks = 可显示的 doing（子树里没有更深 doing 的）
//       nextTodo  = "下一个待办"，最多 1 个；被 waiting 阻塞或没有时为 null
//
// 规则：
//   - doing 权重最高（手动标记），全部显示；仅当子树里还有 doing 时隐藏父，
//     只显示最深一层的 doing，避免父子重复
//   - todo 有未完成子任务 → 下钻显示第一个未完成子任务
//     （序列顺序 = checkbox 文档顺序，天然"子任务在前父任务在后"，逐层递归下钻）
//   - "下一个待办" = 最后一个 doing 之后（无 doing 则从清单开头）遇到的
//     第一个未完成任务；doing 之前的残留 todo 视为跳过不显示
//   - waiting 阻塞其后所有 todo；带日期任务旁路，不算序列位置
// =========================================================
export function filterSequentialList(tasks) {

    const childrenMap = new Map();
    const roots = [];

    for (const t of tasks) {
        if (t.parent) {
            if (!childrenMap.has(t.parent)) childrenMap.set(t.parent, []);
            childrenMap.get(t.parent).push(t);
        } else {
            roots.push(t);
        }
    }

    const hasUnfinishedChildren = t =>
        childrenMap.has(t) && childrenMap.get(t).length > 0;

    // 递归扫描一个层级，返回 { status: 'todo' | 'blocked' | 'none', task? }
    const scanLevel = levelTasks => {

        let lastDoingIdx = -1;
        levelTasks.forEach((t, i) => {
            if (t.state === 'doing') lastDoingIdx = i;
        });

        for (let i = 0; i < levelTasks.length; i++) {
            const t = levelTasks[i];

            // 带日期的任务旁路：不算序列位置，由日期逻辑单独展示
            if (t.date) continue;

            if (t.state === 'waiting') {
                // waiting 阻塞其后所有 todo（waiting 本身照常显示在 Waiting For）
                if (i > lastDoingIdx) return { status: 'blocked' };
                continue;
            }

            if (t.state === 'doing' || t.state === 'todo') {
                // 有未完成子任务 → 指针下钻子任务（找"进行中下的第一个 todo"）
                if (hasUnfinishedChildren(t)) {
                    const r = scanLevel(childrenMap.get(t));
                    if (r.status !== 'none') return r;
                    continue;
                }
                // doing 之前的 todo 是跳过的步骤；可见 doing 不作为待办
                if (t.state === 'todo' && i > lastDoingIdx) {
                    return { status: 'todo', task: t };
                }
            }
        }

        return { status: 'none' };
    };

    // Today's Focus：doing 权重最高，全部显示（前面有 todo 也不影响）；
    // 唯一例外：子树里还有 doing（父子同时 doing）时隐藏父，只显示最深一层
    const hasDoingDescendant = t => {
        const kids = childrenMap.get(t);
        if (!kids) return false;
        return kids.some(k => k.state === 'doing' || hasDoingDescendant(k));
    };

    const focusTasks = tasks.filter(
        t => t.state === 'doing' && !hasDoingDescendant(t));

    const result = scanLevel(roots);
    const nextTodo = result.status === 'todo' ? result.task : null;

    return { focusTasks, nextTodo };
}

// ── 计算顺序模式隐藏集合（被顺序规则隐藏的任务 key）──
export function computeSeqHidden(allTasks) {

    const seqHidden = new Set();
    const byNote = new Map();

    for (const t of allTasks) {
        if (t.flowMode !== 'sequential') continue;
        if (!byNote.has(t.noteId)) byNote.set(t.noteId, []);
        byNote.get(t.noteId).push(t);
    }

    for (const tasks of byNote.values()) {
        const result = filterSequentialList(tasks);
        const visibleDoing = new Set(result.focusTasks.map(t => t.key));

        for (const t of tasks) {
            // waiting / 带日期任务始终显示（旁路）
            if (t.state === 'waiting' || t.date) continue;
            if (t.state === 'doing' && visibleDoing.has(t.key)) continue;
            if (result.nextTodo && t.key === result.nextTodo.key) continue;
            seqHidden.add(t.key);
        }
    }

    return seqHidden;
}

// ── 按状态分组（Today's Focus 的排序由入口在分组后应用）──
export function buildSections(allTasks, today, seqHidden) {
    return [
        {
            key: 'doing',
            label: "Today's Focus",
            color: '#ef5350', // 红色：今日焦点，最高优先级
            // 进行中 + 日期为今天 + 已过期的未完成任务（后两者不限状态）
            tasks: allTasks.filter(t =>
                !seqHidden.has(t.key) &&
                (t.state === 'doing' || t.date === today || t.overdue))
        },
        {
            key: 'todo',
            label: 'Next Actions',
            color: '#a6e3a1',
            // 已进入 Today's Focus 的（今天/过期）不再重复显示，日历照常
            tasks: allTasks.filter(t => t.state === 'todo'
                && !seqHidden.has(t.key)
                && t.date !== today && !t.overdue)
        },
        {
            key: 'waiting',
            label: 'Waiting For',
            color: '#9e9e9e', // 灰色：等待中，低存在感
            tasks: allTasks.filter(t => t.state === 'waiting')
        },
        {
            key: 'calendar',
            label: 'Calendar',
            color: '#64b5f6', // 浅蓝：日历，时间感
            tasks: allTasks
                .filter(t => t.date)
                .sort((a, b) => (
                    a.date < b.date ? -1 :
                    a.date > b.date ? 1 : 0
                ))
        }
    ];
}

// =========================================================
// 排位表存取
// =========================================================

// 读取排位表
export function loadOrderMap() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || '{}');
        const map = {};

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const key of Object.keys(parsed)) {
                const rank = parsed[key];
                if (typeof rank === 'number' && Number.isFinite(rank)) map[key] = rank;
            }
        }

        return map;
    } catch (e) {
        console.error(e);
        return {};
    }
}

export function saveOrderMap(map) {
    try {
        localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
        console.error(e);
    }
}

// 只保留 keys 中仍存在的任务，其余（已完成 / 状态变动 / 文本已改）直接丢弃
export function pruneOrderMap(map, keys) {
    const keep = new Set(keys);
    let changed = false;

    for (const key of Object.keys(map)) {
        if (!keep.has(key)) {
            delete map[key];
            changed = true;
        }
    }

    if (changed) saveOrderMap(map);
    return map;
}

// 有排位的按排位升序在前，没排位的保持默认相对顺序排在后面
export function applyStoredOrder(tasks, map) {
    const rank = t => (map[t.key] === undefined ? Infinity : map[t.key]);

    return tasks
        .map((t, i) => ({ t, i }))
        .sort((a, b) => {
            const ra = rank(a.t);
            const rb = rank(b.t);
            return ra === rb ? a.i - b.i : ra - rb;
        })
        .map(x => x.t);
}

// =========================================================
// 页面路由（同 TriliumNext-GTD 模式）
// 一套代码 bundle，多个宿主 Render 笔记共用；
// 宿主笔记用 #gtdPage=xxx 标签声明自己渲染哪个视图
// =========================================================

// 页面标识 → 显示名
export const PAGE_TITLES = {
    dashboard: '任务面板',
    inbox: '收集箱'
};

// 支持的页面标识（默认回落 dashboard）
export const PAGE_KEYS = Object.keys(PAGE_TITLES);

// 前端 FNote.getOwnedAttributes() 不支持 (type, name) 参数过滤，
// 取全部属性后手动过滤；getLabelValue 作降级
function readLabelValue(note, name) {
    // 降级 1：取宿主全部自有属性后手动过滤
    try {
        if (note && note.getOwnedAttributes) {
            const attrs = note.getOwnedAttributes();
            if (attrs && attrs.length) {
                for (const a of attrs) {
                    if (a && a.type === 'label' && a.name === name && a.value) {
                        return String(a.value);
                    }
                }
            }
        }
    } catch (e) { /* ignore */ }
    // 降级 2：FNote.getLabelValue（部分版本可用）
    try {
        if (note && note.getLabelValue) {
            const v = note.getLabelValue(name);
            if (v) return String(v);
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 读取宿主声明的页面身份；无标签或值非法时回落 'dashboard'
export function readPageKey(hostNote) {
    const v = readLabelValue(hostNote, 'gtdPage');
    const key = v ? String(v).toLowerCase().trim() : '';
    return PAGE_KEYS.indexOf(key) >= 0 ? key : 'dashboard';
}
