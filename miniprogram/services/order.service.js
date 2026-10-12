/**
 * 订单业务服务
 * ------------------------------------------------------------------
 * 页面只调用这里的方法，不直接碰 wx.cloud。
 * 所有金额单位为「分」的整数，日期为 'YYYY-MM-DD' 字符串。
 * ------------------------------------------------------------------
 */

const { getAdapter } = require('./adapters/index');
const { COLLECTIONS } = require('../config/env');
const {
  ORDER_STATUS,
  DERIVED_STATUS,
  DASHBOARD_PREVIEW_LIMIT,
} = require('../constants/index');
const orderModel = require('../models/order');
const dateUtil = require('../utils/date');

/**
 * 拿当前用户标识。
 *
 * v1（微信小程序）：uid 即 openid，需通过云函数获取（小程序端拿不到 openid）。
 * 取到后缓存，避免每次录入都请求一次。
 *
 * 拿不到也不阻塞业务：因为安全规则校验用的是平台自动注入的 _openid，
 * uid 在 v1 只是为跨端预留的业务主键。失败时降级为空串并记录日志。
 */
let _uidCache = null;

function getUid() {
  if (_uidCache) return Promise.resolve(_uidCache);

  // 先看本地缓存，减少一次云函数调用
  try {
    const cached = wx.getStorageSync('tuihuo_uid');
    if (cached) {
      _uidCache = cached;
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.uid = cached;
      }
      return Promise.resolve(cached);
    }
  } catch (e) {
    // 读缓存失败不影响主流程
  }

  return getAdapter()
    .callFunction('api', { action: 'whoami' })
    .then(function (res) {
      const uid = (res && res.data && res.data.uid) || '';
      if (uid) {
        _uidCache = uid;
        try {
          wx.setStorageSync('tuihuo_uid', uid);
        } catch (e) {
          /* ignore */
        }
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.uid = uid;
          app.globalData.openid = (res.data && res.data.openid) || '';
        }
      }
      return uid;
    })
    .catch(function (err) {
      console.warn('[order] whoami 失败，uid 降级为空（不影响数据归属）', err && err.message);
      return '';
    });
}

/** 清掉 uid 缓存（一般不需要，换账号调试时可手动调用） */
function clearUidCache() {
  _uidCache = null;
  try {
    wx.removeStorageSync('tuihuo_uid');
  } catch (e) {
    /* ignore */
  }
}

/**
 * 新增一笔退货订单。
 * 落库前统一走模型层的 validate + normalize，保证数据干净。
 */
function create(input) {
  const errors = orderModel.validate(input);
  if (errors.length) {
    const err = new Error(errors[0]);
    err.validationErrors = errors;
    return Promise.reject(err);
  }

  return getUid().then(function (uid) {
    const payload = orderModel.normalize(input, uid);
    const now = new Date();
    payload.createdAt = now;
    payload.updatedAt = now;

    return getAdapter()
      .add(COLLECTIONS.ORDERS, payload)
      .then(function (res) {
        return Object.assign({ _id: res._id }, payload);
      });
  });
}

/**
 * 更新订单（部分字段）。
 *
 * 字段处理逻辑（deadline 重算、空串防护、日期归一）全部委托给
 * orderModel.buildUpdatePatch —— 放在纯逻辑层是为了能被 Node 直接测试，
 * 那段逻辑踩过坑，必须有测试锁住。
 */
function update(id, patch) {
  const data = orderModel.buildUpdatePatch(patch);
  data.updatedAt = new Date();

  return getAdapter().update(COLLECTIONS.ORDERS, id, data);
}

/**
 * 标记为「已申请」。
 * v1 状态机的终态，同时写入 appliedAt 供时间线展示（F-10）。
 */
function markApplied(id, remark) {
  const patch = {
    status: ORDER_STATUS.APPLIED,
    appliedAt: new Date(),
  };
  if (remark !== undefined) patch.remark = remark;
  return update(id, patch);
}

/** 撤销「已申请」，退回待退货 */
function revertToPending(id) {
  return update(id, {
    status: ORDER_STATUS.PENDING,
    appliedAt: null,
  });
}

/** 删除订单 */
function remove(id) {
  return getAdapter().remove(COLLECTIONS.ORDERS, id);
}

/** 按 _id 取单条，并补齐派生字段 */
function getById(id) {
  return getAdapter()
    .get(COLLECTIONS.ORDERS, id)
    .then(function (doc) {
      return orderModel.decorate(doc);
    });
}

/**
 * 查询待退货单（status=pending），按 deadline 升序 —— 越紧急越靠前。
 * 逾期项因为 deadline 更早，会自然排在前面。
 */
function listPending() {
  return getAdapter()
    .listAll(COLLECTIONS.ORDERS, {
      where: { status: ORDER_STATUS.PENDING },
      orderBy: ['deadline', 'asc'],
    })
    .then(function (rows) {
      return orderModel.decorateList(rows);
    });
}

/** 全部订单（含已申请），按创建时间倒序，供后续列表页使用 */
function listAllOrders() {
  return getAdapter()
    .listAll(COLLECTIONS.ORDERS, {
      orderBy: ['createdAt', 'desc'],
    })
    .then(function (rows) {
      return orderModel.decorateList(rows);
    });
}

/**
 * 首页看板聚合。
 *
 * 为什么在客户端算而不是云函数：
 *   本应用是单用户个人账本，数据量小（活跃待退通常个位数到几十条），
 *   客户端聚合省掉一次云函数往返，且录入后能立刻刷新，实时性更好。
 *   查询只取「待退货单」和「本月已申请」两个子集，不是全表扫描。
 *   （注意走 listAll 翻页，避免单次 20 条上限导致统计漏数。）
 */
function getDashboard() {
  const adapter = getAdapter();
  const today = dateUtil.today();
  const month = dateUtil.monthRange(today);

  const pendingTask = adapter.listAll(COLLECTIONS.ORDERS, {
    where: { status: ORDER_STATUS.PENDING },
    orderBy: ['deadline', 'asc'],
  });

  const appliedTask = adapter
    .listAll(COLLECTIONS.ORDERS, {
      where: {
        status: ORDER_STATUS.APPLIED,
        appliedAt: adapter.command().gte(dateUtil.parseDateOnly(month.start)),
      },
      orderBy: ['appliedAt', 'desc'],
    })
    .catch(function (err) {
      // appliedAt 可能为 null（历史数据），该条件查不出结果不影响主看板
      console.warn('[order] 本月已退统计失败，按 0 处理', err && err.message);
      return [];
    });

  return Promise.all([pendingTask, appliedTask]).then(function (results) {
    const pendingList = orderModel.decorateList(results[0], today);
    const appliedThisMonth = results[1] || [];

    let pendingAmount = 0;
    let overdueCount = 0;
    let overdueAmount = 0;
    let dueThisWeekCount = 0;

    pendingList.forEach(function (o) {
      const amount = Number(o.amount) || 0;
      pendingAmount += amount;

      if (o.derivedStatus === DERIVED_STATUS.OVERDUE) {
        overdueCount += 1;
        overdueAmount += amount;
      } else if (o.deadline && dateUtil.isThisWeek(o.deadline)) {
        dueThisWeekCount += 1;
      }
    });

    let appliedAmountThisMonth = 0;
    appliedThisMonth.forEach(function (o) {
      appliedAmountThisMonth += Number(o.amount) || 0;
    });

    return {
      today: today,
      monthLabel: dateUtil.formatMonthCN(today),

      pendingCount: pendingList.length,
      pendingAmount: pendingAmount,

      dueThisWeekCount: dueThisWeekCount,

      overdueCount: overdueCount,
      overdueAmount: overdueAmount,

      appliedCountThisMonth: appliedThisMonth.length,
      appliedAmountThisMonth: appliedAmountThisMonth,

      // 临期名单：最紧急的前 N 条
      preview: pendingList.slice(0, DASHBOARD_PREVIEW_LIMIT),
    };
  });
}

module.exports = {
  create,
  update,
  remove,
  getById,
  markApplied,
  revertToPending,
  listPending,
  listAllOrders,
  getDashboard,
  getUid,
  clearUidCache,
};
