/**
 * 订单领域模型 —— 纯函数
 * ------------------------------------------------------------------
 * 这里只放「不依赖任何平台 API」的纯计算逻辑：算最晚可退日、判逾期、算倒计时。
 * 因为是纯函数，它们可以：
 *   - 在小程序端直接调用；
 *   - 在云函数里 require 复用（云函数目录会单独拷一份，见云函数内注释）；
 *   - 写单元测试；
 *   - 未来跨端（独立 App）时原样复用。
 * 这是本项目「跨端预留」里最实在的一层。
 * ------------------------------------------------------------------
 */

const {
  ORDER_STATUS,
  DERIVED_STATUS,
  URGENCY,
  DEFAULT_RETURN_DAYS,
  MAX_AMOUNT_FEN,
  MAX_VOUCHER_COUNT,
} = require('../constants/index');
const dateUtil = require('../utils/date');
const { daysToText } = require('../utils/format');

/**
 * 计算最晚可退日。
 * 规则（需求文档 §2.2 / F-5）：最晚可退日 = 收货日 + 退货天数（默认 7），允许手动覆盖。
 *
 * @param {string} receiveDate 'YYYY-MM-DD'
 * @param {number} returnDays  退货天数
 * @returns {string} 'YYYY-MM-DD'，入参非法时返回 ''
 */
function calcDeadline(receiveDate, returnDays) {
  const days =
    returnDays === null || returnDays === undefined || returnDays === ''
      ? DEFAULT_RETURN_DAYS
      : Number(returnDays);

  if (!isFinite(days) || days < 0) return '';

  const base = dateUtil.toDateOnly(receiveDate);
  if (!base) return '';

  return dateUtil.addDays(base, days);
}

/**
 * 派生订单的展示状态。
 *
 * 落库的 status 只有 pending / applied；
 * overdue 是这里根据 deadline 与今天的比较结果「算」出来的，不落库。
 * 好处：任何时候读到的逾期状态都和真实日期一致，不会因为定时任务没跑而失真。
 *
 * @param {object} order
 * @param {string} [todayStr] 便于测试时注入固定日期
 */
function deriveStatus(order, todayStr) {
  if (!order) return DERIVED_STATUS.PENDING;

  // 已申请是终态，永远优先
  if (order.status === ORDER_STATUS.APPLIED) return DERIVED_STATUS.APPLIED;

  const today = todayStr || dateUtil.today();
  const deadline = dateUtil.toDateOnly(order.deadline);

  // 没有 deadline 视为仍然待退货，不误判为逾期
  if (!deadline) return DERIVED_STATUS.PENDING;

  const remain = dateUtil.diffDays(today, deadline);
  if (remain !== null && remain < 0) return DERIVED_STATUS.OVERDUE;

  return DERIVED_STATUS.PENDING;
}

/**
 * 计算倒计时信息。
 * @returns {{remainDays:number|null, urgency:string, countdownText:string, deadlineText:string}}
 */
function getCountdown(order, todayStr) {
  const today = todayStr || dateUtil.today();
  const deadline = dateUtil.toDateOnly(order && order.deadline);
  const status = deriveStatus(order, today);

  if (status === DERIVED_STATUS.APPLIED) {
    return {
      remainDays: null,
      urgency: URGENCY.NORMAL,
      countdownText: '已申请',
      deadlineText: deadline ? dateUtil.formatCN(deadline) : '',
    };
  }

  if (!deadline) {
    return {
      remainDays: null,
      urgency: URGENCY.NORMAL,
      countdownText: '未设置',
      deadlineText: '',
    };
  }

  const remain = dateUtil.diffDays(today, deadline);
  let urgency = URGENCY.NORMAL;
  if (remain < 0) urgency = URGENCY.OVERDUE;
  else if (remain === 0) urgency = URGENCY.TODAY;
  else if (remain <= 3) urgency = URGENCY.URGENT;

  return {
    remainDays: remain,
    urgency,
    countdownText: urgency === URGENCY.OVERDUE ? '已逾期 ' + Math.abs(remain) + ' 天' : daysToText(remain),
    deadlineText: dateUtil.formatCN(deadline),
  };
}

/**
 * 给订单补充所有派生展示字段，供页面直接渲染。
 * 页面不做业务计算，一律拿这里的结果。
 */
function decorate(order, todayStr) {
  if (!order) return null;
  const countdown = getCountdown(order, todayStr);
  return Object.assign({}, order, {
    derivedStatus: deriveStatus(order, todayStr),
    remainDays: countdown.remainDays,
    urgency: countdown.urgency,
    countdownText: countdown.countdownText,
    deadlineText: countdown.deadlineText,
    isOverdue: countdown.urgency === URGENCY.OVERDUE,
  });
}

/** 批量装饰 */
function decorateList(list, todayStr) {
  return (list || []).map(function (item) {
    return decorate(item, todayStr);
  });
}

/**
 * 校验一笔待保存的订单，返回错误信息数组（空数组表示通过）。
 * 放在纯函数层，保证录入页与未来的批量导入走同一套校验。
 */
function validate(input) {
  const errors = [];
  const data = input || {};

  if (!data.productName || !String(data.productName).trim()) {
    errors.push('请填写商品名');
  }
  if (!data.platform || !String(data.platform).trim()) {
    errors.push('请选择平台');
  }
  if (!dateUtil.toDateOnly(data.receiveDate)) {
    errors.push('请选择收货日期');
  }

  const amount = Number(data.amount);
  if (!isFinite(amount) || amount < 0) {
    errors.push('金额需为不小于 0 的数字');
  } else if (amount > MAX_AMOUNT_FEN) {
    // 上限校验：防止误粘贴超长数字撑爆首页排版，
    // 也避免超过安全整数范围后金额比较失真
    errors.push('金额过大，请确认是否多输入了几位（上限 100 万元）');
  }

  const days = Number(data.returnDays);
  if (!isFinite(days) || days < 0) {
    errors.push('退货天数需为不小于 0 的数字');
  }

  // 凭证数量上限。前端的 picker 限制只是顺手拦截，
  // 真正的约束放这里，未来 OCR / 批量导入才绕不过去。
  if (Array.isArray(data.voucher) && data.voucher.length > MAX_VOUCHER_COUNT) {
    errors.push('凭证最多 ' + MAX_VOUCHER_COUNT + ' 张');
  }

  // 收货日期不能晚于今天（还没收到货就谈不上退货）
  const receive = dateUtil.toDateOnly(data.receiveDate);
  if (receive && dateUtil.diffDays(receive, dateUtil.today()) < 0) {
    errors.push('收货日期不能晚于今天');
  }

  return errors;
}

/**
 * 把录入表单归一化成可直接入库的订单对象。
 * 确保 amount 是「分」的整数、日期是 'YYYY-MM-DD' 字符串。
 */
function normalize(input, uid) {
  const data = input || {};
  const receiveDate = dateUtil.toDateOnly(data.receiveDate);
  const returnDays =
    data.returnDays === null || data.returnDays === undefined || data.returnDays === ''
      ? DEFAULT_RETURN_DAYS
      : Number(data.returnDays);

  // 允许用户直接改 deadline（F-5：支持手动修改天数或日期）
  const deadline = data.deadline
    ? dateUtil.toDateOnly(data.deadline)
    : calcDeadline(receiveDate, returnDays);

  // 金额钳制到合法区间，防止绕过 validate 直接调用时写入异常值
  const rawAmount = Math.round(Number(data.amount) || 0);
  const amount = Math.min(Math.max(rawAmount, 0), MAX_AMOUNT_FEN);

  // 凭证最多保留上限张数（同样是绕过 validate 时的最后一道防线）
  const voucher = Array.isArray(data.voucher)
    ? data.voucher.slice(0, MAX_VOUCHER_COUNT)
    : [];

  return {
    uid: uid || '',
    platform: String(data.platform || '').trim(),
    productName: String(data.productName || '').trim(),
    amount: amount,
    receiveDate: receiveDate,
    returnDays: returnDays,
    deadline: deadline,
    status: data.status === ORDER_STATUS.APPLIED ? ORDER_STATUS.APPLIED : ORDER_STATUS.PENDING,
    source: data.source || 'manual',
    ocrRaw: data.ocrRaw || '',
    lastRemindStage: data.lastRemindStage === undefined ? null : data.lastRemindStage,
    appliedAt: data.appliedAt || null,
    logisticsNo: data.logisticsNo || '',
    voucher: voucher,
    remark: String(data.remark || '').trim(),
  };
}

/**
 * 把「变更集」组装成可直接写库的 update patch。
 * ------------------------------------------------------------------
 * 这是编辑保存路径的核心纯逻辑，刻意放这里而不是留在 service 层：
 * 因为它最容易出错、出问题又最隐蔽（见下面 deadline 的坑），
 * 放在纯逻辑层才能被 Node 直接测试，不在开发者工具里也能验证。
 *
 * 关键约定：**字段不存在 = 不修改**。
 *   页面用 undefined（不出现该 key）表达"这次不改这个字段"。
 *   绝不能用 '' / null 表达"没填"——那会被当成"要写空值"入库。
 *
 * ⚠️ deadline 的坑（真实踩过，导致订单静默失效）：
 *   若把判定写成 patch.deadline === undefined 才算"未指定"，
 *   而页面给了 ''（很自然的写法），就会：
 *     1. 跳过自动重算分支；
 *     2. 又被下面的日期归一化写成 ''，覆盖掉库里正确的 deadline。
 *   后果是订单不再判逾期、不再进临期名单、定时提醒永久跳过 —— 且无任何报错。
 *   所以这里把 '' 也视为"未指定"，并且最后再兜一道：空串一律不写库。
 *
 * @param {object} patch 变更集（页面 collectForm 的输出）
 * @returns {object} 可直接传给 adapter.update 的字段对象
 */
function buildUpdatePatch(patch) {
  const data = Object.assign({}, patch || {});

  const deadlineNotSpecified = data.deadline === undefined || data.deadline === '';

  // 改了收货日或退货天数，且调用方没指定 deadline -> 自动重算
  if (
    (data.receiveDate !== undefined || data.returnDays !== undefined) &&
    deadlineNotSpecified
  ) {
    const receiveDate = dateUtil.toDateOnly(data.receiveDate);
    if (receiveDate) {
      data.deadline = calcDeadline(receiveDate, data.returnDays);
    }
  }

  // 空串一律不写库：宁可保留原值，也不能把 deadline 写成空导致业务失真
  if (data.deadline === '') {
    delete data.deadline;
  }
  if (data.deadline !== undefined) {
    data.deadline = dateUtil.toDateOnly(data.deadline);
  }
  if (data.receiveDate !== undefined) {
    data.receiveDate = dateUtil.toDateOnly(data.receiveDate);
  }

  return data;
}

module.exports = {
  calcDeadline,
  deriveStatus,
  getCountdown,
  decorate,
  decorateList,
  validate,
  normalize,
  buildUpdatePatch,
};
