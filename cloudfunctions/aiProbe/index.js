/**
 * 云开发 AI 额度探针（aiProbe）
 *
 * 目的：确认「小程序成长计划」赠送的 Token 额度在当前云开发环境下能不能真正调用。
 * 只看控制台数字不够——套餐类型不对时额度在、调用照样失败，所以必须真发一次请求。
 *
 * 设计约束（为什么不复用 api 云函数）：
 *   cloud.ai() 需要 wx-server-sdk >= 4.0.1，而 api 云函数锁在 ~2.6.3。
 *   升级 api 的 SDK 会同时影响 OCR 与订单读写，风险不对等，故独立成一个函数。
 *
 * 探测两路，任一路 ok 即代表额度可用：
 *   1. cloudbase 分组 + deepseek-v4.1-flash  —— 唯一支持图片的模型；仅资源点套餐可用
 *   2. hunyuan-v3 分组 + hy3                  —— 旧分组，只吃免费额度，任意套餐可用
 * 两路都失败时原样回传错误码，用于判定卡在「套餐类型」还是「额度已耗尽」还是「SDK 版本」。
 *
 * 部署：开发者工具右键本目录 → 「创建并部署：云端安装依赖」
 * 测试：右键 → 「云端测试」，入参留 {} 即可
 */
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 25000,
});

const AI_TIMEOUT_MS = 15000;
const PING = [{ role: 'user', content: '只回复两个字：可用' }];

/** 取 SDK 版本；拿不到就返回空串，不因为读版本号而让整个探针失败 */
function sdkVersion() {
  try {
    return require('wx-server-sdk/package.json').version || '';
  } catch (e) {
    return '';
  }
}

/**
 * 探测单一路径。
 * generateText 是 SDK 参考文档里的方法；部分环境只暴露 invoke，故做一次方法名兜底。
 */
async function probeOne(ai, provider, modelName) {
  const startedAt = Date.now();
  const args = { model: modelName, messages: PING, timeout: AI_TIMEOUT_MS };
  try {
    const model = ai.createModel(provider);
    let res;
    if (typeof model.generateText === 'function') {
      res = await model.generateText(args);
    } else if (typeof model.invoke === 'function') {
      res = await model.invoke(args);
    } else {
      return {
        provider,
        model: modelName,
        ok: false,
        errorCode: 'NO_METHOD',
        errorMsg: '模型实例既没有 generateText 也没有 invoke，SDK 版本可能过低',
        costMs: Date.now() - startedAt,
      };
    }
    const text = String(
      (res && (res.text || (res.choices && res.choices[0] && res.choices[0].delta && res.choices[0].delta.content))) || ''
    ).slice(0, 60);
    return {
      provider,
      model: modelName,
      ok: true,
      text,
      usage: (res && res.usage) || null,
      costMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      provider,
      model: modelName,
      ok: false,
      errorCode: String((err && (err.code || err.errCode)) || ''),
      errorMsg: String((err && (err.message || err.errMsg)) || err).slice(0, 300),
      costMs: Date.now() - startedAt,
    };
  }
}

/** 把错误码翻成一句人话，避免用户面对裸错误码无从下手 */
function explain(results) {
  if (results.some((r) => r.ok)) return '额度可用';
  const codes = results.map((r) => r.errorCode + ' ' + r.errorMsg).join(' | ');
  if (/套餐|package|quota.?plan|resource/i.test(codes)) {
    return '额度在但套餐类型不对：cloudbase 分组要求资源点套餐，请到云开发控制台 → 套餐管理 查套餐类型';
  }
  if (/concurrent/i.test(codes)) return '并发超限，稍后重试即可，额度本身没问题';
  if (/expire|耗尽|exceed/i.test(codes)) return '额度已耗尽或过期，见控制台 → AI 模型用量';
  return '两种分组都调不通，先确认额度是否已到账（控制台 → AI 模型用量）与网络';
}

exports.main = async (event) => {
  if (typeof cloud.ai !== 'function') {
    return {
      ok: false,
      stage: 'sdk',
      sdkVersion: sdkVersion(),
      hint: '当前 wx-server-sdk 没有 cloud.ai()，需 >= 4.0.1；把本函数 package.json 的版本改到 4.0.1 后选「云端安装依赖」重新部署，不要用「上传并部署：所有文件」。',
    };
  }

  const only = event && event.provider;
  const plans = [
    ['cloudbase', 'deepseek-v4.1-flash'],
    ['hunyuan-v3', 'hy3'],
  ].filter((pair) => !only || pair[0] === only);

  const ai = cloud.ai();
  const results = [];
  for (const pair of plans) {
    results.push(await probeOne(ai, pair[0], pair[1]));
  }

  return {
    ok: results.some((r) => r.ok),
    stage: 'model',
    sdkVersion: sdkVersion(),
    conclusion: explain(results),
    results,
  };
};
