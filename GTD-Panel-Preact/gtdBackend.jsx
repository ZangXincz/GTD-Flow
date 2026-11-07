// ============================================================
//  GTD 任务面板 · 后端桥接模块（子笔记标题必须为：gtdBackend）
// ============================================================
//  职责边界：
//    - 本项目唯一允许调用 runOnBackend 的模块
//    - 其他模块（入口 / 视图）一律通过这里的函数间接访问后端
//
//  ⚠ runOnBackend 在 Render 笔记里【不是全局变量】，必须从 "trilium:api" 导入；
//    而只有入口允许 import 官方包，所以由入口把它作为第一个参数传进来。
//
//  ⚠ runOnBackend 的函数体是【序列化后】在后端执行的：
//    - 函数体里不能引用本模块或任何模块的变量（闭包会断掉）
//    - 需要的数据全部通过第二个数组参数传入
//    - 需要的辅助函数必须在函数体内部重新定义
//    - 失败时 throw，前端 catch；成功时 return 数据
//
//  注意：不要用 ?? 和 ?.
// ============================================================

// 收集检索范围内的未完成任务（含笔记 HTML 内容与流程模式）
// runOnBackend: 由入口从 "trilium:api" 注入
export function collectTasks(runOnBackend, scope, exclude) {
    return runOnBackend((scope, exclude) => {

        // ── 以下代码在后端 Node.js 环境执行 ──
        // api.sql / api.getNote 等后端 API 都可以直接用

        // 解析 'id' / 'id/' 形式的条目 → noteId 集合
        const collectSubtree = (note, acc) => {
            for (const child of note.getChildNotes()) {
                acc.add(child.noteId);
                collectSubtree(child, acc);
            }
        };

        const resolveEntries = entries => {
            const acc = new Set();

            for (const entry of entries) {
                const raw = String(entry).trim();
                if (!raw) continue;

                const withChildren = raw.endsWith('/');
                const id = withChildren ? raw.slice(0, -1) : raw;
                const note = api.getNote(id);
                if (!note) continue;

                acc.add(note.noteId);
                if (withChildren) collectSubtree(note, acc);
            }

            return acc;
        };

        const targetIds = resolveEntries(scope);

        // 排斥列表：从目标集合中剔除（含其子树）
        for (const id of resolveEntries(exclude)) targetIds.delete(id);

        if (targetIds.size === 0) return [];

        // 只查目标范围内的 text 笔记（分块 IN 查询，避免全表扫描）
        const ids = Array.from(targetIds);
        const rows = [];
        const CHUNK = 500;

        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');

            rows.push(...api.sql.getRows(`
                SELECT noteId, title
                FROM notes
                WHERE isDeleted = 0 AND type = 'text'
                  AND noteId IN (${placeholders})
            `, chunk));
        }

        rows.sort((a, b) =>
            String(a.title || '').localeCompare(String(b.title || '')));

        return rows.map(row => {
            const note = api.getNote(row.noteId);

            // 流程模式：#flowMode 标签（sequential / 其他或无值 = 并行）
            // getLabelValue 会把祖先笔记上 inheritable 的标签一并算进来
            const flowMode = note
                ? String(note.getLabelValue('flowMode') || '').trim().toLowerCase()
                : '';

            return {
                noteId: row.noteId,
                title: row.title || '(无标题)',
                content: note ? String(note.getContent()) : '',
                flowMode: flowMode === 'sequential' ? 'sequential' : 'parallel'
            };
        });

    }, [scope, exclude]);
}

// 写回任务状态（面板唯一的状态写入出口）
// state: 'doing' | 'waiting' | 'maybe' | 'cancelled' | 'done' | null(清除状态)
//
// Trilium 的存储约定（从 document.db 实测）：
//   已完成   → <input checked="checked"> 且 <li> 不带 data-trilium-task-state
//   进行中等 → <li data-trilium-task-state="doing" title="进行中">，input 不勾选
// 只勾 input 而不处理 li 属性，编辑器会按状态属性重新渲染成原状态
// runOnBackend: 由入口从 "trilium:api" 注入
export function writeTaskState(runOnBackend, noteId, cbIndex, state, label) {
    return runOnBackend((noteId, cbIndex, state, label) => {

        const note = api.getNote(noteId);
        if (!note) throw new Error('笔记不存在：' + noteId);

        let content = String(note.getContent());

        // 1) 定位第 cbIndex 个 checkbox
        // 先匹配任意 <input> 标签再校验 type，避免属性顺序不同（如
        // <input checked type="checkbox">）导致序号错位、写错任务
        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, inputEnd = -1, inputAttrs = '', i = 0;

        while ((m = inputRe.exec(content)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) {
                inputStart = m.index;
                inputEnd = m.index + m[0].length;
                inputAttrs = m[0].replace(/^<input/i, '').replace(/>$/, '');
                break;
            }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        // 2) 向前找最近的 <li，中间不能有 </li>（否则说明不在该 li 内）
        const liStart = content.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (content.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        const liEnd = content.indexOf('>', liStart);
        let tag = content.slice(liStart, liEnd + 1);

        // 3) li：先清掉旧状态，再按需要写回（done / 清除状态都不带属性）
        tag = tag.replace(/\s*data-trilium-task-state="[^"]*"/i, '');
        tag = tag.replace(/\s*title="[^"]*"/i, '');

        if (state && state !== 'done' && label) {
            tag = tag.replace(/>$/,
                ` data-trilium-task-state="${state}" title="${label}">`);
        }

        // 4) input：done 勾选，其余取消勾选
        const attrs = inputAttrs.replace(/\s*checked(="[^"]*")?/i, '');
        const inputTag = state === 'done'
            ? `<input type="checkbox"${attrs} checked="checked">`
            : `<input type="checkbox"${attrs}>`;

        // 5) 先替换 input（在 li 开标签之后），再替换 li 开标签，偏移互不影响
        content = content.slice(0, inputStart) + inputTag + content.slice(inputEnd);
        content = content.slice(0, liStart) + tag + content.slice(liEnd + 1);

        note.setContent(content);

    }, [noteId, cbIndex, state, label]);
}

// 收集箱：读取 Inbox 下属 Tasks 笔记的原始内容
// 条目解析在前端 gtdCore.parseInboxItems 做（DOMParser），后端只取内容
// runOnBackend: 由入口从 "trilium:api" 注入
export function collectInboxTasks(runOnBackend, inboxNoteId, childTitles) {
    return runOnBackend((inboxNoteId, childTitles) => {

        const parent = api.getNote(inboxNoteId);
        if (!parent) {
            throw new Error('未找到 Inbox 笔记（检查 gtdCore 的 INBOX_NOTE_ID）');
        }

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

        return { noteId: target.noteId, content: String(target.getContent()) };

    }, [inboxNoteId, childTitles]);
}
