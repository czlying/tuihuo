/**
 * 业务 API 云函数
 * ------------------------------------------------------------------
 * 用 action 路由的方式把多个动作收在一个函数里，而不是为每个动作建一个云函数。
 * 原因：
 *   1. 减少冷启动次数（小程序云函数冷启动是体验大头）；
 *   2. 部署只需一次，维护成本低。
 * 内部按 handler 分文件组织，保持可读性（后续动作多了按需再拆）。
 *
 * 当前动作：
 *   whoami  —— 返回调用者的 openid 与 uid。
 *              小程序端拿不到自己的 openid，必须经云函数获取。
 *              v1 里 uid === openid；v2 接独立 App 时 uid 改为自建用户 ID，
 *              这里换成查 users 集合即可，前端不用改。
 *
 *   horoscope —— 今日双鱼座运势（聚合数据代理）。
 *              Key 从环境变量 JUHE_KEY 读，绝不出现在前端；
 *              失败时前端保持静态兜底文案，不白屏不报错。
 *
 *   horoscopeProbe —— 运势接口自检：返回 Key 是否读到、HTTP 状态、
 *              聚合数据错误码与中文结论。用于排查「配置了为什么没生效」。
 *
 * 安全约定（重要）：
 *   任何动作都不能相信前端传来的 uid / openid。
 *   用户身份一律取 cloud.getWXContext()，这是微信在服务端注入的，无法伪造。
 * ------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// OCR 纯逻辑（字段抽取），独立文件便于测试
const ocr = require('./ocr');
// 取件码结构化抽取（版面 + 标签优先，不猜），独立文件便于 Node 测试
const pickupExtract = require('./pickup-extract');
// 第 0 步平台闸门（pdd / taobao / jd / express / unknown），决定后续规则用哪档
const platformGate = require('./platform-gate');
// 星座运势（聚合数据代理）：纯逻辑 + 请求，独立文件便于 Node 测试
const horoscope = require('./horoscope');

let _ocrClient = null;

/** 复用 OCR client，避免每次调用重新初始化 SDK */
function getOcrClient(secretId, secretKey) {
  if (_ocrClient) return _ocrClient;

  const tencentcloud = require('tencentcloud-sdk-nodejs-ocr');
  const OcrClient = tencentcloud.ocr.v20181119.Client;

  _ocrClient = new OcrClient({
    credential: { secretId: secretId, secretKey: secretKey },
    region: 'ap-guangzhou',
    profile: {
      httpProfile: { endpoint: 'ocr.tencentcloudapi.com' },
    },
  });

  return _ocrClient;
}

/** 回退路径：下载云存储图片并转 base64 */
async function buildBase64Params(fileID) {
  const download = await cloud.downloadFile({ fileID: fileID });
  return { ImageBase64: download.fileContent.toString('base64') };
}

const handlers = {
  /**
   * 获取当前调用者身份。
   */
  async whoami(event, context) {
    const wxContext = cloud.getWXContext();

    return {
      ok: true,
      data: {
        openid: wxContext.OPENID || '',
        // v1：uid 与 openid 同值，业务层统一用 uid，
        // 将来换账号体系时只改这一行，业务代码不用动。
        uid: wxContext.OPENID || '',
        appid: wxContext.APPID || '',
        unionid: wxContext.UNIONID || '',
      },
    };
  },

  /**
   * 健康检查。用于确认云函数已正确部署、环境变量可达。
   */
  async health() {
    return {
      ok: true,
      data: {
        service: 'tuihuo-api',
        version: '1.0.0',
        serverTime: new Date().toISOString(),
      },
    };
  },

  /**
   * 今日双鱼座运势（聚合数据代理）。
   *
   * Key 从环境变量 JUHE_KEY 读，绝不出现在前端；前端只请求本动作。
   * 失败（未配 key / 超时 / 网络 / 接口报错）时返回 ok:false，
   * 前端保持静态兜底文案，不白屏不报错。
   *
   * 返回：{ ok, data: { text } }
   */
  async horoscope() {
    const key = process.env.JUHE_KEY || '';
    if (!key) {
      return {
        ok: false,
        code: 'FORTUNE_NOT_CONFIGURED',
        message: '运势接口未配置密钥，请在云函数环境变量中设置 JUHE_KEY',
      };
    }

    try {
      const text = await horoscope.fetchHoroscope({ key: key });
      return { ok: true, data: { text: text } };
    } catch (err) {
      // 失败原因（HTTP 状态 / error_code / reason）带回前端日志，
      // 否则只看得到「没生效」，无从排查
      return {
        ok: false,
        code: 'FORTUNE_FETCH_FAILED',
        message: (err && err.message) || '运势接口请求失败',
      };
    }
  },

  /**
   * 运势接口自检：把「Key 是否读到 / 是否带空格 / HTTP 状态 / 聚合数据错误码」
   * 摊开返回，并附一句中文结论与下一步操作。设置页一键调用。
   *
   * 不返回 Key 本身，只返回长度与是否含首尾空白。
   * 本动作本身失败（如云端代码未更新）时前端会收到 UNKNOWN_ACTION，
   * 这正好说明「api 云函数没有重新部署」。
   */
  async horoscopeProbe() {
    const key = process.env.JUHE_KEY || '';
    const probe = await horoscope.probeHoroscope({ key: key });

    return {
      ok: true,
      data: Object.assign({}, probe, {
        conclusion: horoscope.buildProbeConclusion(probe),
      }),
    };
  },

  /**
   * OCR 识别订单截图。
   *
   * 入参：event.fileID —— 已上传到云存储的图片 fileID。
   * 流程：临时 URL → 腾讯云 OCR「通用印刷体识别」→ 抽取字段返回；
   *       URL 拉取失败时回退「下载图片 + base64」，保证识别不中断。
   * 密钥从环境变量读（OCR_SECRET_ID / OCR_SECRET_KEY），绝不写进代码。
   *
   * 返回：{ ok, data: { rawText, productName, amount, date, platform } }
   *   前端把结果回填表单，由用户核对后保存（识别结果仅作建议）。
   */
  async ocrOrder(event, context) {
    const fileID = (event && event.fileID) || '';
    if (!fileID) {
      return { ok: false, code: 'NO_FILE', message: '缺少图片 fileID' };
    }

    const secretId = process.env.OCR_SECRET_ID || '';
    const secretKey = process.env.OCR_SECRET_KEY || '';
    if (!secretId || !secretKey) {
      return {
        ok: false,
        code: 'OCR_NOT_CONFIGURED',
        message: 'OCR 尚未配置密钥，请在云函数环境变量中设置 OCR_SECRET_ID 与 OCR_SECRET_KEY',
      };
    }

    // 1. 优先取临时 URL，让腾讯云 OCR 直接拉图：
    //    省掉云函数 downloadFile + base64 的额外一跳和内存拷贝
    let imageUrl = '';
    try {
      const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
      const first = (urlRes && urlRes.fileList && urlRes.fileList[0]) || null;
      imageUrl = (first && first.tempFileURL) || '';
    } catch (err) {
      console.warn('[ocr] 获取临时 URL 失败，回退 base64', err && err.message);
    }

    // 2. 调腾讯云 OCR（通用印刷体识别，GeneralBasicOCR）
    const client = getOcrClient(secretId, secretKey);
    let resp;

    try {
      resp = imageUrl
        ? await client.GeneralBasicOCR({ ImageUrl: imageUrl })
        : await client.GeneralBasicOCR(await buildBase64Params(fileID));
    } catch (err) {
      // ImageUrl 拉取失败（URL 过期/网络）时回退 base64，保证识别不中断
      if (!imageUrl) throw err;
      console.warn('[ocr] ImageUrl 识别失败，回退 base64', err && err.message);
      resp = await client.GeneralBasicOCR(await buildBase64Params(fileID));
    }

    // 3. 拼接识别出的全部文本
    const rawText = (resp.TextDetections || [])
      .map(function (d) { return d.DetectedText || ''; })
      .join('\n');

    // 3.1 版面区块（text + bbox + score）：取件码抽取用它做邻近判断与置信度，
    //     腾讯云 OCR 的 ItemPolygon 是 {X,Y,Width,Height}，Confidence 是 0-100
    const blocks = (resp.TextDetections || []).map(function (d) {
      const poly = d.ItemPolygon || {};
      return {
        text: d.DetectedText || '',
        bbox: {
          x: Number(poly.X) || 0,
          y: Number(poly.Y) || 0,
          w: Number(poly.Width) || 0,
          h: Number(poly.Height) || 0,
        },
        score: typeof d.Confidence === 'number' ? d.Confidence / 100 : 0,
      };
    });

    // 4. 平台感知的结构化抽取（平台 + 置信度 + 订单/售后字段）
    const extracted = ocr.analyzeOrder(rawText);

    // 4.1 第 0 步：平台闸门（英文平台码 + 置信档 + 命中证据 + 规则档位）
    const gate = platformGate.detectPlatformGate(rawText);

    // 4.1.1 闸门结果回填既有中文字段：无品牌词的拼多多售后页，analyzeOrder 会给空，
    //       此时用闸门兜一次（只补 pdd 且非 low，其他平台不抢既有结论）
    const gatePddName = gate.platform === 'pdd' && gate.platform_conf !== 'low' ? '拼多多' : '';
    const formPlatform = extracted.platform || gatePddName;
    const formPlatformConfidence =
      extracted.platform && extracted.platformConfidence !== 'unknown'
        ? extracted.platformConfidence
        : gatePddName
          ? gate.platform_conf === 'mid'
            ? 'medium'
            : gate.platform_conf
          : 'unknown';

    // 4.2 取件码结构化结果（新增通道，8 个字段；平台不达标时只做通用标签抽取）
    const pickup = pickupExtract.extractPickupStructured({
      page_text: rawText,
      blocks: blocks,
      platform: gate.platform,
      platform_conf: gate.platform_conf,
    });

    return {
      ok: true,
      data: {
        rawText: rawText,
        ocrVersion: extracted.ruleVersion,
        productName: extracted.productName,
        amount: extracted.amount,
        amountLabel: extracted.amountLabel,
        date: extracted.date,
        platform: formPlatform,
        platformConfidence: formPlatformConfidence,
        pageKind: extracted.pageKind,
        orderNo: extracted.orderNo,
        orderNoLabel: extracted.orderNoLabel,
        orderNoIsFallback: extracted.orderNoIsFallback,
        returnNo: extracted.returnNo,
        returnNoLabel: extracted.returnNoLabel,
        returnReason: extracted.returnReason,
        pickupCode: extracted.pickupCode,
        // 取件码专用输出（识别取件码入口用）：标签命中为 high，
        // 6 位数字正则兜底为 low，此时 need_confirm=true 让用户核对
        pickup_code: extracted.pickupCode || null,
        // confidence 与 pickup_confidence 同值：前者是「识别取件码」入口的约定字段名
        confidence: extracted.pickupConfidence || '',
        pickup_confidence: extracted.pickupConfidence || '',
        need_confirm: !!extracted.needConfirm,
        // 取件码结构化抽取结果（页型 / 原始码 / 归一化码 / 低置信 / 快递公司 / 订单号 / 时间 / 地址）
        pickup: pickup,
        // 第 0 步平台闸门：platform 是英文码（pdd/taobao/jd/express/unknown），
        // 与上面既有中文 `platform` 并存，两者用途不同
        platform_gate: gate,
        order_no: extracted.orderNo || null,
        raw_lines: extracted.rawLines || [],
        pickupTime: extracted.pickupTime,
        statusRaw: extracted.statusRaw,
        statusKey: extracted.statusKey,
        evidence: extracted.evidence,
      },
    };
  },
};

exports.main = async (event, context) => {
  const action = (event && event.action) || '';

  if (!action) {
    return { ok: false, code: 'NO_ACTION', message: '缺少 action 参数' };
  }

  const handler = handlers[action];
  if (!handler) {
    return { ok: false, code: 'UNKNOWN_ACTION', message: '未知动作：' + action };
  }

  try {
    return await handler(event, context);
  } catch (err) {
    console.error('[api] action=' + action + ' 执行失败', err);
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: (err && err.message) || '服务异常',
    };
  }
};
