/**
 * 运势服务
 * ------------------------------------------------------------------
 * 数据来源由下方 FORTUNE_SOURCE 开关决定：
 *   'remote' —— 经云函数代理取聚合数据星座运势（当前）
 *   'local'  —— 读本地文本（miniprogram/utils/fortune-local.js），已停用但实现保留
 *
 * 两种来源对调用方完全一致：成功 resolve 一句文案，失败 reject，
 * 由页面走它自己的兜底（页面优先用本地文本，缺了再用静态文案池）。
 *
 * 本地文本缺数据时**不回退网站**：直接 reject，页面保留兜底文案。
 * 远端实现的 Key 只存在于云函数环境变量 JUHE_KEY，前端不接触任何密钥。
 * ------------------------------------------------------------------
 */

const { getAdapter } = require('./adapters/index');
const localFortune = require('../utils/fortune-local');
const dateUtil = require('../utils/date');

/**
 * 数据来源开关：
 *   'local'  读本地文本（已停用，保留实现随时可切回）
 *   'remote' 走云函数查聚合数据（当前）
 */
const FORTUNE_SOURCE = 'remote';

/** 前端兜底超时（毫秒）：云函数侧另有更短的请求超时，双保险 */
const REQUEST_TIMEOUT = 6000;

/**
 * 自检超时（毫秒）。
 * 自检要真发一次上游请求（云函数侧 5s），比普通取文案慢，给足余量，
 * 否则会在云函数还没返回时就被前端掐断，看起来像「接口没反应」。
 */
const PROBE_TIMEOUT = 12000;

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
 * 本地实现：读 miniprogram/utils/fortune-local.js。
 *
 * 缺数据时**不回退网站**，直接 reject，由页面保留它自己的兜底文案。
 * 返回契约与远端实现保持一致（Promise<string>），调用方无需区分来源。
 *
 * @returns {Promise<string>}
 */
function getTodayFromLocal() {
  const date = dateUtil.today();
  const text = localFortune.getFortuneText(date, localFortune.SIGN);

  if (!text) {
    return Promise.reject(new Error('本地运势文本缺失：' + date));
  }
  return Promise.resolve(text);
}

/**
 * 取今日运势文案（远端实现：经云函数查聚合数据）。
 *
 * 按需求保留，函数体与原先完全一致，未做任何改动。
 * 是否对外生效由文件末尾的 FORTUNE_SOURCE 开关决定。
 *
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
 * 运势接口自检（设置页「测试运势接口」用）。
 *
 * 云端 horoscopeProbe 会把「Key 是否读到 / 是否带空格 / HTTP 状态 /
 * 聚合数据错误码 / 耗时」摊开返回，并附一句中文结论 conclusion。
 * 这里只负责调用与超时，不解读内容——解读逻辑在云端一处维护。
 *
 * @returns {Promise<object>} 诊断对象；调用失败时 reject
 */
function probe() {
  const request = getAdapter()
    .callFunction('api', { action: 'horoscopeProbe' })
    .then(function (res) {
      if (!res || !res.ok) {
        throw new Error((res && res.message) || '自检动作未返回结果');
      }
      return res.data || {};
    });

  return withTimeout(request, PROBE_TIMEOUT, '自检请求超时');
}

module.exports = {
  REQUEST_TIMEOUT,
  PROBE_TIMEOUT,
  FORTUNE_SOURCE,
  // 开关只在这一行决定对外暴露哪个实现，两个实现本身都不动。
  // 想切回本地文本：把上面 FORTUNE_SOURCE 改成 'local' 即可，其余无需改动。
  getToday: FORTUNE_SOURCE === 'local' ? getTodayFromLocal : getToday,
  // 两个实现都单独导出，便于测试与按需调用
  getTodayFromLocal,
  getTodayFromRemote: getToday,
  probe,
};
