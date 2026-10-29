/**
 * 本地运势文本（开发者维护）
 * ==================================================================
 * 这里是「今日运势」卡片唯一的文案来源。改这个文件、重新编译即可生效，
 * 不用重传云函数、不用碰接口。
 *
 * 为什么是 .js 而不是 .txt：小程序端没有 Node 的 fs，代码包里的裸文本
 * 要经 FileSystemManager 读取，还受基础库与编码差异影响；用 .js 模块
 * require 直接拿到字符串数组，零兼容风险，维护体验与文本文件一致。
 *
 * 取值优先级（高 → 低）：
 *   1. BY_DATE[日期]        —— 指定某一天用哪句，精确控制
 *   2. BY_SIGN[星座][n]     —— 按星座的文案池，按日期哈希选一条
 *   3. COMMON[n]           —— 不分星座的公共池，按日期哈希选一条
 *   4. 都没有 → 返回空串    —— 页面保留它自己的兜底文案，**不会回退网站**
 *
 * 维护提醒：同一天内改了文案，卡片不会立刻变（当日缓存已命中），
 * 需要清掉小程序缓存或等第二天。缓存逻辑在 utils/fortune-cache.js，本轮不动。
 * ==================================================================
 */

/** 当前小程序展示的星座（与 index.wxml 的「今日双鱼运势」保持一致） */
const SIGN = '双鱼座';

/**
 * 按日期精确指定。键为 'YYYY-MM-DD'，值为整句文案。
 * 例：'2026-11-01': '新月加持，适合把拖着的退货一次处理完。',
 */
const BY_DATE = {};

/**
 * 按星座的文案池。同一天固定取池中同一条（按日期哈希），保证当天不跳变。
 * 想临时置顶某句，把它挪到数组第一位不影响（哈希按日期算，不按顺序）。
 */
const BY_SIGN = {
  双鱼座: [
    '宝儿拼多多截图识别妥了，可以试试昂，今天也是爱你的一天，那天的事情是我没考虑好，对不起的昂，么么哒',
  ],
};

/**
 * 公共池：BY_SIGN 里没有对应星座时用这个。
 * 想让所有星座都说同一句话，把文案写这里、把 BY_SIGN 留空即可。
 */
const COMMON = [];

/** 字符串 → 非负整数哈希，用于「同一天稳定、跨天变化」的取句 */
function hashOf(text) {
  const str = String(text || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 从文案池里按种子取一条；池空或非法返回空串 */
function pickFrom(list, seed) {
  if (!Array.isArray(list) || !list.length) return '';

  const usable = list.filter(function (item) {
    return typeof item === 'string' && item.trim();
  });
  if (!usable.length) return '';

  return usable[hashOf(seed) % usable.length];
}

/**
 * 取某天某星座的运势文案。
 *
 * @param {string} dateOnly  'YYYY-MM-DD'
 * @param {string} [sign]    星座名，缺省用 SIGN
 * @returns {string} 命中返回文案；全部缺失返回空串（不回退任何接口）
 */
function getFortuneText(dateOnly, sign) {
  const date = String(dateOnly || '');
  if (!date) return '';

  // 1. 指定日期最优先
  if (BY_DATE && typeof BY_DATE[date] === 'string' && BY_DATE[date].trim()) {
    return BY_DATE[date].trim();
  }

  const wanted = String(sign || SIGN);

  // 2. 该星座的文案池（种子带上星座，避免两个星座同一天拿到同一句）
  const bySign = pickFrom(BY_SIGN && BY_SIGN[wanted], date + '|' + wanted);
  if (bySign) return bySign;

  // 3. 公共池
  const byCommon = pickFrom(COMMON, date);
  if (byCommon) return byCommon;

  // 4. 什么都没有
  return '';
}

module.exports = {
  SIGN,
  BY_DATE,
  BY_SIGN,
  COMMON,
  hashOf,
  pickFrom,
  getFortuneText,
};
