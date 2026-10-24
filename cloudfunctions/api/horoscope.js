/**
 * 星座运势（聚合数据代理）—— 云函数侧纯逻辑 + 请求 + 自检
 * ------------------------------------------------------------------
 * Key 只从环境变量 JUHE_KEY 读（由 index.js 注入），绝不写进代码、
 * 绝不流到前端。本文件不依赖 wx-server-sdk，可在 Node 里直接 require
 * 做单元测试（见 scripts/verify-models.js）。
 *
 * 接口：https://web.juhe.cn/constellation/getAll
 *   GET ?key=...&consName=双鱼座&type=today
 *   成功 { reason, result: { summary, all, love, work, money, ... }, error_code: 0 }
 *   失败 { reason: 'KEY ERROR!', result: [], error_code: 10001 }
 *
 * 注意两个真实坑（不加防护会静默失败）：
 *   1. error_code 有的接口返回字符串 '0'，用 `!== 0` 判断会把成功当失败；
 *   2. result.all / love / work / money 是「运势指数」数字（如 '78'），
 *      不是文案；当成文案展示会显示成 "78"。
 * ------------------------------------------------------------------
 */

const https = require('https');

const JUHE_ENDPOINT = 'https://web.juhe.cn/constellation/getAll';

/** 卡片固定展示双鱼座今日运势；换星座/周期只改这两处 */
const DEFAULT_CONS_NAME = '双鱼座';
const DEFAULT_TYPE = 'today';

/** 云函数侧请求超时（毫秒）。前端服务层另有更长一层的兜底超时，双保险 */
const REQUEST_TIMEOUT = 5000;

/**
 * 文案长度上限。
 * 卡片默认态只显示摘要（前端截 16 字），点开浮层要能看到全文，
 * 所以上限要足够容纳聚合数据整段 summary —— 官方示例约 110 字，
 * 这里给到 400 字，避免再出现「切在第 N 个字」的残句；
 * 同时保留一个上界，防止异常超长返回值被原样搬给前端。
 */
const MAX_TEXT_LENGTH = 400;

/** 判断一段文本是否「能当文案展示」：纯数字是运势指数，不是文案 */
function isDisplayableText(raw) {
  return /[\u4e00-\u9fa5A-Za-z]/.test(String(raw || ''));
}

/** 拼请求地址。key 只在云函数内部流转，不到前端 */
function buildRequestUrl(key, consName, type) {
  return (
    JUHE_ENDPOINT +
    '?key=' +
    encodeURIComponent(String(key || '')) +
    '&consName=' +
    encodeURIComponent(String(consName || DEFAULT_CONS_NAME)) +
    '&type=' +
    encodeURIComponent(String(type || DEFAULT_TYPE))
  );
}

/** 清理文案：去 HTML 标签、压空白、截断到展示上限 */
function cleanText(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** 清理后再判断是否可展示；不可展示返回空串 */
function pickText(raw) {
  const text = cleanText(raw);
  return isDisplayableText(text) ? text : '';
}

/**
 * 归一化接口错误码。
 * 依次看：顶层 error_code → result.error_code（部分接口塞在 result 里）。
 * 返回 null 表示「接口没给错误码」，0 表示成功，其他值为错误。
 * 字符串 '0' 会被正确识别为 0，避免把成功当失败。
 */
function normalizeErrorCode(payload) {
  if (!payload || typeof payload !== 'object') return null;

  let raw = payload.error_code;
  if (raw === undefined) {
    const inner = payload.result;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      raw = inner.error_code;
    }
  }
  if (raw === undefined || raw === null || raw === '') return null;

  const code = Number(raw);
  return isFinite(code) ? code : null;
}

/** 把接口错误拼成一句可读文本，用于日志/错误信息 */
function describeError(payload) {
  if (!payload || typeof payload !== 'object') return '接口无返回内容';
  const code = normalizeErrorCode(payload);
  const reason = String(payload.reason || '').trim();
  if (code === null) return reason || '接口未返回可用文案';
  return 'error_code=' + code + (reason ? '（' + reason + '）' : '');
}

/**
 * 取出结果实体。真实接口见过四种形状，逐层降级：
 *   1. payload.result —— 标准字段（文档上的写法）；
 *   2. payload.data / list / items —— 部分接口改名后的容器；
 *   3. result 本身是数组时取第一条；
 *   4. result 本身是字符串时当成一句话；
 *   5. 以上都没有时，把 payload 顶层当结果（少数接口不包 result，
 *      直接把 date/name/all/summary 放在最外层）。
 * 全部落空返回 null。
 */
function toResultObject(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const candidates = [payload.result, payload.data, payload.list, payload.items];

  for (let i = 0; i < candidates.length; i++) {
    let item = candidates[i];
    if (typeof item === 'string') return { summary: item };
    if (Array.isArray(item)) item = item[0];
    if (item && typeof item === 'object') return item;
  }

  // 顶层兜底：没有容器字段时，结果可能就在最外层
  return payload;
}

/** 运势指数（数字）转成可展示分值；非数字或 <=0 视为没有 */
function toScore(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
}

/** 分项指数 → 「综合78分 · 爱情70分 · 财运90分」；没有任何可展示分数时返回空串 */
function formatScores(result) {
  if (!result) return '';

  const fields = [
    ['all', '综合'],
    ['love', '爱情'],
    ['work', '工作'],
    ['money', '财运'],
  ];

  const parts = [];
  fields.forEach(function (pair) {
    const score = toScore(result[pair[0]]);
    if (score) parts.push(pair[1] + score + '分');
  });

  return parts.length ? cleanText(parts.join(' · ')) : '';
}

/**
 * 从聚合数据返回值里提取一句可展示文案。
 * 优先级：summary（一句话总评）→ all（综合运势）→ 兼容旧结构 content/today
 *         → 拼合 love/work/money 的文字描述 → 都没有时用分项指数拼分值。
 *
 * 之所以保留「分项指数」这一层：聚合数据部分套餐只给 1~5 / 0~100 的指数，
 * 不给 summary 文案。此时返回空会让卡片看起来像没生效，拼成「综合78分」更有用。
 * 接口明确报错时仍返回空串，由调用方走前端静态兜底。
 */
function extractFortuneText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const code = normalizeErrorCode(payload);
  if (code !== null && code !== 0) return '';

  const result = toResultObject(payload);
  if (!result) return '';

  const single =
    pickText(result.summary) ||
    pickText(result.all) ||
    pickText(result.content) ||
    pickText(result.today) ||
    pickText(result.fortune) ||
    pickText(result.text);
  if (single) return single;

  const parts = [];
  if (pickText(result.all)) parts.push('综合' + pickText(result.all));
  if (pickText(result.love)) parts.push('爱情' + pickText(result.love));
  if (pickText(result.work)) parts.push('工作' + pickText(result.work));
  if (pickText(result.money)) parts.push('财运' + pickText(result.money));
  if (parts.length) return cleanText(parts.join('，'));

  return formatScores(result);
}

/**
 * 返回体结构摘要：给自检用。
 * 只描述形状与截断预览，不含请求参数，故不会带出 Key。
 */
function describeShape(payload) {
  const shape = { payloadKeys: [], resultType: 'none', resultKeys: [], preview: '' };
  if (!payload || typeof payload !== 'object') return shape;

  shape.payloadKeys = Object.keys(payload).slice(0, 20);

  try {
    // 200 字够看清字段名与首层内容，又不至于把卡片撑爆
    shape.preview = JSON.stringify(payload).slice(0, 200);
  } catch (e) {
    shape.preview = '';
  }

  const result = payload.result;
  if (Array.isArray(result)) shape.resultType = 'array(' + result.length + ')';
  else if (result === null) shape.resultType = 'null';
  else if (result === undefined) shape.resultType = 'missing';
  else shape.resultType = typeof result;

  const first = Array.isArray(result) ? result[0] : result;
  if (first && typeof first === 'object') {
    shape.resultKeys = Object.keys(first).slice(0, 20);
  }

  return shape;
}


/**
 * 发一次请求，只负责拿到 HTTP 状态与 JSON，不判断业务成败。
 * 网络错误 / 超时 / 非 200 / 非 JSON 一律 reject，错误信息写清阶段。
 * @returns {Promise<{statusCode:number, payload:object}>}
 */
function requestHoroscope(options) {
  const opts = options || {};
  const key = String(opts.key || '');
  const consName = String(opts.consName || DEFAULT_CONS_NAME);
  const type = String(opts.type || DEFAULT_TYPE);

  if (!key) return Promise.reject(new Error('运势接口未配置密钥（JUHE_KEY）'));

  const url = buildRequestUrl(key, consName, type);

  return new Promise(function (resolve, reject) {
    const req = https.get(url, { timeout: REQUEST_TIMEOUT }, function (res) {
      res.setEncoding('utf8');

      if (res.statusCode !== 200) {
        res.resume(); // 丢 body，尽快释放连接
        reject(new Error('运势接口 HTTP ' + res.statusCode));
        return;
      }

      let body = '';
      res.on('data', function (chunk) {
        body += chunk;
      });
      res.on('end', function () {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch (e) {
          reject(new Error('运势接口返回非 JSON'));
          return;
        }
        resolve({ statusCode: res.statusCode, payload: payload });
      });
    });

    req.on('timeout', function () {
      reject(new Error('运势接口请求超时'));
      req.destroy();
    });
    req.on('error', function (err) {
      reject(err);
    });
  });
}

/**
 * 请求今日运势，返回 Promise<string>。
 * 任何失败（缺 key / 超时 / 网络 / 接口报错 / 无可用文案）都 reject，
 * 由前端保持静态兜底文案，不白屏不报错。
 */
function fetchHoroscope(options) {
  return requestHoroscope(options).then(function (res) {
    const text = extractFortuneText(res.payload);
    if (!text) throw new Error('运势接口未返回可用文案：' + describeError(res.payload));
    return text;
  });
}

/**
 * 自检：把「Key 有没有读到 / 带没带空格 / HTTP 状态 / 接口错误码」全部摊开，
 * 供设置页一键排查「配置了为什么还不生效」。不返回 Key 本身。
 * @returns {Promise<object>} 诊断对象，永不 reject
 */
function probeHoroscope(options) {
  const opts = options || {};
  const key = String(opts.key || '');

  const base = {
    hasKey: !!key,
    keyLength: key.length,
    keyHasSpace: /^\s|\s$/.test(key),
  };

  if (!key) {
    return Promise.resolve(
      Object.assign({}, base, { ok: false, stage: 'no-key', error: '云函数未读到 JUHE_KEY' })
    );
  }

  const started = Date.now();

  return requestHoroscope(opts)
    .then(function (res) {
      const text = extractFortuneText(res.payload);
      const shape = describeShape(res.payload);

      // 预览里若出现 Key（极端情况下接口回显请求参数）就抹掉
      if (key && shape.preview.indexOf(key) > -1) {
        shape.preview = shape.preview.split(key).join('***');
      }

      return Object.assign({}, base, {
        ok: !!text,
        stage: 'requested',
        httpStatus: res.statusCode,
        elapsedMs: Date.now() - started,
        errorCode: normalizeErrorCode(res.payload),
        reason: String((res.payload && res.payload.reason) || ''),
        text: text || '',
        payloadKeys: shape.payloadKeys,
        resultType: shape.resultType,
        resultKeys: shape.resultKeys,
        preview: shape.preview,
      });
    })
    .catch(function (err) {
      return Object.assign({}, base, {
        ok: false,
        stage: 'request-failed',
        elapsedMs: Date.now() - started,
        error: (err && err.message) || '请求失败',
      });
    });
}

/**
 * 把返回体形状拼成一行「结构信息」，自检结果里直接展示。
 * 不含请求参数，不会带出 Key。
 */
function buildShapeDetail(probe) {
  const p = probe || {};
  const parts = [];

  if (p.httpStatus) parts.push('HTTP ' + p.httpStatus);
  if (p.payloadKeys && p.payloadKeys.length) parts.push('顶层字段 ' + p.payloadKeys.join('/'));
  if (p.resultType) parts.push('result 类型 ' + p.resultType);
  if (p.resultKeys && p.resultKeys.length) parts.push('result 字段 ' + p.resultKeys.join('/'));
  if (p.preview) parts.push('原文 ' + p.preview);

  return parts.join(' · ');
}

/**
 * 把诊断结果翻译成「结论 + 下一步动作」。纯函数，可单测。
 * 每一步都指向一个具体操作，不给「再试试」这类空话。
 * @returns {{level:'ok'|'error', title:string, advice:string, detail?:string}}
 */
function buildProbeConclusion(probe) {
  const p = probe || {};

  if (!p.hasKey) {
    return {
      level: 'error',
      title: '云函数没读到 JUHE_KEY',
      advice:
        '环境变量没配到 api 云函数，或配完没重新部署。请到云开发控制台 → 云函数 → api → 配置 → 环境变量，添加 JUHE_KEY，保存后右键 cloudfunctions/api 重新「上传并部署」。',
    };
  }

  if (p.keyHasSpace) {
    return {
      level: 'error',
      title: 'JUHE_KEY 首尾带空格或换行',
      advice:
        '复制粘贴时带进了空白字符，接口会判定 Key 无效。请删除该变量重新粘贴，只保留 Key 本身（一串连续字符，前后不要留空），保存后重新部署 api 云函数。',
    };
  }

  if (p.stage === 'request-failed') {
    return {
      level: 'error',
      title: '请求聚合数据失败',
      advice:
        '云函数出网请求没成功（' +
        (p.error || '未知原因') +
        '）。先确认 api 云函数已开启外网访问，再重试一次；持续失败就换网络环境复测。',
    };
  }

  if (p.ok && p.errorCode === 0) {
    return {
      level: 'ok',
      title: '接口正常，文案已取到',
      advice:
        '云端链路没问题。若首页仍显示本地兜底文案，是前端包不是最新版（设置页版本应为 2026-10-24.17），重新编译或重启小程序即可。',
      detail: '取到的文案：' + p.text,
    };
  }

  // 关键分支：接口答应成功了，但没解析出文案。
  // 这不是 Key 问题，不能报成「接口返回异常」，否则会被引向改 Key 的错误方向。
  if (p.errorCode === 0) {
    const noContainer = p.resultType === 'missing' || p.resultType === 'null';
    return {
      level: 'error',
      title: '接口通了，但没解析到文案',
      advice: noContainer
        ? '聚合数据返回 HTTP 200、error_code=0，但没有 result 容器字段。本次已加「顶层字段兜底」：找不到 result / data / list 时，直接按最外层字段解析。重新部署 api 云函数后再检测；若仍显示这条，下方原文就是接口返回的真实内容。'
        : '聚合数据返回 HTTP 200、error_code=0，说明 Key 与接口权限都正常，是返回结构和解析对不上。本次已加兼容：数组取第一条、data/list 容器、只有分值时拼成「综合78分」。重新部署 api 云函数后再检测；若仍显示这条，下方原文就是接口返回的真实内容。',
      detail: buildShapeDetail(p),
    };
  }

  if (p.errorCode === 10001) {
    return {
      level: 'error',
      title: 'Key 无效（error_code=10001）',
      advice:
        '聚合数据返回 KEY ERROR：Key 与该账号不匹配，或复制时不完整。请到聚合数据后台「我的数据」重新复制 Key，替换 JUHE_KEY 后重新部署。',
      detail: buildShapeDetail(p),
    };
  }

  if (p.errorCode === 10002) {
    return {
      level: 'error',
      title: '接口未开通或无权限（error_code=10002）',
      advice:
        '账号还没申请「星座运势」这个接口。到聚合数据后台找到该接口点「申请/开通」，审核通过后再来自检一次。',
      detail: buildShapeDetail(p),
    };
  }

  if (p.errorCode === 10012 || p.errorCode === 10013) {
    return {
      level: 'error',
      title: '请求次数超限（error_code=' + p.errorCode + '）',
      advice:
        '免费额度用完或套餐到期。到聚合数据后台查看剩余次数，充值或换套餐后重试；不影响小程序使用（会自动走兜底文案）。',
      detail: buildShapeDetail(p),
    };
  }

  return {
    level: 'error',
    title: '接口返回异常（error_code=' + (p.errorCode === null ? '无' : p.errorCode) + '）',
    advice:
      '聚合数据返回：' +
      (p.reason || '无 reason') +
      '。HTTP ' +
      (p.httpStatus || '未知') +
      '。按该错误码在聚合数据文档里核对配置，或换一个星座参数复测。',
    detail: buildShapeDetail(p),
  };
}

module.exports = {
  JUHE_ENDPOINT,
  DEFAULT_CONS_NAME,
  DEFAULT_TYPE,
  REQUEST_TIMEOUT,
  MAX_TEXT_LENGTH,
  isDisplayableText,
  buildRequestUrl,
  cleanText,
  pickText,
  normalizeErrorCode,
  describeError,
  toResultObject,
  toScore,
  formatScores,
  extractFortuneText,
  describeShape,
  buildShapeDetail,
  requestHoroscope,
  fetchHoroscope,
  probeHoroscope,
  buildProbeConclusion,
};
