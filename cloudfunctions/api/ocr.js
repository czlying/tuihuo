/**
 * OCR 订单识别 —— 纯逻辑层
 * ------------------------------------------------------------------
 * 这里只放「不依赖云函数运行时」的纯函数：把 OCR 返回的原始文本，
 * 抽成可回填表单的结构化字段（商品名 / 金额 / 日期 / 平台）。
 *
 * 为什么要单独拆文件：
 *   云函数 index.js 顶部 require 了 wx-server-sdk 与腾讯云 SDK，
 *   Node 测试环境加载不了，逻辑留在里面就永远无法被验证。
 *   拆出来后可以用 node scripts/verify-models.js 直接测（见测试脚本）。
 *
 * 设计原则（与需求决策 1 一致）：
 *   OCR 识别结果只是「建议值」，最终由用户核对补全再保存。
 *   所以这里的抽取规则尽量保守——宁可漏抽，也不要抽错给用户错误引导。
 * ------------------------------------------------------------------
 */

/** OCR 规则版本：部署后可在返回里确认云端是否已更新 */
const OCR_RULE_VERSION = '2026-10-28.4';

/** 商品名最大长度（与录入页商品名输入框 maxlength 保持一致） */
const MAX_PRODUCT_NAME_LENGTH = 60;

/** 常见平台的名称清单，用于从文本里嗅探平台 */
const PLATFORM_KEYWORDS = [
  '天猫',
  '淘宝',
  '京东',
  '拼多多',
  '抖音电商',
  '抖音',
  '快手小店',
  '快手',
  '唯品会',
  '苏宁易购',
  '苏宁',
  '美团',
  '饿了么',
  '小红书',
];

/**
 * 从 OCR 原始文本里抽取结构化字段。
 *
 * @param {string} text OCR 返回的原始文本（可能含换行）
 * @returns {{productName:string, amount:number|null, date:string, platform:string}}
 *   amount 单位为「分」；date 为 'YYYY-MM-DD' 或 ''；抽不到则为空。
 */
function extractOrder(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);

  return {
    productName: extractProductName(lines),
    amount: extractAmount(raw),
    date: extractDate(raw),
    platform: extractPlatform(raw),
    returnNo: extractReturnNo(raw),
    returnReason: extractReturnReason(raw),
    pickupCode: extractPickupCode(raw),
  };
}

/** 去掉行尾价格（如「商品名 ¥105 x1」） */
function stripTrailingPrice(line) {
  return String(line || '')
    .replace(/\s*[¥￥]\s*\d+(?:\.\d{1,2})?(?:\s*[x×]\s*\d+)?\s*$/, '')
    .trim();
}

/** 商品名清洗：去掉行尾价格与下拉箭头 */
function cleanProductName(line) {
  return stripTrailingPrice(line)
    .replace(/\s*[∨⌄˅∧⌃]\s*$/, '')
    .trim();
}

/** 商品标题的续行：中文、无价格/字段/状态；allowBracket=true 时允许规格括号 */
function isProductContinuation(line, allowBracket) {
  const s = cleanProductName(line);
  if (s.length < 4 || s.length > 40) return false;
  if (!/[\u4e00-\u9fa5]/.test(s)) return false;
  if (!allowBracket && /[【】\[\]（）()]/.test(s)) return false; // 「美乐蒂【拆盒未拆袋】」是规格，不是标题续行
  if (/[¥￥]\s*\d/.test(s)) return false;
  if (
    /订单|快递|运费|合计|实付|应付|收货|退货|退款|售后|服务单|取件|物流|店铺|客服|优惠|申请时间|下单时间|商品金额|钱款去向|好评率|进店逛逛|去更新|去查看/.test(
      s
    )
  )
    return false;
  if (
    /待收货|待发货|已完成|交易成功|退款成功|处理中|商家处理|审核通过|退款中|已退款|七天无理由|无理由/.test(
      s
    )
  )
    return false;
  return true;
}

/** 抽取商品名：取一条最像商品名的行（含中文、非纯数字、非金额/日期） */
function extractProductName(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = cleanProductName(lines[i]);
    // 排除明显不是商品名的行：纯金额、纯日期、纯数字、太短
    if (line.length < 2) continue;
    if (/^[¥￥]?\s*\d+(\.\d+)?\s*$/.test(line)) continue; // 纯金额
    if (/^\d{4}[-/年]\d{1,2}/.test(line)) continue; // 日期行
    if (/^[0-9\s.]+$/.test(line)) continue; // 纯数字
    if (
      /订单|快递|运费|合计|实付|应付|收货|退货|退款|售后|服务单|进度查询|取件|物流|店铺|客服|优惠|申请时间|下单时间|商品金额|钱款去向/.test(
        line
      )
    )
      continue; // 页面字段/按钮行
    if (
      /待收货|待发货|待付款|已完成|交易成功|交易完成|交易关闭|退款成功|处理中|等待商家|商家处理|审核通过|退款中|已退款|七天无理由|无理由|仅退款|退货退款|撤销|拒绝/.test(
        line
      )
    )
      continue; // 状态 / 售后原因行
    if (/已签收|待签收|派送中|运输中|已发货|待评价|已评价/.test(line)) continue; // 物流状态行
    if (/^\d{1,2}[-/月]\d{1,2}/.test(line)) continue; // 月-日 时间段
    if (/周[一二三四五六日]/.test(line) && /\d{1,2}:\d{2}/.test(line)) continue; // 周X + 时段
    if (/^\d{1,2}:\d{2}/.test(line)) continue; // 纯时间
    // 收件人 / 地址 / 手机号：如「张兰 86-182****8754」「城区 XX小区5号楼2单元303」
    if (/\*{3,}/.test(line)) continue;
    if (/\*{3,}|1[3-9]\d{9}|1[3-9]\d[-*]\d{4}[-*]\d{4}/.test(line)) continue;
    if (/(先生|女士|收货人)/.test(line)) continue;
    if (/(小区|号楼|单元|室|街道|号院|城区|镇|村)/.test(line)) continue;
    // 导航入口（「去更新 >」「去查看 >」等），不是商品
    if (/去更新|去查看|去逛逛|去看看|去评价|去分享|去付款|去认证/.test(line)) continue;
    if (/[>›»]\s*$/.test(line)) continue;
    // 促销/进度/统计/平台导流/商品卡操作行
    if (
      /收集进度|拆盒后可|好评率|进店逛逛|价格明细|优惠解析|店铺优惠|共减|交易快照|共\d+项|来自豆包|豆包App|服务保障|买后必看|操作使用指南|使用指南|分享商品|再买一单|申请售后|联系商家|删除订单|追加评价|查看物流|更多信息|运费险|退换货自动理赔|快件|收件人|已领取|兔喜生活|号码保护|消费提醒|购后小助手|售后详情|承诺达|准时送达|商品快照|发生争议|可作为判断依据/.test(
        line
      )
    )
      continue;
    // 寄回流程的进度节点与寄件服务说明：这些行长得最像商品名（「寄回商品」），
    // 但真实商品名在这种页面里是缩略图，OCR 文本里没有——宁可空着让用户手填
    if (
      /寄回商品|寄件服务|寄件详情|寄件码|官方补贴|预估费用|费用详情|预约成功|已预约|取消预约|修改预约|重新预约|快递员将上门|上门后出示/.test(
        line
      )
    )
      continue;
    // 店铺名（含旗舰店/杂货铺/超市等字样）
    if (
      /(旗舰店|专卖店|专营店|食品店|杂货铺|铺子|商贸|超市|便利店|小店|店铺|官方店)/.test(
        line
      )
    )
      continue;
    if (/会员|积分|成长值|余额|优惠券/.test(line)) continue; // 账户/营销标签
    if (/\+\d+$/.test(line)) continue; // 「系列+1」
    if (/^[\u4e00-\u9fa5]{1,2}\d{1,3}$/.test(line)) continue; // 角标：新1 / 新品2
    if (
      /我的淘宝|已买到的宝贝|抖音商城|快手小店|我的易购|唯品会|苏宁|天猫|淘宝|京东|拼多多|美团|饿了么|小红书/.test(
        line
      )
    )
      continue; // 平台/入口文案
    // 纯编号 / 全大写代号（GG7、NTP、88VIP）不是商品名
    if (/^[A-Za-z0-9_-]{6,40}$/.test(line)) continue;
    if (/^[A-Z0-9][A-Z0-9-]{2,9}$/.test(line)) continue;
    if (/^(复制|查看|详情|联系客服|申请售后|查看物流|再来一单|评价|备注)$/.test(line)) continue; // 按钮
    if (
      /^(查看更多|查看全部|查看详情|联系卖家|联系商家|申请退款|撤销申请|修改申请|再次购买|去评价)$/.test(
        line
      )
    )
      continue; // 按钮（长文案）
    if (/^(商品|商品信息|商品名称|商品详情|宝贝|宝贝名称)$/.test(line)) continue; // 分区标题
    // 店铺名：下一行是「好评率/进店逛逛/88VIP」等店铺元信息
    if (i + 1 < lines.length && /好评率|进店逛逛|88VIP|粉丝|关注/.test(lines[i + 1])) continue;
    // 收件人姓名：下一行是手机号（OCR 可能把姓名与号码拆成两行）
    if (
      i + 1 < lines.length &&
      /\*{3,}|1[3-9]\d{9}|1[3-9]\d[-*]\d{4}[-*]\d{4}/.test(lines[i + 1])
    )
      continue;
    // 跳过「纯平台名」行：整行就是一个平台名（如"淘宝"），不是商品
    if (isPlatformNameOnly(line)) continue;
    // 第一个「像商品」的中文行，作为商品名
    if (/[\u4e00-\u9fa5]/.test(line)) {
      // 标题被 OCR 拆成多行时拼接续行；首行以省略号结尾说明标题被截断，
      // 此时允许续行带规格括号，但「美乐蒂【拆盒未拆袋】」这类变体行不拼。
      const truncated = /[…]$|\.\.\.$/.test(line);
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      const variantLine = /^[\u4e00-\u9fa5]{1,12}【/.test(next);
      if (next && isProductContinuation(next, truncated && !variantLine)) {
        return (line + cleanProductName(next)).slice(0, MAX_PRODUCT_NAME_LENGTH);
      }
      return line.slice(0, MAX_PRODUCT_NAME_LENGTH);
    }
    // 纯英文商品名（如 AirPods Pro 2）：要求含小写字母、足够长，且有空格或数字
    if (
      /[a-z]/.test(line) &&
      /^[A-Za-z][A-Za-z0-9 .+\/-]{5,39}$/.test(line) &&
      (/\s/.test(line) || line.length >= 8)
    ) {
      return line.slice(0, MAX_PRODUCT_NAME_LENGTH);
    }
  }
  return '';
}

/** 判断一行是否「纯粹就是平台名」（整行等于某平台名，无其他字） */
function isPlatformNameOnly(line) {
  const s = line.trim();
  for (let i = 0; i < PLATFORM_KEYWORDS.length; i++) {
    if (s === PLATFORM_KEYWORDS[i]) return true;
  }
  return false;
}

/** 抽取金额：找「¥/￥ + 数字」或「数字 + 元」的模式，返回分 */
function extractAmount(text) {
  const raw = String(text || '');

  // 优先匹配货币符号金额
  const m = raw.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
  if (m) {
    return yuanToFen(m[1]);
  }

  // 其次匹配「XX元」/「XX.XX元」
  const m2 = raw.match(/(\d+(?:\.\d{1,2})?)\s*元/);
  if (m2) {
    return yuanToFen(m2[1]);
  }

  return null;
}

/** 元字符串转分，保留整数 */
function yuanToFen(yuan) {
  const n = Number(yuan);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** 「收货日期」的常见标签：多日期页面上优先取它后面的日期，避免抽到申请时间 */
const RECEIVE_DATE_LABELS = [
  '收货日期',
  '收货时间',
  '签收日期',
  '签收时间',
  '到货日期',
  '到货时间',
];

/** 把单个字符串里的日期归一化为 'YYYY-MM-DD'，取不到返回 '' */
function dateFromString(s) {
  const str = String(s || '');
  const m = str.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return normalizeDate(m[1], m[2], m[3]);
  const m2 = str.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (m2) return normalizeDate(m2[1], m2[2], m2[3]);
  return '';
}

/** 组装并校验日期，非法返回 '' */
function normalizeDate(y, mo, da) {
  const M = Number(mo);
  const D = Number(da);
  if (M < 1 || M > 12 || D < 1 || D > 31) return '';
  return pad(y) + '-' + pad(M) + '-' + pad(D);
}

/**
 * 抽取日期，返回 'YYYY-MM-DD'。
 *
 * 策略（重要）：
 *  1) 优先定位「收货日期 / 签收日期」等标签，取其后（同行或下一行）的日期。
 *     退货页面常同时出现「收货日期」与「申请时间」，若直接取全文第一个日期，
 *     当「收货日期」用「YYYY年M月D日」而「申请时间」用「YYYY-MM-DD」时，
 *     正则会先命中申请时间 → 抽到错误日期 → deadline 计算整体错位。
 *  2) 找不到收货类标签时才兜底：取全文第一个日期。
 */
function extractDate(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);

  // 1) 优先按「收货日期」类标签取
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let hit = false;
    for (let k = 0; k < RECEIVE_DATE_LABELS.length; k++) {
      if (line.indexOf(RECEIVE_DATE_LABELS[k]) > -1) { hit = true; break; }
    }
    if (!hit) continue;

    // 同行可能就带日期（如「收货日期 2026-09-20」）
    let d = dateFromString(line);
    // 标签独占一行时，日期在下一行（如「收货日期\n2026年09月15日」）
    if (!d && i + 1 < lines.length) d = dateFromString(lines[i + 1]);
    if (d) return d;
  }

  // 2) 兜底：全文第一个日期
  return dateFromString(raw);
}

function pad(n) {
  const s = String(n);
  return s.length < 2 ? '0' + s : s;
}

/** 把原始文本切成去空行的行数组 */
function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

/**
 * 从「标签 + 值」的结构里取值。
 * 兼容两种常见排版：
 *   - 同行：「退货原因 尺码不合适」
 *   - 换行：「退货原因」\n「尺码不合适」
 */
function valueAfterLabel(lines, labels) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let k = 0; k < labels.length; k++) {
      const lb = labels[k];
      const idx = line.indexOf(lb);
      if (idx < 0) continue;

      // 同行标签后面的内容
      const same = line.slice(idx + lb.length).replace(/^[：:\s]+/, '').trim();
      if (same) return same;

      // 标签独占一行时，取下一行作为值
      if (i + 1 < lines.length) {
        const next = String(lines[i + 1] || '').trim();
        if (next) return next;
      }
    }
  }
  return '';
}

/**
 * 抽取「退货/退款单号」（平台业务单号，如 VPH20260912ABC88）。
 * 与「取件码」不是一回事：单号是平台内部单据号，取件码是快递揽收凭证。
 */
function extractReturnNo(text) {
  return valueAfterLabel(toLines(text), [
    '退货单号',
    '退款单号',
    '售后单号',
    '服务单号',
    '退货码',
  ]);
}

/** 抽取退货原因（如「尺码不合适」「七天无理由退货」） */
function extractReturnReason(text) {
  return valueAfterLabel(toLines(text), ['退货原因', '退款原因', '退货理由']);
}

/** 抽取取件码（上门取件的取件码/寄件码；没有则为空） */
function extractPickupCode(text) {
  const value = valueAfterLabel(toLines(text), ['取件码', '取件号', '上门取件码', '寄件码']);
  // 标签下面常跟一个「复制」按钮，不能把它当取件码
  return isNoiseLine(value) ? '' : value;
}

// ================================================================ 取件码（按平台分发）
// 取件码必须「标签绑定」——这是最高优先级规则：
//   1) 「取件码」标签下面一行的值——最可靠；
//   2) 标签与值在同一行，如「取件码 123456」——valueAfterLabel 已覆盖；
//   3) 标签存在但值没贴着（被折叠/换行错位）——按行距就近兜底，低于高置信。
// 页面**没有**取件码标签时一律不出码：真实订单详情页只有「订单号」，
// 而 261011-360343170593024 的前 6 位会被正则命中，误填成取件码（用户实测踩过）。

/** 取件码兜底正则：4~6 位纯数字 */
const PICKUP_CODE_RE = /\b\d{4,6}\b/g;

/** 取件码标签关键词，判断「靠近哪个关键词」时用 */
const PICKUP_LABEL_KEYWORDS = ['取件码', '取件号', '上门取件码', '寄件码'];

/** 判断一行里是否出现了取件码标签 */
function hasPickupLabel(line) {
  const s = String(line || '');
  for (let i = 0; i < PICKUP_LABEL_KEYWORDS.length; i++) {
    if (s.indexOf(PICKUP_LABEL_KEYWORDS[i]) > -1) return true;
  }
  return false;
}

/**
 * 标签后面取到的值，是不是「像个取件码」。
 *
 * 规则：4~6 位，**不含连字符**；允许 OCR 常见的字符混淆 O/o/l/I（后续归一化成数字）。
 *   - 标签下面跟一句说明（如「请向快递员出示」）——没有数字，拒绝；
 *   - 标签下面紧跟订单号（如 261011-360343170593024）——含连字符，拒绝；
 * 这两种情况都会被当成取件码，前者给出假的 high，后者直接把订单号填进表单。
 */
function looksLikePickupCode(value) {
  const v = String(value || '').replace(/\s+/g, '');
  return /^[0-9OolI]{4,6}$/.test(v);
}

/**
 * 从一行里取「可作为取件码」的数字：4~6 位，且
 *   - 前后不能紧邻字母数字（不是长串的一部分）
 *   - 前后不能是「连字符 + 数字」（261011-360343170593024 属订单号，整串丢弃）
 *
 * @param {string} line
 * @returns {string[]}
 */
function pickupCodeCandidates(line) {
  const s = String(line || '');
  const out = [];
  const re = /\d{4,6}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? s.charAt(start - 1) : '';
    const after = end < s.length ? s.charAt(end) : '';
    if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;

    const afterNext = end + 1 < s.length ? s.charAt(end + 1) : '';
    if (after === '-' && /\d/.test(afterNext)) continue;
    const beforePrev = start > 1 ? s.charAt(start - 2) : '';
    if (before === '-' && /\d/.test(beforePrev)) continue;

    out.push(m[0]);
  }
  return out;
}

/**
 * 兜底找取件码：仅在页面**存在**取件码标签时启用，
 * 取离标签行最近的 4~6 位数字。距离相同取靠前的，保证结果稳定可测。
 *
 * @param {string[]} lines
 * @returns {string} 命中返回数字串，否则空串
 */
function findPickupCodeFallback(lines) {
  const list = Array.isArray(lines) ? lines : [];

  let labelLine = -1;
  for (let i = 0; i < list.length; i++) {
    if (hasPickupLabel(list[i])) {
      labelLine = i;
      break;
    }
  }

  // 标签绑定是硬前提：没有标签直接不出码，不做全页数字扫描
  if (labelLine === -1) return '';

  let best = '';
  let bestDistance = Infinity;

  for (let i = 0; i < list.length; i++) {
    const candidates = pickupCodeCandidates(list[i]);
    for (let j = 0; j < candidates.length; j++) {
      const distance = Math.abs(i - labelLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidates[j];
      }
    }
  }

  return best;
}

/**
 * 解析取件码：标签优先，正则兜底，并给出置信度。
 * @returns {{code:string, confidence:'high'|'low'|'', source:'label'|'regex'|''}}
 */
function resolvePickupCode(text) {
  const raw = extractPickupCode(text);
  const labelCode = looksLikePickupCode(raw) ? String(raw).replace(/\s+/g, '') : '';
  if (labelCode) return { code: labelCode, confidence: 'high', source: 'label' };

  const fallbackCode = findPickupCodeFallback(toLines(text));
  if (fallbackCode) return { code: fallbackCode, confidence: 'low', source: 'regex' };

  return { code: '', confidence: '', source: '' };
}

/**
 * 按平台取件码识别（预留接口）。
 *
 * 本期只实现拼多多（含「兔喜生活」包裹页）；其他平台按设计返回空，
 * 由调用方提示用户手填——不在这一版里猜别的平台规则。
 *
 * @param {string} text OCR 原始文本
 * @param {string} platform detectPlatform 得出的标准平台名
 * @returns {{code:string, confidence:'high'|'low'|'', source:string}}
 */
function getPickupCodeByPlatform(text, platform) {
  const name = String(platform || '');
  if (name === '拼多多') return resolvePickupCode(text);
  return { code: '', confidence: '', source: '' };
}


/** 品牌简称 → 平台清单里的标准名 */
const PLATFORM_ALIASES = {
  抖音: '抖音电商',
  快手: '快手小店',
  苏宁: '苏宁易购',
};

/** 抽取平台：从文本里嗅探常见平台名（返回标准名） */
function extractPlatform(text) {
  const raw = String(text || '');
  for (let i = 0; i < PLATFORM_KEYWORDS.length; i++) {
    const hit = PLATFORM_KEYWORDS[i];
    if (raw.indexOf(hit) > -1) {
      return PLATFORM_ALIASES[hit] || hit;
    }
  }
  return '';
}

// ================================================================ 平台识别与结构化抽取
// 依据《国内主流电商平台订单与退款页面识别特征》：
//   1) 平台判定靠「品牌词 + 入口/字段组合」，不靠配色，也不靠订单号长度；
//   2) 编号必须先有标签再取值，不能把任意数字串当成订单号；
//   3) 证据不足时返回 unknown，宁可让用户手填，也不要猜错。

/** 订单维度编号的标签（顺序即优先级；兼容各平台「订单编号/订单号/订单号码」等叫法） */
const ORDER_NO_LABELS = [
  '订单编号',
  '订单号码',
  '订单号',
  '交易订单号',
  '交易单号',
  '淘宝交易单号',
  '订单ID',
  'order_id',
  'orderId',
];

/** 售后维度编号的标签（顺序即优先级） */
const AFTERSALE_NO_LABELS = [
  '退款编号',
  '退款单号',
  '售后单号',
  '售后申请单号',
  '服务单号',
  '售后编号',
  '退货单号',
  '退货编号',
  '退货码',
];

/** 金额标签的优先级：售后退款 > 实付 > 应付 > 订单金额 > 合计 > 商品金额 */
const AMOUNT_LABEL_RULES = [
  '退款金额',
  '实付金额',
  '实付款',
  '实付',
  '应付总额',
  '订单金额',
  '合计',
  '商品金额',
];

/** 售后状态文案 → 内部语义（顺序即优先级，取页面中最"靠后"的阶段） */
const STATUS_RULES = [
  { key: 'refunded', words: ['退款成功', '已退款', '退款完成', '退款已到账'] },
  { key: 'return_received', words: ['商品退仓', '仓库验货', '退货已签收', '商家已签收'] },
  { key: 'return_in_transit', words: ['快递员已取回商品', '已取回商品', '已取件', '退回中'] },
  { key: 'failed', words: ['退款失败'] },
  { key: 'closed', words: ['已关闭', '撤销售后', '拒绝退款', '商家拒绝'] },
  { key: 'processing', words: ['退款处理中', '退款中', '待退款'] },
  { key: 'approved', words: ['审核通过', '商家已同意', '同意退货', '卖家已同意'] },
  { key: 'pending_seller', words: ['等待商家处理', '商家处理中', '待商家处理', '等待卖家处理'] },
];

/** 收货类日期标签（严格）：只有明确写了收货/签收，才当作收货日期 */
const RECEIVE_DATE_STRICT_LABELS = [
  '收货日期',
  '收货时间',
  '签收日期',
  '签收时间',
  '到货日期',
  '到货时间',
  '确认收货时间',
  '确认收货',
];

/** 取件时间标签 */
const PICKUP_TIME_LABELS = ['取件时间', '预约取件时间', '上门取件时间', '上门时间', '预约时间'];

function isNoiseLine(line) {
  return /^(复制|查看|详情|联系客服|申请售后|查看物流|撤回|修改|删除)$/.test(
    String(line || '').trim()
  );
}

/** 从标签后面的文本里清洗出编号（只保留字母/数字/_/-） */
function cleanIdValue(value) {
  const v = String(value || '').replace(/^[：:\s]+/, '').trim();
  if (!v || isNoiseLine(v)) return '';

  // 值里混入中文时，只取中文之前的部分（如 "VPH2026 退货码"）
  const head = v.split(/[\u4e00-\u9fa5]/)[0];
  // 至少 6 位，避免把 4 位年份/短码误当编号
  const m = head.match(/[A-Za-z0-9][A-Za-z0-9_-]{5,39}/);
  if (!m) return '';

  const id = m[0];
  // 排除日期串（YYYY-MM-DD / YYYY/MM/DD）
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(id)) return '';
  return id;
}

/** 在标签后取值：支持同行、以及标签独占一行时向下 1–2 行 */
function extractIdAfterLabel(lines, label) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(label);
    if (idx < 0) continue;

    const same = cleanIdValue(line.slice(idx + label.length));
    if (same) return same;

    for (let k = 1; k <= 2 && i + k < lines.length; k++) {
      const next = lines[i + k];
      if (isNoiseLine(next)) continue;
      const v = cleanIdValue(next);
      if (v) return v;
      break; // 只看紧邻的有效行，避免把后面的商品名当编号
    }
  }
  return '';
}

/** 抽取订单编号（交易维度） */
function extractOrderNoInfo(text) {
  const lines = toLines(text);
  for (let i = 0; i < ORDER_NO_LABELS.length; i++) {
    const label = ORDER_NO_LABELS[i];
    const value = extractIdAfterLabel(lines, label);
    if (value) return { value: value, label: label };
  }

  // 无标签兜底：淘宝等页面把订单号放在「订单信息 共7项 3316... 复制」里
  for (let i = 0; i < lines.length; i++) {
    if (!/订单信息|订单编号|订单号|复制/.test(lines[i])) continue;
    const m = lines[i].match(/\d{12,24}/);
    if (m) return { value: m[0], label: '订单信息' };
  }

  return { value: '', label: '' };
}

/** 抽取售后编号（退款/售后/服务单维度） */
function extractReturnNoInfo(text) {
  const lines = toLines(text);
  for (let i = 0; i < AFTERSALE_NO_LABELS.length; i++) {
    const label = AFTERSALE_NO_LABELS[i];
    const value = extractIdAfterLabel(lines, label);
    if (value) return { value: value, label: label };
  }
  return { value: '', label: '' };
}

/** 从一段文本里取金额（分）；取不到返回 null。优惠/运费等上下文里的数字会跳过 */
function amountFromString(s) {
  const str = String(s || '');
  const re = /[¥￥]\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元/g;
  let m;

  while ((m = re.exec(str)) !== null) {
    const num = m[1] || m[2];
    const before = str.slice(Math.max(0, m.index - 4), m.index);
    // 「共减¥10」「立减¥20」「运费¥10」不是订单金额
    if (/减|省|优惠|立减|折扣|抵|券|返|运费|税/.test(before)) continue;
    return yuanToFen(num);
  }

  return null;
}

/** 兜底取金额：跳过优惠/运费/税费行，避免把折扣或运费当订单金额 */
function extractAmountFallback(text) {
  const lines = toLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (/优惠|减|省|折扣|抵|券|返|运费|税费/.test(lines[i])) continue;
    const v = amountFromString(lines[i]);
    if (v !== null) return v;
  }
  return null;
}

/** 先用后付：实付为 0 时，取「确认收货并付款 ¥9.7」里的应付金额 */
function extractPayLaterAmount(text) {
  const m = String(text || '').match(/付款\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
  if (m) return yuanToFen(m[1]);
  return null;
}

/**
 * 按标签优先级抽取金额。
 * 退货场景优先「退款金额」，订单页优先「实付」，避免抓到商品原价或优惠前金额。
 */
function extractAmountInfo(text) {
  const lines = toLines(text);

  for (let r = 0; r < AMOUNT_LABEL_RULES.length; r++) {
    const label = AMOUNT_LABEL_RULES[r];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf(label);
      if (idx < 0) continue;
      // 「合计优惠 -¥5」不是订单合计
      if (label === '合计' && /优惠|立减|折扣|满减|券/.test(line)) continue;

      let v = amountFromString(line.slice(idx + label.length));
      if (v === null) v = amountFromString(line);
      if (v === null && i + 1 < lines.length) v = amountFromString(lines[i + 1]);
      if (v !== null) {
        // 先用后付页面「实付 ¥0.0」不是真实金额，取稍后应付的金额
        if (v === 0 && /先用后付|先享后付|货到付款/.test(text)) {
          const later = extractPayLaterAmount(text);
          if (later !== null && later > 0) {
            return { amount: later, label: '先用后付-应付' };
          }
          const alt = extractAmountFallback(text);
          if (alt !== null && alt > 0) {
            return { amount: alt, label: '先用后付-商品价' };
          }
        }
        return { amount: v, label: label };
      }
    }
  }

  // 没有标签时兜底：跳过优惠/运费，取第一个有效金额
  return { amount: extractAmountFallback(text), label: '' };
}

/** 严格抽取收货日期：没有明确的收货/签收标签就不猜（避免把下单/申请时间当收货日） */
function extractReceiveDate(text) {
  const raw = String(text || '');
  const lines = toLines(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/预计|预计送达/.test(line)) continue; // 预计时间不是已收货时间
    let hit = false;
    for (let k = 0; k < RECEIVE_DATE_STRICT_LABELS.length; k++) {
      if (line.indexOf(RECEIVE_DATE_STRICT_LABELS[k]) > -1) { hit = true; break; }
    }
    if (!hit) continue;

    let d = dateFromString(line);
    if (!d && i + 1 < lines.length) {
      const next = lines[i + 1];
      // 下一行必须以日期开头，避免把「预计送达 2026-10-08」当成收货日
      if (/^\s*20\d{2}[-/年]/.test(next)) d = dateFromString(next);
    }
    if (d) return d;
  }

  // 物流明确写了已签收/已领取，但页面没有「收货日期」标签：取页面第一个日期
  if (/已签收|已领取|已送达/.test(raw)) {
    const signed = dateFromString(raw);
    if (signed) return signed;
  }

  return '';
}

/** 判断是订单详情页还是售后/退款详情页 */
function detectPageKind(text) {
  const t = String(text || '');
  const afterWords = [
    '退款详情',
    '退货详情',
    '售后详情',
    '退款编号',
    '退款单号',
    '售后单号',
    '服务单号',
    '售后申请单号',
    '退款处理中',
    '退货退款',
    '退款成功',
    '已退款',
  ];
  for (let i = 0; i < afterWords.length; i++) {
    if (t.indexOf(afterWords[i]) > -1) return 'aftersale_detail';
  }

  const orderWords = [
    '订单详情',
    '订单编号',
    '订单号',
    '下单时间',
    '实付款',
    '实付金额',
    '实付',
    '交易成功',
  ];
  for (let i = 0; i < orderWords.length; i++) {
    if (t.indexOf(orderWords[i]) > -1) return 'order_detail';
  }
  return 'unknown';
}

/** 抽取售后状态：保留原文，同时给出内部语义 */
function extractStatus(text) {
  const t = String(text || '');
  for (let i = 0; i < STATUS_RULES.length; i++) {
    const rule = STATUS_RULES[i];
    for (let k = 0; k < rule.words.length; k++) {
      if (t.indexOf(rule.words[k]) > -1) {
        return { raw: rule.words[k], key: rule.key };
      }
    }
  }
  return { raw: '', key: '' };
}

/** 抽取取件时间（只保留页面原文，不做日期换算） */
function extractPickupTime(text) {
  const lines = toLines(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let k = 0; k < PICKUP_TIME_LABELS.length; k++) {
      const label = PICKUP_TIME_LABELS[k];
      const idx = line.indexOf(label);
      if (idx < 0) continue;

      const same = line.slice(idx + label.length).replace(/^[：:\s]+/, '').trim();
      if (same) return same.slice(0, 40);
      if (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next && !isNoiseLine(next)) return next.slice(0, 40);
      }
    }
  }

  // 淘宝文案：「等待10月30日15:00—17:00 上门取件」
  const m = String(text || '').match(/([^\n]{0,24}\d[^\n]{0,16}上门取件)/);
  if (m && /\d/.test(m[1])) {
    // 「明天09:00-11:00快递员将上门取件」是相对日期：取件时间字段存的是绝对时刻，
    // 填个「明天」进去以后看不出来是哪天，宁可不填让用户自己写
    if (/今天|明天|后天|今晚|上午|下午/.test(m[1])) return '';
    return m[1].trim().slice(0, 40);
  }

  return '';
}

/**
 * 平台识别：品牌词 + 入口/字段组合 + 置信度。
 * 只出现「订单号/退款/售后」这类通用词时返回 unknown（文档三级规则）。
 */
function detectPlatform(text) {
  const t = String(text || '');
  const has = function (kw) { return t.indexOf(kw) > -1; };
  const evidence = [];
  function add(kw) { if (kw && evidence.indexOf(kw) === -1) evidence.push(kw); }
  function high(platform) { return { platform: platform, confidence: 'high', evidence: evidence }; }
  function medium(platform) { return { platform: platform, confidence: 'medium', evidence: evidence }; }

  // 内容电商：品牌词唯一，先判
  if (has('快手小店') || has('快手')) {
    add('快手');
    if (has('售后')) { add('售后入口'); return high('快手小店'); }
    return medium('快手小店');
  }
  if (
    has('抖音商城') ||
    has('抖音电商') ||
    has('抖音') ||
    has('来自豆包') ||
    has('豆包App') ||
    (has('交易完成') && (has('买后必看') || has('再买一单')))
  ) {
    add('抖音');
    const doubao = has('来自豆包') || has('豆包App');
    const weakCombo = has('交易完成') && (has('买后必看') || has('再买一单'));
    const brandHit = has('抖音商城') || has('抖音电商') || has('抖音');

    if (doubao) add('豆包');
    if (has('交易完成')) add('交易完成');
    if (has('买后必看')) add('买后必看');

    // 只有「交易完成 + 买后必看/再买一单」的弱组合：中置信，不因页面有「申请售后」就升为高
    if (weakCombo && !doubao && !brandHit) return medium('抖音电商');

    if (has('我的订单') || has('售后') || doubao) {
      add('订单/售后入口');
      return high('抖音电商');
    }
    return medium('抖音电商');
  }

  // 唯品会：退货进度链是最强证据
  if (has('唯品会')) {
    add('唯品会');
    if (has('退货详情') || has('快递员已取回商品') || has('取件时间') || has('仓库验货')) {
      add('退货进度');
      return high('唯品会');
    }
    return medium('唯品会');
  }
  if (has('退货详情') && (has('快递员已取回商品') || has('仓库验货') || has('取件时间'))) {
    add('退货详情');
    add('取件/验货');
    return high('唯品会');
  }

  // 苏宁：我的易购 + 服务单进度
  if (has('我的易购') || has('苏宁易购') || has('苏宁')) {
    add('苏宁');
    if (has('服务单') || has('进度查询')) { add('服务单进度'); return high('苏宁易购'); }
    return medium('苏宁易购');
  }

  // 京东：服务单号 + 进度查询 / 退换售后
  if (has('我的京东') || has('京东')) {
    add('京东');
    if (has('服务单号')) add('服务单号');
    if (has('退换/售后') || has('退换货') || has('进度查询')) add('售后进度');
    if (has('服务单号') && (has('进度查询') || has('退换/售后'))) return high('京东');
    return medium('京东');
  }

  // 天猫必须在淘宝前：两者共用交易体系
  if (has('天猫客服') || has('要求天猫客服介入') || has('天猫超市') || has('天猫国际') || has('天猫')) {
    add('天猫');
    if (has('退款编号') || has('退款详情')) add('退款编号/退款详情');
    if (has('天猫客服') || has('退款编号')) return high('天猫');
    return medium('天猫');
  }

  // 淘宝
  if (
    has('我的淘宝') ||
    has('已买到的宝贝') ||
    has('淘宝') ||
    has('88VIP') ||
    has('闲鱼转卖') ||
    has('退货宝')
  ) {
    add('淘宝');
    if (has('已买到的宝贝')) add('已买到的宝贝');
    if (has('退款编号') || has('退款处理中')) add('退款编号/退款处理中');
    if (has('88VIP')) add('88VIP');
    if (has('闲鱼转卖')) add('闲鱼转卖');
    if (has('退货宝')) add('退货宝');
    // 品牌/入口 + 退款编号即可高置信（订单页常见「已买到的宝贝」不在售后页出现）
    if (has('退款编号') || has('退款处理中')) return high('淘宝');
    if (has('已买到的宝贝')) return high('淘宝');
    return medium('淘宝');
  }

  // 拼多多：兔喜生活是其包裹代收品牌，页面无「拼多多」字样时作为强入口证据
  if (has('拼多多') || has('兔喜生活')) {
    add('拼多多');
    if (has('兔喜生活')) add('兔喜生活');
    if (has('退款/售后') || has('售后详情') || has('商家处理中') || has('兔喜生活')) {
      add('售后入口');
      return high('拼多多');
    }
    return medium('拼多多');
  }

  // 其他预置平台：品牌词只能给中等置信
  if (has('美团')) { add('美团'); return medium('美团'); }
  if (has('饿了么')) { add('饿了么'); return medium('饿了么'); }
  if (has('小红书')) { add('小红书'); return medium('小红书'); }

  // 只有通用词（订单号/退款/售后/服务单），无法判定平台
  return { platform: '', confidence: 'unknown', evidence: evidence };
}

/**
 * 平台感知的完整解析（供云函数使用）。
 * 在原有 7 个表单字段之外，补平台置信度、页面类型、订单号/售后号标签、
 * 状态原文与语义、取件时间、命中证据。
 */
function analyzeOrder(text) {
  const raw = String(text || '');
  const platformInfo = detectPlatform(raw);
  const amountInfo = extractAmountInfo(raw);
  const orderNoInfo = extractOrderNoInfo(raw);
  const returnNoInfo = extractReturnNoInfo(raw);
  const statusInfo = extractStatus(raw);

  // 取件码：标签优先；拼多多额外走 6 位数字兜底（低置信，需用户核对）
  const labelValue = extractPickupCode(raw);
  const labelCode = looksLikePickupCode(labelValue) ? String(labelValue).replace(/\s+/g, '') : '';
  const platformPickup = getPickupCodeByPlatform(raw, platformInfo.platform);
  const pickupCode = labelCode || platformPickup.code || '';
  const pickupConfidence = labelCode ? 'high' : platformPickup.code ? 'low' : '';

  return {
    ruleVersion: OCR_RULE_VERSION,
    platform: platformInfo.platform,
    platformConfidence: platformInfo.confidence,
    pageKind: detectPageKind(raw),
    productName: extractProductName(toLines(raw)),
    amount: amountInfo.amount,
    amountLabel: amountInfo.label,
    date: extractReceiveDate(raw),
    // 订单编号：优先「订单编号/订单号」，退货页只有「退货单号」时用它兜底，保证查重有键
    orderNo: orderNoInfo.value || returnNoInfo.value,
    orderNoLabel: orderNoInfo.label || (returnNoInfo.value ? returnNoInfo.label : ''),
    orderNoIsFallback: !orderNoInfo.value && !!returnNoInfo.value,
    returnNo: returnNoInfo.value,
    returnNoLabel: returnNoInfo.label,
    returnReason: extractReturnReason(raw),
    pickupCode: pickupCode,
    pickupConfidence: pickupConfidence,
    pickupCodeSource: labelCode ? 'label' : platformPickup.code ? platformPickup.source : '',
    // 非「高置信」都要求用户核对：这是「识别→确认→写入」的闸
    // 非「高置信」都要求用户核对；但完全没有码时没有可核对的内容，置 false
    needConfirm: !!pickupCode && pickupConfidence !== 'high',
    rawLines: toLines(raw),
    pickupTime: extractPickupTime(raw),
    statusRaw: statusInfo.raw,
    statusKey: statusInfo.key,
    evidence: platformInfo.evidence,
  };
}

module.exports = {
  OCR_RULE_VERSION,
  extractOrder,
  analyzeOrder,
  detectPlatform,
  detectPageKind,
  extractOrderNoInfo,
  extractReturnNoInfo,
  extractAmountInfo,
  extractReceiveDate,
  extractStatus,
  extractPickupTime,
  extractProductName,
  extractAmount,
  extractDate,
  extractPlatform,
  extractReturnNo,
  extractReturnReason,
  extractPickupCode,
  PICKUP_CODE_RE,
  PICKUP_LABEL_KEYWORDS,
  hasPickupLabel,
  looksLikePickupCode,
  findPickupCodeFallback,
  resolvePickupCode,
  getPickupCodeByPlatform,
  isPlatformNameOnly,
  yuanToFen,
};
