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

/**
 * 缓存键版本号。
 *
 * 改了数据来源（local ↔ remote）或改了 utils/fortune-local.js 的文案、
 * 又想在当天立刻看到效果时，把这里 +1（v5 → v6）即可让旧缓存失效，
 * 不必清整个数据缓存（清数据缓存会连自定义背景图 pageBgPath 一起清掉）。
 * 不改也没关系：第二天日期变了，缓存自然失效。
 */
const STORAGE_KEY = 'fortune_cache_v5';

/**
 * 缓存只能存「远端取到的文案」。
 *
 * 2026-11-10 实测踩到的坑：数据源切回远端之前的那次运行里，页面用的是本地文案，
 * 但它同样走了「成功回调」被写进缓存；之后即使代码换成远端、自检也显示接口正常，
 * 首页读到的仍是那条本地文案 —— 同日命中就直接 return，请求根本发不出去。
 * 所以缓存必须记来源，且只认远端；没有 source 的历史记录一律视为失效。
 */
const SOURCE_REMOTE = 'remote';

/**
 * 缓存是否还能用：同一天、文案非空、且来源是远端。
 * @param {{date?:string, text?:string, source?:string}|null} cache
 * @param {string} today 'YYYY-MM-DD'
 */
function isFresh(cache, today) {
  if (!cache || typeof cache !== 'object') return false;
  if (!today) return false;
  if (cache.date !== today) return false;
  // 没有 source 或 source 不是远端：视为旧版本留下的本地文案，丢掉重取
  if (cache.source !== SOURCE_REMOTE) return false;
  return typeof cache.text === 'string' && cache.text.length > 0;
}

/** 组装一条待写入的缓存记录 */
function make(text, today, source) {
  return {
    date: String(today || ''),
    text: String(text || ''),
    source: String(source || SOURCE_REMOTE),
  };
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
  SOURCE_REMOTE,
  isFresh,
  make,
  read,
  write,
};
