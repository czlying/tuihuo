/**
 * 日期工具
 * ------------------------------------------------------------------
 * 设计决策：与本项目里所有「按天粒度」的日期，统一使用 'YYYY-MM-DD' 字符串。
 *
 * 为什么不用 Date 对象？
 *   用户在小程序里选的是「收货日期」，这是个纯粹的「哪一天」的概念，
 *   不含时刻。若存成 Date，会被转成 UTC，再读出来时可能因为时区差
 *   而错开一天（典型表现：选了 10 月 1 日，读出来变成 9 月 30 日）。
 *   用 'YYYY-MM-DD' 字符串存储，既可以按字典序正确排序、直接做区间比较，
 *   也彻底绕开时区问题。
 *
 *   带时刻的字段（appliedAt / createdAt / updatedAt）仍用 Date，两者分工明确。
 * ------------------------------------------------------------------
 */

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把各种输入归一化为 'YYYY-MM-DD'（本地时区）。
 * 可接受：Date 对象 / 'YYYY-MM-DD' / ISO 字符串 / 时间戳。
 * 无法解析时返回 ''。
 */
function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'string') {
    // 本来就是 YYYY-MM-DD，直接取前 10 位
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    const d = new Date(value);
    return isNaN(d.getTime()) ? '' : toDateOnly(d);
  }

  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? '' : toDateOnly(d);
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return (
      value.getFullYear() +
      '-' +
      pad2(value.getMonth() + 1) +
      '-' +
      pad2(value.getDate())
    );
  }

  return '';
}

/** 今天的 'YYYY-MM-DD' */
function today() {
  return toDateOnly(new Date());
}

/**
 * 解析 'YYYY-MM-DD' 为本地时区当天 00:00 的 Date。
 * 用 new Date(y, m, d) 构造（本地时区），而不是 new Date('YYYY-MM-DD')（会被当成 UTC）。
 */
function parseDateOnly(value) {
  const s = toDateOnly(value);
  if (!s) return null;
  const parts = s.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return isNaN(d.getTime()) ? null : d;
}

/** 日期加减天数，返回 'YYYY-MM-DD' */
function addDays(dateOnly, days) {
  const d = parseDateOnly(dateOnly);
  if (!d) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return toDateOnly(d);
}

/**
 * 计算两个日期相差的整天数：to - from。
 * 例：diffDays('2026-10-12', '2026-10-19') === 7
 * 解析失败返回 null。
 */
function diffDays(from, to) {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  if (!a || !b) return null;
  // 用 round 兜住潜在的夏令时导致的 0.958 天这类小数（国内无夏令时，属保险）
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 今天是否落在本周（周一 ~ 周日） */
function isThisWeek(dateOnly) {
  const target = parseDateOnly(dateOnly);
  if (!target) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 周一为一周起点：getDay() 里 0 是周日，需要换算
  const dow = todayStart.getDay();
  const offsetToMonday = dow === 0 ? 6 : dow - 1;

  const monday = new Date(todayStart);
  monday.setDate(monday.getDate() - offsetToMonday);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  return target >= monday && target < nextMonday;
}

/** 本月第一天 / 最后一天的 'YYYY-MM-DD' */
function monthRange(refDateOnly) {
  const ref = parseDateOnly(refDateOnly) || new Date();
  const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const last = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return { start: toDateOnly(first), end: toDateOnly(last) };
}

/** '2026-10-12' -> '10月12日' */
function formatCN(dateOnly) {
  const s = toDateOnly(dateOnly);
  if (!s) return '';
  const parts = s.split('-');
  return Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

/** '2026-10-12' -> '2026年10月' */
function formatMonthCN(dateOnly) {
  const s = toDateOnly(dateOnly);
  if (!s) return '';
  const parts = s.split('-');
  return parts[0] + '年' + Number(parts[1]) + '月';
}

module.exports = {
  pad2,
  toDateOnly,
  today,
  parseDateOnly,
  addDays,
  diffDays,
  isThisWeek,
  monthRange,
  formatCN,
  formatMonthCN,
};
