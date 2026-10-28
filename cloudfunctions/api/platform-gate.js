/**
 * 第 0 步：平台判定闸门（纯逻辑，零依赖，可 Node 直测）
 * ------------------------------------------------------------------
 * 这是所有字段抽取之前的准入判断：先确认「这页是不是拼多多」，
 * 不是拼多多的页面，拼多多专属规则一律降级，不硬抽。
 *
 * 输出与既有代码的关系（重要）：
 *   - 既有 ocr.js 的 detectPlatform() 返回**中文平台名**（拼多多/淘宝/…），
 *     字段 `platform` / `platformConfidence` 保持不动，与前端平台回填逻辑兼容。
 *   - 本模块是**新增闸门**，输出 `platform_gate`，取值是英文码
 *     （pdd / taobao / jd / express / unknown），供取件码抽取决定用哪档规则。
 *
 * 信号分三档（与需求方约定）：
 *   强信号：品牌词、「退货单号特征」——命中即 pdd，high
 *   组件信号：上门取件 / 退款进度 / 售后详情——**其他平台也有**，单条 low、≥2 条 mid
 *   弱信号：取件码 / 待取件 / 快递员接单 / 极兔 / 韵达——**单独不算**，≥2 条才 low
 *
 * 为什么组件信号不给 high：
 *   「上门取件」「退款进度」「售后详情」在淘宝、京东退货页同样出现，
 *   若单条即 high，会与「排除：淘宝/京东退货页 → 各自平台」直接冲突。
 *   需要按原文把组件当强信号时，把 COMPONENT_AS_STRONG 改为 true 即可（仅此一处）。
 * ------------------------------------------------------------------
 */

/** 平台码 */
const PLATFORM = {
  PDD: 'pdd',
  TAOBAO: 'taobao',
  JD: 'jd',
  EXPRESS: 'express',
  UNKNOWN: 'unknown',
};

/** 置信档 */
const CONF = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
};

/**
 * 组件信号是否直接当强信号。
 * 需求方 2026-10-28 规则把「售后详情 / 上门取件」列为强信号（命中即可定 pdd），
 * 故置 true。竞争平台品牌词在更前面判断，淘宝/京东页不会被它抢走。
 */
const COMPONENT_AS_STRONG = true;

/** 拼多多品牌词（命中即 high） */
const PDD_BRAND = ['拼多多', 'PDD', '拼多多官方取件', '拼多多退货', '百亿补贴'];

/** 淘宝系品牌词 */
const TAOBAO_BRAND = ['我的淘宝', '已买到的宝贝', '淘宝', '天猫', '88VIP', '退货宝'];

/** 京东系品牌词 */
const JD_BRAND = ['我的京东', '京东'];

/** 京东/淘宝共用的弱入口（品牌缺失时用于区分，不给 high） */
const JD_ENTRY = ['服务单号', '退换/售后', '进度查询'];

/** 快递公司小程序/壳子特征 */
const EXPRESS_SHELL = [
  '顺丰速运',
  '菜鸟裹裹',
  '菜鸟驿站',
  '我的快递',
  '运单详情',
  '快递100',
  '中通快递',
  '圆通速递',
  '韵达快递',
  '极兔速递',
];

/** 电商业务词：出现这些说明是电商页面而不是快递壳子 */
const ECOM_WORDS = ['退货', '退款', '售后', '订单', '取件码', '上门取件', '商家'];

/** 微信/通知壳子特征 */
const WECHAT_SHELL = ['微信支付', '服务通知', '通知详情', '微信团队'];

/** 组件信号（其他平台也有） */
const COMPONENT_SIGNALS = ['上门取件', '退款进度', '售后详情'];

/**
 * 拼多多**专属**组件（其他平台不用这些文案）：
 * 来自 docs/2026-10-24-拼多多售后页平台识别要素.md 的 A 级要素。
 * 单条给 mid（防 OCR 噪声），≥2 条给 high。
 * 必须有这一组：真实「预约成功页」没有品牌词，只有这些专属文案，
 * 否则该页会判成 unknown（这正是用户 10-24 报的问题）。
 */
const PDD_EXCLUSIVE = [
  '寄回商品',
  '撤销售后',
  '月卡专享',
  '寄件详情',
  '本次寄件服务享受官方补贴',
  '请在快递员上门后出示',
  '待快递员取件',
  '拼多多退货服务协议',
  '兔喜生活',
  '兔喜',
];

/** 弱信号（单独不算） */
const WEAK_SIGNALS = ['取件码', '待取件', '快递员接单', '极兔', '韵达'];

/** 退货单号标签 */
const RETURN_LABELS = ['退货单号', '退款单号', '售后单号', '退货编号'];

/** 订单号标签 */
const ORDER_LABELS = ['订单号', '订单编号', '订单号码', '交易单号', '交易订单号'];

/**
 * 拼多多退货单号特征：26/24 开头的长数字、带连字符的长数字，或 PP/PDD 前缀
 * 目录样本里出现过 `261015-521320568353024` 这种连字符格式，所以两种都要认。
 */
const PDD_RETURN_NO_RE = /^(?:(?:26|24)\d{8,}|(?:26|24)\d{4}-\d{8,}|(?:PP|PDD)[A-Za-z0-9]{6,})$/i;

/**
 * 拼多多订单号格式（规则表 §4.2，目录样本 4/4 覆盖、淘宝对照为 19 位纯数字）：
 * `YYMMDD-15位数字`，例 `261011-360343170593024`。
 */
const PDD_ORDER_NO_RE = /^2[0-9]{5}-\d{15}$/;

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

function countOf(text, words) {
  const t = String(text || '');
  const hit = [];
  for (let i = 0; i < words.length; i++) {
    if (t.indexOf(words[i]) > -1) hit.push(words[i]);
  }
  return hit;
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

/** 退货单号是否具备拼多多特征 */
function hasPddReturnNo(lines) {
  const raw = valueAfterLabels(lines, RETURN_LABELS);
  const m = String(raw || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{5,39}/);
  if (!m) return '';
  return PDD_RETURN_NO_RE.test(m[0]) ? m[0] : '';
}

/** 订单号是否具备拼多多格式特征（YYMMDD-15位） */
function hasPddOrderNo(lines) {
  const raw = valueAfterLabels(lines, ORDER_LABELS);
  const m = String(raw || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{5,39}/);
  if (!m) return '';
  return PDD_ORDER_NO_RE.test(m[0]) ? m[0] : '';
}

/** 短信截图：看落款【XXX】 */
function smsSignature(text) {
  const m = String(text || '').match(/【([^】]{1,20})】/);
  return m ? m[1] : '';
}

/**
 * 主入口：判定平台。
 *
 * @param {string} pageText OCR 原文
 * @returns {{platform:string, platform_conf:string, evidence:string[], mode:string}}
 *   mode=full 表示可以使用平台专属规则；label_only 表示只做通用标签抽取
 */
function detectPlatformGate(pageText) {
  const t = String(pageText || '');
  const lines = toLines(t);
  const evidence = [];

  const pddBrand = countOf(t, PDD_BRAND);
  const taobaoBrand = countOf(t, TAOBAO_BRAND);
  const jdBrand = countOf(t, JD_BRAND);
  const expressShell = countOf(t, EXPRESS_SHELL);
  const ecom = countOf(t, ECOM_WORDS);
  const wechatShell = countOf(t, WECHAT_SHELL);

  // ── 1. 品牌词优先（排除壳子干扰：壳子里出现业务方时以业务方为准）
  if (pddBrand.length) {
    pddBrand.forEach(function (w) { evidence.push('拼多多品牌词：' + w); });
    return result(PLATFORM.PDD, CONF.HIGH, evidence);
  }

  // ── 2. 竞争平台品牌词：必须排在「拼多多专属组件」之前
  // 隔离底线（用户 2026-10-28 明确）：别的平台页面不能被拼多多的文案抢走。
  // 反例（实测）：淘宝页只因含「撤销售后／寄件详情」两条拼多多专属组件，曾被判成 pdd/high。
  if (taobaoBrand.length) {
    taobaoBrand.forEach(function (w) { evidence.push('淘宝系品牌词：' + w); });
    return result(PLATFORM.TAOBAO, CONF.HIGH, evidence);
  }

  // 京东：品牌词 high；只有「服务单号 + 进度查询」给 mid
  if (jdBrand.length) {
    jdBrand.forEach(function (w) { evidence.push('京东品牌词：' + w); });
    return result(PLATFORM.JD, CONF.HIGH, evidence);
  }
  const jdEntry = countOf(t, JD_ENTRY);
  if (jdEntry.length >= 2) {
    jdEntry.forEach(function (w) { evidence.push('京东售后入口：' + w); });
    return result(PLATFORM.JD, CONF.MID, evidence);
  }

  // ── 3. 拼多多专属组件：≥2 条直接 high（无品牌词的真实售后页靠这一组）
  const exclusive = countOf(t, PDD_EXCLUSIVE);
  if (exclusive.length >= 2) {
    exclusive.forEach(function (w) { evidence.push('拼多多专属组件：' + w); });
    return result(PLATFORM.PDD, CONF.HIGH, evidence);
  }

  // ── 2. 快递公司壳子：只有「没有电商业务词」时才成立
  if (expressShell.length && !ecom.length) {
    expressShell.forEach(function (w) { evidence.push('快递壳子：' + w); });
    const conf = /顺丰速运|菜鸟裹裹|菜鸟驿站|我的快递|运单详情/.test(t) ? CONF.HIGH : CONF.MID;
    return result(PLATFORM.EXPRESS, conf, evidence);
  }

  // ── 3. 短信截图：看落款
  const sms = smsSignature(t);
  if (sms && /退订|回复TD|回T退订/i.test(t)) {
    evidence.push('短信落款：' + sms);
    if (/拼多多/.test(sms)) return result(PLATFORM.PDD, CONF.HIGH, evidence);
    if (/淘宝|天猫/.test(sms)) return result(PLATFORM.TAOBAO, CONF.HIGH, evidence);
    if (/京东/.test(sms)) return result(PLATFORM.JD, CONF.HIGH, evidence);
    return result(PLATFORM.UNKNOWN, CONF.LOW, evidence);
  }

  // ── 4. 微信服务通知壳子：业务方已在品牌词那步处理，这里只剩「无业务方」
  if (wechatShell.length) {
    wechatShell.forEach(function (w) { evidence.push('微信壳子：' + w); });
    return result(PLATFORM.UNKNOWN, CONF.LOW, evidence);
  }

  // ── 5. 退货单号特征（需求方列为强信号）
  const pddReturnNo = hasPddReturnNo(lines);
  if (pddReturnNo) {
    evidence.push('退货单号特征：' + pddReturnNo);
    return result(PLATFORM.PDD, CONF.HIGH, evidence);
  }

  // ── 6. 专属组件单条 + 组件信号 + 弱信号加权
  if (exclusive.length === 1) {
    evidence.push('拼多多专属组件：' + exclusive[0]);
    return result(PLATFORM.PDD, CONF.MID, evidence);
  }

  const components = countOf(t, COMPONENT_SIGNALS);
  components.forEach(function (w) { evidence.push('组件信号：' + w); });

  if (COMPONENT_AS_STRONG && components.length) {
    return result(PLATFORM.PDD, CONF.HIGH, evidence);
  }
  if (components.length >= 2) return result(PLATFORM.PDD, CONF.MID, evidence);
  if (components.length === 1) return result(PLATFORM.PDD, CONF.LOW, evidence);

  // 弱信号按「组」计数（同一组内的同义文案只算 1 条），需 ≥2 组才给 pdd low
  const weakHits = [];
  if (t.indexOf('取件码') > -1 || t.indexOf('提货码') > -1) weakHits.push('取件码');
  if (t.indexOf('待取件') > -1 || t.indexOf('待快递员取件') > -1) weakHits.push('待取件');
  if (t.indexOf('快递员接单') > -1 || t.indexOf('快递员已接单') > -1) weakHits.push('快递员接单');
  if (t.indexOf('极兔') > -1 || t.indexOf('韵达') > -1) weakHits.push('极兔/韵达');
  // 需求方规则：「订单编号」是弱信号，单独不算拼多多
  if (t.indexOf('订单编号') > -1 || t.indexOf('订单号') > -1) weakHits.push('订单编号');
  const pddOrderNo = hasPddOrderNo(lines);
  if (pddOrderNo) weakHits.push('订单号格式');

  weakHits.forEach(function (w) { evidence.push('弱信号：' + w); });

  if (weakHits.length >= 2) return result(PLATFORM.PDD, CONF.LOW, evidence);

  // 只有 1 条弱信号（如只有「取件码」三个字）→ unknown，禁止直接判 pdd
  return result(PLATFORM.UNKNOWN, CONF.LOW, evidence);
}

/** 组装结果：mode 由平台与置信度决定 */
function result(platform, conf, evidence) {
  // 只有「拼多多 + 非 low」才允许跑拼多多专属规则（含邻近兜底）
  const mode = platform === PLATFORM.PDD && conf !== CONF.LOW ? 'full' : 'label_only';
  return {
    platform: platform,
    platform_conf: conf,
    evidence: evidence,
    mode: mode,
  };
}

module.exports = {
  PLATFORM,
  CONF,
  COMPONENT_AS_STRONG,
  PDD_BRAND,
  TAOBAO_BRAND,
  JD_BRAND,
  COMPONENT_SIGNALS,
  WEAK_SIGNALS,
  PDD_EXCLUSIVE,
  PDD_RETURN_NO_RE,
  PDD_ORDER_NO_RE,
  hasPddReturnNo,
  hasPddOrderNo,
  smsSignature,
  detectPlatformGate,
};
