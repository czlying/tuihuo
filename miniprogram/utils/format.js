/**
 * 格式化工具
 */

/**
 * 金额：分 -> 展示用字符串
 * 数据层始终存「分」的整数（避免浮点误差），展示层才除以 100。
 *   128600  -> '1,286.00'
 *   0       -> '0.00'
 */
function fenToYuan(fen, withSeparator) {
  const n = Number(fen);
  if (!isFinite(n)) return '0.00';

  const yuan = n / 100;
  const fixed = Math.abs(yuan).toFixed(2);
  const negative = yuan < 0 ? '-' : '';

  if (withSeparator === false) return negative + fixed;

  const parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative + parts[0] + '.' + parts[1];
}

/** 金额：元字符串 -> 分整数。'12.30' -> 1230 */
function yuanToFen(yuan) {
  const n = Number(yuan);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 文本截断，超出补省略号 */
function truncate(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** 倒计时文案：把天数差转成中文 */
function daysToText(days) {
  if (days === null) return '';
  if (days > 0) return '还剩 ' + days + ' 天';
  if (days === 0) return '今天到期';
  return '已逾期 ' + Math.abs(days) + ' 天';
}

module.exports = {
  fenToYuan,
  yuanToFen,
  truncate,
  daysToText,
};
