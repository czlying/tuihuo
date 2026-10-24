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
 * 保存前**强制**做订单编号查重；有重复直接拒绝，不提供绕过入口。
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
    const check = payload.orderNo
      ? findByOrderNo(payload.orderNo)
      : Promise.resolve([]);

    return check.then(function (dups) {
      if (dups.length) {
        const err = new Error('订单编号已存在');
        err.code = 'DUPLICATE_ORDER_NO';
        err.duplicates = dups;
        throw err;
      }

      const now = new Date();
      payload.createdAt = now;
      payload.updatedAt = now;

      return getAdapter()
        .add(COLLECTIONS.ORDERS, payload)
        .then(function (res) {
          return Object.assign({ _id: res._id }, payload);
        });
    });
  });
}

/**
 * 更新订单（部分字段）。
 *
 * 字段处理逻辑（deadline 重算、空串防护、日期归一）全部委托给
 * orderModel.buildUpdatePatch —— 放在纯逻辑层是为了能被 Node 直接测试，
 * 那段逻辑踩过坑，必须有测试锁住。
 *
 * 若 patch 里带了订单编号，**强制**查重（排除自己），有重复直接拒绝。
 */
function update(id, patch) {
  const data = orderModel.buildUpdatePatch(patch);
  const no = data.orderNo !== undefined ? data.orderNo : '';

  const check = no
    ? Promise.resolve().then(function () {
        return findByOrderNo(no, id);
      })
    : Promise.resolve([]);

  return check.then(function (dups) {
    if (dups.length) {
      const err = new Error('订单编号已存在');
      err.code = 'DUPLICATE_ORDER_NO';
      err.duplicates = dups;
      throw err;
    }

    data.updatedAt = new Date();
    return getAdapter().update(COLLECTIONS.ORDERS, id, data);
  });
}

/**
 * 标记为「已申请」。
 * v1 状态机的终态，同时写入 appliedAt 供时间线展示（F-10）。
 */
/**
 * 标记为「上门取件」。
 * @param {string} id
 * @param {string} [pickupTime] 用户选择的上门取件时间（YYYY-MM-DD HH:mm）
 */
function markApplied(id, pickupTime) {
  const appliedAt = new Date();
  const patch = {
    status: ORDER_STATUS.APPLIED,
    appliedAt: appliedAt,
    // 默认 7 天发货期；后续可按平台配置
    shipDeadline: orderModel.calcDeadline(dateUtil.today(), 7),
    pickedAt: null,
    considering: false,
  };
  const t = String(pickupTime || '').trim();
  if (t) patch.pickupTime = t;
  return update(id, patch);
}

/** 撤销「已申请」，退回待退货 */
function revertToPending(id) {
  return update(id, {
    status: ORDER_STATUS.PENDING,
    appliedAt: null,
    pickedAt: null,
    shipDeadline: '',
    considering: false,
  });
}

/**
 * 标记为「已取货」：快递员已上门取走包裹。
 * 第三阶段终态，记录取货时间供名单展示。
 */
function markPicked(id) {
  return update(id, {
    status: ORDER_STATUS.PICKED,
    pickedAt: new Date(),
  });
}

/**
 * 删除订单，并尽力清理云存储中的凭证图（M-2）。
 *
 * 顺序：先读订单拿 voucher fileID → 删云存储图 → 再删数据库记录。
 * 容错（重要）：
 *   1. 图片删除失败不阻塞订单删除——图残留是小事，订单删不掉才是大问题；
 *   2. 读取订单失败（脏数据/网络）也继续删记录，避免用户被卡住。
 *   两步失败都只记日志，不向上抛错。
 */
function remove(id) {
  const adapter = getAdapter();

  return adapter
    .get(COLLECTIONS.ORDERS, id)
    .then(function (doc) {
      const files = orderModel.voucherFileIds(doc);
      if (!files.length) return null;
      return adapter.deleteFile(files).catch(function (err) {
        console.warn('[order] 凭证图清理失败（不阻塞删除）', err && err.message);
        return null;
      });
    })
    .catch(function (err) {
      console.warn('[order] 删除前读取订单失败，继续删记录', err && err.message);
      return null;
    })
    .then(function () {
      return adapter.remove(COLLECTIONS.ORDERS, id);
    });
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

/** 待退货单搜索默认最多返回条数（避免关键词过宽时一次渲染过多行） */
const PENDING_SEARCH_LIMIT = 20;

/**
 * 搜索待退货单：按「商品名 / 平台」关键词筛选，按 deadline 升序（越急越前）。
 *
 * 与已申请搜索共用同一套纯函数（filterByKeyword + slicePage），
 * 不重复实现筛选与翻页数学。
 *
 * @param {{keyword?:string, limit?:number}} [options]
 * @returns {Promise<{list:Array, total:number, hasMore:boolean, keyword:string}>}
 */
function searchPending(options) {
  const opts = options || {};
  const keyword = String(opts.keyword || '').trim();
  const limit = Math.max(1, Number(opts.limit) || PENDING_SEARCH_LIMIT);

  return getAdapter()
    .listAll(COLLECTIONS.ORDERS, {
      where: { status: ORDER_STATUS.PENDING },
      orderBy: ['deadline', 'asc'],
    })
    .then(function (rows) {
      const decorated = orderModel.decorateList(rows).filter(function (o) {
        return !o.considering;
      });
      const matched = keyword ? orderModel.filterByKeyword(decorated, keyword) : decorated;
      const page = orderModel.slicePage(matched, 0, limit);

      return {
        list: page.list,
        total: page.total,
        hasMore: page.hasMore,
        keyword: keyword,
      };
    });
}

/** 全局搜索：跨所有状态搜索商品名/平台/订单编号 */
function searchAll(keyword, limit, offset) {
  const kw = String(keyword || '').trim();
  const max = Math.max(1, Number(limit) || 50);
  const start = Math.max(0, Number(offset) || 0);

  return getAdapter()
    .listAll(COLLECTIONS.ORDERS, {
      orderBy: ['createdAt', 'desc'],
    })
    .then(function (rows) {
      return orderModel.searchOrders(rows, kw, start, max);
    });
}

/** 已申请列表每页条数（滚动到底再加载下一页） */
const APPLIED_PAGE_SIZE = 10;

/**
 * 按状态分页查询订单（内部通用实现，供已申请 / 已取货复用）。
 *
 * 分页策略：
 *   - 无关键词：服务端 skip/limit，只取当前页，数据量再大也不会全量拉取；
 *   - 有关键词：取回后按纯函数 filterByKeyword 筛选，再用 slicePage 切片
 *     （个人账本 listAll 上限 500 条；关键词搜索是主动行为，可接受）。
 *
 * @param {string} status ORDER_STATUS 中的状态值
 * @param {{keyword?:string, offset?:number, limit?:number}} [options]
 */
function listByStatus(status, options) {
  const opts = options || {};
  const keyword = String(opts.keyword || '').trim();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Number(opts.limit) || APPLIED_PAGE_SIZE);
  // 默认按申请时间倒序；已取货传 pickedAt
  const orderBy = opts.orderBy || ['appliedAt', 'desc'];
  const adapter = getAdapter();
  const where = { status: status };

  // 无关键词：服务端分页，多取 1 条用于判断是否还有下一页
  if (!keyword) {
    return Promise.all([
      adapter.list(COLLECTIONS.ORDERS, {
        where: where,
        orderBy: orderBy,
        skip: offset,
        limit: limit + 1,
      }),
      adapter.count(COLLECTIONS.ORDERS, where),
    ]).then(function (res) {
      const rows = res[0] || [];
      const total = res[1] || 0;

      return {
        list: orderModel.decorateList(rows.slice(0, limit)),
        total: total,
        hasMore: rows.length > limit,
        offset: offset,
        keyword: '',
      };
    });
  }

  // 有关键词：取回后筛选再切片
  return adapter
    .listAll(COLLECTIONS.ORDERS, {
      where: where,
      orderBy: orderBy,
    })
    .then(function (rows) {
      const matched = orderModel.filterByKeyword(orderModel.decorateList(rows), keyword);
      const page = orderModel.slicePage(matched, offset, limit);

      return {
        list: page.list,
        total: page.total,
        hasMore: page.hasMore,
        offset: offset,
        keyword: keyword,
      };
    });
}

/**
 * 已申请订单（按申请时间倒序，新申请的在前），分页返回。
 * @param {{keyword?:string, offset?:number, limit?:number}} [options]
 */
function listApplied(options) {
  return listByStatus(ORDER_STATUS.APPLIED, options);
}

/**
 * 已取货订单（按取货时间倒序，最近取走的在前），分页返回。
 * @param {{keyword?:string, offset?:number, limit?:number}} [options]
 */
function listPicked(options) {
  return listByStatus(
    ORDER_STATUS.PICKED,
    Object.assign({}, options || {}, { orderBy: ['pickedAt', 'desc'] })
  );
}

/**
 * 按状态聚合出「总额 + 笔数」。
 * 一次聚合同时拿两个数字；聚合不可用时回退 listAll 计算。
 */
function statsByStatus(status) {
  const adapter = getAdapter();
  const where = { status: status };

  return adapter
    .stats(COLLECTIONS.ORDERS, { where: where, field: 'amount' })
    .then(function (res) {
      return {
        total: Number(res && res.total) || 0,
        count: Number(res && res.count) || 0,
      };
    })
    .catch(function (err) {
      console.warn('[order] 聚合统计失败，回退全量计算', err && err.message);
      return adapter
        .listAll(COLLECTIONS.ORDERS, { where: where })
        .then(function (rows) {
          return {
            total: orderModel.sumAmount(rows),
            count: (rows || []).length,
          };
        })
        .catch(function () {
          return { total: 0, count: 0 };
        });
    });
}

/**
 * 按订单编号查重（同时兼容旧字段 returnNo）。
 * 编辑时传入 excludeId 排除自己。
 * 查询失败会抛出 DUPLICATE_CHECK_FAILED —— 宁可不让保存，也不静默放过重复单。
 *
 * @param {string} orderNo
 * @param {string} [excludeId]
 * @returns {Promise<Array>} 最多 3 条重复订单
 */
function findByOrderNo(orderNo, excludeId) {
  const no = orderModel.normalizeOrderNo(orderNo);
  if (!no) return Promise.resolve([]);

  const adapter = getAdapter();

  return Promise.all([
    adapter.list(COLLECTIONS.ORDERS, { where: { orderNo: no }, limit: 5 }),
    adapter.list(COLLECTIONS.ORDERS, { where: { returnNo: no }, limit: 5 }),
  ])
    .then(function (res) {
      const out = orderModel.matchByOrderNo(
        (res[0] || []).concat(res[1] || []),
        no,
        excludeId
      );

      if (out.length) {
        console.warn('[order] 订单编号重复：' + no + '，命中 ' + out.length + ' 条');
      }
      return out.slice(0, 3);
    })
    .catch(function (err) {
      console.error('[order] 订单编号查重失败', err);
      const e = new Error('订单编号查重失败，请稍后重试');
      e.code = 'DUPLICATE_CHECK_FAILED';
      e.raw = err;
      throw e;
    });
}

/**
 * 首页看板聚合。
 *
 * 统计口径（2026-10-19 统一）：
 *   - 待退 / 已申请 / 已取货三个状态的**总额与笔数**都走服务端聚合，精确且不拉全量；
 *   - 待退列表用 listAll 取回，拆成「想退货名单」与「退货名单」；
 *   - 想退 / 退货按各自 `deadline`，上门取件按 `shipDeadline` 统计今/明到期；
 *     若超过 listAll 上限（500 条），仅笔数统计受影响，总额/总笔数仍精确。
 *   - 月度统计已随 UI 下线（原先的「本月已申请」查询已删除）。
 */
function getDashboard() {
  const adapter = getAdapter();
  const today = dateUtil.today();

  const pendingTask = adapter.listAll(COLLECTIONS.ORDERS, {
    where: { status: ORDER_STATUS.PENDING },
    orderBy: ['deadline', 'asc'],
  });

  // 上门取件明细：按 shipDeadline 统计今/明到期
  const appliedListTask = adapter.listAll(COLLECTIONS.ORDERS, {
    where: { status: ORDER_STATUS.APPLIED },
  });

  // 三个状态各一次聚合：总额 + 笔数
  const pendingStatsTask = statsByStatus(ORDER_STATUS.PENDING);
  const appliedStatsTask = statsByStatus(ORDER_STATUS.APPLIED);
  const pickedStatsTask = statsByStatus(ORDER_STATUS.PICKED);

  return Promise.all([
    pendingTask,
    appliedListTask,
    pendingStatsTask,
    appliedStatsTask,
    pickedStatsTask,
  ]).then(function (results) {
    const pendingList = orderModel.decorateList(results[0], today);
    const appliedList = results[1] || [];
    const pendingStats = results[2] || { total: 0, count: 0 };
    const appliedStats = results[3] || { total: 0, count: 0 };
    const pickedStats = results[4] || { total: 0, count: 0 };

    const tomorrow = dateUtil.addDays(today, 1);
    let pendingDueSoonCount = 0;
    let decidedDueSoonCount = 0;
    let pickupDueSoonCount = 0;

    const resolveDeadline = function (o) {
      return (
        dateUtil.toDateOnly(o.deadline) ||
        orderModel.calcDeadline(o.receiveDate, o.returnDays)
      );
    };

    // 未申请退货拆成：想退货（犹豫中）与退货名单（已决定退）
    const consideringList = pendingList.filter(function (o) {
      return !!o.considering;
    });
    const decidedList = pendingList.filter(function (o) {
      return !o.considering;
    });
    const consideringCount = consideringList.length;
    const consideringAmount = orderModel.sumAmount(consideringList);
    const decidedAmount = orderModel.sumAmount(decidedList);
    const pendingCount = Math.max(
      decidedList.length,
      pendingStats.count - consideringCount
    );
    const pendingAmount =
      pendingStats.count > 0
        ? Math.max(0, pendingStats.total - consideringAmount)
        : decidedAmount;

    consideringList.forEach(function (o) {
      const deadline = resolveDeadline(o);
      if (deadline === today || deadline === tomorrow) {
        pendingDueSoonCount += 1;
      }
    });

    decidedList.forEach(function (o) {
      const deadline = resolveDeadline(o);
      if (deadline === today || deadline === tomorrow) {
        decidedDueSoonCount += 1;
      }
    });

    appliedList.forEach(function (o) {
      const shipDeadline = orderModel.resolveShipDeadline(o);
      if (shipDeadline === today || shipDeadline === tomorrow) {
        pickupDueSoonCount += 1;
      }
    });

    // 四个名单合计：想退 + 退货 + 上门取件 + 已取货
    const totalAmount =
      consideringAmount + pendingAmount + appliedStats.total + pickedStats.total;
    const totalCount =
      consideringCount + pendingCount + appliedStats.count + pickedStats.count;

    return {
      today: today,

      pendingCount: pendingCount,
      pendingAmount: pendingAmount,
      consideringCount: consideringCount,
      consideringAmount: consideringAmount,

      pendingDueSoonCount: pendingDueSoonCount,
      decidedDueSoonCount: decidedDueSoonCount,
      pickupDueSoonCount: pickupDueSoonCount,

      // 各状态全量总额与笔数
      appliedCountAll: appliedStats.count,
      appliedAmountAll: appliedStats.total,
      pickedCountAll: pickedStats.count,
      pickedAmountAll: pickedStats.total,
      totalCount: totalCount,
      totalAmount: totalAmount,

      // 退货名单：已决定退（pending）的前 N 条
      preview: decidedList.slice(0, DASHBOARD_PREVIEW_LIMIT),
      // 想退货名单：犹豫中的前 N 条
      consideringPreview: consideringList.slice(0, DASHBOARD_PREVIEW_LIMIT),
    };
  });
}

module.exports = {
  create,
  update,
  remove,
  getById,
  markApplied,
  markPicked,
  revertToPending,
  listPending,
  searchPending,
  searchAll,
  listApplied,
  listPicked,
  findByOrderNo,
  getDashboard,
  getUid,
  clearUidCache,
};
