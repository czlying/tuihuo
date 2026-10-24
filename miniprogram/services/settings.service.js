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
 * 读取设置。没有记录时返回默认值（不自动写库，
 * 等用户真的改了设置再落库，避免空写入）。
 *
 * 查询按 updatedAt 倒序取第一条：设计上每用户只有一条记录，
 * 但并发保存（快速连点）理论上可能产生多条，
 * 无排序时 rows[0] 是哪条不确定，会让用户读到旧设置。
 */
function get() {
  return getAdapter()
    .list(COLLECTIONS.SETTINGS, { orderBy: ['updatedAt', 'desc'], limit: 1 })
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

  return adapter
    .list(COLLECTIONS.SETTINGS, { orderBy: ['updatedAt', 'desc'], limit: 1 })
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
