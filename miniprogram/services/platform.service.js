/**
 * 平台服务
 * ------------------------------------------------------------------
 * 两条数据来源，刻意分开：
 *   1. platforms      系统预置平台库，全局只读，不按用户隔离；
 *   2. userPlatforms  用户自建平台，带 _openid，只有本人可见可改。
 *
 * 为什么不把用户自建平台直接写进 platforms？
 *   因为 platforms 是全局共享的，任何用户的写操作都会影响其他人，
 *   会造成跨用户数据串扰。这是 v1.1 架构评审中修正的一个隐患。
 * ------------------------------------------------------------------
 */

const { getAdapter } = require('./adapters/index');
const { COLLECTIONS } = require('../config/env');
const { PRESET_PLATFORMS } = require('../constants/index');
const { getUid } = require('./order.service');

/** 预置平台（本地常量，无需请求数据库） */
function listPreset() {
  return PRESET_PLATFORMS.slice();
}

/** 用户自建平台 */
function listCustom() {
  return getAdapter()
    .listAll(COLLECTIONS.USER_PLATFORMS, { orderBy: ['createdAt', 'asc'] })
    .catch(function (err) {
      console.warn('[platform] 读取自建平台失败，按空处理', err && err.message);
      return [];
    });
}

/**
 * 录入时可选的完整平台清单：预置 + 自建，并按名称去重
 * （用户可能自建了一个与预置同名的平台）。
 */
function listForPicker() {
  return listCustom().then(function (custom) {
    const seen = {};
    const merged = [];

    PRESET_PLATFORMS.forEach(function (p) {
      seen[p.name] = true;
      merged.push(Object.assign({}, p, { isCustom: false }));
    });

    custom.forEach(function (p) {
      if (seen[p.name]) return;
      seen[p.name] = true;
      merged.push({
        _id: p._id,
        name: p.name,
        defaultReturnDays: p.defaultReturnDays || 7,
        color: p.color || '#6b665e',
        isCustom: true,
      });
    });

    return merged;
  });
}

/** 新增自建平台 */
function addCustom(name, color) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    return Promise.reject(new Error('平台名称不能为空'));
  }

  return getUid().then(function (uid) {
    const now = new Date();
    return getAdapter()
      .add(COLLECTIONS.USER_PLATFORMS, {
        uid: uid,
        name: trimmed,
        defaultReturnDays: 7,
        color: color || '#6b665e',
        createdAt: now,
        updatedAt: now,
      })
      .then(function (res) {
        return { _id: res._id, name: trimmed };
      });
  });
}

/** 删除自建平台（预置平台不可删） */
function removeCustom(id) {
  return getAdapter().remove(COLLECTIONS.USER_PLATFORMS, id);
}

module.exports = {
  listPreset,
  listCustom,
  listForPicker,
  addCustom,
  removeCustom,
};
