/**
 * 运势当日缓存（落盘）
 * ------------------------------------------------------------------
 * 页面实例属性 `_fortuneDate` 只在本次运行内有效：小程序冷启动后
 * 实例重建，缓存就没了，于是每次打开都会再请求一次接口。
 *
 * 这里把「今天已经取到过的真实文案」写进本地存储，跨冷启动复用：
 *   - 只缓存「接口成功取到的文案」，兜底文案一律不写；
 *     否则某次失败后，当天就再也不会重试，看起来像配置没生效。
 *   - 跨天自动失效（按 'YYYY-MM-DD' 字符串比较）。
 * ------------------------------------------------------------------
 */

const STORAGE_KEY = 'fortune_cache_v1';

/**
 * 缓存是否还能用：同一天且文案非空。
 * @param {{date?:string, text?:string}|null} cache
 * @param {string} today 'YYYY-MM-DD'
 */
function isFresh(cache, today) {
  if (!cache || typeof cache !== 'object') return false;
  if (!today) return false;
  if (cache.date !== today) return false;
  return typeof cache.text === 'string' && cache.text.length > 0;
}

/** 组装一条待写入的缓存记录 */
function make(text, today) {
  return { date: String(today || ''), text: String(text || '') };
}

/** 读缓存；存储异常时当作没有缓存，不影响运势展示 */
function read() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    return value && typeof value === 'object' ? value : null;
  } catch (err) {
    return null;
  }
}

/** 写缓存；存储写失败只是下次多请求一次，不抛错 */
function write(cache) {
  try {
    wx.setStorageSync(STORAGE_KEY, cache);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  STORAGE_KEY,
  isFresh,
  make,
  read,
  write,
};
