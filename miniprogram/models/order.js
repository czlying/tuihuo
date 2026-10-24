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
  MAX_RETURN_DAYS,
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

  // 已申请 / 已取货都是终态，永远优先
  if (order.status === ORDER_STATUS.APPLIED) return DERIVED_STATUS.APPLIED;
  if (order.status === ORDER_STATUS.PICKED) return DERIVED_STATUS.PICKED;

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

  if (status === DERIVED_STATUS.PICKED) {
    return {
      remainDays: null,
      urgency: URGENCY.NORMAL,
      countdownText: '已取货',
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
  const out = Object.assign({}, order, {
    derivedStatus: deriveStatus(order, todayStr),
    remainDays: countdown.remainDays,
    urgency: countdown.urgency,
    countdownText: countdown.countdownText,
    deadlineText: countdown.deadlineText,
    isOverdue: countdown.urgency === URGENCY.OVERDUE,
  });
  // 旧记录：订单编号曾存在 returnNo 字段
  if (out.orderNo === undefined) out.orderNo = order.returnNo || '';
  return out;
}

/**
 * 全局搜索纯函数：装饰 → 关键词筛选 → 分页。
 * 服务层只负责取数，命中与分页逻辑集中在这里，便于 Node 直接测试。
 *
 * @param {Array} list 原始订单数组
 * @param {string} keyword 关键词
 * @param {number} offset 跳过条数
 * @param {number} limit 每页条数
 * @param {string} [todayStr] 今天（YYYY-MM-DD），缺省时 decorate 内部取今天
 * @returns {{list:Array,total:number,hasMore:boolean,keyword:string,offset:number}}
 */
function searchOrders(list, keyword, offset, limit, todayStr) {
  const kw = String(keyword || '').trim();
  const start = Math.max(0, Number(offset) || 0);
  const decorated = decorateList(list, todayStr);
  const matched = filterByKeyword(decorated, kw);
  const page = slicePage(matched, start, limit);

  return {
    list: page.list,
    total: page.total,
    hasMore: page.hasMore,
    keyword: kw,
    offset: start,
  };
}

/**
 * 对已排序的列表做分页切片。
 * 返回 { list, total, hasMore }，翻页数学集中在这里，便于单测。
 *
 * @param {Array} list   已按目标顺序排好的完整数组
 * @param {number} offset 跳过条数（负数按 0 处理）
 * @param {number} limit  每页条数（非法值回退 10）
 */
function slicePage(list, offset, limit) {
  const arr = list || [];
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 10);

  return {
    list: arr.slice(off, off + lim),
    total: arr.length,
    hasMore: off + lim < arr.length,
  };
}

/** 求和金额（单位：分）。空值/非法值按 0 处理 */
function sumAmount(list) {
  return (list || []).reduce(function (sum, item) {
    return sum + (Number(item && item.amount) || 0);
  }, 0);
}

/** 批量装饰 */
function decorateList(list, todayStr) {
  return (list || []).map(function (item) {
    return decorate(item, todayStr);
  });
}

/**
 * 按关键词筛选订单：命中「商品名」「平台」或「订单编号」任一即保留。
 * 订单编号优先读 orderNo，旧记录回落 returnNo。
 * - 关键词去首尾空格、忽略大小写（中文不受影响）
 * - 关键词为空时返回全部（浅拷贝，避免调用方误改原数组）
 *
 * 抽成纯函数是为了能被 Node 直接测试；服务层与测试共用同一实现，
 * 不在测试里复刻筛选逻辑（复刻的测试改真实代码不会变红）。
 */
function filterByKeyword(list, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return (list || []).slice();

  return (list || []).filter(function (item) {
    if (!item) return false;
    const name = String(item.productName || '').toLowerCase();
    const platform = String(item.platform || '').toLowerCase();
    const no = String(
      item.orderNo !== undefined ? item.orderNo : item.returnNo || ''
    ).toLowerCase();
    return name.indexOf(kw) > -1 || platform.indexOf(kw) > -1 || no.indexOf(kw) > -1;
  });
}

/**
 * 校验一笔待保存的订单，返回错误信息数组（空数组表示通过）。
 * 放在纯函数层，保证录入页与未来的批量导入走同一套校验。
 */
function validate(input) {
  const errors = [];
  const data = input || {};

  // 订单编号长度上限：normalize 会截断，这里提前拦截，避免静默丢字符
  const rawOrderNo = String(data.orderNo !== undefined ? data.orderNo : data.returnNo || '');
  if (rawOrderNo.replace(/\s+/g, '').length > 64) {
    errors.push('订单编号不能超过 64 位');
  }

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
  if (!isFinite(days) || days < 0 || days > MAX_RETURN_DAYS) {
    errors.push('退货天数需在 0–' + MAX_RETURN_DAYS + ' 天之间');
  } else if (Math.round(days) !== days) {
    errors.push('退货天数需为整数');
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
 * 订单编号归一化：全角转半角、去掉所有空白、截断 64 位。
 * 手动输入和 OCR 都可能出现全角数字/空格，不统一会查不到重复。
 */
function normalizeOrderNo(value) {
  const raw = String(value === undefined || value === null ? '' : value);
  return raw
    .replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    })
    .replace(/\s+/g, '')
    .slice(0, 64);
}

/**
 * 从候选订单中筛出订单编号相同的记录（兼容旧 returnNo）。
 * 纯函数：service 查库后调用这里做命中判定，便于单测。
 *
 * @param {Array} rows 候选订单
 * @param {string} orderNo 待查编号
 * @param {string} [excludeId] 排除自身
 * @returns {Array} 命中的订单
 */
function matchByOrderNo(rows, orderNo, excludeId) {
  const no = normalizeOrderNo(orderNo);
  if (!no) return [];

  const seen = {};
  const out = [];

  (rows || []).forEach(function (o) {
    if (!o) return;

    const id = o._id || '';
    if (excludeId && id === excludeId) return;
    if (id && seen[id]) return;

    const candidate = normalizeOrderNo(
      o.orderNo !== undefined && o.orderNo !== '' ? o.orderNo : o.returnNo || ''
    );
    if (candidate !== no) return;

    if (id) seen[id] = true;
    out.push(o);
  });

  return out;
}

/**
 * 最晚发货日兜底：优先显式 shipDeadline，否则按基准日 + 7 天。
 * 基准日依次取 appliedAt / createdAt / receiveDate，避免老订单显示空。
 */
function resolveShipDeadline(order) {
  const o = order || {};
  const explicit = dateUtil.toDateOnly(o.shipDeadline);
  if (explicit) return explicit;

  const base =
    dateUtil.toDateOnly(o.appliedAt) ||
    dateUtil.toDateOnly(o.createdAt) ||
    dateUtil.toDateOnly(o.receiveDate);

  return base ? calcDeadline(base, 7) : '';
}

/**
 * 最晚可退日的时分秒归一化：默认 00:00:00，非法值回默认，各段夹在合法范围。
 */
function normalizeDeadlineTime(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return '00:00:00';

  const pad = function (n) {
    return n < 10 ? '0' + n : '' + n;
  };
  const h = Math.max(0, Math.min(23, Number(m[1]) || 0));
  const mi = Math.max(0, Math.min(59, Number(m[2]) || 0));
  const se = Math.max(0, Math.min(59, Number(m[3] || 0) || 0));
  return pad(h) + ':' + pad(mi) + ':' + pad(se);
}

/**
 * 把录入表单归一化成可直接入库的订单对象。
 * 确保 amount 是「分」的整数、日期是 'YYYY-MM-DD' 字符串。
 */
function normalize(input, uid) {
  const data = input || {};
  const receiveDate = dateUtil.toDateOnly(data.receiveDate);
  let returnDays =
    data.returnDays === null || data.returnDays === undefined || data.returnDays === ''
      ? DEFAULT_RETURN_DAYS
      : Number(data.returnDays);

  // 归一化最后一道防线：非法值回落默认，取整并封顶，避免 deadline 被推到极远
  if (!isFinite(returnDays) || returnDays < 0) returnDays = DEFAULT_RETURN_DAYS;
  returnDays = Math.min(Math.round(returnDays), MAX_RETURN_DAYS);

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
    deadlineTime: normalizeDeadlineTime(data.deadlineTime),
    // 最晚发货日：已申请退货后使用，旧记录为空时由页面按 appliedAt+7 兜底
    shipDeadline: dateUtil.toDateOnly(data.shipDeadline) || '',
    considering: !!data.considering,
    status:
      data.status === ORDER_STATUS.APPLIED
        ? ORDER_STATUS.APPLIED
        : data.status === ORDER_STATUS.PICKED
        ? ORDER_STATUS.PICKED
        : ORDER_STATUS.PENDING,
    source: data.source || 'manual',
    ocrRaw: data.ocrRaw || '',
    lastRemindStage: data.lastRemindStage === undefined ? null : data.lastRemindStage,
    appliedAt: data.appliedAt || null,
    pickedAt: data.pickedAt || null,
    // 运单号：预留给后续「已寄出」阶段，v1 无 UI、不参与查重
    logisticsNo: data.logisticsNo || '',
    // 订单编号：兼容旧字段 returnNo（早期版本把订单/退款号都放在这里）
    orderNo: normalizeOrderNo(
      data.orderNo !== undefined ? data.orderNo : data.returnNo || ''
    ),
    returnReason: String(data.returnReason || '').trim(),
    pickupCode: String(data.pickupCode || '').trim(),
    voucher: voucher,
    remark: String(data.remark || '').trim(),
  };
}

/**
 * 取订单的凭证 fileID 列表（去空、去重）。
 * 删除订单时用它清理云存储里的凭证图（M-2）；抽成纯函数便于测试。
 */
function voucherFileIds(order) {
  const list = order && Array.isArray(order.voucher) ? order.voucher : [];
  const out = [];
  list.forEach(function (f) {
    if (typeof f === 'string' && f && out.indexOf(f) === -1) out.push(f);
  });
  return out;
}

/**
 * 把 fileID 追加到凭证列表（纯函数）。
 * 识图时把截图存入凭证也走这里，保证「重复不追加、满额不覆盖」。
 *
 * @param {string[]} list 当前凭证
 * @param {string} fileId 新文件 fileID
 * @param {number} max 上限
 * @returns {{list:string[], added:boolean, reason:string}}
 *   reason: '' | 'empty' | 'duplicate' | 'full'
 */
function appendVoucher(list, fileId, max) {
  const current = Array.isArray(list) ? list.slice() : [];
  const limit = Math.max(1, Number(max) || 1);

  if (typeof fileId !== 'string' || !fileId) {
    return { list: current, added: false, reason: 'empty' };
  }
  if (current.indexOf(fileId) > -1) {
    return { list: current, added: false, reason: 'duplicate' };
  }
  if (current.length >= limit) {
    return { list: current, added: false, reason: 'full' };
  }

  current.push(fileId);
  return { list: current, added: true, reason: '' };
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
  if (data.deadlineTime !== undefined) {
    data.deadlineTime = normalizeDeadlineTime(data.deadlineTime);
  }
  if (data.considering !== undefined) {
    data.considering = !!data.considering;
  }
  if (data.shipDeadline !== undefined) {
    data.shipDeadline = dateUtil.toDateOnly(data.shipDeadline);
  }
  if (data.receiveDate !== undefined) {
    data.receiveDate = dateUtil.toDateOnly(data.receiveDate);
  }
  if (data.orderNo !== undefined) {
    data.orderNo = normalizeOrderNo(data.orderNo);
  }

  return data;
}

module.exports = {
  calcDeadline,
  resolveShipDeadline,
  deriveStatus,
  getCountdown,
  decorate,
  decorateList,
  filterByKeyword,
  searchOrders,
  slicePage,
  sumAmount,
  validate,
  normalize,
  normalizeOrderNo,
  normalizeDeadlineTime,
  matchByOrderNo,
  voucherFileIds,
  appendVoucher,
  buildUpdatePatch,
};
