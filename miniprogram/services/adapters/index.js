/**
 * 适配器注册表
 * ------------------------------------------------------------------
 * 业务层只通过这里拿当前适配器，不直接 require 具体实现。
 *
 * 跨端时怎么改：
 *   1. 新增 adapters/httpapi.js，实现 wxcloud.js 顶部注释里的同一套契约；
 *   2. 在下面 getAdapter() 里加一个分支；
 *   3. 业务代码（order.service.js 等）一行都不用动。
 * ------------------------------------------------------------------
 */

const wxcloud = require('./wxcloud');

/** 当前启用的适配器名。跨端时改这一行即可切换 */
const ACTIVE = 'wxcloud';

const registry = {
  wxcloud: wxcloud,
  // httpapi: require('./httpapi'),  // v2 独立 App 时启用
};

let cached = null;

function getAdapter() {
  if (cached) return cached;

  const adapter = registry[ACTIVE];
  if (!adapter) {
    throw new Error('未找到适配器：' + ACTIVE);
  }

  if (!adapter.available()) {
    const err = new Error('当前环境不支持云开发，请确认已开通云开发并升级微信版本');
    err.action = 'adapter.available';
    throw err;
  }

  cached = adapter;
  return cached;
}

/** 适配器是否为可用状态（不抛错，供页面做友好提示） */
function isAvailable() {
  try {
    getAdapter();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getAdapter,
  isAvailable,
  ACTIVE,
};
