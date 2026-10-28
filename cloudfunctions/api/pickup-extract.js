/**
 * 取件码结构化抽取（纯逻辑，不依赖 wx-server-sdk，可 Node 直接跑）
 * ------------------------------------------------------------------
 * 目标：把「取件码识别不准」从「靠猜」拉回「靠版面与标签」。
 *
 * 抽取顺序（不可调换）：
 *   1. 先定页面类型（关键词加权，不看单个词）
 *   2. 再定取件码位置（必须紧跟标签 / 或紧邻复制按钮·二维码）
 *   3. 排除干扰数字（订单号、退货单号、运单号、手机号、金额、时间、门牌号）
 *   4. OCR 错识处理（raw 原样保留；normalized 只做 O→0、o→0、l→1、I→1）
 *
 * 硬约束：
 *   - 没有标签、也不在复制/二维码旁 → 判定「没有取件码」，不猜。
 *   - 不在「像取件码」的基础上补字符。
 *   - 输出只有 8 个字段，缺值给空串，不给 null。
 *
 * 与既有代码的关系：
 *   本模块是**新增通道**，不改动 ocr.js 的既有字段语义（pickupCode / pickup_confidence /
 *   need_confirm 保持原样）。两处结论冲突时，前端优先用本模块结果（仅当 has_pickup_code=true）。
 * ------------------------------------------------------------------
 */

/** 取件码标签（出现即强证据） */
const CODE_LABELS = ['取件码', '提货码', '取件口令'];

/** 「独立展示」标记：复制按钮 / 二维码 / 条码 */
const COPY_MARKERS = ['复制'];
const QR_MARKERS = ['二维码', '条码', '扫码'];

/**
 * 码值形态：4~6 位，不含连字符（含「-」的一律是订单号）。
 * 允许 OCR 混淆字符 O/o/l/I —— 它们先被接受，再由 normalizeCode 归一成数字；
 * 若在准入阶段就拒掉，「O128 → 0128」这条规则永远不会生效。
 */
const DIGIT_CODE_RE = /^[0-9OolI]{4,6}$/;

/** 说明句特征：形似码值但其实是提示文案 */
const EXPLAIN_RE = /请在|请向|请凭|请出|出示|快递员/;

/** 快递公司名（用于 express_company，菜鸟属驿站品牌不算承运商） */
const COURIERS = ['顺丰', '中通', '圆通', '韵达', '申通', '极兔', '邮政', 'EMS', '京东物流', '德邦'];

/** 订单号标签 */
const ORDER_LABELS = ['订单编号', '订单号码', '订单号', '交易订单号', '交易单号', '订单ID', 'order_id'];

/** 退货/售后单号标签（用于排除，不填 order_sn） */
const RETURN_LABELS = ['退货单号', '退款单号', '售后单号', '服务单号', '退货编号', '退款编号'];

/** 运单号标签 */
const EXPRESS_LABELS = ['运单号', '快递单号', '物流单号', '快递编号'];

/** 取件时间标签 */
const TIME_LABELS = ['上门时间', '取件时间', '预约取件时间', '上门取件时间', '预约时间'];

/** 地址标签 */
const ADDRESS_LABELS = ['取件地址', '上门地址', '退货地址', '收货地址'];

/** 页面类型（schema 约定值，输出用这四个） */
const PAGE_TYPE = {
  ORDER_DETAIL: 'order_detail',
  AFTER_SALE: 'after_sale_detail',
  PICKUP_CODE: 'pickup_code_page',
  UNKNOWN: 'unknown',
};

/**
 * 内部识别桶：比 schema 多两级细分，只在本模块内用，输出前映射成 PAGE_TYPE。
 * 细分的原因：「申请成功页」必须短路成无码，「选方式页」不能出码但也不短路，
 * 二者对外都归为 after_sale_detail，对内必须分开。
 */
const BUCKET = {
  ORDER: 'order',
  APPLIED: 'applied',
  BOOK: 'book',
  CODE: 'code',
  WAIT: 'wait',
  LOGISTICS: 'logistics',
};

/** 内部桶 → schema 页面类型 */
function mapBucketToPageType(bucket) {
  if (bucket === BUCKET.ORDER) return PAGE_TYPE.ORDER_DETAIL;
  if (bucket === BUCKET.APPLIED || bucket === BUCKET.BOOK) return PAGE_TYPE.AFTER_SALE;
  if (bucket === BUCKET.CODE || bucket === BUCKET.WAIT) return PAGE_TYPE.PICKUP_CODE;
  return PAGE_TYPE.UNKNOWN;
}

/** 轻量行切分（与 ocr.js 的 toLines 语义一致，本模块自持以保持独立可测） */
function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(Boolean);
}

/** 码值形态判断（去掉空白后再判） */
function isCodeShaped(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!v) return false;
  return DIGIT_CODE_RE.test(v);
}

/**
 * 从一行里切出「完整的」字母数字串。
 * 关键：被更长串包住的片段直接丢弃——否则 15 位订单号会被截成 8 位当取件码。
 * 补充：拼多多订单号形如 `261015-521320568353024`，连字符两侧仍是同一串数字，
 *       若不认这一点，「261015」会被当成独立的 6 位码（目录样本实测误抽）。
 */
function codeTokens(line) {
  const s = String(line || '');
  const out = [];
  const re = /[0-9A-Za-z]{4,8}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? s.charAt(start - 1) : '';
    const after = end < s.length ? s.charAt(end) : '';

    // 前后紧邻字母数字 → 是长串的一部分，丢弃
    if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;

    // 前后是「连字符 + 数字」→ 属于带分隔符的长编号（如 261015-521320568353024），丢弃
    const afterNext = end + 1 < s.length ? s.charAt(end + 1) : '';
    if (after === '-' && /[0-9]/.test(afterNext)) continue;
    const beforePrev = start > 1 ? s.charAt(start - 2) : '';
    if (before === '-' && /[0-9]/.test(beforePrev)) continue;

    out.push(m[0]);
  }
  return out;
}

/** 判断一行是否只是说明文案（不是码值行） */
function isExplainLine(line) {
  const s = String(line || '');
  if (!s) return true;
  if (isCodeShaped(s)) return false;
  return EXPLAIN_RE.test(s);
}

/** 只做保守修正：O→0、o→0、l→1、I→1 */
function normalizeCode(raw) {
  return String(raw || '')
    .replace(/[Oo]/g, '0')
    .replace(/[lI]/g, '1');
}

/** 某一行是否含取件码标签，返回标签位置（无则 -1） */
function labelIndexIn(line) {
  const s = String(line || '');
  for (let i = 0; i < CODE_LABELS.length; i++) {
    const idx = s.indexOf(CODE_LABELS[i]);
    if (idx > -1) return { index: idx, label: CODE_LABELS[i] };
  }
  return null;
}

/** 按标签取值：同行优先，其次下一行（跳过说明句；跨行的值要过干扰项过滤） */
function findLabelCode(lines, ctx) {
  for (let i = 0; i < lines.length; i++) {
    const found = labelIndexIn(lines[i]);
    if (!found) continue;

    const tail = lines[i].slice(found.index + found.label.length);
    const sameLine = codeTokens(tail).filter(isCodeShaped);
    if (sameLine.length) {
      return { raw: sameLine[0], lineIndex: i, mode: 'label-same-line' };
    }

    for (let k = 1; k <= 2 && i + k < lines.length; k++) {
      const next = lines[i + k];
      if (isExplainLine(next)) continue;
      // 下一行是单号/地址/金额行时，行内数字属于那些字段，不是取件码
      if (NUMBER_OWNER_LINE_RE.test(next)) continue;
      // 跨行取到的值只在不是年份/日期/手机号/单号时才算数：
      // 标签独占一行时，紧邻的「2026」更可能是年份而不是码
      const tokens = codeTokens(next)
        .filter(isCodeShaped)
        .filter(function (t) { return !isNoiseToken(t, ctx); });
      if (tokens.length) {
        return { raw: tokens[0], lineIndex: i + k, mode: 'label-next-line' };
      }
      if (next.length > 14) break; // 太长，不像码值行
    }
  }
  return null;
}

/**
 * 「这个数字属于别的字段」的行特征：出现这些标签的行，行内数字不得当取件码。
 * 规则表 §4.3：门牌号、金额、单号都属于明确排除项。
 * 用在两处：①「取件码」标签的下一行 ②「复制」按钮所在行及相邻行。
 */
const NUMBER_OWNER_LINE_RE =
  /订单号|订单编号|订单号码|运单号|快递单号|物流单号|商家地址|退货地址|收货地址|取件地址|上门地址|实付|付款|金额|预估费用|运费/;

/** 「复制」按钮 / 二维码旁独立展示的码（必须靠近取件码语义，避免抓到订单号的复制） */
function findCopyQrCode(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 目录样本天然反例：选择退货方式页唯一「复制」属于商家地址「汉世刘家退货组」
    if (NUMBER_OWNER_LINE_RE.test(line)) continue;

    const isCopy = COPY_MARKERS.some(function (m) { return line.indexOf(m) > -1; });
    const isQr = QR_MARKERS.some(function (m) { return line.indexOf(m) > -1; });
    if (!isCopy && !isQr) continue;

    // 上下文里必须有「取件码」语义，或本身就是二维码/扫码
    const from = Math.max(0, i - 3);
    const to = Math.min(lines.length, i + 4);
    const nearbyLabel = lines
      .slice(from, to)
      .some(function (l) { return !!labelIndexIn(l); });
    if (!nearbyLabel && !isQr) continue;

    const own = codeTokens(line).filter(isCodeShaped);
    if (own.length) return { raw: own[0], lineIndex: i, mode: 'copy-same-line' };

    const offsets = [1, -1];
    for (let k = 0; k < offsets.length; k++) {
      const j = i + offsets[k];
      if (j < 0 || j >= lines.length) continue;
      if (isExplainLine(lines[j])) continue;
      // 邻居行本身是单号/地址时，它的数字不能当取件码
      if (NUMBER_OWNER_LINE_RE.test(lines[j])) continue;
      const tokens = codeTokens(lines[j]).filter(isCodeShaped);
      if (tokens.length) return { raw: tokens[0], lineIndex: j, mode: 'copy-near-line' };
    }
  }
  return null;
}

/** 看起来像年份/日期/手机号的值，不参与兜底（标签直取不套这层） */
function isNoiseToken(token, ctx) {
  const t = String(token || '');
  if (!t) return true;
  if (ctx && ctx.orderSn && t === ctx.orderSn) return true;
  if (ctx && ctx.returnNo && t === ctx.returnNo) return true;
  if (ctx && ctx.expressNo && t === ctx.expressNo) return true;
  if (/^1[3-9]\d{9}$/.test(t)) return true; // 手机号
  if (/^(19|20)\d{2}$/.test(t)) return true; // 年份
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(t)) return true; // 日期
  return false;
}

/** 兜底：同页多个数字串时，取离「取件码」标签最近的那个（距离相同取靠前） */
function findNearestToLabel(lines, labelLine, ctx) {
  let best = null;
  let bestDistance = Infinity;

  for (let i = 0; i < lines.length; i++) {
    // 单号/地址/金额行里的数字属于那些字段，兜底也不能取
    if (NUMBER_OWNER_LINE_RE.test(lines[i])) continue;
    const tokens = codeTokens(lines[i]).filter(isCodeShaped);
    for (let k = 0; k < tokens.length; k++) {
      if (isNoiseToken(tokens[k], ctx)) continue;
      const distance = Math.abs(i - labelLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { raw: tokens[k], lineIndex: i, mode: 'nearest-to-label' };
      }
    }
  }
  return best;
}

/** 取标签后的值（同行的冒号后 / 否则下一行） */
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

/** 订单号：只认订单标签，不拿退货运单号来凑（那是业务兜底，不属于本模块职责） */
function extractOrderSn(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let k = 0; k < ORDER_LABELS.length; k++) {
      const idx = line.indexOf(ORDER_LABELS[k]);
      if (idx < 0) continue;
      const tail = line.slice(idx + ORDER_LABELS[k].length);
      const m = tail.match(/[A-Za-z0-9][A-Za-z0-9_-]{7,39}/);
      if (m) return m[0];
      if (i + 1 < lines.length) {
        const m2 = String(lines[i + 1] || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{7,39}/);
        if (m2) return m2[0];
      }
    }
  }
  return '';
}

/** 运单号（用于排除，不直接返回给前端表单） */
function extractExpressNo(lines) {
  const v = valueAfterLabels(lines, EXPRESS_LABELS);
  const m = String(v || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{7,39}/);
  return m ? m[0] : '';
}

/**
 * 快递公司：优先「快递公司/承运」标签行；排除商家地址里的「拒收申通」这类字样。
 *
 * @param {string[]} lines
 * @param {boolean} labelOnly true 时只认带「快递公司/承运」标签的行。
 *   规则表 §5：订单详情页没有承运商字段（只有代收点），非标签命中一律算误抽。
 */
/**
 * 快递公司：只认带「快递公司/承运/物流公司」标签的行。
 *
 * 不做全页扫快递公司名——订单详情页只有代收点（如「兔喜生活」），
 * 商家地址里也会出现「（拒收申通）」这类字样，扫全页必然误抽。
 * 抽不到就留空，不猜。
 */
function extractExpressCompany(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/快递公司|承运|快递[：:]|物流公司/.test(line)) continue;
    if (/拒收|商家地址|退货地址/.test(line)) continue;
    for (let k = 0; k < COURIERS.length; k++) {
      if (line.indexOf(COURIERS[k]) > -1) return COURIERS[k];
    }
  }
  return '';
}

/** 取件时间：先标签，再「…快递员将上门取件」句子；原样返回，不做日期推断 */
function extractPickupTime(lines, text) {
  const byLabel = valueAfterLabels(lines, TIME_LABELS);
  if (byLabel) return byLabel;

  const m = String(text || '').match(/([^\n]{0,24}\d[^\n]{0,16}上门取件)/);
  return m ? m[1].trim() : '';
}

/** 地址：先取件/上门地址，再退货/收货地址 */
function extractAddress(lines) {
  return valueAfterLabels(lines, ADDRESS_LABELS);
}

/**
 * 页面类型：关键词加权，取最高分；同分按「待取件页 > 取件码展示页 > 预约页 > 申请成功页 > 物流页」。
 * 全 0 返回空串（判不出来就不硬判）。
 */
function detectPageType(text) {
  const t = String(text || '');
  const has = function (w) { return t.indexOf(w) > -1; };

  let code = 0;
  let wait = 0;
  let book = 0;
  let applied = 0;
  let logi = 0;
  let order = 0;

  // 取件码展示页：码 + 独立展示组件
  if (has('取件码') || has('提货码') || has('取件口令')) code += 3;
  if (has('复制')) code += 1;
  if (/二维码|扫码|条码/.test(t)) code += 1;

  // 待取件页：已预约 + 快递员 + 取件提示
  if (has('待取件') || has('待快递员取件')) wait += 3;
  if (has('预约成功') || has('已预约')) wait += 2;
  if (/快递员[：:]/.test(t) || has('快递员已接单') || has('快递员将上门')) wait += 2;
  if (has('请在快递员上门后出示')) wait += 1;
  if (has('取消预约') || has('修改预约')) wait += 1;

  // 上门取件预约页：还没生成码，只有方式/时间/地址
  if (has('上门取件')) book += 2;
  if (has('上门时间')) book += 2;
  if (has('取件地址')) book += 1;
  if (has('请选择退货方式')) book += 2;
  if (has('立即退回')) book += 1;
  if (/去服务点|去快递柜|自行退回/.test(t)) book += 1;

  // 退货申请成功页：无码页
  if (has('退货申请成功') || has('申请成功') || has('已提交')) applied += 3;
  if (has('商家处理中') || has('待商家处理')) applied += 2;

  // 物流详情页
  if (has('物流详情') || has('运单号') || has('物流轨迹')) logi += 2;
  if (/运输中|派送中|已签收|已揽收|已发出/.test(t)) logi += 2;

  // 订单详情页（规则表 §2：另一套外壳，有收件人卡/商品卡/订单号+复制/商品快照/确认收货）
  if (has('订单号') || has('订单编号') || has('订单号码')) order += 2;
  if (has('商品快照')) order += 2;
  if (has('确认收货')) order += 2;
  if (has('查看物流')) order += 1;
  if (has('分享商品') || has('联系商家')) order += 1;
  if (has('实付') || has('先用后付')) order += 1;

  const table = [
    [BUCKET.WAIT, wait],
    [BUCKET.CODE, code],
    [BUCKET.BOOK, book],
    [BUCKET.ORDER, order],
    [BUCKET.APPLIED, applied],
    [BUCKET.LOGISTICS, logi],
  ];

  let bestType = '';
  let bestScore = 0;
  for (let i = 0; i < table.length; i++) {
    if (table[i][1] > bestScore) {
      bestScore = table[i][1];
      bestType = table[i][0];
    }
  }
  return bestType;
}

/** 在 blocks 里找承载该码值的区块（整块等于，或整块含码值且含标签） */
function findCodeBlock(blocks, raw) {
  const list = Array.isArray(blocks) ? blocks : [];
  const target = String(raw || '').trim();
  if (!target) return null;

  for (let i = 0; i < list.length; i++) {
    const text = String((list[i] && list[i].text) || '').trim();
    if (text === target) return list[i];
  }
  for (let i = 0; i < list.length; i++) {
    const text = String((list[i] && list[i].text) || '');
    if (text.indexOf(target) > -1 && labelIndexIn(text)) return list[i];
  }
  return null;
}

/**
 * 字符断裂判断：OCR 把码值拆成单字符，或码值由多个区块拼起来。
 * 只在有 blocks 或能观察到断裂特征时才判 true，判不了不算断裂。
 */
function detectBreak(lines, hit, blocks) {
  // 1. 单字符被空白拆开，如「2 2 8 1」
  const from = Math.max(0, hit.lineIndex - 1);
  const to = Math.min(lines.length, hit.lineIndex + 2);
  const scope = lines.slice(from, to).join(' ');
  if (/(?:[0-9A-Za-z][\s·]){3,}[0-9A-Za-z]/.test(scope)) return true;

  // 2. 有区块信息但没有任何区块完整承载该码值 → 是拼出来的
  if (Array.isArray(blocks) && blocks.length) {
    return !findCodeBlock(blocks, hit.raw);
  }
  return false;
}

/**
 * 主入口：结构化抽取取件码。
 *
 * 第 0 步先看平台：`platform` / `platform_conf` 由 platform-gate 给出。
 *   - platform=pdd 且 conf 非 low → 全规则（含邻近兜底）
 *   - 其他情况（含未判定）→ 只做通用标签直取，不跑拼多多专属兜底，结果强制标低置信
 *   - 未传 platform（模块单独调用）→ 按全规则处理，保持既有行为
 *
 * @param {{page_text?:string, blocks?:Array<{text:string,bbox:object,score:number}>,
 *          platform?:string, platform_conf?:string}} input
 * @returns {{page_type:string, has_pickup_code:boolean, pickup_code_raw:string,
 *            pickup_code_normalized:string, low_confidence:boolean,
 *            express_company:string, order_sn:string, pickup_time:string, address:string}}
 */
function extractPickupStructured(input) {
  const pageText = String((input && input.page_text) || '');
  const blocks = Array.isArray(input && input.blocks) ? input.blocks : [];
  const lines = toLines(pageText);

  // 第 0 步：平台准入
  const platformCode = String((input && input.platform) || '').toLowerCase();
  const platformConf = String((input && input.platform_conf) || '').toLowerCase();
  const hasPlatformHint = !!platformCode;
  const pddRules = !hasPlatformHint || (platformCode === 'pdd' && platformConf !== 'low');

  const bucket = detectPageType(pageText);
  const pageType = mapBucketToPageType(bucket);

  // 干扰项上下文：这些值一旦和某个数字串相同，就不能当取件码
  const returnRaw = valueAfterLabels(lines, RETURN_LABELS);
  const returnMatch = String(returnRaw || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{5,39}/);
  const ctx = {
    orderSn: extractOrderSn(lines),
    returnNo: returnMatch ? returnMatch[0] : '',
    expressNo: extractExpressNo(lines),
  };

  // 快递公司只认明确标签行（订单页自然抽不到 → 留空，不猜）
  const pageExpressCompany = extractExpressCompany(lines);

  // 1. 无码页直接短路：申请成功 / 已提交这类页面按约定一律 has=false
  let hit = null;
  if (bucket !== BUCKET.APPLIED) {
    hit = findLabelCode(lines, ctx);
    if (!hit) hit = findCopyQrCode(lines);
    // 邻近兜底是拼多多专属（依赖「取件码」文案在本页的位置），平台不达标时不用
    if (!hit && pddRules) {
      let labelLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (labelIndexIn(lines[i])) { labelLine = i; break; }
      }
      if (labelLine > -1) hit = findNearestToLabel(lines, labelLine, ctx);
    }
  }

  // 无标签也非复制/二维码旁 → 按约定没有取件码，不猜
  if (!hit) {
    return {
      platform: platformCode || 'unknown',
      platform_conf: platformConf || 'low',
      page_type: pageType,
      has_pickup_code: false,
      pickup_code_raw: '',
      pickup_code_normalized: '',
      low_confidence: false,
      order_sn: ctx.orderSn,
      express_company: pageExpressCompany,
      pickup_time: extractPickupTime(lines, pageText),
      address: extractAddress(lines),
    };
  }

  const raw = String(hit.raw || '').trim();
  const broken = detectBreak(lines, hit, blocks);
  const block = findCodeBlock(blocks, raw);
  const score = block && typeof block.score === 'number' ? block.score : null;
  const lowByScore = typeof score === 'number' ? score < 0.6 : false;
  // 平台没定成拼多多时，即使抽到了码也不能当高置信用
  const lowByPlatform = !pddRules;
  const low = broken || lowByScore || lowByPlatform;

  return {
    platform: platformCode || 'unknown',
    platform_conf: platformConf || 'low',
    page_type: pageType,
    has_pickup_code: true,
    pickup_code_raw: raw,
    // 低置信时留空：宁可让用户看原样，也不给一个「修正过但可能是错的」值
    pickup_code_normalized: low ? '' : normalizeCode(raw),
    low_confidence: low,
    order_sn: ctx.orderSn,
    express_company: pageExpressCompany,
    pickup_time: extractPickupTime(lines, pageText),
    address: extractAddress(lines),
  };
}

module.exports = {
  PAGE_TYPE,
  BUCKET,
  mapBucketToPageType,
  CODE_LABELS,
  isCodeShaped,
  codeTokens,
  normalizeCode,
  detectPageType,
  findLabelCode,
  findCopyQrCode,
  findNearestToLabel,
  extractOrderSn,
  extractExpressCompany,
  extractExpressNo,
  extractPickupTime,
  extractAddress,
  extractPickupStructured,
};
