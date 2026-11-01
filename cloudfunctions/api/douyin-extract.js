/**
 * 抖音订单/售后截图：结构化字段抽取（纯逻辑，零依赖，可 Node 直测）
 * ==================================================================
 * 与拼多多的关系（平台隔离底线，用户 2026-10-28 明确）：
 *   本文件只服务 platform = 'douyin' 的页面。拼多多的专属组件、邻近兜底、
 *   页型加权一律不共用；反过来 douyin 的规则也不出现在 pickup-extract.js 里。
 *   两者共用的只有「订单号/快递公司标签行”这类平台无关的取值方式。
 *
 * 规则来自 4 张真实截图（D:\购物订单\抖音）：
 *   抖音订单页 3 张（同一页型）＋ 抖音售后页 1 张（退货中，带取件码）
 *
 * 页面类型（按需求方 2026-10-31 约定，抖音只有这两类 + unknown）：
 *   order_detail      含「订单编号」「查看物流」「实付」
 *   after_sale_detail 含「退货进度」或「退款详情」
 *   unknown           两者都没有
 * 注意：**「申请售后」不能当售后页判据**——订单详情页上就有这个按钮，
 *      实测 3 张订单页里有 2 张带这三个字（douyin2、售后前那张）。
 *
 * 取件码（抖音只有一种写法，且必须验共现）：
 *   样本原文：`退货进度 取件码0131 11月1日(明天)上门取件`
 *   - 「取件码」与数字**紧贴、无空格**（拼多多样本是「取件码 2281」带空格）
 *   - 必须同页出现「上门取件」或「快递员」，否则不出码（寄件语义闸门）
 *   - 同页还有「出示运单号后五位98123取件」——那是**去驿站取包裹**的收货码，
 *     不是寄件码；凡带「运单号/驿站/快递柜」上下文的行一律跳过。
 *
 * 只取真实可见：看不到的字段返回空串，由上层填 null，不写「未知/无」。
 * ==================================================================
 */

/**
 * 码值切分用 L1 通用模块（平台无关）。
 *
 * 「标签后面的数字该切几位」不依赖平台——拼多多、抖音、以后接入的任何平台
 * 都可能遇到「码值与日期/时间被 OCR 粘在一起」，所以这段逻辑按手册 §16
 * 的三层结构放到 L1 共用，不在这里复制一份。
 * 本模块自己只保留平台专属的东西：标签词、寄件/收货语义、页型判据。
 */
const codeSplit = require('./code-split');

/** 取件码标签（抖音只用这一个） */
const CODE_LABEL = '取件码';

/** 码值形态（复用 L1 定义，避免两处漂移） */
const CODE_STRICT_RE = codeSplit.CODE_SHAPE_RE;

/** 寄件语义：必须有其中之一，取件码才成立 */
const SEND_CONTEXT_RE = /上门取件|快递员/;

/** 收货语义：出现这些说明是「去驿站取包裹」，该行不能出寄件码 */
const RECEIVE_CONTEXT_RE = /运单号|驿站|快递柜|取包裹/;

/** 售后页判据（实测：退货中是导航标题，另两处是退货进度 / 退款详情） */
const AFTER_SALE_RE = /退货进度|退款详情|退货中|退货退款/;

/** 订单页判据 */
const ORDER_RE = /订单编号|订单号|查看物流|实付款|实付/;

/** 订单号标签 */
const ORDER_LABELS = ['订单编号', '订单号', '交易单号', '交易订单号'];

/** 快递公司标签（无标签就留空，不扫全页猜） */
const EXPRESS_LABEL_RE = /快递公司|承运|物流公司/;

/** 取件时间标签 */
const TIME_LABELS = ['上门时间', '取件时间', '预约取件时间', '上门取件时间'];

/** 地址标签 */
const ADDRESS_LABELS = ['取件地址', '上门地址', '退货地址', '收货地址'];

/** 常见快递公司（只用于把标签行里的名字切出来，不做全页扫描） */
const COURIERS = ['顺丰', '中通', '圆通', '韵达', '申通', '极兔', '邮政', 'EMS', '京东物流', '德邦'];

/** 行切分（与其它模块语义一致，本模块自持以保持独立可测） */
function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

/** 保守归一：只做 OCR 常见混淆，不补字符 */
function normalizeCode(raw) {
  return String(raw || '')
    .replace(/[Oo]/g, '0')
    .replace(/[lI]/g, '1');
}

/** 取标签后的值（同行优先，其次下一行） */
function valueAfterLabels(lines, labels) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let k = 0; k < labels.length; k++) {
      const label = labels[k];
      const idx = line.indexOf(label);
      if (idx < 0) continue;
      const same = line.slice(idx + label.length).replace(/^[：:\s]+/, '').trim();
      if (same) return same;
      if (i + 1 < lines.length) {
        const next = String(lines[i + 1] || '').trim();
        if (next) return next;
      }
    }
  }
  return '';
}

/** 订单号：标签后第一段字母数字，原样保留（抖音实测 19 位纯数字） */
function extractOrderSn(lines) {
  const raw = valueAfterLabels(lines, ORDER_LABELS);
  const m = String(raw || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{5,39}/);
  return m ? m[0] : '';
}

/** 快递公司：只认明确标签行，其余留空 */
function extractExpressCompany(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!EXPRESS_LABEL_RE.test(line)) continue;
    for (let k = 0; k < COURIERS.length; k++) {
      if (line.indexOf(COURIERS[k]) > -1) return COURIERS[k];
    }
  }
  return '';
}

/** 地址：只认明确标签，不猜 */
function extractAddress(lines) {
  return valueAfterLabels(lines, ADDRESS_LABELS).slice(0, 80);
}

/**
 * 从一行里切出「取件码标签后面的码值」。
 *
 * 抖音实测写法：`取件码0131 11月1日(明天)上门取件`（紧贴无空格）。
 * 但 OCR 会把中间空格合并（原图有、文本里没有），
 * 切分本身交给 L1 通用模块 code-split，这里只负责定位标签。
 *
 * @returns {{code:string, rest:string, ambiguous:boolean}|null}
 *   rest 是码后面的剩余文字（可能是取件时间）；
 *   ambiguous=true 表示数字串被切开过，存在吃错位的可能，必须让用户核对。
 */
function codeAfterLabel(line) {
  const s = String(line || '');
  const idx = s.indexOf(CODE_LABEL);
  if (idx < 0) return null;
  return codeSplit.splitCodeAfterLabel(s.slice(idx + CODE_LABEL.length));
}

/**
 * 找抖音的取件码（寄件码）。
 *
 * 两条硬闸门缺一不可：
 *   1. 码所在行（含下一行）必须出现「上门取件」或「快递员」——证明这是寄件场景；
 *      去驿站取包裹的行只有「运单号」，过不了这一关。
 *   2. 该行不能属于收货上下文（运单号 / 驿站 / 快递柜）。
 * 另：「取件码」标签后必须紧跟 4~6 位（由 codeAfterLabel 保证）。
 *
 * @param {string[]} lines
 * @returns {{code:string, rest:string, lineIndex:number}|null}
 */
function findPickupCode(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf(CODE_LABEL) < 0) continue;

    // 闸门 2：收货上下文跳过（「出示运单号后五位98123取件」这类行）
    if (RECEIVE_CONTEXT_RE.test(line)) continue;

    const hit = codeAfterLabel(line);
    if (!hit) continue;

    // 闸门 1：码所在行（含下一行）必须有寄件语义「上门取件 / 快递员」。
    // 这一条就是「必须共现」的落地：寄件码一定挨着上门取件提示，
    // 收货码（运单号后五位）不会。
    const context = line + ' ' + (lines[i + 1] || '');
    if (!SEND_CONTEXT_RE.test(context)) continue;

    return {
      code: hit.code,
      rest: hit.rest,
      ambiguous: !!hit.ambiguous,
      lineIndex: i,
    };
  }
  return null;
}

/**
 * 取件时间：优先「取件码」同一行后半段（抖音实测就是这种），其次标签行。
 * 只原样返回，不做日期换算。
 */
function extractPickupTime(lines, text, codeHit) {
  if (codeHit && codeHit.rest) {
    const rest = String(codeHit.rest).trim();
    // 只要带「取件」的那一段，避免把其它文案带进来
    if (/取件/.test(rest)) return rest.slice(0, 40);
  }
  const labeled = valueAfterLabels(lines, TIME_LABELS);
  if (labeled) return labeled.slice(0, 40);
  return '';
}

/**
 * 页面类型判定。
 *
 * 顺序：售后页判据优先（售后页也可能同时有「订单编号/实付」，
 *      若先判订单页，售后页会全被误判成 order_detail）。
 *
 * 抖音不出 pickup_code_page 这一档：它没有独立的「取件码展示页」，
 * 取件码直接长在售后页里，页面类型仍按售后页算，有无码看 has_pickup_code。
 *
 * @returns {'order_detail'|'after_sale_detail'|'unknown'}
 */
function detectPageType(text) {
  const t = String(text || '');
  if (AFTER_SALE_RE.test(t)) return 'after_sale_detail';
  if (ORDER_RE.test(t)) return 'order_detail';
  return 'unknown';
}

/**
 * 主入口：抖音订单/售后截图 → 与拼多多通道一致的 11 字段。
 *
 * @param {{page_text?:string, platform_conf?:string}} input
 * @returns {object} 缺值一律空串，由上层决定是否转 null
 */
function extractDouyin(input) {
  const pageText = String((input && input.page_text) || '');
  const platformConf = String((input && input.platform_conf) || '') || 'low';
  const lines = toLines(pageText);

  const pageType = detectPageType(pageText);
  const hit = findPickupCode(lines);
  const code = hit ? hit.code : '';

  // 数字串被切开过（码后面紧贴数字，可能是被吞掉的日期）→ 必须让用户核对。
  // 这是 2026-10-31 那次「0131 被填成 013111 却毫无提示」的直接补丁：
  // 值错还能改，静默填错会直接报给快递员。
  const low = !!(hit && hit.ambiguous);

  return {
    platform: 'douyin',
    platform_conf: platformConf,
    page_type: pageType,
    has_pickup_code: !!code,
    pickup_code_raw: code,
    // 低置信时留空，与拼多多通道一致：宁可让用户看原值，也不给「修正过但可能错」的值
    pickup_code_normalized: code && !low ? normalizeCode(code) : '',
    low_confidence: low,
    order_sn: extractOrderSn(lines),
    express_company: extractExpressCompany(lines),
    pickup_time: extractPickupTime(lines, pageText, hit),
    address: extractAddress(lines),
  };
}

module.exports = {
  CODE_LABEL,
  CODE_STRICT_RE,
  SEND_CONTEXT_RE,
  RECEIVE_CONTEXT_RE,
  AFTER_SALE_RE,
  ORDER_RE,
  toLines,
  normalizeCode,
  valueAfterLabels,
  extractOrderSn,
  extractExpressCompany,
  extractAddress,
  codeAfterLabel,
  findPickupCode,
  extractPickupTime,
  detectPageType,
  extractDouyin,
  // 切分能力来自 L1 通用模块，这里转发一份便于调用方与测试统一入口
  codeSplit,
  restKind: codeSplit.restKind,
};
