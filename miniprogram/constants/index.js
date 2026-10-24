/**
 * 全局常量与枚举
 * 所有状态值、默认值集中在这里，避免散落在各页面里形成"魔法字符串"。
 */

/**
 * orders.status 的「落库值」。
 * 只有两个值会被真正写进数据库。
 *
 * 注意：'overdue'（已逾期）刻意不落库，而是每次读取时按 deadline 派生计算。
 * 原因：
 *   1. 定时任务与用户操作会竞争写同一个 status 字段，容易写出脏数据；
 *   2. 定时任务一旦失败，状态就会和真实日期不一致，用户看到的是错的；
 *   3. 逾期本质上只是「当前日期已经超过 deadline」这个事实的呈现，派生最准。
 * 详见 models/order.js 的 deriveStatus。
 */
const ORDER_STATUS = {
  PENDING: 'pending', // 待退货
  APPLIED: 'applied', // 已申请（拿到取件码/寄件码）
  PICKED: 'picked',   // 已取货（快递员已取走）
};

/** 派生态（不落库，仅用于展示与筛选） */
const DERIVED_STATUS = {
  PENDING: 'pending',
  APPLIED: 'applied',
  PICKED: 'picked',
  OVERDUE: 'overdue',
};

/** 倒计时紧急程度，用于列表左侧色条编码 */
const URGENCY = {
  OVERDUE: 'overdue', // 已逾期
  TODAY: 'today',     // 今天到期
  URGENT: 'urgent',   // 3 天内
  NORMAL: 'normal',   // 还早
};

/** 默认退货天数：收货日 + 7 天 */
const DEFAULT_RETURN_DAYS = 7;

/** 退货天数上限（防止误输入把 deadline 推到极远） */
const MAX_RETURN_DAYS = 365;

/** 前端构建版本：设置页可见，用于确认是否编译到最新代码 */
const BUILD_VERSION = '2026-10-24.26';

/** 默认提醒档位：提前 3 天 / 1 天 / 当天。用户可在设置中覆盖 */
const DEFAULT_REMIND_ADVANCE_DAYS = [3, 1, 0];

/** 录入来源 */
const ORDER_SOURCE = {
  MANUAL: 'manual',
  OCR: 'ocr',
};

/** 首页临期名单展示条数 */
const DASHBOARD_PREVIEW_LIMIT = 5;

/**
 * 单笔金额上限（单位：分）。
 * 100 万元。防止误粘贴超长数字把首页大字号数值撑爆、
 * 或因溢出导致浮点精度失真。校验放在 models/order.js，前端与服务层共用。
 */
const MAX_AMOUNT_FEN = 100000000;

/** 每笔订单最多几张凭证。前端 picker 与服务层校验共用同一常量 */
const MAX_VOUCHER_COUNT = 3;

/**
 * 预置平台库。
 * 这是「系统预置、全局只读」的清单，用户自建的平台写入 userPlatforms 集合，
 * 不要往这里写，否则会串到其他用户。
 */
const PRESET_PLATFORMS = [
  { name: '淘宝', defaultReturnDays: 7, color: '#e8734a' },
  { name: '天猫', defaultReturnDays: 7, color: '#c9302c' },
  { name: '京东', defaultReturnDays: 7, color: '#b4442f' },
  { name: '拼多多', defaultReturnDays: 7, color: '#c8963e' },
  { name: '抖音电商', defaultReturnDays: 7, color: '#2f2b28' },
  { name: '快手小店', defaultReturnDays: 7, color: '#ff5a3c' },
  { name: '唯品会', defaultReturnDays: 7, color: '#b0457a' },
  { name: '苏宁易购', defaultReturnDays: 7, color: '#f0a01a' },
  { name: '美团', defaultReturnDays: 7, color: '#c8a13e' },
  { name: '饿了么', defaultReturnDays: 7, color: '#3a7bbf' },
  { name: '小红书', defaultReturnDays: 7, color: '#a8352f' },
  { name: '其他', defaultReturnDays: 7, color: '#6b665e' },
];

module.exports = {
  ORDER_STATUS,
  DERIVED_STATUS,
  URGENCY,
  DEFAULT_RETURN_DAYS,
  MAX_RETURN_DAYS,
  BUILD_VERSION,
  DEFAULT_REMIND_ADVANCE_DAYS,
  ORDER_SOURCE,
  DASHBOARD_PREVIEW_LIMIT,
  MAX_AMOUNT_FEN,
  MAX_VOUCHER_COUNT,
  PRESET_PLATFORMS,
};
