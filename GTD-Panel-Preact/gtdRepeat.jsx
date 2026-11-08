// ============================================================
//  GTD 重复任务 · 纯逻辑模块（子笔记标题必须为：gtdRepeat）
// ============================================================
//  职责边界：
//    - 重复标记的解析、文案、下一次日期计算（纯函数，不发请求）
//  语法：任务文本带 #every:<规格> 且带 #yyyy-mm-dd 日期才生效；
//    日期是唯一锚点（按计划推进），无日期时标记视为普通文本
//  规格：
//    #every:3d    每 3 天          #every:2w      每 2 周（锚点同星期）
//    #every:wed   每周三（mon~sun）#every:1m      每 N 个月（同日，短月取月末）
//    #every:mend  每月最后一天     #every:mwork   每月最后一个工作日（周一~五）
//    #every:1y    每 N 年（2/29 自动折算）
//  过期滚动：算出的下一次若不晚于今天，按周期向前滚动到第一个未来日期
//  注意：不要 import 任何东西；不要用 ?? 和 ?.
// ============================================================

// 标记正则（gtdCore.parseNotes 内有同一定义，改动需两处同步）
export const REPEAT_RE = /#every:([a-z0-9]+)/i;

// ── 解析任务文本 → 规格字符串（如 '3d' / 'wed'），不生效返回 null ──
export function parseRepeat(text) {
    const m = String(text || '').match(REPEAT_RE);
    if (!m) return null;
    const dateM = String(text || '').match(/#(\d{4}-\d{2}-\d{2})/);
    if (!dateM) return null; // 无 #日期：重复标记不生效
    return m[1].toLowerCase();
}

// ── 规格 → 中文说明（徽章 tooltip 用）──
export function repeatLabel(spec) {
    const s = String(spec || '').toLowerCase();
    const wd = { mon: '周一', tue: '周二', wed: '周三', thu: '周四',
        fri: '周五', sat: '周六', sun: '周日' };

    const m = s.match(/^(\d+)([dwmy])$/);
    if (m) {
        const n = m[1], u = m[2];
        if (u === 'd') return n === '1' ? '每天' : '每 ' + n + ' 天';
        if (u === 'w') return n === '1' ? '每周' : '每 ' + n + ' 周';
        if (u === 'm') return n === '1' ? '每月' : '每 ' + n + ' 个月';
        return n === '1' ? '每年' : '每 ' + n + ' 年';
    }
    if (wd[s]) return '每' + wd[s];
    if (s === 'mend') return '每月末';
    if (s === 'mwork') return '每月末工作日';
    return s;
}

// ── 计算下一次日期 ──
// spec: 规格字符串；anchorDate: 锚点 #日期 yyyy-mm-dd；today: yyyy-mm-dd
// 返回 yyyy-mm-dd；规格或锚点非法返回 null
export function nextRepeatDate(spec, anchorDate, today) {

    const s = String(spec || '').toLowerCase().trim();
    const am = String(anchorDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!am) return null;

    const p = n => String(n).padStart(2, '0');
    const fmt = d => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

    // 月份加法：日超短月时折到月末（如 31 号在 4 月取 30）
    const addMonths = (d, n) => {
        const t = d.getMonth() + n;
        const ny = d.getFullYear() + Math.floor(t / 12);
        const nm = ((t % 12) + 12) % 12;
        return new Date(ny, nm, Math.min(d.getDate(), daysInMonth(ny, nm + 1)));
    };

    const tm = String(today || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const todayD = tm ? new Date(+tm[1], +tm[2] - 1, +tm[3]) : null;
    const anchor = new Date(+am[1], +am[2] - 1, +am[3]);

    const wdMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
    let step;   // 候选 → 下一候选（一个周期）
    let first;  // 首个候选（可选；缺省 = step(锚点)）

    const qm = s.match(/^(\d+)([dwmy])$/);
    if (qm) {
        const n = parseInt(qm[1], 10);
        if (n < 1) return null;
        const u = qm[2];
        if (u === 'd') {
            step = d => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
        } else if (u === 'w') {
            step = d => { const x = new Date(d); x.setDate(x.getDate() + 7 * n); return x; };
        } else if (u === 'm') {
            step = d => addMonths(d, n);
        } else {
            step = d => addMonths(d, 12 * n);
        }
    } else if (wdMap.hasOwnProperty(s)) {
        const target = wdMap[s];
        // 锚点不一定落在目标星期：逐日走到第一个匹配日，其后按 7 天步进
        first = d => {
            const x = new Date(d);
            while (x.getDay() !== target) x.setDate(x.getDate() + 1);
            return x;
        };
        step = d => { const x = new Date(d); x.setDate(x.getDate() + 7); return x; };
    } else if (s === 'mend' || s === 'mwork') {
        // 月末系列：候选恒为某月末（mwork 再回退到周五）
        const monthEndOf = d => {
            const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            if (s === 'mwork') {
                while (e.getDay() === 0 || e.getDay() === 6) e.setDate(e.getDate() - 1);
            }
            return e;
        };
        first = d => monthEndOf(d);       // 锚点所在月的月末（必不早于锚点日）
        step = d => monthEndOf(addMonths(d, 1));
    } else {
        return null;
    }

    // 从锚点推进，跳过所有不晚于今天的场次（不堆积过期）
    let c = first ? first(anchor) : step(anchor);
    if (!todayD) return fmt(c);

    let guard = 0;
    while (c.getTime() <= todayD.getTime() && guard++ < 500) c = step(c);
    return fmt(c);
}
