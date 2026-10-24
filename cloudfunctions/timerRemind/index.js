/**
 * 定时提醒云函数
 * ------------------------------------------------------------------
 * 职责：每天定时扫描待退货单，命中用户设置的提醒档位时下发订阅消息。
 * 由 config.json 里的 timer 触发器驱动（需在开发者工具中上传触发器才会生效）。
 *
 * ⚠️ 两个必须注意的坑：
 *
 * 1【时区】腾讯云函数运行时是 UTC，不是北京时间。
 *   直接 new Date().getDate() 会在北京时间 08:00 拿到「前一天」。
 *   本文件所有"今天"一律用 remind.todayInBeijing() 计算。
 *
 * 2【幂等】定时任务可能重跑（手动触发、失败重试）。若不记录已发档位，
 *   同一档位会重复推送。用 orders.lastRemindStage 记录已推的剩余天数，
 *   发送前先比对再更新，保证同档位只发一次。
 *
 * 纯逻辑（日期工具、档位判定、模板组装）已抽到 remind.js：
 * 那里不依赖 SDK，可被 Node 直接加载做单元测试。云函数目录独立打包，
 * 无法 require 小程序目录的文件，故 remind.js 与 miniprogram/utils/date.js
 * 的日期逻辑同源，修改日期规则时两侧必须同步改。
 * ------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');
const remind = require('./remind');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ================================================================ 配置
const CONFIG = {
  /**
   * 订阅消息模板 ID。
   * 留空时函数会正常运行、正常计算，但跳过实际推送并打印提示。
   * 填法：微信公众平台 -> 功能 -> 订阅消息 -> 选用模板，复制模板 ID 填到这里，
   * 或配置为云函数环境变量 REMIND_TEMPLATE_ID（推荐，改配置不用重新部署）。
   */
  TEMPLATE_ID: process.env.REMIND_TEMPLATE_ID || '',

  /** 用户未设置时的默认提醒档位 */
  DEFAULT_ADVANCE_DAYS: [3, 1, 0],

  /** 免扰时段（北京时间）。命中则本轮跳过，等下一次触发 */
  QUIET_HOURS: { start: '22:00', end: '08:00' },

  /** 云函数单次查询上限 100 条，翻页步长 */
  PAGE_SIZE: 100,
  MAX_PAGES: 20,

  /** 点击提醒消息跳转的页面 */
  LANDING_PAGE: 'pages/index/index',

  /** 正式版才推送；开发调试时可改成 'developer' */
  MINIPROGRAM_STATE: 'formal',

  /** 逾期是否也推一条。v1 需求只要求到期前提醒，默认关闭 */
  NOTIFY_ON_OVERDUE: false,
};

// ================================================================ 数据读取

/** 分页取全部待退货单（云函数端单次上限 100 条） */
async function fetchPendingOrders() {
  const all = [];

  for (let page = 0; page < CONFIG.MAX_PAGES; page++) {
    const res = await db
      .collection('orders')
      .where({ status: 'pending' })
      .orderBy('deadline', 'asc')
      .skip(page * CONFIG.PAGE_SIZE)
      .limit(CONFIG.PAGE_SIZE)
      .get();

    const rows = res.data || [];
    if (!rows.length) break;

    for (let i = 0; i < rows.length; i++) all.push(rows[i]);

    if (rows.length < CONFIG.PAGE_SIZE) break;
  }

  return all;
}

/** 批量取用户设置，返回 { openid: settings } */
async function fetchSettingsFor(openids) {
  const map = {};

  // 去重后分批查（云函数 in 查询有条件数量上限，分成小批更稳）
  const unique = Array.from(new Set(openids.filter(Boolean)));
  const BATCH = 20;

  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const res = await db
      .collection('settings')
      .where({ _openid: _.in(slice) })
      .limit(100)
      .get();

    (res.data || []).forEach(function (doc) {
      map[doc._openid] = doc;
    });
  }

  return map;
}

// ================================================================ 推送

/** 下发一条订阅消息 */
async function sendSubscribeMessage(openid, order, remainDays) {
  return cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId: CONFIG.TEMPLATE_ID,
    page: CONFIG.LANDING_PAGE,
    miniprogramState: CONFIG.MINIPROGRAM_STATE,
    lang: 'zh_CN',
    data: remind.buildTemplateData(order, remainDays),
  });
}

// ================================================================ 主流程

exports.main = async () => {
  const startedAt = Date.now();
  const today = remind.todayInBeijing();

  const summary = {
    today: today,
    triggeredAt: new Date().toISOString(),
    skippedQuiet: 0,
    scannedOrders: 0,
    candidateOrders: 0,
    sent: 0,
    skippedNoAuth: 0,
    failed: 0,
    templateConfigured: !!CONFIG.TEMPLATE_ID,
    details: [],
  };

  let orders = [];
  try {
    orders = await fetchPendingOrders();
  } catch (err) {
    console.error('[timerRemind] 读取订单失败', err);
    summary.error = '读取订单失败：' + ((err && err.message) || '');
    return summary;
  }

  summary.scannedOrders = orders.length;

  if (!orders.length) {
    console.log('[timerRemind] 没有待退货单，结束');
    return summary;
  }

  // 预取这些用户的设置，避免逐条查库
  const settingsMap = await fetchSettingsFor(orders.map((o) => o._openid)).catch(function (err) {
    console.warn('[timerRemind] 读取设置失败，全部按默认档位处理', err && err.message);
    return {};
  });

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const setting = settingsMap[order._openid] || {};

    // F-8：按用户自己的免打扰时段判断；未设置时退回全局默认
    const quietHours = setting.quietHours || CONFIG.QUIET_HOURS;
    if (remind.isQuietHour(quietHours)) {
      summary.skippedQuiet += 1;
      continue;
    }

    const advanceDays =
      Array.isArray(setting.remindAdvanceDays) && setting.remindAdvanceDays.length
        ? setting.remindAdvanceDays
        : CONFIG.DEFAULT_ADVANCE_DAYS;

    const decision = remind.decideRemind(order, today, advanceDays, {
      notifyOnOverdue: CONFIG.NOTIFY_ON_OVERDUE,
    });

    if (!decision.shouldSend) continue;

    summary.candidateOrders += 1;

    // 模板未配置时不实际发送，但把判定结果打出来，
    // 方便在没有模板的情况下验证扫描与档位计算是否正确。
    if (!CONFIG.TEMPLATE_ID) {
      summary.details.push({
        orderId: order._id,
        stage: decision.stage,
        remainDays: decision.remainDays,
        reason: decision.reason,
        result: 'skipped_no_template',
      });
      continue;
    }

    try {
      await sendSubscribeMessage(order._openid, order, decision.remainDays);

      // 推送成功后立刻记录档位，保证幂等。
      // 顺序很重要：先发后写。若写失败只是可能重复推送一次，
      // 而先写后发若发送失败则会永久漏推。
      await db
        .collection('orders')
        .doc(order._id)
        .update({
          data: {
            lastRemindStage: decision.stage,
            lastRemindAt: new Date(),
            updatedAt: new Date(),
          },
        });

      summary.sent += 1;
      summary.details.push({
        orderId: order._id,
        stage: decision.stage,
        remainDays: decision.remainDays,
        reason: decision.reason,
        result: 'sent',
      });
    } catch (err) {
      const code = (err && (err.errCode || err.code)) || '';
      // 43101：用户未授权 / 订阅额度已用完。这属于正常情况，不是故障。
      if (code === 43101) {
        summary.skippedNoAuth += 1;
        summary.details.push({
          orderId: order._id,
          stage: decision.stage,
          remainDays: decision.remainDays,
          result: 'skipped_no_subscription',
        });
      } else {
        summary.failed += 1;
        console.error('[timerRemind] 推送失败 order=' + order._id, err);
        summary.details.push({
          orderId: order._id,
          stage: decision.stage,
          remainDays: decision.remainDays,
          result: 'failed',
          error: (err && err.message) || String(code),
        });
      }
    }
  }

  summary.elapsedMs = Date.now() - startedAt;
  console.log('[timerRemind] 执行完成', JSON.stringify(summary));
  return summary;
};
