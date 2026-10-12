/**
 * 提醒判定纯逻辑
 * ------------------------------------------------------------------
 * 为什么单独拆一个文件：
 *   这些函数不依赖 wx-server-sdk，因此可以被 Node 直接 require 做单元测试
 *   （scripts/verify-models.js 会加载它跑档位判定用例）。
 *   如果把它们留在 index.js 里，index.js 顶部 require 了 SDK，
 *   测试环境就加载不了，核心的提醒档位逻辑将永远无法被验证 ——
 *   而这正是最容易写错、出问题又最隐蔽的地方。
 *
 *   与 miniprogram/utils/date.js 的日期逻辑同源，改动需同步。
 * ------------------------------------------------------------------
 */

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 北京时间下的当前时刻。云函数运行于 UTC，故加 8 小时偏移 */
function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

/** 北京时间下的今天，'YYYY-MM-DD' */
function todayInBeijing() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** 北京时间下的小时与分钟 */
function beijingHourMinute() {
  const d = beijingNow();
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** 解析 'YYYY-MM-DD' 为该日 00:00 的 UTC 时间戳（仅用于算天数差） */
function dateOnlyToUTC(dateOnly) {
  const m = String(dateOnly || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 两个日期相差的整天数：to - from */
function diffDays(from, to) {
  const a = dateOnlyToUTC(from);
  const b = dateOnlyToUTC(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}

/** 'HH:mm' -> 分钟数 */
function timeToMinutes(hhmm) {
  const parts = String(hhmm || '').split(':');
  if (parts.length !== 2) return null;
  return Number(parts[0]) * 60 + Number(parts[1]);
}

/** 当前是否处于免扰时段（支持跨零点，如 22:00-08:00） */
function isQuietHour(quietHours, now) {
  const cur0 = now || beijingHourMinute();
  const cur = cur0.hour * 60 + cur0.minute;
  const start = timeToMinutes(quietHours && quietHours.start);
  const end = timeToMinutes(quietHours && quietHours.end);
  if (start === null || end === null) return false;

  if (start <= end) return cur >= start && cur < end;
  // 跨零点
  return cur >= start || cur < end;
}

/**
 * 判断这笔订单本轮该不该推、推哪一档。
 *
 * 档位模型（关键，改之前先读懂）：
 *   档位 advanceDays = [3,1,0] 把「到期前的时间轴」切成若干区间：
 *     剩余 > 3 天         -> 尚未进入提醒期，不推
 *     剩余 ∈ [1, 3] 天    -> 处于「3 天档」区间
 *     剩余 = 0 天         -> 处于「0 天档」（今天到期）
 *   每个区间在**首次进入时**推一条，同一区间内不重复推。
 *
 *   用「区间」而不是「精确等于档位值」判定，是因为后者会漏推：
 *   若写成 advanceDays.indexOf(remainDays) === -1 就返回不推，
 *   那么某档当天若因免扰时段 / 未授权（43101）/ 函数异常而跳过，
 *   次日剩余天数落在两档之间，精确相等匹配不上 → 该档永久漏推。
 *   例：档位 [3,1,0]，剩 3 天当天被免扰跳过，次日剩 2 天，
 *       indexOf(2) === -1 -> 直接跳过，用户永远收不到 3 天档提醒。
 *
 *   lastRemindStage 存的是「已推送到的档位阈值」（即区间的上界），
 *   不是剩余天数。这样判据统一为 targetThreshold < lastRemindStage。
 *   例：已推过 3 档（last=3），剩 2 天时区间上界仍是 3，
 *       3 < 3 不成立 -> 不重复推；剩 1 天时区间上界变 1，
 *       1 < 3 成立 -> 补推「1 天档」。
 *
 * @param {object} order          订单（需 deadline、lastRemindStage）
 * @param {string} today          'YYYY-MM-DD'
 * @param {number[]} advanceDays  提醒档位，如 [3,1,0]
 * @param {object} [options]      { notifyOnOverdue:boolean }
 * @returns {{shouldSend:boolean, stage:number|null, remainDays:number|null, reason:string}}
 *          stage      已推到的「档位阈值」，写入 lastRemindStage 用于幂等
 *          remainDays 真实剩余天数，用于消息文案与日志（不要用 stage 替代）
 */
function decideRemind(order, today, advanceDays, options) {
  const opts = options || {};
  const deadline = order && order.deadline;
  const remainDays = diffDays(today, deadline);

  if (remainDays === null) {
    return { shouldSend: false, stage: null, remainDays: null, reason: 'deadline 非法' };
  }

  // 逾期处理：v1 默认不推，需求只要求"到期前提醒"
  if (remainDays < 0) {
    if (!opts.notifyOnOverdue) {
      return {
        shouldSend: false,
        stage: null,
        remainDays: remainDays,
        reason: '已逾期且未开启逾期提醒',
      };
    }
    return { shouldSend: true, stage: remainDays, remainDays: remainDays, reason: '逾期提醒' };
  }

  // 找出所有「剩余天数 <= 档位值」的档位，取其中最小的作为当前区间上界
  // （档位值越小的越晚，例如 [3,1,0] 里 0 是最晚档）
  const applicable = (advanceDays || []).filter(function (d) {
    return remainDays <= d;
  });

  if (!applicable.length) {
    return {
      shouldSend: false,
      stage: null,
      remainDays: remainDays,
      reason: '未进入任何提醒档位，剩余 ' + remainDays + ' 天',
    };
  }

  const threshold = Math.min.apply(null, applicable);
  const last = order.lastRemindStage;

  // 首次推送：进入任意档位区间即可推
  if (last === null || last === undefined) {
    return {
      shouldSend: true,
      stage: threshold,
      remainDays: remainDays,
      reason: '首次推送（档位 ' + threshold + '，剩余 ' + remainDays + ' 天）',
    };
  }

  // 已推到的档位阈值比当前区间上界还晚 -> 当前区间是新的，补推
  if (threshold < last) {
    return {
      shouldSend: true,
      stage: threshold,
      remainDays: remainDays,
      reason: '进入更晚档位（当前 ' + threshold + '，上次 ' + last + '，剩余 ' + remainDays + ' 天）',
    };
  }

  return {
    shouldSend: false,
    stage: null,
    remainDays: remainDays,
    reason: '该档位已推送过（当前 ' + threshold + '，上次 ' + last + '）',
  };
}

/**
 * 组装订阅消息的 data 字段。
 * key 名必须与在微信公众平台选用的模板字段一致，否则会报 47003。
 */
function buildTemplateData(order, remainDays) {
  const countdown = remainDays === 0 ? '今天到期' : '还剩 ' + remainDays + ' 天';
  return {
    thing1: { value: String(order.productName || '退货订单').slice(0, 20) },
    thing2: { value: String(order.platform || '未填平台').slice(0, 20) },
    time3: { value: String(order.deadline || '') },
    thing4: { value: countdown.slice(0, 20) },
  };
}

module.exports = {
  pad2,
  beijingNow,
  todayInBeijing,
  beijingHourMinute,
  dateOnlyToUTC,
  diffDays,
  timeToMinutes,
  isQuietHour,
  decideRemind,
  buildTemplateData,
};
