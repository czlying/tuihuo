/**
 * wxcloud 适配器 —— 微信云开发实现
 * ------------------------------------------------------------------
 * 这是「跨端预留」的落点：业务服务层只认下面这套接口，不认 wx.cloud。
 * 未来要接独立 App（CloudBase HTTP API）或换成 uni-app/Taro 时，
 * 只需新增一个 adapter 实现同一套方法，业务代码零改动。
 *
 * 适配器契约（新增适配器必须实现）：
 *   name                              适配器名
 *   available()                       运行环境是否可用
 *   command()                         查询操作符（gt/lt/in/and/or ...）
 *   add(collection, data)             新增，返回 { _id }
 *   get(collection, id)               按 _id 取单条
 *   list(collection, options)         条件查询，返回数组
 *   listAll(collection, options)      自动翻页取全部（绕过单次 20 条上限）
 *   count(collection, where)          计数
 *   update(collection, id, data)      按 _id 更新
 *   remove(collection, id)            按 _id 删除
 *   callFunction(name, data)          调用云函数
 *   uploadFile(filePath)              上传文件到云存储
 *   deleteFile(fileList)              删除云存储文件（单个或数组）
 *   getTempFileURL(fileList)          云存储 fileID → 临时 HTTPS URL
 *   stats(collection, options)        按条件聚合出总额与笔数
 * ------------------------------------------------------------------
 */

const { ENV_ID } = require('../../config/env');

/** 小程序端单次查询上限为 20 条，翻页时以此为步长 */
const CLIENT_PAGE_SIZE = 20;

let _db = null;

function getDb() {
  if (_db) return _db;
  if (!wx.cloud) {
    throw new Error('当前环境不支持云开发（wx.cloud 不存在）');
  }
  _db = wx.cloud.database();
  return _db;
}

/**
 * 取出错误里所有可能的文本。
 *
 * 为什么不能只看 errMsg：云开发的错误没有统一的形状。有时 errMsg 只是
 * 一句 'collection.get:fail'，真实的 errCode 说明被塞在 message 里；
 * 只看一个字段会漏判，用户最后拿到的是一句毫无用处的「操作失败，请稍后重试」。
 */
function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;

  const parts = [];
  ['errMsg', 'message', 'error', 'details'].forEach(function (k) {
    if (err[k]) parts.push(String(err[k]));
  });
  return parts.join(' | ');
}

/**
 * 把云开发抛出的原始错误转成用户能看懂的话。
 * 保留原始错误在 raw 字段里，方便开发者排查。
 */
function normalizeError(err, action) {
  const raw = err || {};
  const text = errorText(raw);

  // 错误码未必在顶层字段上，常见的是被拼进 errMsg 字符串里
  // （形如 'xxx:fail Error: errCode: -501023 permission denied'），
  // 取不到顶层值时再从文本里捞一次，否则会漏判。
  const embedded = text.match(/errcode:\s*(-?\d+)/i);
  const code = Number(
    raw.errCode !== undefined
      ? raw.errCode
      : raw.code !== undefined
      ? raw.code
      : embedded
      ? embedded[1]
      : NaN
  );

  let friendly = '操作失败，请稍后重试';

  if (code === -501023 || /unauthenticated/i.test(text)) {
    // -501023：未登录访问被拒。多端应用是独立客户端，没有登录态时必踩。
    friendly = '未登录，无法访问云数据';
  } else if (
    code === -601002 ||
    /env not exists|environment not found|invalid env/i.test(text)
  ) {
    // -601002：环境不存在 / 无访问权限。多端下多半是 appid 与 envid 没配好。
    friendly = '云环境不可用，请检查环境 ID 与 AppID';
  } else if (text.indexOf('collection not exists') > -1 || code === -502005) {
    friendly = '云数据库集合不存在，请先在云开发控制台创建集合';
  } else if (text.indexOf('permission denied') > -1 || code === -502003) {
    friendly = '没有权限，请检查数据库安全规则是否为「仅创建者可读写」';
  } else if (text.indexOf('cloud init') > -1 || text.indexOf('not initialized') > -1) {
    friendly = '云开发未初始化，请确认已开通云开发环境';
  } else if (
    text.indexOf('timeout') > -1 ||
    text.indexOf('network') > -1 ||
    /request:fail|uploadFile:fail|downloadFile:fail|callFunction:fail/i.test(text)
  ) {
    friendly = '网络请求失败，请检查网络后重试';
  }

  const e = new Error(friendly);
  e.action = action;
  e.raw = raw;
  return e;
}

function wrap(action, fn) {
  return Promise.resolve()
    .then(fn)
    .catch(function (err) {
      console.error('[wxcloud] ' + action + ' 失败:', err);
      throw normalizeError(err, action);
    });
}

const adapter = {
  name: 'wxcloud',

  available() {
    return typeof wx !== 'undefined' && !!wx.cloud;
  },

  envId() {
    return ENV_ID || '(默认环境)';
  },

  command() {
    return getDb().command;
  },

  raw() {
    return getDb();
  },

  add(collection, data) {
    return wrap('add:' + collection, function () {
      return getDb()
        .collection(collection)
        .add({ data: data })
        .then(function (res) {
          return { _id: res._id };
        });
    });
  },

  get(collection, id) {
    return wrap('get:' + collection, function () {
      return getDb()
        .collection(collection)
        .doc(id)
        .get()
        .then(function (res) {
          return res.data || null;
        });
    });
  },

  /**
   * @param {object} options { where, orderBy: [field, 'asc'|'desc'], skip, limit, field }
   */
  list(collection, options) {
    const opts = options || {};
    return wrap('list:' + collection, function () {
      let query = getDb().collection(collection);

      if (opts.where) query = query.where(opts.where);

      if (opts.orderBy && opts.orderBy.length >= 2) {
        query = query.orderBy(opts.orderBy[0], opts.orderBy[1]);
      }

      if (opts.field) query = query.field(opts.field);

      return query
        .skip(opts.skip || 0)
        .limit(opts.limit || CLIENT_PAGE_SIZE)
        .get()
        .then(function (res) {
          return res.data || [];
        });
    });
  },

  /**
   * 自动翻页取全部匹配记录。
   * 小程序端单次最多 20 条，数据超过 20 条时直接 list 会静默丢数据，
   * 所以凡是「需要完整集合做统计」的场景必须走这个方法。
   *
   * @param {number} maxPages 保护上限，避免异常情况下无限翻页
   */
  listAll(collection, options) {
    const opts = options || {};
    const pageSize = opts.pageSize || CLIENT_PAGE_SIZE;
    const maxPages = opts.maxPages || 25; // 最多 500 条，个人使用足够
    const all = [];

    function fetchPage(pageIndex) {
      if (pageIndex >= maxPages) return Promise.resolve(all);

      return adapter
        .list(collection, {
          where: opts.where,
          orderBy: opts.orderBy,
          skip: pageIndex * pageSize,
          limit: pageSize,
        })
        .then(function (rows) {
          if (!rows.length) return all;
          for (let i = 0; i < rows.length; i++) all.push(rows[i]);
          if (rows.length < pageSize) return all;
          return fetchPage(pageIndex + 1);
        });
    }

    return fetchPage(0);
  },

  count(collection, where) {
    return wrap('count:' + collection, function () {
      let query = getDb().collection(collection);
      if (where) query = query.where(where);
      return query.count().then(function (res) {
        return res.total || 0;
      });
    });
  },

  /**
   * 按条件聚合出「字段总和」与「记录数」，一次查询拿到列表头的两个数字。
   * 不拉取全量文档，数据量再大也高效；聚合同样受数据库权限约束。
   *
   * @param {object} options { where, field }
   * @returns {Promise<{total:number, count:number}>} total 单位与字段一致（金额为分）
   */
  stats(collection, options) {
    const opts = options || {};
    return wrap('stats:' + collection, function () {
      const db = getDb();
      const $ = db.command.aggregate;

      let agg = db.collection(collection).aggregate();
      if (opts.where) agg = agg.match(opts.where);

      return agg
        .group({
          _id: null,
          total: $.sum('$' + (opts.field || 'amount')),
          count: $.sum(1),
        })
        .end()
        .then(function (res) {
          const row = (res && res.list && res.list[0]) || {};
          return {
            total: Number(row.total) || 0,
            count: Number(row.count) || 0,
          };
        });
    });
  },

  update(collection, id, data) {
    return wrap('update:' + collection, function () {
      return getDb()
        .collection(collection)
        .doc(id)
        .update({ data: data })
        .then(function (res) {
          return { updated: res.stats ? res.stats.updated : 0 };
        });
    });
  },

  remove(collection, id) {
    return wrap('remove:' + collection, function () {
      return getDb()
        .collection(collection)
        .doc(id)
        .remove()
        .then(function (res) {
          return { removed: res.stats ? res.stats.removed : 0 };
        });
    });
  },

  callFunction(name, data) {
    return wrap('callFunction:' + name, function () {
      return wx.cloud
        .callFunction({ name: name, data: data || {} })
        .then(function (res) {
          return res.result;
        });
    });
  },

  uploadFile(filePath) {
    return wrap('uploadFile', function () {
      const ext = String(filePath).split('.').pop() || 'png';
      const cloudPath =
        'voucher/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath });
    });
  },

  /**
   * 删除云存储文件。
   * 入参可为单个 fileID 或数组；空值/非字符串会被过滤。
   * 返回 { deleted, failed }：文件本来就不存在（STORAGE_FILE_NONEXIST）算已清理，不计失败。
   * 用于删除订单时清理凭证图（M-2）。
   */
  /**
   * 云存储 fileID 转临时 HTTPS URL。
   * <image> 可以直接用 cloud:// fileID，但 wx.previewImage 只认 http(s)，
   * 所以预览前必须转换一次。
   *
   * @param {string|string[]} fileList
   * @returns {Promise<string[]>} 与入参顺序一致；失败的项为空串
   */
  getTempFileURL(fileList) {
    const list = (Array.isArray(fileList) ? fileList : [fileList]).filter(function (f) {
      return typeof f === 'string' && f;
    });
    if (!list.length) return Promise.resolve([]);

    return wrap('getTempFileURL', function () {
      return wx.cloud.getTempFileURL({ fileList: list }).then(function (res) {
        const arr = (res && res.fileList) || [];
        return list.map(function (id) {
          for (let i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].fileID === id) return arr[i].tempFileURL || '';
          }
          return '';
        });
      });
    });
  },

  deleteFile(fileList) {
    const list = (Array.isArray(fileList) ? fileList : [fileList]).filter(function (f) {
      return typeof f === 'string' && f;
    });
    if (!list.length) return Promise.resolve({ deleted: 0, failed: 0 });

    return wrap('deleteFile', function () {
      return wx.cloud.deleteFile({ fileList: list }).then(function (res) {
        const arr = (res && res.fileList) || [];
        // 结果数组缺失时按全部成功处理（兼容旧基础库）
        if (!arr.length) return { deleted: list.length, failed: 0 };

        let deleted = 0;
        let failed = 0;
        arr.forEach(function (item) {
          const ok =
            item && (item.status === 0 || /NONEXIST/i.test(String(item.errMsg || '')));
          if (ok) deleted += 1;
          else failed += 1;
        });
        return { deleted: deleted, failed: failed };
      });
    });
  },
};

module.exports = adapter;
module.exports.CLIENT_PAGE_SIZE = CLIENT_PAGE_SIZE;
// 错误翻译是不依赖 wx 的纯函数，但译错会直接误导用户（曾把「未登录」
// 说成「请稍后重试」，导致整条链路无从排查）。导出以便用例锁住它。
module.exports.normalizeError = normalizeError;
