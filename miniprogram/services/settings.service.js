/**
 * 用户设置服务
 * 每用户一条记录，存在 settings 集合。
 */

const { getAdapter } = require('./adapters/index');
const { COLLECTIONS } = require('../config/env');
const settingsModel = require('../models/settings');
const { getUid } = require('./order.service');

/** 默认设置，字段缺失时用它兜底（统一由 models/settings 提供，避免两处默认值漂移） */
function defaultSettings() {
  const d = settingsModel.DEFAULT_SETTINGS;
  return {
    defaultReturnDays: d.defaultReturnDays,
    remindAdvanceDays: d.remindAdvanceDays.slice(),
    quietHours: { start: d.quietHours.start, end: d.quietHours.end },
    subscribeFlag: d.subscribeFlag,
  };
}

/**
 * 查询条件里的用户范围。
 *
 * uid 拿得到 → 显式带 `{ uid }`，即使集合安全规则被放宽成「所有用户可读」，
 * 也不会读到别人的设置。
 * uid 拿不到（whoami 失败/超时）→ 返回 null，沿用原行为、靠集合的
 * 「仅创建者可读写」规则隔离。这样不会因为一次网络抖动就把用户设置
 * 读成默认值，观感上像「设置被清空」。
 *
 * @returns {Promise<object|null>}
 */
function scopedWhere() {
  return getUid()
    .then(function (uid) {
      return uid ? { uid: uid } : null;
    })
    .catch(function () {
      return null;
    });
}

/** 取当前用户的设置记录（设计上每用户一条） */
function firstRecord() {
  return scopedWhere().then(function (where) {
    const query = { orderBy: ['updatedAt', 'desc'], limit: 1 };
    if (where) query.where = where;
    return getAdapter().list(COLLECTIONS.SETTINGS, query);
  });
}

/**
 * 读取设置。没有记录时返回默认值（不自动写库，
 * 等用户真的改了设置再落库，避免空写入）。
 *
 * 查询按 updatedAt 倒序取第一条：设计上每用户只有一条记录，
 * 但并发保存（快速连点）理论上可能产生多条，
 * 无排序时 rows[0] 是哪条不确定，会让用户读到旧设置。
 */
function get() {
  return firstRecord()
    .then(function (rows) {
      if (!rows || !rows.length) return defaultSettings();
      return Object.assign(defaultSettings(), rows[0]);
    })
    .catch(function (err) {
      // 集合还没建时不要阻塞页面，用默认值继续
      console.warn('[settings] 读取失败，使用默认设置', err && err.message);
      return defaultSettings();
    });
}

/** 保存设置（有则更新，无则创建） */
function save(patch) {
  const adapter = getAdapter();

  return firstRecord()
    .then(function (rows) {
    const now = new Date();

    if (rows && rows.length) {
      return adapter
        .update(COLLECTIONS.SETTINGS, rows[0]._id, Object.assign({}, patch, { updatedAt: now }))
        .then(function () {
          return Object.assign(defaultSettings(), rows[0], patch);
        });
    }

    return getUid().then(function (uid) {
      const doc = Object.assign(defaultSettings(), patch, {
        uid: uid,
        createdAt: now,
        updatedAt: now,
      });
      return adapter.add(COLLECTIONS.SETTINGS, doc).then(function (res) {
        return Object.assign({ _id: res._id }, doc);
      });
    });
  });
}

module.exports = {
  get,
  save,
  defaultSettings,
};
