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
 * 把云开发抛出的原始错误转成用户能看懂的话。
 * 保留原始错误在 raw 字段里，方便开发者排查。
 */
function normalizeError(err, action) {
  const raw = err || {};
  const msg = String(raw.errMsg || raw.message || '');

  let friendly = '操作失败，请稍后重试';

  if (msg.indexOf('collection not exists') > -1 || raw.errCode === -502005) {
    friendly = '云数据库集合不存在，请先在云开发控制台创建集合';
  } else if (msg.indexOf('permission denied') > -1 || raw.errCode === -502003) {
    friendly = '没有权限，请检查数据库安全规则是否为「仅创建者可读写」';
  } else if (msg.indexOf('cloud init') > -1 || msg.indexOf('not initialized') > -1) {
    friendly = '云开发未初始化，请确认已开通云开发环境';
  } else if (msg.indexOf('timeout') > -1 || msg.indexOf('fail') > -1) {
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
};

module.exports = adapter;
module.exports.CLIENT_PAGE_SIZE = CLIENT_PAGE_SIZE;
