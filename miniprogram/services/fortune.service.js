/**
 * 运势服务
 * ------------------------------------------------------------------
 * 经云函数代理取聚合数据星座运势：Key 只存在于云函数环境变量
 * （JUHE_KEY），前端（含本文件）不接触任何密钥。
 *
 * 失败/超时一律 reject，由页面走静态兜底文案（同日缓存由页面按
 * 日期判定，本层不管）。
 * ------------------------------------------------------------------
 */

const { getAdapter } = require('./adapters/index');

/** 前端兜底超时（毫秒）：云函数侧另有更短的请求超时，双保险 */
const REQUEST_TIMEOUT = 6000;

/**
 * 给 Promise 套一层超时：超过 ms 仍未结束就 reject，避免页面一直转圈。
 * 无论成败都会清掉定时器，不留下悬挂的 setTimeout。
 */
function withTimeout(promise, ms, message) {
  let timer = null;

  const timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error(message || '请求超时'));
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
 * 取今日运势文案。
 * @returns {Promise<string>} 成功返回一句文案；失败/超时 reject
 */
function getToday() {
  const request = getAdapter()
    .callFunction('api', { action: 'horoscope' })
    .then(function (res) {
      const text = res && res.ok && res.data ? res.data.text : '';
      if (!text) {
        throw new Error((res && res.message) || '运势接口未返回文案');
      }
      return text;
    });

  return withTimeout(request, REQUEST_TIMEOUT, '运势请求超时');
}

/**
 * 运势接口自检：把云端诊断结果原样交回页面展示。
 * 不做兜底、不吞错——自检的价值就在于把失败原因露出来。
 * @returns {Promise<object>} 云函数返回的 { ok, data?, code?, message? }
 */
function probe() {
  const request = getAdapter().callFunction('api', { action: 'horoscopeProbe' });
  return withTimeout(request, REQUEST_TIMEOUT, '自检请求超时');
}

module.exports = {
  REQUEST_TIMEOUT,
  getToday,
  probe,
};
