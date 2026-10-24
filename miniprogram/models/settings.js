/**
 * 用户设置 —— 纯逻辑层
 * ------------------------------------------------------------------
 * 归一化与校验放这里，设置页、服务层与测试共用同一实现；
 * 不依赖任何平台 API，可用 node 直接测。
 * ------------------------------------------------------------------
 */

const {
  DEFAULT_RETURN_DAYS,
  DEFAULT_REMIND_ADVANCE_DAYS,
} = require('../constants/index');

const MAX_DEFAULT_RETURN_DAYS = 30;
const MAX_ADVANCE_DAYS = 30;
/** HH:MM（24 小时制，00:00–23:59） */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(value) {
  return TIME_RE.test(String(value || ''));
}

/**
 * 归一化设置：越界钳制、去重、降序、非法值回退默认。
 * 任何脏数据都不应让页面或定时任务崩掉。
 */
function normalizeSettings(input) {
  const data = input || {};

  // 默认退货天数：0–30 的整数
  let days = Number(data.defaultReturnDays);
  if (!isFinite(days)) days = DEFAULT_RETURN_DAYS;
  days = Math.min(Math.max(Math.round(days), 0), MAX_DEFAULT_RETURN_DAYS);

  // 提醒档位：0–30 的整数，去重后降序（7,3,1,0）
  const rawAdv = Array.isArray(data.remindAdvanceDays)
    ? data.remindAdvanceDays
    : DEFAULT_REMIND_ADVANCE_DAYS.slice();

  const cleaned = [];
  rawAdv.forEach(function (v) {
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > MAX_ADVANCE_DAYS) return;
    const day = Math.round(n);
    if (cleaned.indexOf(day) === -1) cleaned.push(day);
  });
  cleaned.sort(function (a, b) { return b - a; });

  // 免打扰时段：格式非法则回退默认
  const quiet = data.quietHours || {};
  const start = isValidTime(quiet.start) ? quiet.start : '22:00';
  const end = isValidTime(quiet.end) ? quiet.end : '08:00';

  return {
    defaultReturnDays: days,
    remindAdvanceDays: cleaned.length
      ? cleaned
      : DEFAULT_REMIND_ADVANCE_DAYS.slice(),
    quietHours: { start: start, end: end },
    subscribeFlag: !!data.subscribeFlag,
  };
}

/**
 * 校验设置，返回错误数组（空数组表示通过）。
 * 页面提交前调用，避免把非法值写库。
 */
function validateSettings(input) {
  const data = input || {};
  const errors = [];

  const days = Number(data.defaultReturnDays);
  if (!isFinite(days) || days < 0 || days > MAX_DEFAULT_RETURN_DAYS) {
    errors.push('默认退货天数需在 0–' + MAX_DEFAULT_RETURN_DAYS + ' 天之间');
  }

  const adv = data.remindAdvanceDays;
  if (!Array.isArray(adv) || !adv.length) {
    errors.push('请至少保留一个提醒档位');
  } else {
    const bad = adv.some(function (v) {
      const n = Number(v);
      return !isFinite(n) || n < 0 || n > MAX_ADVANCE_DAYS;
    });
    if (bad) errors.push('提醒档位需在 0–' + MAX_ADVANCE_DAYS + ' 天之间');
  }

  const quiet = data.quietHours || {};
  if (!isValidTime(quiet.start) || !isValidTime(quiet.end)) {
    errors.push('免打扰时段格式应为 HH:MM');
  }

  return errors;
}

module.exports = {
  DEFAULT_SETTINGS: {
    defaultReturnDays: DEFAULT_RETURN_DAYS,
    remindAdvanceDays: DEFAULT_REMIND_ADVANCE_DAYS.slice(),
    quietHours: { start: '22:00', end: '08:00' },
    subscribeFlag: false,
  },
  MAX_DEFAULT_RETURN_DAYS,
  MAX_ADVANCE_DAYS,
  isValidTime,
  normalizeSettings,
  validateSettings,
};
