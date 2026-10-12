/**
 * 业务 API 云函数
 * ------------------------------------------------------------------
 * 用 action 路由的方式把多个动作收在一个函数里，而不是为每个动作建一个云函数。
 * 原因：
 *   1. 减少冷启动次数（小程序云函数冷启动是体验大头）；
 *   2. 部署只需一次，维护成本低。
 * 内部按 handler 分文件组织，保持可读性（后续动作多了按需再拆）。
 *
 * 当前动作：
 *   whoami  —— 返回调用者的 openid 与 uid。
 *              小程序端拿不到自己的 openid，必须经云函数获取。
 *              v1 里 uid === openid；v2 接独立 App 时 uid 改为自建用户 ID，
 *              这里换成查 users 集合即可，前端不用改。
 *
 * 安全约定（重要）：
 *   任何动作都不能相信前端传来的 uid / openid。
 *   用户身份一律取 cloud.getWXContext()，这是微信在服务端注入的，无法伪造。
 * ------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const handlers = {
  /**
   * 获取当前调用者身份。
   */
  async whoami(event, context) {
    const wxContext = cloud.getWXContext();

    return {
      ok: true,
      data: {
        openid: wxContext.OPENID || '',
        // v1：uid 与 openid 同值，业务层统一用 uid，
        // 将来换账号体系时只改这一行，业务代码不用动。
        uid: wxContext.OPENID || '',
        appid: wxContext.APPID || '',
        unionid: wxContext.UNIONID || '',
      },
    };
  },

  /**
   * 健康检查。用于确认云函数已正确部署、环境变量可达。
   */
  async health() {
    return {
      ok: true,
      data: {
        service: 'tuihuo-api',
        version: '1.0.0',
        serverTime: new Date().toISOString(),
      },
    };
  },
};

exports.main = async (event, context) => {
  const action = (event && event.action) || '';

  if (!action) {
    return { ok: false, code: 'NO_ACTION', message: '缺少 action 参数' };
  }

  const handler = handlers[action];
  if (!handler) {
    return { ok: false, code: 'UNKNOWN_ACTION', message: '未知动作：' + action };
  }

  try {
    return await handler(event, context);
  } catch (err) {
    console.error('[api] action=' + action + ' 执行失败', err);
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: (err && err.message) || '服务异常',
    };
  }
};
