/**
 * 当天到期提醒服务（方案 B：现授权现推）
 * ------------------------------------------------------------------
 * 首页「今日到期提醒」按钮在用户点击的同步调用栈里先请求微信授权，
 * 授权成功回调里再调本服务，由 timerRemind 云函数向微信「服务通知」
 * 下发一条消息。前端不直接调 wx.cloud，也不信任前端传来的身份。
 *
 * 服务层把云端结果统一成 { ok, result, message }，页面只管提示文案。
 * ------------------------------------------------------------------
 */

const { getAdapter } = require('./adapters/index');

/** 云端现推要发一次微信 API，超时给足余量，避免按钮一直转圈 */
const REQUEST_TIMEOUT = 10000;

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error(message));
    }, ms);
  });
  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  return Promise.race([promise, timeout]).then(
    function (value) {
      clear();
      return value;
    },
    function (err) {
      clear();
      throw err;
    }
  );
}

/**
 * 云端结果 -> 用户可看懂的提示。
 * result 原样保留，方便排查；message 只给页面 showToast 用。
 */
function normalize(res) {
  if (!res) {
    return { ok: false, result: 'empty', message: '提醒服务没有返回结果' };
  }

  const result = String(res.result || '');
  if (result === 'sent') {
    return { ok: true, result: result, message: res.message || '已推送到微信服务通知' };
  }
  if (result === 'skipped_no_subscription') {
    return { ok: false, result: result, message: '未授权或额度已用完，请在微信提示中允许接收' };
  }
  if (result === 'skipped_already_pushed_or_not_due') {
    return { ok: false, result: result, message: '这笔今天已推过，或已不是今天到期' };
  }
  if (result === 'skipped_no_template') {
    return { ok: false, result: result, message: '提醒模板未配置' };
  }
  if (result === 'failed') {
    return { ok: false, result: result, message: res.message || '推送失败，请重试' };
  }
  return { ok: false, result: result || 'unknown', message: res.message || '推送失败，请重试' };
}

/**
 * 请求把某笔当天到期的订单推送到微信。
 * @param {string} orderId 订单 _id
 * @returns {Promise<{ok:boolean, result:string, message:string}>}
 */
function sendDueNow(orderId) {
  const id = String(orderId || '');
  if (!id) {
    return Promise.resolve({ ok: false, result: 'invalid', message: '缺少订单 ID' });
  }

  const request = getAdapter()
    .callFunction('timerRemind', { action: 'sendDue', orderId: id })
    .then(normalize);

  return withTimeout(request, REQUEST_TIMEOUT, '提醒请求超时');
}

module.exports = {
  REQUEST_TIMEOUT,
  sendDueNow,
};
