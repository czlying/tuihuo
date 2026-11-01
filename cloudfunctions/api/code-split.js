/**
 * 取件码切分（平台无关的 L1 通用规则）
 * ==================================================================
 * 只回答一个问题：**标签后面那一段数字，码应该切几位、剩下的算不算完整日期时间**。
 *
 * 不判平台、不判页型、不碰标签定位、不做任何平台专属加权——
 * 因此拼多多、抖音、淘宝、京东……所有平台都可以共用本模块。
 * （平台专属规则仍留在各自文件里，见手册 §16 三层结构。）
 *
 * ------------------------------------------------------------------
 * 为什么需要它（2026-10-31 真机实测）：
 *
 *   原图   退货进度 取件码0131 11月1日(明天)上门取件
 *   OCR    退货进度取件码013111月1日(明天)上门取件   ← 中间空格被 OCR 合并
 *
 * 此时的陷阱是**双向**的：
 *   - 贪婪 `{4,6}`  → 取 `013111`，把日期的 11 也吃进来（错值）
 *   - 非贪婪 `{4,6}?` → 永远只取 4 位，真实 6 位码被截成 4 位（另一种错值）
 *
 * 正解：先抓「整段连续数字」，再对 4/5/6 位候选逐一比较，
 * 用「切掉码之后剩下的文字能不能构成完整日期/时间」来定夺。
 * ==================================================================
 */

/** 码值长度候选区间 */
const CODE_MIN_LEN = 4;
const CODE_MAX_LEN = 6;

/** 6 位码 + 最多 3 位日期 = 9 位。再长不是取件码 */
const RUN_MAX_LEN = CODE_MAX_LEN + 3;

/** 连续码值字符（把 OCR 常见混淆字符一并纳入，归一化另做） */
const RUN_RE = /^[0-9OolI]+/;

/** 形似码值：4~6 位纯数字（含混淆字符） */
const CODE_SHAPE_RE = /^[0-9OolI]{4,6}$/;

/** 完整的日期/时间起头：rest 能这样开头，说明码切在这里是对的 */
const FULL_DATE_HEAD_RE = /^(?:0?[1-9]|1[0-2])月|^(?:0?[1-9]|[12]\d|3[01])[日号]/;
const FULL_TIME_HEAD_RE = /^(?:[01]?\d|2[0-3])[:：][0-5]\d/;

/** rest 以这些开头，说明日期/时间的数字被码吃掉了 */
const EATEN_HEAD_RE = /^(?:月|日|号|时|分|秒|[:：])/;

/**
 * 判断「切掉码值之后剩下的文字」属于哪种情况。
 *
 *   full    以完整日期/时间开头（`11月1日`、`11:00`）→ 切在这里对
 *   eaten   以 `月/日/号/时/分/秒/冒号` 开头（`月1日`、`:00`）→ 数字被码吃了
 *   digits  数字开头但不成日期时间（`15 明天`）→ 码被切短了，该取更长
 *   neutral 其它（空串、中文开头）→ 整段数字就是码
 *
 * @param {string} raw 未清理的剩余文字（**保留冒号**，否则 `:00` 会退化成普通文字）
 * @returns {'full'|'eaten'|'digits'|'neutral'}
 */
function restKind(raw) {
  const r = String(raw || '').replace(/^\s+/, '');
  if (!r) return 'neutral';
  if (FULL_DATE_HEAD_RE.test(r) || FULL_TIME_HEAD_RE.test(r)) return 'full';
  if (EATEN_HEAD_RE.test(r)) return 'eaten';
  if (/^[0-9]/.test(r)) return 'digits';
  return 'neutral';
}

/**
 * 切出标签后的码值。
 *
 * @param {string} tail 标签之后的整段文字（调用方负责定位标签）
 * @returns {{code:string, rest:string, ambiguous:boolean}|null}
 *   rest      码后面的剩余文字（可能是取件时间）；
 *   ambiguous true 表示数字串被切开过，存在吃错位的可能，调用方应强制低置信。
 */
function splitCodeAfterLabel(tail) {
  const s = String(tail || '').replace(/^[：:\s]+/, '');
  const run = (s.match(RUN_RE) || [''])[0];
  if (!run) return null;

  // 超长数字串：不是取件码（订单号、运单号片段）
  if (run.length > RUN_MAX_LEN) return null;

  // 数字串后面紧跟字母数字 → 是从更长串里截出来的，不是独立码值
  const afterRun = s.charAt(run.length);
  if (/[0-9A-Za-z]/.test(afterRun)) return null;

  const cands = [];
  for (let len = CODE_MIN_LEN; len <= CODE_MAX_LEN && len <= run.length; len++) {
    const restRaw = s.slice(len);
    cands.push({
      code: run.slice(0, len),
      rest: restRaw.replace(/^[：:\s]+/, '').trim(),
      kind: restKind(restRaw),
    });
  }
  if (!cands.length) return null;

  const firstOf = function (kind) {
    for (let i = 0; i < cands.length; i++) {
      if (cands[i].kind === kind) return cands[i];
    }
    return null;
  };

  let picked = null;
  let ambiguous = false;

  const full = firstOf('full');
  if (full) {
    // 有候选能让日期/时间完整 → 取它（cands 按长度升序，firstOf 拿到的是最短的）
    picked = full;
    ambiguous = run.length > picked.code.length;
  } else if (firstOf('eaten')) {
    // 每种切法都会让剩余文字缺数字 → 取最短并标记歧义
    picked = cands[0];
    ambiguous = true;
  } else if (run.length > CODE_MAX_LEN) {
    // 超过 6 位又切不出完整日期 → 不是取件码
    return null;
  } else {
    // 剩余为空、纯数字或中文 → 整个数字串就是码
    picked = cands[cands.length - 1];
    ambiguous = false;
  }

  if (!CODE_SHAPE_RE.test(picked.code)) return null;

  return { code: picked.code, rest: picked.rest, ambiguous: ambiguous };
}

module.exports = {
  CODE_MIN_LEN,
  CODE_MAX_LEN,
  RUN_MAX_LEN,
  RUN_RE,
  CODE_SHAPE_RE,
  FULL_DATE_HEAD_RE,
  FULL_TIME_HEAD_RE,
  EATEN_HEAD_RE,
  restKind,
  splitCodeAfterLabel,
};
