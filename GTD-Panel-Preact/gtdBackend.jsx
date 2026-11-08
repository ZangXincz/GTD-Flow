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
// paused: 暂停项目子树清单（'id'/'id/'），命中笔记标记 paused=true，
//         内容照常返回，由前端 parseNotes 按状态软过滤
// runOnBackend: 由入口从 "trilium:api" 注入
export function collectTasks(runOnBackend, scope, exclude, paused) {
    return runOnBackend((scope, exclude, paused) => {

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

        // 排斥列表（归档等硬排斥）：从目标集合中剔除（含其子树）
        for (const id of resolveEntries(exclude)) targetIds.delete(id);

        // 暂停项目子树集合：只做标记，不剔除（软排斥）
        const pausedIds = resolveEntries(paused || []);

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
                flowMode: flowMode === 'sequential' ? 'sequential' : 'parallel',
                paused: pausedIds.has(row.noteId)
            };
        });

    }, [scope, exclude, paused]);
}

// 面板任务状态写回（完成/取消/切换状态），含归档与项目处理记录
// state: 'doing' | 'waiting' | 'maybe' | 'cancelled' | 'done' | null(清除状态)
//
// Trilium 的存储约定（从 document.db 实测）：
//   已完成   → <input checked="checked"> 且 <li> 不带 data-trilium-task-state
//   进行中等 → <li data-trilium-task-state="doing" title="进行中">，input 不勾选
//
// 额外行为：
//   done/cancelled → 任务文本追加完成时间戳 #done:/#cancelled:yyyy-mm-dd HH-mm
//   其他状态       → 移除已有时间戳
//   任务在 Quick Tasks 里且为 done/cancelled → 移入 Archive 列表最前（最新在最上）
//   任务在项目子树里 → 刷新 Archive 的项目处理记录（已勾选任务形式，
//   文本「今日 项目（#noteId）完成 N 个任务」+ #done:时间戳；重新统计，幂等；
//   #noteId 作为定位锚点，项目改名后记录仍可接续，标题随当前名重写）
// opts: { archiveNoteId, quickNoteId, projectsRoot }，字段可为 null（跳过对应分支）
// text: 面板端任务文本，写盘前与 li 实际文本比对（防止面板数据过期按序号改错
//       条目）；为空则跳过校验
// runOnBackend: 由入口从 "trilium:api" 注入
export function archiveTask(runOnBackend, noteId, cbIndex, state, label, opts, text, repeatDate) {
    return runOnBackend((noteId, cbIndex, state, label, opts, text, repeatDate) => {

        const isDone = state === 'done';
        const isClosed = isDone || state === 'cancelled';
        const closeTag = isDone ? 'done' : 'cancelled';

        // 时间戳：yyyy-mm-dd HH-mm（与日历的 #yyyy-mm-dd 通过 #done:/#cancelled: 前缀区分）
        const p = n => String(n).padStart(2, '0');
        const now = new Date();
        const stamp = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
            + ' ' + p(now.getHours()) + '-' + p(now.getMinutes());

        // ── 1) 定位第 cbIndex 个任务 li（先匹配任意 input 再校验 type，防序号错位）──
        const note = api.getNote(noteId);
        if (!note) throw new Error('笔记不存在：' + noteId);

        const content = String(note.getContent());

        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, i = 0;
        while ((m = inputRe.exec(content)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) { inputStart = m.index; break; }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        const liStart = content.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (content.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        // 深度扫描找配对的 </li>（任务子内容里可能有嵌套列表）
        const liTagRe = /<(\/?)li\b[^>]*>/gi;
        liTagRe.lastIndex = liStart;
        let depth = 0, mm, liEnd = -1;
        while ((mm = liTagRe.exec(content)) !== null) {
            if (mm[1] === '/') {
                depth--;
                if (depth === 0) { liEnd = mm.index + mm[0].length; break; }
            } else {
                depth++;
            }
        }
        if (liEnd < 0) throw new Error('li 标签不配对');

        // ── 2) 修改 li：文本时间戳 + 状态属性 + input 勾选 ──
        let liHtml = content.slice(liStart, liEnd);

        // 文本校验：预期文本与 li 实际文本不一致时拒绝写盘。
        // 面板数据过期（操作前笔记已被编辑，checkbox 序号错位）时，
        // 与其按序号改错条目，不如直接报错让用户刷新面板
        const normLiText = s => String(s)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/#every:[a-z0-9]+/gi, '')
            .replace(/#\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expectedText = normLiText(text);
        if (expectedText) {
            const chk = liHtml.match(
                /<span class="todo-list__label__description"[^>]*>([\s\S]*?)<\/span>/i);
            if (chk && normLiText(chk[1]) !== expectedText) {
                throw new Error('任务内容已变化，面板数据可能过期，请刷新面板后重试');
            }
        }

        // 最后一个「顶层列表」的闭合位置。不能用 lastIndexOf('</ul>')：
        // 上次插入的条目可能带嵌套子内容（备注子列表），那时整个内容里
        // 最后一个 </ul> 是嵌套子列表的闭合，锚点会插进上一条的子列表里
        const lastTopUlClose = s => {
            const re = /<(\/?)ul\b[^>]*>/gi;
            let depth = 0, last = -1, m;
            while ((m = re.exec(s)) !== null) {
                if (m[1] === '/') {
                    depth--;
                    if (depth === 0) last = m.index;
                } else {
                    depth++;
                }
            }
            return last;
        };

        // 文本：移除旧时间戳，done/cancelled 追加新的
        const descRe = /(<span class="todo-list__label__description"[^>]*>)([\s\S]*?)(<\/span>)/i;
        const dm = liHtml.match(descRe);
        if (!dm) throw new Error('未找到任务文本');
        let inner = dm[2]
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/\s+$/, '');
        // 原始文本（未盖完成时间戳）：重复任务的翻新/履历用
        const repeatInner = inner;
        if (isClosed) inner = inner + ' #' + closeTag + ':' + stamp;
        liHtml = liHtml.slice(0, dm.index) + dm[1] + inner + dm[3]
            + liHtml.slice(dm.index + dm[0].length);

        // li 开标签：清旧状态，按需写回（done / 清除状态都不带属性）
        // title 只精确匹配本系统写入的状态提示词，避免误删其他用途的 title 属性
        const liOpenEnd = liHtml.indexOf('>');
        let openTag = liHtml.slice(0, liOpenEnd + 1);
        openTag = openTag.replace(/\s*data-trilium-task-state="[^"]*"/i, '');
        openTag = openTag.replace(/\s*title="(?:进行中|等待中|已取消|已完成|待定|待办)"/i, '');
        if (state && !isDone && label) {
            // label 做属性值转义（引号/尖括号），防止破坏 HTML
            const safeLabel = String(label)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/"/g, '&quot;');
            openTag = openTag.replace(/>$/,
                ` data-trilium-task-state="${state}" title="${safeLabel}">`);
        }
        liHtml = openTag + liHtml.slice(liOpenEnd + 1);

        // input：done 勾选，其余取消勾选
        const im = liHtml.match(/<input\b[^>]*>/i);
        if (im) {
            let attrs = im[0].replace(/\s*checked(="[^"]*")?/i, '');
            if (isDone) attrs = attrs.replace(/>$/, ' checked="checked">');
            liHtml = liHtml.slice(0, im.index) + attrs
                + liHtml.slice(im.index + im[0].length);
        }

        const closedContent = content.slice(0, liStart) + liHtml + content.slice(liEnd);

        // ── 2.5) 重复任务：#every: 标记 + 完成时（仅 done；取消=终止循环）生成下一次 ──
        // repeatDate 由前端 gtdRepeat.nextRepeatDate 按锚点 #日期 算好传入，后端不算日期
        // 快速任务：原 li 翻新（未勾选、换新日期），完成副本照常进 Archive
        // 项目等笔记：父 li 整体翻新，已完成记录收进子内容（见下）
        const repM = isDone ? repeatInner.match(/#every:([a-z0-9]+)/i) : null;
        let quickRepeatLi = null;     // Quick Tasks：原位置翻新后的 li
        let projectRepeatLi = null;   // 项目：翻新后的父 li（含履历子内容）
        if (isDone && repM && repeatDate && repeatInner.match(/#\d{4}-\d{2}-\d{2}/)) {

            // 翻新文本：旧 #日期 → 下一次日期；#every: 标记保留
            const renewedInner = repeatInner
                .replace(/#\d{4}-\d{2}-\d{2}/g, ' #' + repeatDate)
                .replace(/\s+/g, ' ')
                .trim();

            // 未勾选的 label span（全新待办）
            const freshLabel = '<span class="todo-list__label">'
                + '<span contenteditable="false">'
                + '<input type="checkbox" tabindex="-1"></span>'
                + '<span class="todo-list__label__description">' + renewedInner + '</span>'
                + '</span>';

            if (opts && noteId === opts.quickNoteId) {
                // Quick Tasks：从已盖戳的 liHtml 逆操作出翻新 li（保留原子内容）
                let rl = liHtml.replace(descRe, (m0, m1, m2, m3) => m1 + renewedInner + m3);
                const rim = rl.match(/<input\b[^>]*>/i);
                if (rim) {
                    rl = rl.slice(0, rim.index)
                        + rim[0].replace(/\s*checked(="[^"]*")?/i, '')
                        + rl.slice(rim.index + rim[0].length);
                }
                const rOpenEnd = rl.indexOf('>');
                let rOpen = rl.slice(0, rOpenEnd + 1);
                rOpen = rOpen.replace(/\s*data-trilium-task-state="[^"]*"/i, '');
                rOpen = rOpen.replace(/\s*title="(?:进行中|等待中|已取消|已完成|待定|待办)"/i, '');
                quickRepeatLi = rOpen + rl.slice(rOpenEnd + 1);

            } else {
                // 项目等笔记：已完成的不动（#done: 标签保留，计数不受影响），
                // 父 li 翻新为下一次，履历收进子内容（均为任务文本形式）：
                //   [x] 任务名 #旧日期 #done:时间戳   ← 最近一次（唯一保留的细节）
                //   [x] 已折叠存档 N 条               ← 中间场次汇总（不保留细节）
                //   [x] 任务名 #第一次日期 #done:时间戳 ← 第一次完成记录，永久保留
                // 注意：重复任务的子内容被本系统接管，请勿手动存放其他内容
                const oldDateM = repeatInner.match(/#(\d{4}-\d{2}-\d{2})/);
                const cleanName = repeatInner
                    .replace(/#\d{4}-\d{2}-\d{2}/g, '')
                    .replace(/#every:[a-z0-9]+/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                // 从原始 li（未盖戳版本）解析现有履历：切出子内容里的顶层子 li
                const origLi = content.slice(liStart, liEnd);
                const descEnd = dm.index + dm[0].length;
                const ulAt = origLi.toLowerCase().indexOf('<ul', descEnd);
                let folded = 0;
                let prevDetailText = null;  // 旧的「最近一次」记录（含时间戳）
                let firstRecordText = null; // 已保存的「第一次」记录（含时间戳）

                if (ulAt >= 0) {
                    const ulRe = /<(\/?)ul\b[^>]*>/gi;
                    ulRe.lastIndex = ulAt;
                    let ud = 0, ulOpenEnd = -1, ulCloseAt = -1, um2;
                    while ((um2 = ulRe.exec(origLi)) !== null) {
                        if (um2[1] === '/') {
                            ud--;
                            if (ud === 0) { ulCloseAt = um2.index; break; }
                        } else {
                            if (ud === 0) ulOpenEnd = um2.index + um2[0].length;
                            ud++;
                        }
                    }
                    if (ulCloseAt >= 0) {
                        const region = origLi.slice(ulOpenEnd, ulCloseAt);
                        // 轻量归一化：只剥标签，保留 #done: 等标记（履历分类依据）
                        const cNorm = s => String(s)
                            .replace(/<[^>]*>/g, '')
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        const cLiRe = /<(\/?)li\b[^>]*>/gi;
                        let cd = 0, cStart = -1, cm2;
                        while ((cm2 = cLiRe.exec(region)) !== null) {
                            if (cm2[1] === '/') {
                                cd--;
                                if (cd === 0 && cStart >= 0) {
                                    const cHtml = region.slice(cStart, cm2.index + cm2[0].length);
                                    const cText = cNorm(cHtml);
                                    if (cText.indexOf('#done:') >= 0
                                        || cText.indexOf('#cancelled:') >= 0) {
                                        // 子内容固定顺序 [最近一次, 汇总, 第一次]，
                                        // 第 1 条带戳的是旧「最近一次」，第 2 条是「第一次」
                                        if (prevDetailText === null) {
                                            prevDetailText = cText;
                                        } else if (firstRecordText === null) {
                                            firstRecordText = cText;
                                        }
                                    } else {
                                        const fm = cText.match(/已折叠存档\s*(\d+)/);
                                        if (fm) folded = parseInt(fm[1], 10);
                                    }
                                    cStart = -1;
                                }
                            } else {
                                if (cd === 0) cStart = cm2.index;
                                cd++;
                            }
                        }
                    }
                }
                // 旧的「最近一次」何去何从：
                //   「第一次」记录已存在 → 它是中间场次，折叠进汇总（+1）
                //   尚无「第一次」记录   → 它就是第一次完成，转为永久保留的第一条
                if (prevDetailText && firstRecordText) folded++;
                const keepFirstRecord = firstRecordText || prevDetailText;

                const checkedLi = t => '<li><span class="todo-list__label">'
                    + '<span contenteditable="false">'
                    + '<input type="checkbox" tabindex="-1" checked="checked"></span>'
                    + '<span class="todo-list__label__description">' + t + '</span>'
                    + '</span></li>';

                let kids = checkedLi(cleanName + ' #' + oldDateM[1]
                    + ' #' + closeTag + ':' + stamp);
                if (folded > 0) kids += checkedLi('已折叠存档 ' + folded + ' 条');
                if (keepFirstRecord) kids += checkedLi(keepFirstRecord);

                projectRepeatLi = '<li>' + freshLabel + '<ul>' + kids + '</ul></li>';
            }
        }

        // ── 3) Quick Tasks 里的任务完成/取消 → 移入 Archive（列表最前 = 最新在最上）──
        let moved = false;
        if (isClosed && opts && opts.quickNoteId && noteId === opts.quickNoteId) {
            if (!opts.archiveNoteId) {
                throw new Error('年度笔记下没有 Archive 子笔记，请手动创建（标题 Archive）后再试');
            }
            const archiveNote = api.getNote(opts.archiveNoteId);
            if (!archiveNote) throw new Error('未找到 Archive 笔记：' + opts.archiveNoteId);

            const archiveContent = String(archiveNote.getContent());
            // 插到最后一个顶层列表的最前面；没有列表则在末尾新建
            const closeAt = lastTopUlClose(archiveContent);
            let newArchive;
            if (closeAt < 0) {
                newArchive = archiveContent.replace(/<p>(&nbsp;|\s)*<\/p>/gi, '').trim()
                    + '<ul class="todo-list">' + liHtml + '</ul>';
            } else {
                // 从头做 ul 深度扫描，找与 closeAt 配对的开标签（嵌套安全）
                const lowerAll = archiveContent.toLowerCase();
                const ulScanRe = /<(\/?)ul\b[^>]*>/g;
                let openAt = -1, ulDepth = 0, sm;
                while ((sm = ulScanRe.exec(lowerAll)) !== null) {
                    if (sm.index >= closeAt) break;
                    if (sm[1] === '/') { ulDepth--; }
                    else { if (ulDepth === 0) openAt = sm.index; ulDepth++; }
                }
                if (openAt < 0) openAt = 0;
                const openTagEnd = archiveContent.indexOf('>', openAt) + 1;
                newArchive = archiveContent.slice(0, openTagEnd) + liHtml
                    + archiveContent.slice(openTagEnd);
            }
            archiveNote.setContent(newArchive);

            if (quickRepeatLi) {
                // 重复任务：源位置原地翻新（不删除条目）
                note.setContent(content.slice(0, liStart)
                    + quickRepeatLi + content.slice(liEnd));
            } else {
                // 从源笔记删除该 li（源已写盘更新，这里基于新内容删除），
                // 并清掉紧跟的换行空白，避免残留空行（与 moveInboxItem 行为一致）
                note.setContent(closedContent.slice(0, liStart)
                    + closedContent.slice(liEnd).replace(/^\s*\n/, ''));
            }
            moved = true;
        }

        if (!moved) {
            if (projectRepeatLi) {
                // 重复任务：父 li 整体替换（翻新为下一次 + 履历子内容）；
                // 已完成记录不再以打勾形式留在顶层，其 #done: 标签移入
                // 子内容里的履历条目，项目计数（数标签）不受影响
                note.setContent(content.slice(0, liStart)
                    + projectRepeatLi + content.slice(liEnd));
            } else {
                note.setContent(closedContent);
            }
        }

        // ── 4) 项目任务 → 刷新 Archive 的「处理了 项目 ×N」记录 ──
        // Quick Tasks 在北极星下、项目在 projectsRoot 下，两者互斥不会同时命中
        if (opts && opts.projectsRoot && opts.archiveNoteId) {
            // 从源笔记沿父链向上，找 projectsRoot 的直接子笔记 = 任务所属项目
            let n = api.getNote(noteId);
            let projectId = null;
            while (n) {
                const parents = n.getParentNotes();
                if (!parents.length) break;
                const par = parents[0];
                if (par.noteId === opts.projectsRoot) { projectId = n.noteId; break; }
                n = par;
            }

            if (projectId) {
                const proj = api.getNote(projectId);
                if (proj) {
                    const today = stamp.substring(0, 10);
                    const escTitle = String(proj.title || '未命名项目')
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                    // ── 1) 当天完成数：只数项目子树里带「今天」日期的时间戳 ──
                    //    每天从 0 起算（每日快照，不累加历史）；
                    //    删除历史任务不影响当天数（历史时间戳日期不是今天）
                    const todayStampRe = new RegExp(
                        '#(?:done|cancelled):' + today + ' \\d{2}-\\d{2}', 'g');
                    let todayCount = 0;
                    const stack = [proj];
                    while (stack.length) {
                        const cur = stack.pop();
                        const c = String(cur.getContent());
                        const cm = c.match(todayStampRe);
                        if (cm) todayCount += cm.length;
                        stack.push.apply(stack, cur.getChildNotes());
                    }

                    const archiveNote = api.getNote(opts.archiveNoteId);
                    if (!archiveNote) throw new Error('未找到 Archive 笔记：' + opts.archiveNoteId);
                    let ac = String(archiveNote.getContent());

                    // 定位锚点：项目 noteId（改名不影响），只认带（#id）的记录
                    const escId = String(projectId)
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                    // ── 2) 当天数字 = 当天完成数（每日独立快照）──
                    //    当天多次完成：todayCount 随记录原地更新（幂等）；
                    //    删掉今天的记录再完成，会按同一公式重算回来
                    const count = todayCount;

                    // 记录文本：项目名后紧跟（#noteId）作为定位锚点——
                    // 项目改名后今日记录仍能接上；标题用当前名重写
                    const recordText = '今日 ' + escTitle + '（#' + projectId
                        + '）完成 ' + count + ' 个任务';

                    // 记录条目 = 已勾选任务形式，混入归档任务一起，
                    // 文本后带 #done:完成时间戳（与归档任务同一标识）
                    const recValue = recordText + ' #done:' + stamp;
                    const recLi = '<li><span class="todo-list__label">'
                        + '<span contenteditable="false">'
                        + '<input type="checkbox" tabindex="-1" checked="checked"></span>'
                        + '<span class="todo-list__label__description">' + recValue + '</span>'
                        + '</span></li>';

                    // 已有该项目「今天」的记录 → 原地替换文本与时间戳（改名后
                    // 标题随当前项目名刷新）；否则（含跨天）插到最后一个列表的
                    // 最前面（倒序，最新在最上，每天一条独立记录）。
                    // 定位统一按（#noteId）锚定；匹配限定今天的日期，
                    // 不会误改历史记录
                    const recRe = new RegExp(
                        '(<span class="todo-list__label__description"[^>]*>)[^<]*'
                        + '（#' + escId + '）[^<]*#(?:done|cancelled):' + today
                        + '[^<]*(<\\/span>)', 'i');
                    if (recRe.test(ac)) {
                        // 函数替换器的返回值不做 $ 模板处理，直接拼接即可
                        ac = ac.replace(recRe, function (m0, m1, m2) {
                            return m1 + recValue + m2;
                        });
                    } else {
                        const recCloseAt = lastTopUlClose(ac);
                        if (recCloseAt < 0) {
                            ac = ac.replace(/<p>(&nbsp;|\s)*<\/p>/gi, '').trim()
                                + '<ul class="todo-list">' + recLi + '</ul>';
                        } else {
                            // 从头做 ul 深度扫描，找与 recCloseAt 配对的顶层开标签
                            const lowerAll = ac.toLowerCase();
                            const ulScanRe = /<(\/?)ul\b[^>]*>/g;
                            let recOpenAt = -1, recDepth = 0, rsm;
                            while ((rsm = ulScanRe.exec(lowerAll)) !== null) {
                                if (rsm.index >= recCloseAt) break;
                                if (rsm[1] === '/') { recDepth--; }
                                else { if (recDepth === 0) recOpenAt = rsm.index; recDepth++; }
                            }
                            if (recOpenAt < 0) {
                                ac = ac.slice(0, recCloseAt) + recLi + ac.slice(recCloseAt);
                            } else {
                                const openEnd = ac.indexOf('>', recOpenAt) + 1;
                                ac = ac.slice(0, openEnd) + recLi + ac.slice(openEnd);
                            }
                        }
                    }
                    archiveNote.setContent(ac);
                }
            }
        }

    }, [noteId, cbIndex, state, label, opts, text, repeatDate]);
}

// 设置任务日期：定位第 cbIndex 个任务，把任务文本中的 #yyyy-mm-dd 替换为 date
// date 为 null 时清除日期（本来就没有日期则不写盘，不产生空变更）
// 面板日期胶囊编辑与收集箱「择日再看」共用
// text: 面板端任务文本，写盘前校验用（空则跳过校验）
// runOnBackend: 由入口从 "trilium:api" 注入
export function setTaskDate(runOnBackend, noteId, cbIndex, date, text) {
    return runOnBackend((noteId, cbIndex, date, text) => {

        const note = api.getNote(noteId);
        if (!note) throw new Error('笔记不存在：' + noteId);

        let content = String(note.getContent());

        // 1) 定位第 cbIndex 个 checkbox（与 archiveTask 同一套规则）
        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, i = 0;
        while ((m = inputRe.exec(content)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) { inputStart = m.index; break; }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        // 2) 向前找最近的 <li（中间不能有 </li>，否则说明不在该 li 内）
        const liStart = content.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (content.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        // 3) 深度扫描找配对的 </li>（任务子内容里可能有嵌套列表）
        const liTagRe = /<(\/?)li\b[^>]*>/gi;
        liTagRe.lastIndex = liStart;
        let depth = 0, mm, liEnd = -1;
        while ((mm = liTagRe.exec(content)) !== null) {
            if (mm[1] === '/') {
                depth--;
                if (depth === 0) { liEnd = mm.index + mm[0].length; break; }
            } else {
                depth++;
            }
        }
        if (liEnd < 0) throw new Error('li 标签不配对');

        // 4) 在 li 内找任务文本 span，移除旧 #日期后按需写入新日期
        const liHtml = content.slice(liStart, liEnd);
        const descRe = /(<span class="todo-list__label__description"[^>]*>)([\s\S]*?)(<\/span>)/i;
        const dm = liHtml.match(descRe);
        if (!dm) throw new Error('未找到任务文本');

        // 文本校验（同 archiveTask）：面板数据过期时拒绝写盘，防止改错条目
        const normLiText = s => String(s)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/#every:[a-z0-9]+/gi, '')
            .replace(/#\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expectedText = normLiText(text);
        if (expectedText && normLiText(dm[2]) !== expectedText) {
            throw new Error('任务内容已变化，面板数据可能过期，请刷新面板后重试');
        }

        const hadDate = /#\d{4}-\d{2}-\d{2}/.test(dm[2]);
        if (!date && !hadDate) return; // 清除但本来无日期：无需写盘

        const inner = dm[2].replace(/#\d{4}-\d{2}-\d{2}/g, '').replace(/\s+$/, '')
            + (date ? ' #' + date : '');
        const newLi = liHtml.slice(0, dm.index)
            + dm[1] + inner + dm[3]
            + liHtml.slice(dm.index + dm[0].length);

        content = content.slice(0, liStart) + newLi + content.slice(liEnd);
        note.setContent(content);

    }, [noteId, cbIndex, date, text]);
}

// 收集箱：读取 Inbox 下属 Tasks 笔记的原始内容
// 条目解析在前端 gtdCore.parseInboxItems 做（DOMParser），后端只取内容
// runOnBackend: 由入口从 "trilium:api" 注入
export function collectInboxTasks(runOnBackend, inboxNoteId, childTitles) {
    return runOnBackend((inboxNoteId, childTitles) => {

        const parent = api.getNote(inboxNoteId);
        if (!parent) {
            throw new Error('未找到 Inbox 笔记（检查 gtdCore 的 NOTES.inbox）');
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

// =========================================================
// 处理收集箱
// =========================================================

// 列出可归入的项目：项目文件夹的直接子笔记，剔除排除组（'id' 仅该笔记 / 'id/' 含子树）
// runOnBackend: 由入口从 "trilium:api" 注入
export function listProjects(runOnBackend, rootId, excludeIds) {
    return runOnBackend((rootId, excludeIds) => {

        const root = api.getNote(rootId);
        if (!root) {
            throw new Error('未找到项目文件夹笔记（检查 gtdCore 的 NOTES.projectsRoot）');
        }

        const collectSubtree = (note, acc) => {
            for (const child of note.getChildNotes()) {
                acc.add(child.noteId);
                collectSubtree(child, acc);
            }
        };

        const excluded = new Set();
        for (const entry of (excludeIds || [])) {
            const raw = String(entry).trim();
            if (!raw) continue;
            const withChildren = raw.endsWith('/');
            const note = api.getNote(withChildren ? raw.slice(0, -1) : raw);
            if (!note) continue;
            excluded.add(note.noteId);
            if (withChildren) collectSubtree(note, excluded);
        }

        const projects = [];
        for (const child of root.getChildNotes()) {
            if (excluded.has(child.noteId)) continue;
            projects.push({
                noteId: child.noteId,
                title: child.title || '(无标题)',
                dateModified: String(child.dateModified || '')
            });
        }

        // 按项目最后修改时间倒序（最近改过的排前面），无时间戳的排最后；
        // 同时间再用标题升序保持稳定
        projects.sort((a, b) => {
            if (a.dateModified !== b.dateModified) {
                return a.dateModified < b.dateModified ? 1 : -1;
            }
            return a.title.localeCompare(b.title);
        });
        return projects;

    }, [rootId, excludeIds]);
}

// 解析北极星下的任务目标：其下 YYYYcW 格式子笔记（年度笔记）中编号最大者，
// 再进入该年度笔记下的 Quick Tasks 子笔记（任务实际放入处）
// 任一步找不到都抛错提示手动创建（不自动新建）
// runOnBackend: 由入口从 "trilium:api" 注入
export function resolveWeekTarget(runOnBackend, rootId) {
    return runOnBackend(rootId => {

        const root = api.getNote(rootId);
        if (!root) {
            throw new Error('未找到北极星笔记（检查 gtdCore 的 NOTES.northStar）');
        }

        const re = /^(\d{4})c(\d+)$/i;
        let best = null, bestYear = -1, bestNum = -1;

        for (const child of root.getChildNotes()) {
            const m = String(child.title || '').trim().match(re);
            if (!m) continue;
            const year = parseInt(m[1], 10);
            const num = parseInt(m[2], 10);
            if (year > bestYear || (year === bestYear && num > bestNum)) {
                bestYear = year;
                bestNum = num;
                best = child;
            }
        }

        if (!best) {
            throw new Error('北极星下没有 YYYYcW 格式的年度笔记，请手动创建（如 2026c4）后再试');
        }

        // 年度笔记下找 Quick Tasks（待处理）与 Archive（完成/取消归档）子笔记
        // 标题忽略大小写；Archive 缺失不报错（archiveId 为 null，用到时报可读错误）
        let quick = null, archive = null;
        for (const child of best.getChildNotes()) {
            const t = String(child.title || '').trim().toLowerCase();
            if (t === 'quick tasks') quick = child;
            if (t === 'archive') archive = child;
        }

        if (!quick) {
            throw new Error('年度笔记「' + best.title + '」下没有 Quick Tasks 子笔记，请手动创建后再试');
        }

        return {
            noteId: quick.noteId,
            title: best.title + ' / ' + quick.title,
            archiveId: archive ? archive.noteId : null,
            archiveTitle: archive ? archive.title : null
        };

    }, [rootId]);
}

// 用模板笔记实例化一个新项目（放到项目文件夹下）
// 复制模板的内容、类型与标签属性（跳过模板标记本身），并递归复制模板子笔记
// 返回新项目笔记 ID，供后续把任务移入该项目
//
// 类型安全要点（SQLite 绑定器只接受 number/string/bigint/buffer/null）：
//   - 布尔值与 undefined 一律不传入创建参数（mime 为空不传、isProtected 不传）
//   - 属性复制用实体方法 note.setAttribute(type, name, value)（官方 3 参数签名）
// 注意：runOnBackend 的事务函数必须同步（返回 promise 会报
//   "Transaction function cannot return a promise"），全部调用不加 async/await
// runOnBackend: 由入口从 "trilium:api" 注入
export function createProjectFromTemplate(runOnBackend, projectsRoot, templateId, title) {
    return runOnBackend((projectsRoot, templateId, title) => {

        const parent = api.getNote(projectsRoot);
        if (!parent) {
            throw new Error('未找到项目文件夹笔记（检查 gtdCore 的 NOTES.projectsRoot）');
        }

        const tpl = api.getNote(templateId);
        if (!tpl) {
            throw new Error('未找到项目模板笔记（检查 gtdCore 的 NOTES.projectTemplate）：' + templateId);
        }

        const cleanTitle = String(title || '').trim();
        if (!cleanTitle) throw new Error('项目名称不能为空');

        // 模板标记属性不复制到新笔记
        const TPL_ATTRS = ['template', 'templateId', 'templateDisabled'];

        const createFromTemplate = (tplNote, parentNoteId, notePosition, titleOverride) => {
            // 参数只放确定合法的类型；notePosition 省略时追加到末尾
            // titleOverride: 顶层项目笔记用任务名称，模板子笔记保留模板标题
            const params = {
                parentNoteId: parentNoteId,
                title: String(titleOverride || tplNote.title || '未命名'),
                content: String(tplNote.getContent() || ''),
                type: tplNote.type || 'text'
            };
            if (tplNote.mime) params.mime = String(tplNote.mime);
            if (typeof notePosition === 'number') params.notePosition = notePosition;

            // 新版 TriliumNext 用 createNewNote(params)，旧版用 createNote(parentNoteId, params)
            const created = typeof api.createNewNote === 'function'
                ? api.createNewNote(params)
                : api.createNote(parentNoteId, params);
            const newNote = (created && created.note) ? created.note : created;
            if (!newNote || !newNote.noteId) {
                throw new Error('创建笔记失败：' + params.title);
            }

            // 复制模板的标签属性（跳过模板标记；relation 不复制）
            for (const attr of tplNote.getOwnedAttributes()) {
                if (attr.type !== 'label') continue;
                if (TPL_ATTRS.indexOf(attr.name) >= 0) continue;
                newNote.setAttribute('label', attr.name, attr.value || null);
            }
            return newNote;
        };

        // 递归复制模板子树（顺序保持）
        const copyChildren = (tplNote, newNote) => {
            const children = tplNote.getChildNotes();
            for (let i = 0; i < children.length; i++) {
                const childNote = createFromTemplate(children[i], newNote.noteId, i * 10);
                copyChildren(children[i], childNote);
            }
        };

        // 新项目追加到项目文件夹末尾；标题用任务名称（而非模板名），
        // 模板的子笔记保留各自模板标题
        const projNote = createFromTemplate(tpl, projectsRoot,
            parent.getChildNotes().length * 10, cleanTitle);
        copyChildren(tpl, projNote);

        return { noteId: projNote.noteId, title: projNote.title };

    }, [projectsRoot, templateId, title]);
}

// 把收集箱条目移动到目标笔记：
//   1) 从 Tasks 笔记删除第 cbIndex 个 checkbox 所在 li（含其子内容）
//   2) 用传入的文本组装新 li，插入目标笔记任务列表
// opts: { text, desc?, state?, stateLabel?, atEnd?, prepend?, stamp? }
//   desc 按行拆成任务子内容（一行一个 <li>）
//   state: null → 未完成 | 'waiting' → 等待中
//          'done' → 已完成（勾选）| 'cancelled' → 已取消
//   atEnd: true → 放到「待分配任务」标题下列表的最末尾（移入项目用），
//          没有该标题则在笔记末尾创建标题 + 新列表
//   prepend: true → 放到最后一个列表的最前面（倒序，最新在最上；
//          移入 Archive / 将来也许用）
//   stamp: true → done/cancelled 时任务文本追加归档时间戳
//          #done:/#cancelled:yyyy-mm-dd HH-mm（与日历 #yyyy-mm-dd 区分）
//   未带以上标志时插到最后一个列表的未完成区末尾（Quick Tasks 只收待处理任务）
//   text: 面板端条目文本，写盘前校验用（空则跳过校验）
// 锚点用「顶层 ul 闭合」深度扫描。不能用 lastIndexOf('</ul>')：
// 上次插入的条目带嵌套子内容（备注子列表）时，最后一个 </ul> 是
// 子列表的闭合，新条目会被错误插进上一条的子列表里（表现为倒序/嵌套错乱）
// 所有定位/解析都在写盘前完成（失败即 throw），不会出现半删状态
// runOnBackend: 由入口从 "trilium:api" 注入
export function moveInboxItem(runOnBackend, inboxNoteId, cbIndex, targetNoteId, opts, srcText) {
    return runOnBackend((inboxNoteId, cbIndex, targetNoteId, opts, srcText) => {

        opts = opts || {};
        const text = String(opts.text || '').trim();
        if (!text) throw new Error('任务标题不能为空');

        const desc = opts.desc ? String(opts.desc).trim() : '';
        const state = opts.state ? String(opts.state) : null;
        const stateLabel = opts.stateLabel ? String(opts.stateLabel) : state;

        const esc = s => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // ── 1) 目标笔记：准备追加后的完整内容 ──
        const target = api.getNote(targetNoteId);
        if (!target) throw new Error('未找到目标笔记：' + targetNoteId);

        // 描述：一行一个子内容项（结构与编辑器保存的一致）
        const descLines = desc
            ? String(desc).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
            : [];

        // done：按 Trilium 存储约定 = 勾选 + 无状态属性；其余状态写属性
        const isDone = state === 'done';

        // 归档时间戳：#done:/#cancelled:yyyy-mm-dd HH-mm（与日历 #yyyy-mm-dd 区分）
        let stampSuffix = '';
        if (opts.stamp && (isDone || state === 'cancelled')) {
            const p = n => String(n).padStart(2, '0');
            const now = new Date();
            stampSuffix = ' #' + (isDone ? 'done' : 'cancelled') + ':'
                + now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
                + ' ' + p(now.getHours()) + '-' + p(now.getMinutes());
        }

        const li = '<li'
            + (state && !isDone ? ' data-trilium-task-state="' + state + '" title="' + esc(stateLabel) + '"' : '')
            + '><span class="todo-list__label">'
            + '<span contenteditable="false"><input type="checkbox" tabindex="-1"'
            + (isDone ? ' checked="checked"' : '') + '></span>'
            + '<span class="todo-list__label__description">' + esc(text) + stampSuffix + '</span>'
            + '</span>'
            + (descLines.length
                ? '<ul>' + descLines.map(line =>
                    '<li><span class="ck-list-bogus-paragraph">' + esc(line) + '</span></li>'
                ).join('') + '</ul>'
                : '')
            + '</li>';

        let targetContent = String(target.getContent());

        // 最后一个「顶层列表」的闭合位置（深度扫描，见函数头注释；
        // 这就是将来/也许出现「倒序插入」的根因）
        const lastTopUlClose = s => {
            const re = /<(\/?)ul\b[^>]*>/gi;
            let depth = 0, last = -1, m;
            while ((m = re.exec(s)) !== null) {
                if (m[1] === '/') {
                    depth--;
                    if (depth === 0) last = m.index;
                } else {
                    depth++;
                }
            }
            return last;
        };

        // 锚点：最后一个顶层列表的收尾；没有列表时新建
        const closeAt = lastTopUlClose(targetContent);

        if (closeAt < 0) {
            // 没有任何列表：清掉空段落，新建任务列表
            targetContent = targetContent.replace(/<p>(&nbsp;|\s)*<\/p>/gi, '').trim();
            targetContent = targetContent + '<ul class="todo-list">' + li + '</ul>';

        } else if (opts.prepend) {
            // 倒序插入（Archive 用）：放到与 closeAt 配对的顶层列表的最前面
            const lowerAll = targetContent.toLowerCase();
            const ulScanRe = /<(\/?)ul\b[^>]*>/g;
            let openAt = -1, ulDepth = 0, sm;
            while ((sm = ulScanRe.exec(lowerAll)) !== null) {
                if (sm.index >= closeAt) break;
                if (sm[1] === '/') { ulDepth--; }
                else { if (ulDepth === 0) openAt = sm.index; ulDepth++; }
            }
            if (openAt < 0) {
                // 配对失败（标签不平衡）：退化为插到末尾
                targetContent = targetContent.slice(0, closeAt) + li + targetContent.slice(closeAt);
            } else {
                const openTagEnd = targetContent.indexOf('>', openAt) + 1;
                targetContent = targetContent.slice(0, openTagEnd) + li
                    + targetContent.slice(openTagEnd);
            }

        } else if (opts.atEnd) {
            // 移入项目：放到「待分配任务」标题下列表的最末尾；
            // 没有该标题时在笔记末尾创建标题 + 新列表（取最后一个匹配的标题段落）
            const headRe = /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?待分配任务(?:(?!<\/p>)[\s\S])*?<\/p>/gi;
            let headMatch = null;
            let hm;
            while ((hm = headRe.exec(targetContent)) !== null) headMatch = hm;

            if (!headMatch) {
                // 没有标题：清掉末尾空段落，创建标题和新列表
                targetContent = targetContent.replace(/<p>(&nbsp;|\s)*<\/p>/gi, '').trim();
                targetContent = targetContent
                    + '<p><strong>待分配任务</strong></p>'
                    + '<ul class="todo-list">' + li + '</ul>';

            } else {
                const headEnd = headMatch.index + headMatch[0].length;
                const after = targetContent.slice(headEnd);

                // 标题下的第一个列表：从开标签做局部深度扫描找配对的 </ul>
                const openM = after.match(/<ul\b[^>]*>/i);
                let insertAt = -1;

                if (openM) {
                    const ulReLocal = /<(\/?)ul\b[^>]*>/gi;
                    ulReLocal.lastIndex = openM.index;
                    let depth = 0;
                    let um2;
                    while ((um2 = ulReLocal.exec(after)) !== null) {
                        if (um2[1] === '/') {
                            depth--;
                            if (depth === 0) {
                                // 插在配对 </ul> 之前 = 该列表内容的最末尾
                                insertAt = headEnd + um2.index;
                                break;
                            }
                        } else {
                            depth++;
                        }
                    }
                }

                if (insertAt < 0) {
                    // 标题下没有列表（或标签不配对）：紧跟标题新建一个
                    targetContent = targetContent.slice(0, headEnd)
                        + '<ul class="todo-list">' + li + '</ul>'
                        + targetContent.slice(headEnd);
                } else {
                    targetContent = targetContent.slice(0, insertAt) + li + targetContent.slice(insertAt);
                }
            }

        } else {
            // Quick Tasks 只收待处理任务：插到与 closeAt 配对的顶层列表中
            // 最后一个未完成任务的末尾（无则列表开头）。
            // openAt 不能用 lastIndexOf('<ul', closeAt)：最后一个任务带子内容
            // （嵌套列表）时会锚到子内容列表上。改为从头做 ul 深度扫描，
            // 记录最后一个 depth 0→1 的开标签（= 与 closeAt 配对的顶层列表开标签）
            const lowerAll = targetContent.toLowerCase();
            const ulScanRe = /<(\/?)ul\b[^>]*>/g;
            let openAt = -1;
            let ulDepth = 0;
            let sm;
            while ((sm = ulScanRe.exec(lowerAll)) !== null) {
                if (sm.index >= closeAt) break; // 扫到目标 </ul> 即止
                if (sm[1] === '/') {
                    ulDepth--;
                } else {
                    if (ulDepth === 0) openAt = sm.index;
                    ulDepth++;
                }
            }
            const regionStart = openAt >= 0 ? openAt : 0;
            const region = targetContent.slice(regionStart, closeAt);

            // 未完成判定：无 checked 且不是 cancelled/done 状态
            const isPendingLi = html => {
                if (/data-trilium-task-state="(cancelled|done)"/i.test(html)) return false;
                const im = html.match(/<input\b[^>]*>/i);
                if (im && /\bchecked\b/i.test(im[0])) return false;
                return true;
            };

            // 顶层 li 扫描：记录第一个顶层 li 起点、最后一个未完成 li 结束位置
            const liRe = /<(\/?)li\b[^>]*>/gi;
            let liDepth = 0;
            let liStartPos = -1;
            let firstLiAt = -1;
            let lastPendingEnd = -1;
            let lm;

            while ((lm = liRe.exec(region)) !== null) {
                if (lm[1] === '/') {
                    liDepth--;
                    if (liDepth === 0 && liStartPos >= 0) {
                        const liHtml = region.slice(liStartPos, lm.index + lm[0].length);
                        const end = regionStart + lm.index + lm[0].length;
                        if (firstLiAt < 0) firstLiAt = regionStart + liStartPos;
                        if (isPendingLi(liHtml)) lastPendingEnd = end;
                        liStartPos = -1;
                    }
                } else {
                    if (liDepth === 0) liStartPos = lm.index;
                    liDepth++;
                }
            }

            const insertAt = lastPendingEnd >= 0 ? lastPendingEnd
                : (firstLiAt >= 0 ? firstLiAt : closeAt);

            targetContent = targetContent.slice(0, insertAt) + li + targetContent.slice(insertAt);
        }

        // ── 2) 收集箱 Tasks：准备删除对应 li 后的完整内容 ──
        // 定位逻辑与 archiveTask 一致：先匹配任意 input 再校验 type，防止序号错位
        const inboxNote = api.getNote(inboxNoteId);
        if (!inboxNote) throw new Error('未找到收集箱 Tasks 笔记');

        const content = String(inboxNote.getContent());

        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, i = 0;

        while ((m = inputRe.exec(content)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) {
                inputStart = m.index;
                break;
            }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        const liStart = content.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (content.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        // 找到与 liStart 配对的 </li>（深度扫描，兼容带子内容的条目）
        const liTagRe = /<(\/?)li\b[^>]*>/gi;
        liTagRe.lastIndex = liStart;
        let liDepth = 0;
        let liEnd = -1;
        let lm;
        while ((lm = liTagRe.exec(content)) !== null) {
            if (lm[1] === '/') {
                liDepth--;
                if (liDepth === 0) { liEnd = lm.index + lm[0].length; break; }
            } else {
                liDepth++;
            }
        }
        if (liEnd < 0) throw new Error('未找到 li 结束标签');

        // 文本校验（同 archiveTask）：面板数据过期时拒绝写盘，防止移动错条目
        const normLiText = s => String(s)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/#every:[a-z0-9]+/gi, '')
            .replace(/#\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expectedText = normLiText(srcText);
        if (expectedText) {
            const liHtmlChk = content.slice(liStart, liEnd);
            const chk = liHtmlChk.match(
                /<span class="todo-list__label__description"[^>]*>([\s\S]*?)<\/span>/i);
            if (chk && normLiText(chk[1]) !== expectedText) {
                throw new Error('收集箱条目内容已变化，面板数据可能过期，请刷新面板后重试');
            }
        }

        // 删除整个 li（含子内容）及其后紧跟的换行空白
        const inboxContent = content.slice(0, liStart)
            + content.slice(liEnd).replace(/^\s*\n/, '');

        // ── 3) 写盘：先写目标，再删收集箱 ──
        // 顺序保证失败安全：目标写入失败时收集箱原条目还在（不丢数据）；
        // 删除失败时最多两边重复，可手动清理
        target.setContent(targetContent);
        inboxNote.setContent(inboxContent);

    }, [inboxNoteId, cbIndex, targetNoteId, opts, srcText]);
}

// 从收集箱 Tasks 删除第 cbIndex 个 checkbox 所在 li（含其子内容）
// 定位/校验与 moveInboxItem 的删除部分同一套实现；
// 先完成全部定位与文本校验再写盘（失败即 throw），不会出现半删状态
// text: 面板端条目文本，写盘前校验用（空则跳过校验）
// runOnBackend: 由入口从 "trilium:api" 注入
export function removeInboxItem(runOnBackend, inboxNoteId, cbIndex, srcText) {
    return runOnBackend((inboxNoteId, cbIndex, srcText) => {

        const inboxNote = api.getNote(inboxNoteId);
        if (!inboxNote) throw new Error('未找到收集箱 Tasks 笔记');

        const content = String(inboxNote.getContent());

        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, i = 0;
        while ((m = inputRe.exec(content)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) { inputStart = m.index; break; }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        const liStart = content.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (content.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        // 深度扫描找与 liStart 配对的 </li>（兼容带子内容的条目）
        const liTagRe = /<(\/?)li\b[^>]*>/gi;
        liTagRe.lastIndex = liStart;
        let liDepth = 0, liEnd = -1, lm;
        while ((lm = liTagRe.exec(content)) !== null) {
            if (lm[1] === '/') {
                liDepth--;
                if (liDepth === 0) { liEnd = lm.index + lm[0].length; break; }
            } else {
                liDepth++;
            }
        }
        if (liEnd < 0) throw new Error('未找到 li 结束标签');

        // 文本校验（同 moveInboxItem）：面板数据过期时拒绝写盘，防止删错条目
        const normLiText = s => String(s)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/#every:[a-z0-9]+/gi, '')
            .replace(/#\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expectedText = normLiText(srcText);
        if (expectedText) {
            const liHtml = content.slice(liStart, liEnd);
            const chk = liHtml.match(
                /<span class="todo-list__label__description"[^>]*>([\s\S]*?)<\/span>/i);
            if (chk && normLiText(chk[1]) !== expectedText) {
                throw new Error('收集箱条目内容已变化，面板数据可能过期，请刷新面板后重试');
            }
        }

        // 删除整个 li（含子内容）及其后紧跟的换行空白
        inboxNote.setContent(content.slice(0, liStart)
            + content.slice(liEnd).replace(/^\s*\n/, ''));

    }, [inboxNoteId, cbIndex, srcText]);
}

// 参考资料处理：
//   1) 在 parentId（参考资料收集箱）下新建子笔记：标题 = 任务标题，
//      内容 = 描述逐行成段落（空描述则空内容）
//   2) 从收集箱 Tasks 删除第 cbIndex 个 checkbox 所在 li（含其子内容）
// 先建笔记再删源（失败安全）：新建失败时收集箱原条目还在，不丢数据；
// 删除失败时最多两边重复（笔记 + 条目），可手动清理
// text: 面板端条目文本，写盘前校验用（空则跳过校验）
export function moveInboxToReference(runOnBackend, inboxNoteId, cbIndex,
                                     parentId, title, desc, text) {
    return runOnBackend((inboxNoteId, cbIndex, parentId, title, desc, text) => {

        const cleanTitle = String(title || '').trim();
        if (!cleanTitle) throw new Error('标题不能为空');

        const parent = api.getNote(parentId);
        if (!parent) throw new Error('未找到参考资料收集箱笔记：' + parentId);

        // ── 1) 新建子笔记：描述逐行 → 段落 ──
        const esc = s => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lines = String(desc || '').split(/\r?\n/)
            .map(s => s.trim()).filter(Boolean);
        const content = lines.map(l => '<p>' + esc(l) + '</p>').join('');
        api.createNote(parentId, cleanTitle, content, { type: 'text' });

        // ── 2) 从收集箱删除该条目（定位/校验与 moveInboxItem 同一套）──
        const inboxNote = api.getNote(inboxNoteId);
        if (!inboxNote) throw new Error('未找到收集箱 Tasks 笔记：' + inboxNoteId);
        const c = String(inboxNote.getContent());

        const inputRe = /<input\b[^>]*>/gi;
        const checkboxTypeRe = /\btype\s*=\s*(?:"checkbox"|'checkbox'|checkbox)/i;
        let m, inputStart = -1, i = 0;
        while ((m = inputRe.exec(c)) !== null) {
            if (!checkboxTypeRe.test(m[0])) continue;
            if (i++ === cbIndex) { inputStart = m.index; break; }
        }
        if (inputStart < 0) throw new Error('未找到对应的 checkbox');

        const liStart = c.lastIndexOf('<li', inputStart);
        if (liStart < 0) throw new Error('未找到包裹的 li 标签');
        if (c.lastIndexOf('</li>', inputStart) > liStart) {
            throw new Error('checkbox 与 li 不匹配');
        }

        const liTagRe = /<(\/?)li\b[^>]*>/gi;
        liTagRe.lastIndex = liStart;
        let liDepth = 0, liEnd = -1, lm;
        while ((lm = liTagRe.exec(c)) !== null) {
            if (lm[1] === '/') {
                liDepth--;
                if (liDepth === 0) { liEnd = lm.index + lm[0].length; break; }
            } else {
                liDepth++;
            }
        }
        if (liEnd < 0) throw new Error('未找到 li 结束标签');

        const normLiText = s => String(s)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/#(?:done|cancelled):\d{4}-\d{2}-\d{2} \d{2}-\d{2}/g, '')
            .replace(/#every:[a-z0-9]+/gi, '')
            .replace(/#\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expectedText = normLiText(text);
        if (expectedText) {
            const liHtml = c.slice(liStart, liEnd);
            const chk = liHtml.match(
                /<span class="todo-list__label__description"[^>]*>([\s\S]*?)<\/span>/i);
            if (chk && normLiText(chk[1]) !== expectedText) {
                throw new Error('收集箱条目内容已变化，面板数据可能过期，请刷新面板后重试');
            }
        }

        inboxNote.setContent(c.slice(0, liStart)
            + c.slice(liEnd).replace(/^\s*\n/, ''));

    }, [inboxNoteId, cbIndex, parentId, title, desc, text]);
}
