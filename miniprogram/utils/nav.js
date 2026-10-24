/**
 * 页面跳转统一入口
 * ------------------------------------------------------------------
 * 为什么要有这一层？
 *   wx.navigateTo / wx.navigateBack 失败时默认是**完全静默**的：页面栈超过
 *   10 层、目标页没在 app.json 里注册、路径拼错、已经到首页还想返回……
 *   失败原因只出现在 fail 回调里。不写 fail，界面上就什么都不会发生，
 *   用户看到的表现只是「按钮点了没反应」，而真实原因无从查起。
 *
 *   本项目所有跳转统一走这里，保证两件事：
 *     1. 失败必定进日志，带上目标地址与微信原始信息；
 *     2. 失败必定有可见反馈，并把英文原始信息翻译成能看懂的中文。
 *
 *   注意：不要图省事绕过这里直接调 wx.navigateTo，否则又回到「点了没反应
 *   但不知道为什么」的状态 —— 这次排查的成本几乎全耗在这上面。
 * ------------------------------------------------------------------
 */

const { truncate } = require('./format');

/** toast 标题能放下的字数有限，超出部分截断 */
const TITLE_MAX = 30;

/**
 * 取出错误信息文本。
 * 微信给的是 { errMsg: 'navigateTo:fail xxx' }，也可能是普通 Error 或字符串。
 *
 * @param {Error|object|string} [err]
 * @returns {string} 取不到时返回空串
 */
function extractMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.errMsg || err.message || '');
}

/**
 * 把微信的错误信息翻译成人话。
 *
 * 抽成不碰 wx 的纯函数，是为了能被 scripts 侧的用例直接覆盖——这层翻译
 * 一旦译错，用户会拿到一条误导性提示，比不给提示更糟。
 *
 * @param {Error|object|string} [err]
 * @returns {string} 可直接展示的提示
 */
function describe(err) {
  const raw = extractMessage(err);
  const lower = String(raw).toLowerCase();
  if (!lower) return '跳转失败，原因未知';

  // tabBar 页只能用 switchTab 打开，navigateTo 一律失败
  if (lower.indexOf('tabbar') >= 0) return '目标页是 tabBar 页，跳转方式不对';

  // 页面栈上限 10 层
  if (lower.indexOf('exceed') >= 0 || lower.indexOf('page stack') >= 0) {
    return '页面栈已满（上限 10 层）';
  }

  // 目标页没注册
  if (lower.indexOf('is not found') >= 0) return '目标页面未在 app.json 注册';

  // 已经在首页还想返回
  if (lower.indexOf('back at first page') >= 0) return '已经是第一个页面，无法返回';

  // 认不出来的原样透出，别把真实原因吞掉
  return truncate(raw, TITLE_MAX);
}

/**
 * 统一的失败反馈：日志留原文，界面给译文。
 *
 * @param {string} tag 动作名，用于日志
 * @param {Error|object|string} err
 * @param {string} [extra] 附加信息（通常是目标地址）
 * @returns {string} 实际展示出去的提示，便于调用方复用
 */
function report(tag, err, extra) {
  const msg = describe(err);
  console.error('[nav] ' + tag + '失败' + (extra ? '：' + extra : ''), err);
  wx.showToast({ title: msg, icon: 'none' });
  return msg;
}

/**
 * 跳转到指定页面（保留当前页，可返回）。
 *
 * @param {string} url 以 / 开头的页面路径，可带 query
 */
function go(url) {
  if (!url) {
    console.error('[nav] 跳转地址为空');
    return;
  }

  wx.navigateTo({
    url: url,
    fail: function (err) {
      report('跳转', err, url);
    },
  });
}

/**
 * 返回上一页。
 *
 * @param {number} [delta] 返回的层数，默认 1
 */
function back(delta) {
  wx.navigateBack({
    delta: delta || 1,
    fail: function (err) {
      report('返回', err, '');
    },
  });
}

module.exports = {
  describe,
  go,
  back,
};
