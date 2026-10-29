/**
 * 领域模型验证脚本
 * ------------------------------------------------------------------
 * 运行：
 *   node scripts/verify-models.js
 *
 * 为什么这些能脱离小程序直接跑：
 *   models/order.js、utils/date.js、utils/format.js 都是纯函数，
 *   不依赖 wx.* 或任何平台 API。这正是把它们独立成层的价值之一 ——
 *   核心业务逻辑可以被快速验证，不用启开发者工具。
 * ------------------------------------------------------------------
 */

const orderModel = require('../miniprogram/models/order');
const dateUtil = require('../miniprogram/utils/date');
const format = require('../miniprogram/utils/format');
const remind = require('../cloudfunctions/timerRemind/remind');
const ocr = require('../cloudfunctions/api/ocr');
const pickupExtract = require('../cloudfunctions/api/pickup-extract');
const platformGate = require('../cloudfunctions/api/platform-gate');
const fortune = require('../cloudfunctions/api/horoscope');
const settingsModel = require('../miniprogram/models/settings');
const navUtil = require('../miniprogram/utils/nav');
const fortuneCache = require('../miniprogram/utils/fortune-cache');
const localFortune = require('../miniprogram/utils/fortune-local');
const wxcloud = require('../miniprogram/services/adapters/wxcloud');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log('  OK   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       期望: ' + JSON.stringify(expected));
    console.log('       实际: ' + JSON.stringify(actual));
  }
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------- 日期工具
section('日期工具');

check("diffDays 同日为 0", dateUtil.diffDays('2026-10-12', '2026-10-12'), 0);
check("diffDays 跨月正确", dateUtil.diffDays('2026-10-28', '2026-11-04'), 7);
check("diffDays 跨年为 1", dateUtil.diffDays('2026-12-31', '2027-01-01'), 1);
check("addDays 跨月", dateUtil.addDays('2026-10-28', 7), '2026-11-04');
check("addDays 闰年 2 月", dateUtil.addDays('2028-02-28', 1), '2028-02-29');
check("addDays 负数", dateUtil.addDays('2026-03-01', -1), '2026-02-28');
check("toDateOnly 截断 ISO 字符串", dateUtil.toDateOnly('2026-10-12T08:30:00.000Z'), '2026-10-12');
check("toDateOnly 空值", dateUtil.toDateOnly(''), '');
check("toDateOnly 非法值", dateUtil.toDateOnly('abc'), '');

// ---------------------------------------------------------- 最晚可退日计算
section('最晚可退日（F-5）');

check("收货日 + 7 天", orderModel.calcDeadline('2026-10-01', 7), '2026-10-08');
check("未传天数时默认 7", orderModel.calcDeadline('2026-10-01', undefined), '2026-10-08');
check("天数传 0（当天可退）", orderModel.calcDeadline('2026-10-01', 0), '2026-10-01');
check("15 天规则（平台特殊）", orderModel.calcDeadline('2026-10-01', 15), '2026-10-16');
check("收货日期非法时返回空", orderModel.calcDeadline('', 7), '');
check("负数天数视为非法", orderModel.calcDeadline('2026-10-01', -3), '');

// ------------------------------------------------------------ 状态派生
section('状态派生（overdue 不落库）');

const TODAY = '2026-10-12';

check(
  "pending + 已过期 -> overdue",
  orderModel.deriveStatus({ status: 'pending', deadline: '2026-10-01' }, TODAY),
  'overdue'
);
check(
  "pending + 今天到期 -> 仍是 pending（当天仍可退）",
  orderModel.deriveStatus({ status: 'pending', deadline: TODAY }, TODAY),
  'pending'
);
check(
  "pending + 明天到期 -> pending",
  orderModel.deriveStatus({ status: 'pending', deadline: '2026-10-13' }, TODAY),
  'pending'
);
check(
  "applied + 已过期 -> 仍是 applied（终态优先）",
  orderModel.deriveStatus({ status: 'applied', deadline: '2026-10-01' }, TODAY),
  'applied'
);
check(
  "缺少 deadline 时不误判逾期",
  orderModel.deriveStatus({ status: 'pending', deadline: '' }, TODAY),
  'pending'
);

// ------------------------------------------------------------ 倒计时文案
section('倒计时与紧急度');

check(
  "还剩 5 天 -> 正常",
  (function () {
    const c = orderModel.getCountdown({ status: 'pending', deadline: '2026-10-17' }, TODAY);
    return [c.remainDays, c.urgency, c.countdownText];
  })(),
  [5, 'normal', '还剩 5 天']
);
check(
  "还剩 2 天 -> 紧急",
  (function () {
    const c = orderModel.getCountdown({ status: 'pending', deadline: '2026-10-14' }, TODAY);
    return [c.remainDays, c.urgency, c.countdownText];
  })(),
  [2, 'urgent', '还剩 2 天']
);
check(
  "今天到期",
  (function () {
    const c = orderModel.getCountdown({ status: 'pending', deadline: TODAY }, TODAY);
    return [c.remainDays, c.urgency, c.countdownText];
  })(),
  [0, 'today', '今天到期']
);
check(
  "逾期 3 天",
  (function () {
    const c = orderModel.getCountdown({ status: 'pending', deadline: '2026-10-09' }, TODAY);
    return [c.remainDays, c.urgency, c.countdownText];
  })(),
  [-3, 'overdue', '已逾期 3 天']
);
check(
  "已申请优先于逾期展示",
  (function () {
    const c = orderModel.getCountdown({ status: 'applied', deadline: '2026-10-01' }, TODAY);
    return [c.urgency, c.countdownText];
  })(),
  ['normal', '已申请']
);
check(
  "3 天边界算紧急",
  orderModel.getCountdown({ status: 'pending', deadline: '2026-10-15' }, TODAY).urgency,
  'urgent'
);
check(
  "4 天算正常",
  orderModel.getCountdown({ status: 'pending', deadline: '2026-10-16' }, TODAY).urgency,
  'normal'
);

// ---------------------------------------------------------------- 校验
section('录入校验（F-1）');

const validInput = {
  productName: '白色球鞋',
  platform: '淘宝',
  receiveDate: TODAY,
  amount: 29900,
  returnDays: 7,
};

check("完整数据通过", orderModel.validate(validInput), []);
check(
  "缺商品名被拦截",
  orderModel.validate(Object.assign({}, validInput, { productName: '' })).length,
  1
);
check(
  "缺平台被拦截",
  orderModel.validate(Object.assign({}, validInput, { platform: '' }))[0],
  '请选择平台'
);
check(
  "收货日期晚于今天被拦截",
  orderModel.validate(Object.assign({}, validInput, { receiveDate: '2026-12-01' }))[0],
  '收货日期不能晚于今天'
);
check(
  "负数金额被拦截",
  orderModel.validate(Object.assign({}, validInput, { amount: -1 }))[0],
  '金额需为不小于 0 的数字'
);
check(
  "金额 0 允许（赠品/免单场景）",
  orderModel.validate(Object.assign({}, validInput, { amount: 0 })),
  []
);

// ---------------------------------------------------------------- 归一化
section('数据归一化');

const normalized = orderModel.normalize(validInput, 'uid-123');
check("uid 写入", normalized.uid, 'uid-123');
check("金额保持分为整数", normalized.amount, 29900);
check("deadline 自动算出", normalized.deadline, '2026-10-19');
check("默认状态为 pending", normalized.status, 'pending');
check("默认来源 manual", normalized.source, 'manual');
check(
  "手动指定 deadline 时不被覆盖",
  orderModel.normalize(Object.assign({}, validInput, { deadline: '2026-10-20' }), 'u').deadline,
  '2026-10-20'
);
check(
  "字符串金额转数字并取整",
  orderModel.normalize(Object.assign({}, validInput, { amount: '199.99' }), 'u').amount,
  200
);
check(
  "未传退货天数时补默认 7",
  orderModel.normalize({ productName: 'x', platform: 'y', receiveDate: TODAY, amount: 100 }, 'u')
    .returnDays,
  7
);
// ↓ 退货天数：整数校验与上限（2026-10-19 加固）
check(
  "校验：退货天数非整数报错",
  orderModel.validate(Object.assign({}, validInput, { returnDays: 3.5 })),
  ['退货天数需为整数']
);
check(
  "校验：退货天数超上限报错",
  orderModel.validate(Object.assign({}, validInput, { returnDays: 400 })),
  ['退货天数需在 0–365 天之间']
);
check(
  "校验：退货天数 365 合法",
  orderModel.validate(Object.assign({}, validInput, { returnDays: 365 })),
  []
);
check(
  "归一化：退货天数四舍五入",
  orderModel.normalize(Object.assign({}, validInput, { returnDays: 3.6 }), 'u').returnDays,
  4
);
check(
  "归一化：退货天数封顶 365",
  orderModel.normalize(Object.assign({}, validInput, { returnDays: 400 }), 'u').returnDays,
  365
);
check(
  "归一化：退货天数负数回落默认 7",
  orderModel.normalize(Object.assign({}, validInput, { returnDays: -5 }), 'u').returnDays,
  7
);
// ↓ 新增字段：退货原因 / 取件码
check(
  "归一化保留退货原因",
  orderModel.normalize(
    Object.assign({}, validInput, { returnReason: '尺码不合适' }),
    'u'
  ).returnReason,
  '尺码不合适'
);
check(
  "归一化保留取件码",
  orderModel.normalize(Object.assign({}, validInput, { pickupCode: '8821' }), 'u').pickupCode,
  '8821'
);
check(
  "归一化保留订单编号",
  orderModel.normalize(
    Object.assign({}, validInput, { orderNo: '3316356807100404082' }),
    'u'
  ).orderNo,
  '3316356807100404082'
);
check(
  "归一化：订单编号优先于旧 returnNo",
  orderModel.normalize(
    Object.assign({}, validInput, { orderNo: 'NEW123456', returnNo: 'OLD123456' }),
    'u'
  ).orderNo,
  'NEW123456'
);
check(
  "归一化：旧 returnNo 兜底为订单编号",
  orderModel.normalize(
    Object.assign({}, validInput, { returnNo: 'VPH20260912ABC88' }),
    'u'
  ).orderNo,
  'VPH20260912ABC88'
);
check(
  "归一化：订单编号去首尾空格",
  orderModel.normalize(
    Object.assign({}, validInput, { orderNo: '  3316356807100404082  ' }),
    'u'
  ).orderNo,
  '3316356807100404082'
);
check(
  "展示层：旧记录的 returnNo 显示为订单编号",
  orderModel.decorate({ returnNo: 'LEGACY123456' }, TODAY).orderNo,
  'LEGACY123456'
);
check(
  "订单编号归一化：全角转半角、去空格",
  orderModel.normalizeOrderNo(' ３３１６ ８０ '),
  '331680'
);
check(
  "订单编号归一化：截断 64 位",
  orderModel.normalizeOrderNo(new Array(81).join('1')).length,
  64
);
check(
  "更新 patch：订单编号归一化",
  orderModel.buildUpdatePatch({ orderNo: ' １２３ ４５６ ' }).orderNo,
  '123456'
);
check('最晚可退时间：默认 00:00:00', orderModel.normalizeDeadlineTime(''), '00:00:00');
check('最晚可退时间：补零', orderModel.normalizeDeadlineTime('9:5:3'), '09:05:03');
check('最晚可退时间：越界夹取', orderModel.normalizeDeadlineTime('25:70:70'), '23:59:59');
check(
  '归一化：最晚可退时间默认值',
  orderModel.normalize(validInput, 'u').deadlineTime,
  '00:00:00'
);
check(
  '更新 patch：最晚可退时间补零',
  orderModel.buildUpdatePatch({ deadlineTime: '9:5' }).deadlineTime,
  '09:05:00'
);
check(
  '归一化：想退货默认 false',
  orderModel.normalize(validInput, 'u').considering,
  false
);
check(
  '归一化：想退货保留 true',
  orderModel.normalize(Object.assign({}, validInput, { considering: 1 }), 'u').considering,
  true
);
check(
  '更新 patch：想退货转布尔',
  orderModel.buildUpdatePatch({ considering: 1 }).considering,
  true
);
check(
  '归一化：最晚发货默认空',
  orderModel.normalize(validInput, 'u').shipDeadline,
  ''
);
check(
  '更新 patch：最晚发货归一化',
  orderModel.buildUpdatePatch({ shipDeadline: '2026-11-01' }).shipDeadline,
  '2026-11-01'
);
check(
  '退货天数 0 也计算最晚可退日',
  orderModel.calcDeadline('2026-10-22', 0),
  '2026-10-22'
);
check(
  '最晚发货兜底：显式值优先',
  orderModel.resolveShipDeadline({ shipDeadline: '2026-11-01', appliedAt: '2026-10-01' }),
  '2026-11-01'
);
check(
  '最晚发货兜底：appliedAt + 7',
  orderModel.resolveShipDeadline({ appliedAt: '2026-10-01' }),
  '2026-10-08'
);
check(
  '最晚发货兜底：createdAt + 7',
  orderModel.resolveShipDeadline({ createdAt: '2026-10-01' }),
  '2026-10-08'
);
check(
  '最晚发货兜底：无日期返回空',
  orderModel.resolveShipDeadline({}),
  ''
);

// ---------------------------------------------------------------- 查重命中判定
section('订单编号查重命中（纯函数）');

const dupRows = [
  { _id: '1', orderNo: '123456' },
  { _id: '2', returnNo: '123456' },
  { _id: '3', orderNo: '９９９９９９' },
  { _id: '4', orderNo: '000000' },
];

check(
  '查重：命中 orderNo 与旧 returnNo',
  orderModel.matchByOrderNo(dupRows, '123456').map(function (o) { return o._id; }),
  ['1', '2']
);
check(
  '查重：排除自身',
  orderModel.matchByOrderNo(dupRows, '123456', '1').map(function (o) { return o._id; }),
  ['2']
);
check(
  '查重：全角归一化后命中',
  orderModel.matchByOrderNo(dupRows, '999999').map(function (o) { return o._id; }),
  ['3']
);
check('查重：空编号返回空数组', orderModel.matchByOrderNo(dupRows, ''), []);
check('查重：无命中返回空数组', orderModel.matchByOrderNo(dupRows, '555555'), []);

check(
  '筛选：按订单编号',
  orderModel.filterByKeyword(
    [
      { productName: 'A', orderNo: '3316356807100404082' },
      { productName: 'B', returnNo: 'VPH20260912ABC88' },
    ],
    '3316356807100404082'
  ).length,
  1
);
check(
  '筛选：兼容旧 returnNo',
  orderModel.filterByKeyword(
    [{ productName: 'A', orderNo: '3316' }, { productName: 'B', returnNo: 'VPH123456' }],
    'VPH123456'
  ).length,
  1
);
check(
  '校验：订单编号超过 64 位报错',
  orderModel.validate(Object.assign({}, validInput, { orderNo: new Array(66).join('1') })),
  ['订单编号不能超过 64 位']
);
check(
  "未填写时订单编号/退货原因/取件码默认空串",
  (function () {
    const n = orderModel.normalize(validInput, 'u');
    return [n.orderNo, n.returnReason, n.pickupCode];
  })(),
  ['', '', '']
);
check(
  "退货原因去首尾空格",
  orderModel.normalize(
    Object.assign({}, validInput, { returnReason: '  七天无理由  ' }),
    'u'
  ).returnReason,
  '七天无理由'
);

// ---------------------------------------------------------------- 删除时清理凭证图（M-2）
section('凭证图 fileID 提取（删除订单时清理云存储）');

check(
  "过滤空值/非字符串并去重",
  orderModel.voucherFileIds({ voucher: ['a', 'b', 'a', '', null, 'c'] }),
  ['a', 'b', 'c']
);
check("无 voucher 字段返回空数组", orderModel.voucherFileIds({}), []);
check("订单为 null 返回空数组", orderModel.voucherFileIds(null), []);
check(
  "voucher 非数组时返回空数组",
  orderModel.voucherFileIds({ voucher: 'cloud://x' }),
  []
);

// ---------------------------------------------------------------- 格式化
section('金额格式化（分 -> 元）');

check("千分位分隔", format.fenToYuan(128600), '1,286.00');
check("零值", format.fenToYuan(0), '0.00');
check("小额", format.fenToYuan(99), '0.99');
check("无分隔模式", format.fenToYuan(128600, false), '1286.00');
check("非法值兜底", format.fenToYuan('abc'), '0.00');
check("元转分", format.yuanToFen('12.30'), 1230);
check("元转分四舍五入", format.yuanToFen('12.345'), 1235);

// 运势卡可见截断：文本框固定三行，超出补「…」；完整文案留在 fortuneText 给浮层
check("运势截断：短文案原样返回", format.truncate('平稳小吉', 36), '平稳小吉');
check(
  "运势截断：超长补省略号",
  format.truncate('今日整体运势处于平稳上升的小吉区间，日常事务推进顺畅，人际互动氛围融洽，个人状态保持稳定', 36),
  '今日整体运势处于平稳上升的小吉区间，日常事务推进顺畅，人际互动氛围融洽，' + '…'
);
check("运势截断：null 当作空串", format.truncate(null, 36), '');

// 当日落盘缓存：决定「冷启动要不要再请求接口」，判错会要么多请求、要么整天不更新
section('运势当日缓存（落盘）');
check(
  "缓存：同一天且有文案 → 命中",
  fortuneCache.isFresh({ date: '2026-10-24', text: '平稳小吉' }, '2026-10-24'),
  true
);
check(
  "缓存：跨天 → 失效",
  fortuneCache.isFresh({ date: '2026-10-23', text: '平稳小吉' }, '2026-10-24'),
  false
);
check(
  "缓存：空文案 → 失效（兜底文案不会被当成缓存）",
  fortuneCache.isFresh({ date: '2026-10-24', text: '' }, '2026-10-24'),
  false
);
check("缓存：没有记录 → 失效", fortuneCache.isFresh(null, '2026-10-24'), false);
check(
  "缓存：写入记录带日期与文案",
  JSON.stringify(fortuneCache.make('今日运势不错', '2026-10-24')),
  '{"date":"2026-10-24","text":"今日运势不错"}'
);

// ------------------------------------------------------- 本地运势文本（utils/fortune-local.js）
// 换成「读本地文本」之后，文案正确性由这个模块保证：
// 同一天必须稳定、跨天要有变化、缺数据必须返回空串（不回退网站）。
section('本地运势文本');

check("本地文本：默认星座为双鱼座", localFortune.SIGN, '双鱼座');

check(
  "本地文本：同一天两次取值一致（当天不跳变）",
  localFortune.getFortuneText('2026-10-29') === localFortune.getFortuneText('2026-10-29'),
  true
);

check(
  "本地文本：取到的文案必须来自双鱼座文案池",
  localFortune.BY_SIGN['双鱼座'].indexOf(localFortune.getFortuneText('2026-10-29')) > -1,
  true
);

check("本地文本：空日期返回空串", localFortune.getFortuneText(''), '');

check(
  "本地文本：星座不在池里且公共池为空 → 返回空串（不编造）",
  localFortune.getFortuneText('2026-10-29', '天秤座'),
  ''
);

check(
  "本地文本：池中只有一条时，30 天每天都返回同一条（需求：每天都显示同一句）",
  (function () {
    const seen = {};
    for (let i = 1; i <= 30; i++) {
      const d = '2026-11-' + (i < 10 ? '0' + i : String(i));
      seen[localFortune.getFortuneText(d)] = true;
    }
    const keys = Object.keys(seen);
    return keys.length === 1 && keys[0] === localFortune.BY_SIGN['双鱼座'][0];
  })(),
  true
);

check(
  "本地文本：多条目池下哈希未退化（30 个不同日期至少取到 2 种）",
  (function () {
    const pool = ['甲', '乙', '丙'];
    const seen = {};
    for (let i = 1; i <= 30; i++) {
      seen[localFortune.pickFrom(pool, '2026-11-' + (i < 10 ? '0' + i : String(i)))] = true;
    }
    return Object.keys(seen).length >= 2;
  })(),
  true
);

check(
  "本地文本：BY_DATE 精确指定优先于星座池",
  (function () {
    localFortune.BY_DATE['2099-12-31'] = '测试专用文案';
    const got = localFortune.getFortuneText('2099-12-31');
    delete localFortune.BY_DATE['2099-12-31'];
    return got;
  })(),
  '测试专用文案'
);

check(
  "本地文本：池内空字符串条目不会被选中",
  localFortune.pickFrom(['', '   ', '唯一有效文案'], 'seed'),
  '唯一有效文案'
);

check("本地文本：空池返回空串", localFortune.pickFrom([], 'seed'), '');

check("本地文本：非数组入参返回空串", localFortune.pickFrom(null, 'seed'), '');

// ------------------------------------------------------- 提醒档位判定（M-3）
// 这一组覆盖「档位漏推」问题：档位当天被跳过（免扰/未授权/异常）后，
// 次日剩余天数落在两档之间，必须按「档位区间」补推，而非精确相等匹配。
// 注意 lastRemindStage 存的是「已推到的档位阈值」，不是剩余天数。
section('提醒档位判定（timerRemind.decideRemind）');

const STAGE_DAYS = [3, 1, 0];

check(
  "剩 3 天进入 3 档区间 -> 首次推，stage=3",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-15', lastRemindStage: null }, TODAY, STAGE_DAYS);
    return [d.shouldSend, d.stage];
  })(),
  [true, 3]
);
check(
  "剩 2 天（3 档当天漏了）-> 仍要推，不能漏档",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-14', lastRemindStage: null }, TODAY, STAGE_DAYS);
    return [d.shouldSend, d.stage];
  })(),
  [true, 3]
);
check(
  "已推过 3 档，剩 2 天仍在同区间 -> 不重复推",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-14', lastRemindStage: 3 }, TODAY, STAGE_DAYS);
    return [d.shouldSend, d.stage];
  })(),
  [false, null]
);
check(
  "已推过 3 档，剩 1 天进入 1 档区间 -> 补推",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-13', lastRemindStage: 3 }, TODAY, STAGE_DAYS);
    return [d.shouldSend, d.stage];
  })(),
  [true, 1]
);
check(
  "已推过 1 档，剩 0 天进入 0 档 -> 补推",
  (function () {
    const d = remind.decideRemind({ deadline: TODAY, lastRemindStage: 1 }, TODAY, STAGE_DAYS);
    return [d.shouldSend, d.stage];
  })(),
  [true, 0]
);
check(
  "已推过 0 档，今天到期再跑 -> 不重复推",
  remind.decideRemind({ deadline: TODAY, lastRemindStage: 0 }, TODAY, STAGE_DAYS).shouldSend,
  false
);
check(
  "剩 5 天未进入任何档 -> 不推",
  remind.decideRemind({ deadline: '2026-10-17', lastRemindStage: null }, TODAY, STAGE_DAYS).shouldSend,
  false
);
check(
  "同一天重复执行 -> 不重复推（幂等）",
  (function () {
    // 首次推送 stage=3，重跑时 lastRemindStage 已是 3
    const d = remind.decideRemind({ deadline: '2026-10-15', lastRemindStage: 3 }, TODAY, STAGE_DAYS);
    return d.shouldSend;
  })(),
  false
);
check(
  "逾期且未开启逾期提醒 -> 不推",
  remind.decideRemind({ deadline: '2026-10-09', lastRemindStage: null }, TODAY, STAGE_DAYS).shouldSend,
  false
);
check(
  "逾期且开启逾期提醒 -> 推",
  remind.decideRemind(
    { deadline: '2026-10-09', lastRemindStage: null },
    TODAY,
    STAGE_DAYS,
    { notifyOnOverdue: true }
  ).shouldSend,
  true
);
check(
  "deadline 非法 -> 不推",
  remind.decideRemind({ deadline: '', lastRemindStage: null }, TODAY, STAGE_DAYS).shouldSend,
  false
);
check(
  "自定义档位 [7,3,1] 剩 5 天 -> 进入 7 档，stage=7",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-17', lastRemindStage: null }, TODAY, [7, 3, 1]);
    return [d.shouldSend, d.stage];
  })(),
  [true, 7]
);
check(
  "自定义档位 [7,3,1] 剩 6 天且已推过 7 档 -> 同区间不重复",
  remind.decideRemind({ deadline: '2026-10-18', lastRemindStage: 7 }, TODAY, [7, 3, 1]).shouldSend,
  false
);
check(
  "自定义档位 [7,3,1] 剩 3 天且已推过 7 档 -> 进入 3 档，补推",
  (function () {
    const d = remind.decideRemind({ deadline: '2026-10-15', lastRemindStage: 7 }, TODAY, [7, 3, 1]);
    return [d.shouldSend, d.stage];
  })(),
  [true, 3]
);

// ------------------------------------------------- 云函数日期工具（时区）
section('云函数日期工具（UTC 偏移正确）');

check("diffDays 同日为 0", remind.diffDays('2026-10-12', '2026-10-12'), 0);
check("diffDays 跨月", remind.diffDays('2026-10-28', '2026-11-04'), 7);
check("diffDays 非法输入返回 null", remind.diffDays('', '2026-10-12'), null);
check(
  "免扰时段跨零点：23:30 命中",
  remind.isQuietHour({ start: '22:00', end: '08:00' }, { hour: 23, minute: 30 }),
  true
);
check(
  "免扰时段跨零点：07:30 命中",
  remind.isQuietHour({ start: '22:00', end: '08:00' }, { hour: 7, minute: 30 }),
  true
);
check(
  "免扰时段跨零点：12:00 不命中",
  remind.isQuietHour({ start: '22:00', end: '08:00' }, { hour: 12, minute: 0 }),
  false
);

// --------------------------------------------- 金额 / 凭证上限（W-4 / W-5）
section('金额与凭证上限校验');

check(
  "超上限金额被拦截",
  orderModel.validate(Object.assign({}, validInput, { amount: 100000001 }))[0],
  '金额过大，请确认是否多输入了几位（上限 100 万元）'
);
check(
  "恰好等于上限金额放行",
  orderModel.validate(Object.assign({}, validInput, { amount: 100000000 })),
  []
);
check(
  "凭证超过 3 张被拦截",
  orderModel.validate(
    Object.assign({}, validInput, { voucher: ['a', 'b', 'c', 'd'] })
  )[0],
  '凭证最多 3 张'
);
check(
  "归一化时金额被钳制到上限",
  orderModel.normalize(Object.assign({}, validInput, { amount: 999999999999 }), 'u').amount,
  100000000
);
check(
  "归一化时凭证超出部分被截断",
  orderModel.normalize(
    Object.assign({}, validInput, { voucher: ['a', 'b', 'c', 'd', 'e'] }),
    'u'
  ).voucher.length,
  3
);

// ------------------------------------- 集成：页面表单 -> 服务层更新（C-1 / M-1）
// 这一组是本轮修复的重点。之前 48 项全是单元测试，恰好漏掉了
// collectForm 的输出喂给 update() 这条集成路径，导致 deadline 被清空的
// 严重 Bug 长期未被发现。
//
// 注意：这里直接调用 orderModel.buildUpdatePatch —— 即 order.service.update()
// 真正使用的那段逻辑（service 层只是加了个 updatedAt 再转发）。
// 刻意不在这里复刻逻辑：复刻出来的测试改真实代码不会变红，等于没锁住。
section('集成：表单变更集 -> update patch 组装（C-1 / M-1）');

/** 模拟 order-edit.js collectForm() 在「未手动覆盖 deadline」时的输出 */
function formWithoutDeadlineOverride() {
  return {
    productName: '白色球鞋',
    platform: '淘宝',
    amount: 29900,
    receiveDate: '2026-10-01',
    returnDays: 7,
    remark: '',
    voucher: [],
  };
}

check(
  "C-1：未手动覆盖（表单不带 deadline 字段）-> 重算，不能为空",
  orderModel.buildUpdatePatch(formWithoutDeadlineOverride()).deadline,
  '2026-10-08'
);
check(
  "C-1：表单给了空串 deadline 也不写空值（兜住历史写法）",
  (function () {
    const out = orderModel.buildUpdatePatch({
      receiveDate: '2026-10-01',
      returnDays: 7,
      deadline: '',
    });
    return [out.deadline, Object.prototype.hasOwnProperty.call(out, 'deadline') ? 'has' : 'deleted'];
  })(),
  ['2026-10-08', 'has']
);
check(
  "C-1：用户手动覆盖 -> 尊重用户指定值",
  orderModel.buildUpdatePatch({
    receiveDate: '2026-10-01',
    returnDays: 7,
    deadline: '2026-10-20',
  }).deadline,
  '2026-10-20'
);
check(
  "C-1：手动覆盖后再改收货日 -> deadline 不被自动重算覆盖",
  orderModel.buildUpdatePatch({
    receiveDate: '2026-10-05',
    returnDays: 7,
    deadline: '2026-10-20',
  }).deadline,
  '2026-10-20'
);
check(
  "C-1：只改商品名（无日期字段）-> 不产生 deadline 字段",
  Object.prototype.hasOwnProperty.call(
    orderModel.buildUpdatePatch({ productName: '改名了' }),
    'deadline'
  ),
  false
);
check(
  "C-1：只改商品名 + 表单误带空串 deadline -> 空串不得写库",
  Object.prototype.hasOwnProperty.call(
    orderModel.buildUpdatePatch({ productName: '改名了', deadline: '' }),
    'deadline'
  ),
  false
);
check(
  "M-1：编辑态表单不带 source -> patch 中无 source 字段（保留库中原值）",
  Object.prototype.hasOwnProperty.call(formWithoutDeadlineOverride(), 'source'),
  false
);
check(
  "M-1：buildUpdatePatch 不会凭空补出 source 字段",
  Object.prototype.hasOwnProperty.call(
    orderModel.buildUpdatePatch(formWithoutDeadlineOverride()),
    'source'
  ),
  false
);

// ----------------------- 部署环境自愈：空 deadline 脏数据（2026-10-18）
// 背景：早期 C-1 bug 曾把部分订单的 deadline 清成空串，导致编辑页日期
// picker 拿到空 value 点不开、最晚可退日空白。页面 loadOrder 用
// 「收货日 + 天数」自动补算修复。这里锁住「空 deadline 也能算出正确
// 补算值」这条自愈规则，避免修复逻辑将来被改坏。
section('空 deadline 脏数据自愈（部署环境修复）');

check(
  "空 deadline 订单按收货日+天数补算",
  orderModel.calcDeadline('2026-10-18', 7),
  '2026-10-25'
);
check(
  "补算值可被 toDateOnly 正常归一（供 picker 使用）",
  dateUtil.toDateOnly(orderModel.calcDeadline('2026-10-18', 7)),
  '2026-10-25'
);
check(
  "空 deadline 经 buildUpdatePatch 处理不被写回空值",
  (function () {
    // 模拟：只改商品名，但库里 deadline 已是空串（脏数据），
    // 页面修复时会带着补算后的 deadline 一起提交
    const out = orderModel.buildUpdatePatch({
      productName: '水杯',
      receiveDate: '2026-10-18',
      returnDays: 7,
      deadline: '2026-10-25',
    });
    return out.deadline;
  })(),
  '2026-10-25'
);

// ----------------------------- 部署环境配置校验（环境 ID / 集合名）
// 锁住关键部署配置，防止误改环境 ID 或集合名导致线上数据错乱。
section('部署环境配置校验');

const envConfig = require('../miniprogram/config/env');

check(
  "环境 ID 已配置且非空（勿改回空串导致连错环境）",
  typeof envConfig.ENV_ID === 'string' && envConfig.ENV_ID.length > 0,
  true
);
check(
  "环境 ID 格式正确（含环境名前缀）",
  /^[a-z0-9]+-[a-z0-9]+$/i.test(envConfig.ENV_ID),
  true
);
check(
  "集合名 orders 正确",
  envConfig.COLLECTIONS.ORDERS,
  'orders'
);
check(
  "集合名 settings 正确",
  envConfig.COLLECTIONS.SETTINGS,
  'settings'
);
check(
  "集合名 userPlatforms 正确",
  envConfig.COLLECTIONS.USER_PLATFORMS,
  'userPlatforms'
);

// --------------------------------------------- OCR 字段抽取（纯逻辑）
// 覆盖 ocr.js 的字段抽取规则：商品名 / 金额 / 日期 / 平台。
section('OCR 字段抽取（api/ocr.js）');

check(
  "抽取商品名：跳过金额/日期行取首个中文行",
  ocr.extractProductName(['¥199.00', '2026-10-12', '白色球鞋 43码', '订单号123']),
  '白色球鞋 43码'
);
check(
  "抽取商品名：纯数字/金额行被跳过",
  ocr.extractProductName(['128.50', '合计', '水杯']),
  '水杯'
);
check(
  "抽取金额（¥符号）",
  ocr.extractAmount('实付 ¥199.00 元'),
  19900
);
check(
  "抽取金额（￥符号）",
  ocr.extractAmount('￥45.5'),
  4550
);
check(
  "抽取金额（X元 格式）",
  ocr.extractAmount('合计 128 元'),
  12800
);
check(
  "抽取金额：无金额返回 null",
  ocr.extractAmount('没有价格信息'),
  null
);
check(
  "抽取日期（YYYY-MM-DD）",
  ocr.extractDate('下单 2026-10-01'),
  '2026-10-01'
);
check(
  "抽取日期（YYYY年M月D日）",
  ocr.extractDate('2026年10月1日'),
  '2026-10-01'
);
check(
  "抽取日期（YYYY/MM/DD）",
  ocr.extractDate('2026/10/01'),
  '2026-10-01'
);
check(
  "抽取日期：无日期返回空串",
  ocr.extractDate('没有日期'),
  ''
);
// ↓ 回归：多日期页面必须优先取「收货日期」，而不是「申请时间」
check(
  "抽取日期：收货日期(年月日) + 申请时间(YYYY-MM-DD)，优先收货日期",
  ocr.extractDate('收货日期\n2026年09月15日\n申请时间\n2026-09-16'),
  '2026-09-15'
);
check(
  "抽取日期：收货日期与申请时间同行时优先收货日期",
  ocr.extractDate('收货日期 2026-09-20\n申请时间 2026-09-21'),
  '2026-09-20'
);
check(
  "抽取日期：签收时间等价于收货日期",
  ocr.extractDate('签收时间：2026/09/12\n申请退款 2026-09-13'),
  '2026-09-12'
);
check(
  "抽取日期：有收货标签但该行无有效日期时回退全文首个日期",
  ocr.extractDate('收货日期\n待确认\n申请时间\n2026-09-16'),
  '2026-09-16'
);
check(
  "抽取平台：命中淘宝",
  ocr.extractPlatform('淘宝订单 详情'),
  '淘宝'
);
check(
  "抽取平台：命中京东",
  ocr.extractPlatform('京东商城 电子发票'),
  '京东'
);
check(
  "抽取平台：无平台返回空串",
  ocr.extractPlatform('这是普通订单'),
  ''
);
check(
  "综合抽取：完整文本",
  ocr.extractOrder('淘宝\n白色球鞋 43码\n¥199.00\n2026-10-01'),
  { productName: '白色球鞋 43码', amount: 19900, date: '2026-10-01', platform: '淘宝', returnNo: '', returnReason: '', pickupCode: '' }
);
check(
  "综合抽取：部分字段缺失",
  ocr.extractOrder('水杯\n实付 45 元'),
  { productName: '水杯', amount: 4500, date: '', platform: '', returnNo: '', returnReason: '', pickupCode: '' }
);
// ↓ 退货原因 / 取件码（2026-10-19 新增字段）
// ↓ 退货单号（平台业务单号）与取件码的区分
check(
  "抽取退货单号：退货码标签同行",
  ocr.extractReturnNo('退货码 VPH20260912ABC88'),
  'VPH20260912ABC88'
);
check(
  "抽取退货单号：换行",
  ocr.extractReturnNo('退货单号\nVPH001'),
  'VPH001'
);
check(
  "抽取退货单号：退款单号别名",
  ocr.extractReturnNo('退款单号 TB123456'),
  'TB123456'
);
check(
  "抽取退货单号：无则空串",
  ocr.extractReturnNo('退货原因\n尺码不合适'),
  ''
);
check(
  "区分：退货码不会被当成取件码",
  ocr.extractPickupCode('退货码\nVPH20260912ABC88'),
  ''
);
check(
  "区分：取件码不会被当成退货单号",
  ocr.extractReturnNo('取件码\n3821'),
  ''
);
check(
  "抽取退货原因：同行",
  ocr.extractReturnReason('退货原因 尺码不合适'),
  '尺码不合适'
);
check(
  "抽取退货原因：换行",
  ocr.extractReturnReason('退货原因\n七天无理由退货'),
  '七天无理由退货'
);
check(
  "抽取退货原因：带冒号",
  ocr.extractReturnReason('退款原因：质量问题'),
  '质量问题'
);
check(
  "抽取退货原因：无标签返回空串",
  ocr.extractReturnReason('退款金额\n￥259.00'),
  ''
);
check(
  "抽取取件码：同行",
  ocr.extractPickupCode('取件码 8821'),
  '8821'
);
check(
  "抽取取件码：换行",
  ocr.extractPickupCode('取件码\nSF1234567890'),
  'SF1234567890'
);
check(
  "抽取取件码：无则空串",
  ocr.extractPickupCode('退货原因\n尺码不合适'),
  ''
);
check(
  "综合抽取：含退货原因（唯品会样例）",
  ocr.extractOrder(
    '唯品会订单\n运动跑步鞋男透气网面减震运动鞋\n退款金额\n￥259.00\n' +
      '退货码\nVPH20260912ABC88\n收货日期\n2026年09月12日\n申请时间\n2026-09-13\n退货原因\n尺码不合适'
  ),
  {
    productName: '运动跑步鞋男透气网面减震运动鞋',
    amount: 25900,
    date: '2026-09-12',
    platform: '唯品会',
    returnNo: 'VPH20260912ABC88',
    returnReason: '尺码不合适',
    pickupCode: '',
  }
);

// ---------------------------------------------------------------- 平台识别
section('OCR 平台识别（analyzeOrder）');

check(
  "平台：唯品会 退货详情 + 快递员已取回 → 高置信",
  ocr.analyzeOrder('唯品会\n退货详情\n快递员已取回商品\n退款金额 ¥390.00').platform,
  '唯品会'
);
check(
  "平台：唯品会置信度 high",
  ocr.analyzeOrder('唯品会\n退货详情\n快递员已取回商品').platformConfidence,
  'high'
);
check(
  "平台：京东 我的京东 + 服务单号",
  ocr.analyzeOrder('我的京东\n退换/售后\n进度查询\n服务单号 123456789').platform,
  '京东'
);
check(
  "平台：苏宁 我的易购",
  ocr.analyzeOrder('我的易购\n退换/售后\n进度查询\n服务单进度').platform,
  '苏宁易购'
);
check(
  "平台：天猫优先于淘宝",
  ocr.analyzeOrder('天猫\n退款详情\n退款编号 12345678\n要求天猫客服介入').platform,
  '天猫'
);
check(
  "平台：淘宝 已买到的宝贝",
  ocr.analyzeOrder('我的淘宝\n已买到的宝贝\n退款编号 87654321').platform,
  '淘宝'
);
check(
  "平台：拼多多 售后详情",
  ocr.analyzeOrder('拼多多\n退款/售后\n售后详情\n商家处理中').platform,
  '拼多多'
);
check(
  "平台：抖音商城",
  ocr.analyzeOrder('抖音商城\n我的订单\n申请售后\n订单号 7064214528778700000').platform,
  '抖音电商'
);
check(
  "平台：快手小店",
  ocr.analyzeOrder('快手小店\n售后详情\n退款单号 KS123456').platform,
  '快手小店'
);
check(
  "平台：只有订单号不判定",
  ocr.analyzeOrder('订单号 123456789\n申请售后').platform,
  ''
);
check(
  "平台：只有服务单号+进度查询不判定",
  ocr.analyzeOrder('服务单号 123456\n进度查询').platform,
  ''
);

// ---------------------------------------------------------------- 取件码（按平台分发）
section('OCR 取件码识别（getPickupCodeByPlatform）');

// 拼多多上门取件页：标签独占一行、值在下一行
const pddPickupLabel =
  '拼多多\n退款/售后\n售后详情\n上门取件\n取件码\n382915\n快递员将在预约时间上门\n订单号码 251001123456789';

check(
  '取件码：拼多多 + 标签换行 → high/label',
  ocr.getPickupCodeByPlatform(pddPickupLabel, '拼多多'),
  { code: '382915', confidence: 'high', source: 'label' }
);
check(
  '取件码：拼多多 + 标签同行 → high/label',
  ocr.getPickupCodeByPlatform('拼多多\n上门取件\n取件码 382915', '拼多多'),
  { code: '382915', confidence: 'high', source: 'label' }
);
check(
  '取件码：无标签不出码（标签绑定铁律）',
  ocr.getPickupCodeByPlatform('拼多多\n上门取件\n尊敬的客户\n382915', '拼多多'),
  { code: '', confidence: '', source: '' }
);
check(
  '取件码：既无标签也无 6 位数字 → 空',
  ocr.getPickupCodeByPlatform('拼多多\n上门取件\n快递员已取走', '拼多多'),
  { code: '', confidence: '', source: '' }
);
check(
  '取件码：非拼多多平台不猜规则（预留）',
  ocr.getPickupCodeByPlatform('淘宝\n取件码\n382915', '淘宝'),
  { code: '', confidence: '', source: '' }
);
check(
  '取件码：平台为空也返回空（本期只做拼多多）',
  ocr.getPickupCodeByPlatform('取件码\n382915', ''),
  { code: '', confidence: '', source: '' }
);
check(
  '兜底：取离「取件码」标签最近的 6 位数字',
  ocr.findPickupCodeFallback(['取件码', '短信验证码 111111', '222222']),
  '111111'
);
check(
  '兜底：距离相同取靠前（结果稳定可测）',
  ocr.findPickupCodeFallback(['123456', '取件码', '654321']),
  '123456'
);
check(
  '兜底：8 位以上订单号不会被当成取件码',
  ocr.findPickupCodeFallback(['订单号码 251001123456789']),
  ''
);
check(
  '标签下面是说明文字时不算取件码（避免假 high）',
  ocr.resolvePickupCode('取件码\n请向快递员出示\n382915'),
  { code: '382915', confidence: 'low', source: 'regex' }
);
check('looksLikePickupCode：无数字拒绝', ocr.looksLikePickupCode('请向快递员出示'), false);
check('looksLikePickupCode：6 位数字接受', ocr.looksLikePickupCode('382915'), true);

const pddHit = ocr.analyzeOrder(pddPickupLabel);
check('取件码：analyzeOrder 高置信', pddHit.pickupConfidence, 'high');
check('取件码：analyzeOrder 高置信不需要核对', pddHit.needConfirm, false);
check('取件码：analyzeOrder 输出 rawLines', pddHit.rawLines.indexOf('382915') > -1, true);

const pddLow = ocr.analyzeOrder('拼多多\n退款/售后\n上门取件\n382915');
check('取件码：analyzeOrder 无标签不出码', pddLow.pickupCode, '');
check('取件码：无码时不需要核对', pddLow.needConfirm, false);
check(
  '取件码：带连字符订单号不会被当码',
  ocr.getPickupCodeByPlatform('拼多多\n订单号：261011-360343170593024', '拼多多').code,
  ''
);
check(
  '取件码：标签旁只有订单号时也不出码（连字符整串丢弃）',
  ocr.getPickupCodeByPlatform('拼多多\n取件码\n（暂无）\n订单号：261011-360343170593024', '拼多多').code,
  ''
);
check(
  '取件码：取件码与订单号共存时分别取（用户纠偏示例）',
  ocr.getPickupCodeByPlatform('拼多多\n取件码\n261011\n订单编号\n261011-360343170593024', '拼多多').code,
  '261011'
);

// ---------------------------------------------------------------- 寄回详情页真实回归
section('OCR 寄回详情页真实回归（拼多多·预约成功页）');

// 2026-10-24 真实截图原文（用户提供）：退货退款详情 / 预约成功页。
// 这类页面商品名在缩略图里，OCR 文本中不存在；进度条文案「寄回商品」最像商品名。
const pddReturnSample = [
  '退货退款详情',
  '商家处理',
  '寄回商品',
  '商家收货',
  '退款成功',
  '预约成功',
  '本次寄件服务享受官方补贴',
  '寄件详情',
  '明天09:00-11:00快递员将上门取件',
  '取件码 2281',
  '请在快递员上门后出示',
  '取件地址：北京市北京市通州区通州区富河园23号楼4单元6层461',
  '预估费用：¥0',
  '费用详情',
  '退货商品：',
  '请仔细核对商品，避免因退错商品导致退款失败',
  '快递员：郭龙川',
  '取消预约',
  '修改预约',
].join('\n');
const pddReturn = ocr.analyzeOrder(pddReturnSample);

check(
  '寄回页：进度节点「寄回商品」不会被当成商品名',
  ocr.extractProductName(['寄回商品']),
  ''
);
check('寄回页：无商品名文本时返回空（不瞎填）', pddReturn.productName, '');
check('寄回页：取件码 2281 高置信', pddReturn.pickupCode, '2281');
check('寄回页：取件码置信度 high', pddReturn.pickupConfidence, 'high');
check('寄回页：取件码不需要核对', pddReturn.needConfirm, false);
check('寄回页：预估费用 0 不当金额', pddReturn.amount, 0);
check('寄回页：预估费用不产出金额标签', pddReturn.amountLabel, '');
check('寄回页：无品牌词时平台返回 unknown', pddReturn.platform, '');
check(
  '寄回页：「明天09:00-11:00」是相对日期，不填进取件时间',
  pddReturn.pickupTime,
  ''
);

// ---------------------------------------------------------------- 取件码结构化抽取
section('取件码结构化抽取（pickup-extract）');

const pxA = pickupExtract.extractPickupStructured({ page_text: pddReturnSample });
check('结构化：A 页型为取件码页', pxA.page_type, 'pickup_code_page');
check('结构化：A 有取件码', pxA.has_pickup_code, true);
check('结构化：A 原始码', pxA.pickup_code_raw, '2281');
check('结构化：A 归一化码', pxA.pickup_code_normalized, '2281');
check('结构化：A 不是低置信', pxA.low_confidence, false);
check('结构化：A 平台透传', pxA.platform, 'unknown');
check('结构化：A 地址取件地址', pxA.address, '北京市北京市通州区通州区富河园23号楼4单元6层461');
check(
  '结构化：A 取件时间原样返回',
  pxA.pickup_time,
  '明天09:00-11:00快递员将上门取件'
);
check('结构化：A 字段数为 11', Object.keys(pxA).length, 11);
check(
  '结构化：A 无 null 字段',
  Object.keys(pxA).filter(function (k) { return pxA[k] === null; }).length,
  0
);

const pxB = pickupExtract.extractPickupStructured({ page_text: pddPickupLabel });
check('结构化：B 原始码', pxB.pickup_code_raw, '382915');
check('结构化：B 归一化码', pxB.pickup_code_normalized, '382915');

const pxC = pickupExtract.extractPickupStructured({
  page_text: [
    '退货退款详情',
    '请选择退货方式，退回商品',
    '请在6天23小时内填写快递单号',
    '上门取件',
    '去服务点',
    '去快递柜',
    '自行退回',
    '上门时间：今天下午都可以（13:00-19:00）',
    '取件地址：河南省焦作市山阳区世纪大道2001号河南理工大学',
    '立即退回',
  ].join('\n'),
});
check('结构化：C 页型为售后详情', pxC.page_type, 'after_sale_detail');
check('结构化：C 无取件码', pxC.has_pickup_code, false);
check('结构化：C 码字段全空', pxC.pickup_code_raw + pxC.pickup_code_normalized, '');

const pxApplied = pickupExtract.extractPickupStructured({
  page_text: '退货退款详情\n退货申请成功\n已提交，等待商家处理\n商家处理中',
});
check('结构化：申请成功页型归为售后详情', pxApplied.page_type, 'after_sale_detail');
check('结构化：申请成功页无码', pxApplied.has_pickup_code, false);

check(
  '结构化：O/o 保守归一化为 0',
  pickupExtract.extractPickupStructured({ page_text: '取件码 O128' }).pickup_code_normalized,
  '0128'
);
check(
  '结构化：原始码保留 O 不修正',
  pickupExtract.extractPickupStructured({ page_text: '取件码 O128' }).pickup_code_raw,
  'O128'
);

const pxLowScore = pickupExtract.extractPickupStructured({
  page_text: '取件码 2281',
  blocks: [{ text: '2281', bbox: { x: 0, y: 0, w: 40, h: 20 }, score: 0.4 }],
});
check('结构化：区块分 0.4 标低置信', pxLowScore.low_confidence, true);
check('结构化：低置信时归一化留空', pxLowScore.pickup_code_normalized, '');
check('结构化：低置信时原始码照填', pxLowScore.pickup_code_raw, '2281');

const pxHighScore = pickupExtract.extractPickupStructured({
  page_text: '取件码 2281',
  blocks: [{ text: '2281', bbox: { x: 0, y: 0, w: 40, h: 20 }, score: 0.95 }],
});
check('结构化：区块分 0.95 不标低置信', pxHighScore.low_confidence, false);

check(
  '结构化：字符断裂不补字符（直接判无码）',
  pickupExtract.extractPickupStructured({ page_text: '取件码 2 2 8 1' }).has_pickup_code,
  false
);

const pxOrderNoise = pickupExtract.extractPickupStructured({
  page_text: '拼多多\n订单编号 25100112345678\n取件码 2281\n待取件',
});
check('结构化：订单号不被当取件码', pxOrderNoise.pickup_code_raw, '2281');
check('结构化：订单号填进 order_sn', pxOrderNoise.order_sn, '25100112345678');

check(
  '结构化：多个数字串取离标签最近',
  pickupExtract.extractPickupStructured({ page_text: '待取件\n13800001111\n取件码\n2281\n2026' })
    .pickup_code_raw,
  '2281'
);
check(
  '结构化：提货码标签同样生效',
  pickupExtract.extractPickupStructured({ page_text: '提货码 6612\n快递柜' }).pickup_code_raw,
  '6612'
);
check(
  '结构化：无标签不猜',
  pickupExtract.extractPickupStructured({ page_text: '待取件\n快递员将上门取件\n2281' })
    .has_pickup_code,
  false
);
const pxLogistics = pickupExtract.extractPickupStructured({
  page_text: '物流详情\n运单号 SF1234567890123\n快递公司：顺丰',
});
check('结构化：物流页在 schema 里归 unknown', pxLogistics.page_type, 'unknown');
check('结构化：物流页无取件码', pxLogistics.has_pickup_code, false);
check('结构化：物流页抽到快递公司', pxLogistics.express_company, '顺丰');
check(
  '结构化：商家地址里的「拒收申通」不算承运商',
  pickupExtract.extractPickupStructured({
    page_text: '商家地址：吴晓城（拒收申通）\n取件码 2281',
  }).express_company,
  ''
);
check(
  '结构化：年份不当取件码（兜底路径）',
  pickupExtract.extractPickupStructured({ page_text: '取件码 无效\n2026' }).pickup_code_raw,
  ''
);
// 长串不能被切成 8 位片段：否则 15 位订单号会「长出一个取件码」
check('结构化：15 位订单号不切出片段', pickupExtract.codeTokens('25100112345678'), []);
check(
  '结构化：带连字符订单号不切出片段',
  pickupExtract.codeTokens('订单号：261015-521320568353024 | 复制'),
  []
);
check(
  '结构化：标签旁只有订单号时判无码',
  pickupExtract.extractPickupStructured({
    page_text: '待取件\n取件码\n（暂无）\n订单编号 25100112345678',
  }).has_pickup_code,
  false
);
check(
  '结构化：带连字符订单号在标签旁也不当取件码',
  pickupExtract.extractPickupStructured({
    page_text: '待取件\n取件码\n订单号：261015-521320568353024 | 复制',
  }).has_pickup_code,
  false
);

// 2026-10-28 用户实测样本（图1 订单详情页）：页面上只有「订单号」，没有「取件码」标签。
// 旧通道的 6 位数字兜底把订单号前缀 261011 填进了取件码，这里固化为回归。
const img1Sample = [
  '已签收 已按承诺时间送达',
  '您的快件已领取，收件人在[兔喜生活]',
  '2026-10-13 21:21:11',
  '王超 153****2037 号码保护中',
  '通州区富河园23号楼4单元6层461',
  '霖霖D杂货铺 11.11',
  '观赏鱼杀菌盐海盐养鱼专用鱼缸消毒盐净化水质预防鱼病水族',
  '【除黄防臭杀菌】袋装1000克',
  '¥9.7 ×1',
  '退货包运费保障中',
  '承诺达·已准时送达',
  '购后小助手 查看使用说明书',
  '售后详情',
  '联系商家',
  '先用后付 实付：¥0',
  '15小时后，自动确认收货并付款¥9.7',
  '订单号：261011-360343170593024 复制',
  '商品快照：发生交易争议时，可作为判断依据',
  '消费提醒',
  '更多',
  '延长收货',
  '查看物流',
  '确认收货',
].join('\n');

const img1Gate = platformGate.detectPlatformGate(img1Sample);
const img1Pickup = pickupExtract.extractPickupStructured({
  page_text: img1Sample,
  platform: img1Gate.platform,
  platform_conf: img1Gate.platform_conf,
});
check('图1：平台判 pdd', img1Gate.platform, 'pdd');
check('图1：页型为订单详情', img1Pickup.page_type, 'order_detail');
check('图1：无取件码标签 → has=false', img1Pickup.has_pickup_code, false);
check('图1：取件码 raw 为空（订单号前缀不算）', img1Pickup.pickup_code_raw, '');
check('图1：取件码 normalized 为空', img1Pickup.pickup_code_normalized, '');
check('图1：订单号保留连字符完整串', img1Pickup.order_sn, '261011-360343170593024');
check('图1：schema 11 字段', Object.keys(img1Pickup).length, 11);
check('图1：platform_conf 透传', img1Pickup.platform_conf, 'high');
check(
  '图1：旧通道也不出码（标签绑定）',
  ocr.analyzeOrder(img1Sample).pickupCode,
  ''
);
check(
  '结构化：商家地址旁的「复制」不是取件码按钮',
  pickupExtract.extractPickupStructured({
    page_text: '退货退款详情\n商家地址 汉世刘家退货组 复制\n取件码\n（暂无）',
  }).has_pickup_code,
  false
);

// 规则表 §4.3：门牌号、金额、单号里的数字都不是取件码（三条取值路径都要挡住）
check(
  '结构化：标签下一行是取件地址时不当码',
  pickupExtract.extractPickupStructured({ page_text: '取件码\n（暂无）\n取件地址 3021号 复制' })
    .has_pickup_code,
  false
);
check(
  '结构化：标签下一行是商家地址时不当码',
  pickupExtract.extractPickupStructured({ page_text: '取件码\n（暂无）\n商家地址 汉世刘家 5578 复制' })
    .has_pickup_code,
  false
);
check(
  '结构化：标签下一行是金额行时不当码',
  pickupExtract.extractPickupStructured({ page_text: '取件码\n（暂无）\n实付 ¥ 6621 复制' })
    .has_pickup_code,
  false
);
check(
  '结构化：「复制」路径上也挡住地址门牌',
  pickupExtract.extractPickupStructured({
    page_text: '取件码\n请在快递员上门后出示\n退货商品：\n取件地址 3021号 复制',
  }).has_pickup_code,
  false
);
check(
  '结构化：地址行不影响真正的取件码',
  pickupExtract.extractPickupStructured({ page_text: '取件码 2281\n取件地址 3021号' }).pickup_code_raw,
  '2281'
);

// 订单详情页：规则表 §5 —— 该页没有运单号/承运商字段，抽出即误抽
const pxOrderPage = pickupExtract.extractPickupStructured({
  page_text: [
    '已签收 已按承诺时间送达',
    '您的快件已领取，收件人在[兔喜生活]',
    '王超 153****2037 号码保护中',
    '通州区富河园23号楼4单元6层461',
    '霖霖D杂货铺 11.11',
    '观赏鱼杀菌盐 ¥9.7 ×1',
    '分享商品',
    '联系商家',
    '售后详情',
    '先用后付 实付：¥0',
    '订单号：261011-360343170593024 | 复制',
    '商品快照：发生交易争议时，可作为判断依据',
    '查看物流',
    '确认收货',
  ].join('\n'),
  platform: 'pdd',
  platform_conf: 'high',
});
check('结构化：订单详情页型', pxOrderPage.page_type, 'order_detail');
check('结构化：订单详情页无取件码', pxOrderPage.has_pickup_code, false);
check('结构化：订单号保留连字符', pxOrderPage.order_sn, '261011-360343170593024');
check('结构化：订单详情页承运商置空', pxOrderPage.express_company, '');

// ---------------------------------------------------------------- 第 0 步：平台闸门
section('第 0 步平台闸门（platform-gate）');

const gateA = platformGate.detectPlatformGate(pddReturnSample);
check('闸门：真机截图判 pdd', gateA.platform, 'pdd');
check('闸门：真机截图 high（专属组件）', gateA.platform_conf, 'high');
check('闸门：high 走全规则', gateA.mode, 'full');
check(
  '闸门：证据里出现专属组件',
  gateA.evidence.some(function (e) { return e.indexOf('拼多多专属组件') === 0; }),
  true
);

check(
  '闸门：品牌词直接 pdd high',
  platformGate.detectPlatformGate('拼多多\n退款/售后').platform_conf,
  'high'
);
check(
  '闸门：淘宝页判 taobao',
  platformGate.detectPlatformGate('我的淘宝\n已买到的宝贝\n退款编号 87654321').platform,
  'taobao'
);
check(
  '闸门：淘宝页不跑拼多多规则',
  platformGate.detectPlatformGate('我的淘宝\n已买到的宝贝\n退款编号 87654321').mode,
  'label_only'
);
check(
  '闸门：京东页判 jd',
  platformGate.detectPlatformGate('我的京东\n退换/售后\n服务单号 123456789').platform,
  'jd'
);
check(
  '闸门：京东仅服务单号+进度查询给 mid',
  platformGate.detectPlatformGate('服务单号 SF2026\n进度查询').platform_conf,
  'mid'
);
check(
  '闸门：顺丰壳子（无业务词）判 express',
  platformGate.detectPlatformGate('顺丰速运\n运单详情\n快件已发出').platform,
  'express'
);
check(
  '闸门：只有「取件码」三个字必须 unknown',
  platformGate.detectPlatformGate('取件码 2281').platform,
  'unknown'
);
check(
  '闸门：取件码 + 待取件（2 条弱信号）给 pdd low',
  platformGate.detectPlatformGate('取件码 2281\n待取件').platform_conf,
  'low'
);
check(
  '闸门：pdd low 降级为 label_only',
  platformGate.detectPlatformGate('取件码 2281\n待取件').mode,
  'label_only'
);
check(
  '闸门：组件单条即 pdd high（本轮规则列为强信号）',
  platformGate.detectPlatformGate('商家处理中\n售后详情').platform_conf,
  'high'
);
check(
  '闸门：组件两条仍为 high',
  platformGate.detectPlatformGate('售后详情\n上门取件').platform_conf,
  'high'
);
check(
  '闸门：短信落款拼多多',
  platformGate.detectPlatformGate('【拼多多】您的退货已预约成功，退订回T').platform,
  'pdd'
);
check(
  '闸门：微信壳子无业务方判 unknown',
  platformGate.detectPlatformGate('微信支付\n服务通知\n通知详情').platform,
  'unknown'
);
check(
  '闸门：退货单号 26 开头算强信号',
  platformGate.detectPlatformGate('退货单号\n260123456789012\n取件码 2281').platform_conf,
  'high'
);
check(
  '闸门：订单编号是弱信号，单条只给 low',
  platformGate.detectPlatformGate('退货退款详情\n订单号：261015-521320568353024').platform_conf,
  'low'
);
check(
  '闸门：订单编号 + 取件码（2 条弱信号）→ pdd low',
  platformGate.detectPlatformGate('订单号：261022-436710960673024\n取件码 2281').platform,
  'pdd'
);
check(
  '闸门：订单号格式进弱信号证据',
  platformGate.detectPlatformGate('订单号：261022-436710960673024').evidence[0],
  '弱信号：订单编号'
);
check(
  '闸门：有淘宝品牌词时不判 pdd（品牌优先）',
  platformGate.detectPlatformGate('我的淘宝\n订单号：5127805153821039333\n取件码 2281').platform,
  'taobao'
);
check(
  '闸门：19 位订单号本身不是拼多多信号',
  platformGate.detectPlatformGate('订单号：5127805153821039333').platform,
  'unknown'
);
check(
  '闸门：普通订单号不触发 pdd',
  platformGate.detectPlatformGate('订单编号 123456789012').platform,
  'unknown'
);
check(
  '闸门：普通退货单号不算强信号',
  platformGate.detectPlatformGate('退货单号\nVPH001\n取件码 2281').platform,
  'unknown'
);

// 降级：平台不达标时不跑拼多多专属的邻近兜底
const degradeText = '取件码\n请在快递员上门后出示\n退货商品：\n2281';
check(
  '降级：pdd 全规则时邻近兜底生效',
  pickupExtract.extractPickupStructured({
    page_text: degradeText,
    platform: 'pdd',
    platform_conf: 'high',
  }).pickup_code_raw,
  '2281'
);
check(
  '降级：平台为 taobao 时不跑邻近兜底',
  pickupExtract.extractPickupStructured({
    page_text: degradeText,
    platform: 'taobao',
    platform_conf: 'high',
  }).has_pickup_code,
  false
);
check(
  '降级：平台 unknown 命中标签也要标低置信',
  pickupExtract.extractPickupStructured({
    page_text: '取件码 2281',
    platform: 'unknown',
    platform_conf: 'low',
  }).low_confidence,
  true
);
check(
  '降级：pdd high 命中标签为高置信',
  pickupExtract.extractPickupStructured({
    page_text: '取件码 2281',
    platform: 'pdd',
    platform_conf: 'high',
  }).low_confidence,
  false
);
check(
  '降级：未传平台时保持既有行为（不因平台降级）',
  pickupExtract.extractPickupStructured({ page_text: '取件码 2281' }).low_confidence,
  false
);

// ---------------------------------------------------------------- 平台隔离
section('平台隔离（不同平台规则不可混淆）');

// 底线（用户 2026-10-28 明确）：别的平台的页面不能被拼多多的文案抢走，
// 拼多多的专属兜底也不能套到别的平台上。
check(
  '隔离：淘宝页含 2 条拼多多专属组件，仍判 taobao',
  platformGate.detectPlatformGate('我的淘宝\n已买到的宝贝\n寄件详情\n撤销售后\n退款编号 87654321')
    .platform,
  'taobao'
);
check(
  '隔离：京东页含 2 条拼多多专属组件，仍判 jd',
  platformGate.detectPlatformGate('我的京东\n服务单号 123\n寄件详情\n撤销售后').platform,
  'jd'
);
check(
  '隔离：拼多多页靠专属组件仍判 pdd',
  platformGate.detectPlatformGate('寄回商品\n撤销售后\n寄件详情').platform,
  'pdd'
);

// 旧通道只服务拼多多，其他平台一律返回空
check(
  '隔离：旧通道对淘宝返回空',
  ocr.getPickupCodeByPlatform('取件码 2281', '淘宝'),
  { code: '', confidence: '', source: '' }
);
check(
  '隔离：旧通道对京东返回空',
  ocr.getPickupCodeByPlatform('取件码 2281', '京东'),
  { code: '', confidence: '', source: '' }
);
check(
  '隔离：旧通道对拼多多正常返回',
  ocr.getPickupCodeByPlatform('取件码 2281', '拼多多'),
  { code: '2281', confidence: 'high', source: 'label' }
);

// 拼多多专属的「邻近兜底」不得套到其他平台
const isolatedText = '取件码\n请在快递员上门后出示\n退货商品：\n2281';
check(
  '隔离：pdd 全规则时可走邻近兜底',
  pickupExtract.extractPickupStructured({
    page_text: isolatedText,
    platform: 'pdd',
    platform_conf: 'high',
  }).pickup_code_raw,
  '2281'
);
check(
  '隔离：淘宝不跑拼多多专属兜底',
  pickupExtract.extractPickupStructured({
    page_text: isolatedText,
    platform: 'taobao',
    platform_conf: 'high',
  }).has_pickup_code,
  false
);
check(
  '隔离：京东不跑拼多多专属兜底',
  pickupExtract.extractPickupStructured({
    page_text: isolatedText,
    platform: 'jd',
    platform_conf: 'high',
  }).has_pickup_code,
  false
);
check(
  '隔离：非 pdd 命中标签也要标低置信',
  pickupExtract.extractPickupStructured({
    page_text: '取件码 2281',
    platform: 'taobao',
    platform_conf: 'high',
  }).low_confidence,
  true
);
check(
  '隔离：快递壳子页判 express 且不出码',
  (function () {
    const text = '顺丰速运\n运单详情\n快件已发出';
    const gate = platformGate.detectPlatformGate(text);
    const r = pickupExtract.extractPickupStructured({
      page_text: text,
      platform: gate.platform,
      platform_conf: gate.platform_conf,
    });
    return gate.platform + '/' + r.has_pickup_code;
  })(),
  'express/false'
);
check(
  '隔离：唯品会/苏宁等未接品牌词的平台不判 pdd',
  platformGate.detectPlatformGate('唯品会\n退货详情\n快递员已取回商品').platform,
  'unknown'
);

// ---------------------------------------------------------------- 平台字段
section('OCR 平台字段抽取');

const jdSample =
  '京东\n我的订单\n订单编号 123456789012\n服务单号 SF20260912001\n' +
  '退换/售后\n进度查询\n退款金额 ¥89.00\n商品金额 ¥129.00';
const jd = ocr.analyzeOrder(jdSample);

check('京东：订单号', jd.orderNo, '123456789012');
check(
  '订单号标签：订单号（淘宝）',
  ocr.analyzeOrder('淘宝\n订单号 3316356807100404082').orderNo,
  '3316356807100404082'
);
check(
  '订单号标签：订单号码（拼多多）',
  ocr.analyzeOrder('拼多多\n订单号码 251001123456789').orderNo,
  '251001123456789'
);
check(
  '订单号标签：order_id（抖音）',
  ocr.analyzeOrder('抖音商城\norder_id 7064214528778700000').orderNo,
  '7064214528778700000'
);
check(
  '订单号兜底：只有退货单号',
  ocr.analyzeOrder('唯品会\n退货单号 VPH20260912ABC88').orderNo,
  'VPH20260912ABC88'
);
check(
  '订单号兜底：标签保留',
  ocr.analyzeOrder('唯品会\n退货单号 VPH20260912ABC88').orderNoLabel,
  '退货单号'
);
check(
  '订单号兜底：退货编号',
  ocr.analyzeOrder('苏宁易购\n退货编号 SH20261001XYZ').orderNo,
  'SH20261001XYZ'
);
check(
  '订单号兜底：服务单号',
  ocr.analyzeOrder('京东\n服务单号 SF20261001001').orderNo,
  'SF20261001001'
);
check(
  '订单号优先于退货单号',
  ocr.analyzeOrder('淘宝\n订单编号 3316356807100404082\n退货单号 VPH20260912ABC88')
    .orderNo,
  '3316356807100404082'
);
check('京东：订单号标签', jd.orderNoLabel, '订单编号');
check('京东：售后单号', jd.returnNo, 'SF20260912001');
check('京东：售后编号标签', jd.returnNoLabel, '服务单号');
check('金额：退款金额优先于商品金额', jd.amount, 8900);
check('金额：命中标签', jd.amountLabel, '退款金额');

check(
  '唯品会：取件时间',
  ocr.analyzeOrder('唯品会\n退货详情\n取件时间\n01-22（周六）12:00-14:00').pickupTime,
  '01-22（周六）12:00-14:00'
);
check(
  '唯品会：状态映射',
  ocr.analyzeOrder('唯品会\n退货详情\n快递员已取回商品').statusKey,
  'return_in_transit'
);
check(
  '淘宝：取件码只认标签',
  ocr.analyzeOrder('淘宝\n退款编号 12345678\n取件码 2083').pickupCode,
  '2083'
);
check(
  '淘宝：退货码不当作取件码',
  ocr.analyzeOrder('淘宝\n退货码 VPH123456').pickupCode,
  ''
);
check(
  '页面类型：售后详情',
  ocr.analyzeOrder('退款详情\n退款编号 12345678').pageKind,
  'aftersale_detail'
);
check(
  '页面类型：订单详情',
  ocr.analyzeOrder('订单编号 12345678\n下单时间 2026-10-01').pageKind,
  'order_detail'
);
check(
  '日期：无收货标签不猜',
  ocr.analyzeOrder('唯品会\n下单时间 2026-10-01\n订单编号 12345678').date,
  ''
);
check(
  '日期：确认收货时间可用',
  ocr.analyzeOrder('确认收货时间 2026-10-05').date,
  '2026-10-05'
);
check(
  '商品名：跳过平台与字段行',
  ocr.analyzeOrder(
    '我的淘宝\n已买到的宝贝\n退款详情\n白色球鞋 43码\n退款编号 12345'
  ).productName,
  '白色球鞋 43码'
);
check(
  '商品名：支持英文商品名',
  ocr.extractProductName(['订单编号 1234567890', 'AirPods Pro 2']),
  'AirPods Pro 2'
);
check(
  '页面类型：退款成功也属于售后页',
  ocr.analyzeOrder('退款成功\n¥90.00').pageKind,
  'aftersale_detail'
);
check(
  '状态：普通「已签收」不算退货签收',
  ocr.analyzeOrder('唯品会\n退货详情\n已签收').statusKey,
  ''
);
check(
  '取件码：标签后是「复制」按钮时为空',
  ocr.extractPickupCode('取件码\n复制'),
  ''
);
check(
  '平台：同时出现淘宝与天猫时取天猫',
  ocr.extractPlatform('天猫\n我的淘宝\n已买到的宝贝'),
  '天猫'
);
check(
  '编号：标签下面紧跟日期时不误当订单号',
  ocr.analyzeOrder('订单编号\n2026-10-01').orderNo,
  ''
);
check(
  '金额：只有「合计优惠」时不把优惠当金额',
  ocr.analyzeOrder('合计优惠 -¥5.00').amount,
  null
);
check(
  '金额：运费不被当订单金额',
  ocr.analyzeOrder('运费 ¥10.00').amount,
  null
);
check(
  '金额：实付优先于合计',
  ocr.analyzeOrder('合计 ¥120.00\n实付款 ¥99.00').amount,
  9900
);
check(
  '商品名：不把售后原因当商品',
  ocr.analyzeOrder('天猫\n退款详情\n退款编号 12345678\n退款原因\n七天无理由').productName,
  ''
);
check(
  '商品名：不把商家状态当商品',
  ocr.analyzeOrder('拼多多\n售后详情\n商家处理中').productName,
  ''
);
check(
  '商品名：不把取件时间段当商品',
  ocr.analyzeOrder('唯品会\n退货详情\n取件时间\n01-22（周六）12:00-14:00').productName,
  ''
);
check(
  '商品名：跳过「商品」分区标题',
  ocr.extractProductName(['商品', 'Apple iPhone 15 128GB']),
  'Apple iPhone 15 128GB'
);
check(
  '商品名：不把物流状态当商品',
  ocr.analyzeOrder('京东\n订单详情\n已签收\n小米 充电宝 10000mAh').productName,
  '小米 充电宝 10000mAh'
);
check(
  '商品名：不把「查看更多」按钮当商品',
  ocr.extractProductName(['查看更多', '抽纸 整箱']),
  '抽纸 整箱'
);
check(
  '页面类型：订单详情 + 实付可判定',
  ocr.analyzeOrder('拼多多\n订单详情\n抽纸 整箱\n实付 ¥25.00').pageKind,
  'order_detail'
);
check(
  '平台：淘宝 + 退款编号为高置信',
  ocr.analyzeOrder('淘宝\n退款详情\n退款编号 1234567890123').platformConfidence,
  'high'
);
check(
  '日期：「确认收货」下面是预计送达时不采纳',
  ocr.extractReceiveDate('确认收货\n预计送达 2026-10-08'),
  ''
);
check(
  '日期：「确认收货」下面是纯日期时采纳',
  ocr.extractReceiveDate('确认收货\n2026-10-05'),
  '2026-10-05'
);
check(
  '日期：同行「预计送达」不采纳',
  ocr.extractReceiveDate('确认收货 预计送达 2026-10-08'),
  ''
);
check(
  '平台：旧接口把「抖音」映射为标准名',
  ocr.extractPlatform('抖音商城 我的订单'),
  '抖音电商'
);

// ---------------------------------------------------------------- 真实淘宝页回归
section('OCR 真实淘宝订单页回归');

const taobaoRealSample = [
  '交易成功',
  '已签收 城区 润泽苑小区5号楼2单元303',
  '张兰 86-182****8754',
  '毛茸茸派对系列+1',
  '当前收集进度0/7，拆盒后可手动标记拥有哦～',
  'NTP潮玩',
  '88VIP好评率97%，平均8小时退款',
  '进店逛逛',
  '【现货】MINISO名创优品三丽... ¥105',
  '美乐蒂【拆盒未拆袋】',
  '退货宝 不支持7天无理由 极速退款',
  '实付价 ¥95 价格明细',
  '备注',
  '闲鱼转卖 申请售后 加入购物车',
  '实付款 共减¥10 优惠解析 ¥95',
  '店铺优惠抵¥10',
  '订单信息 共7项 3316356807100404082 复制',
].join('\n');

const tbReal = ocr.analyzeOrder(taobaoRealSample);

check('真实淘宝：平台', tbReal.platform, '淘宝');
check('真实淘宝：置信度', tbReal.platformConfidence, 'medium');
check('真实淘宝：商品名不抓收件人', tbReal.productName, '【现货】MINISO名创优品三丽...');
check('真实淘宝：金额取实付款而非共减', tbReal.amount, 9500);
check('真实淘宝：订单号从「订单信息」兜底', tbReal.orderNo, '3316356807100404082');
check('真实淘宝：不猜测收货日期', tbReal.date, '');
check('真实淘宝：页面类型', tbReal.pageKind, 'order_detail');
check(
  '真实淘宝：金额拆行时仍取实付款',
  ocr.analyzeOrder('实付款\n共减¥10\n优惠解析\n¥95').amount,
  9500
);
check(
  '商品名：收件人姓名与其手机号拆行时不误抓',
  ocr.extractProductName(['张兰', '86-182****8754', '抽纸 整箱']),
  '抽纸 整箱'
);
check(
  '商品名：不把「去更新 >」当商品',
  ocr.extractProductName(['毛茸茸派对系列+1 去更新 >', '【现货】MINISO名创优品三丽...']),
  '【现货】MINISO名创优品三丽...'
);
check(
  '商品名：带箭头的入口行不抓',
  ocr.extractProductName(['去查看 >', '抽纸 整箱']),
  '抽纸 整箱'
);
check(
  '商品名：清理标题末尾的下拉箭头',
  ocr.extractProductName(['【现货】MINISO名创优品三丽... ∨ ¥105']),
  '【现货】MINISO名创优品三丽...'
);
check(
  '商品名：短字母数字串（GG7）不当商品',
  ocr.extractProductName(['GG7', '抽纸 整箱']),
  '抽纸 整箱'
);
check(
  '商品名：全大写代号（GG7X）不当商品',
  ocr.extractProductName(['GG7X', '抽纸 整箱']),
  '抽纸 整箱'
);
check('OCR 返回规则版本', ocr.analyzeOrder('x').ruleVersion, ocr.OCR_RULE_VERSION);
check(
  '商品名：标题跨行时自动拼接',
  ocr.extractProductName([
    'GG7',
    '【现货】MINISO名创优品三丽鸥',
    '家族岛屿狐系列搪胶毛绒盲盒挂件',
    '美乐蒂【拆盒未拆袋】',
  ]),
  '【现货】MINISO名创优品三丽鸥家族岛屿狐系列搪胶毛绒盲盒挂件'
);
check(
  '商品名：清理标题末尾的向上箭头',
  ocr.extractProductName(['【现货】MINISO名创优品三丽鸥 ∧ ¥105']),
  '【现货】MINISO名创优品三丽鸥'
);

// ---------------------------------------------------------------- 真实抖音页回归
section('OCR 真实抖音订单页回归');

const douyinRealSample = [
  '交易完成',
  '新1',
  '来自豆包',
  '秋歌食品店',
  '【2斤大袋装】原味正宗大铁… ¥15.90',
  '2斤*1袋（【柴火炒】现炒现发））酥香珍珠小花生',
  '7天无理由退货',
  '申请售后',
  '实付款',
  '¥10.90',
  '订单编号 691776096877617385 复制',
].join('\n');

const dyReal = ocr.analyzeOrder(douyinRealSample);

check('真实抖音：平台（来自豆包）', dyReal.platform, '抖音电商');
check('真实抖音：置信度', dyReal.platformConfidence, 'high');
check(
  '真实抖音：状态词不当商品、标题跨行拼接',
  dyReal.productName,
  '【2斤大袋装】原味正宗大铁…2斤*1袋（【柴火炒】现炒现发））酥香珍珠小花生'
);
check('真实抖音：角标「新1」未被选中', dyReal.productName === '新1', false);
check('真实抖音：金额取实付款', dyReal.amount, 1090);
check('真实抖音：订单编号', dyReal.orderNo, '691776096877617385');
check('真实抖音：不猜测收货日期', dyReal.date, '');

// 第二张抖音页：无品牌词，商品卡 UI 文案与标题混排
const douyinReal2 = [
  '交易完成',
  'BKT官方旗舰店 J旗舰 直播 >',
  '【七夕礼物】BKT护腰坐姿… ¥398.00',
  '（1个装）加大黑（100-150斤）',
  '买后必看 操作使用指南 分享商品',
  '申请售后',
  '实付款',
  '¥168.00',
  '订单编号 6955312424043485145 复制',
].join('\n');

const dyReal2 = ocr.analyzeOrder(douyinReal2);

check(
  '真实抖音2：UI 文案不当商品、标题跨行拼接',
  dyReal2.productName,
  '【七夕礼物】BKT护腰坐姿…（1个装）加大黑（100-150斤）'
);
check('真实抖音2：金额取实付款', dyReal2.amount, 16800);
check('真实抖音2：订单编号', dyReal2.orderNo, '6955312424043485145');
check('真实抖音2：无品牌词时按「交易完成+买后必看」判抖音', dyReal2.platform, '抖音电商');
check('真实抖音2：置信度 medium', dyReal2.platformConfidence, 'medium');

// 拼多多页：物流提示混排 + 先用后付实付 0
const pddRealSample = [
  '已签收 已按承诺时间送达',
  '您的快件已领取，收件人在[兔喜生活](北…',
  '2026-10-13 21:21:11',
  '王超 153****2037 号码保护中',
  '通州区富河园23号楼4单元6层461',
  '霖霖D杂货铺 11.11',
  '观赏鱼杀菌盐海盐养鱼专用鱼缸消毒盐净化水质预防鱼病水族… ¥9.7',
  '【除黄防臭杀菌】袋装1000克',
  '退货包运费保障中>',
  '承诺达·已准时送达>',
  '购后小助手 查看使用说明书',
  '售后详情 联系商家',
  '先用后付 实付: ¥0.0',
  '15小时后，自动确认收货并付款¥9.7',
  '订单号: 261011-360343170593024 复制',
].join('\n');

const pddReal = ocr.analyzeOrder(pddRealSample);

check('真实拼多多：平台（兔喜生活）', pddReal.platform, '拼多多');
check('真实拼多多：置信度', pddReal.platformConfidence, 'high');
check(
  '真实拼多多：物流提示不当商品、标题跨行',
  pddReal.productName,
  '观赏鱼杀菌盐海盐养鱼专用鱼缸消毒盐净化水质预防鱼病水族…【除黄防臭杀菌】袋装1000克'
);
check(
  '商品名：最长 60 字',
  ocr.extractProductName([new Array(71).join('长')]).length,
  60
);
check('真实拼多多：先用后付取应付金额', pddReal.amount, 970);
check('真实拼多多：金额标签', pddReal.amountLabel, '先用后付-应付');
check('真实拼多多：签收日期', pddReal.date, '2026-10-13');
check('真实拼多多：订单号', pddReal.orderNo, '261011-360343170593024');

// ---------------------------------------------------------------- 已申请筛选
section('已申请列表按关键词筛选（商品名 / 平台）');

const appliedRows = [
  { productName: '运动跑步鞋男', platform: '唯品会' },
  { productName: '蓝牙耳机 Air', platform: '京东' },
  { productName: '抽纸巾整箱', platform: '拼多多' },
];

check("关键词命中商品名", orderModel.filterByKeyword(appliedRows, '跑步').length, 1);
check(
  "关键词命中平台",
  orderModel.filterByKeyword(appliedRows, '京东')[0].productName,
  '蓝牙耳机 Air'
);
check(
  "英文忽略大小写",
  orderModel.filterByKeyword(appliedRows, 'air')[0].productName,
  '蓝牙耳机 Air'
);
check("关键词去首尾空格", orderModel.filterByKeyword(appliedRows, '  拼多多  ').length, 1);
check("关键词为空返回全部", orderModel.filterByKeyword(appliedRows, '   ').length, 3);
check("无匹配返回空数组", orderModel.filterByKeyword(appliedRows, '不存在的词'), []);
check("空列表安全", orderModel.filterByKeyword(null, 'x'), []);
check("未传关键词返回全部", orderModel.filterByKeyword(appliedRows).length, 3);

// ---------------------------------------------------------------- 装饰与全局搜索
section('装饰列表与全局搜索');

const searchRows = [
  {
    _id: '1',
    productName: '跑步鞋',
    platform: '京东',
    orderNo: '3316001',
    status: 'pending',
    deadline: TODAY,
  },
  {
    _id: '2',
    productName: '蓝牙耳机',
    platform: '淘宝',
    returnNo: 'VPH88',
    status: 'applied',
    deadline: '2026-10-10',
    appliedAt: '2026-10-01',
  },
  {
    _id: '3',
    productName: '抽纸巾',
    platform: '拼多多',
    status: 'pending',
    deadline: '2026-10-20',
  },
];

const decoratedRows = orderModel.decorateList(searchRows, TODAY);
check('decorateList：空列表安全', orderModel.decorateList(null, TODAY), []);
check('decorateList：长度不变', decoratedRows.length, 3);
check('decorateList：今天到期 remainDays=0', decoratedRows[0].remainDays, 0);
check('decorateList：已申请显示已申请', decoratedRows[1].countdownText, '已申请');
check('decorateList：保留原字段', decoratedRows[0].productName, '跑步鞋');

const byOrderNo = orderModel.searchOrders(searchRows, '3316001', 0, 10, TODAY);
check('searchOrders：按订单编号命中', byOrderNo.total, 1);
check('searchOrders：命中记录正确', byOrderNo.list[0]._id, '1');
check('searchOrders：带出倒计时', byOrderNo.list[0].remainDays, 0);

const byOldNo = orderModel.searchOrders(searchRows, 'VPH88', 0, 10, TODAY);
check('searchOrders：兼容旧 returnNo', byOldNo.total, 1);

const page1 = orderModel.searchOrders(searchRows, '', 0, 2, TODAY);
check('searchOrders：第一页 total', page1.total, 3);
check('searchOrders：第一页条数', page1.list.length, 2);
check('searchOrders：第一页 hasMore', page1.hasMore, true);
const page2 = orderModel.searchOrders(searchRows, '', 2, 2, TODAY);
check('searchOrders：第二页条数', page2.list.length, 1);
check('searchOrders：第二页 hasMore', page2.hasMore, false);

// ---------------------------------------------------------------- 分页切片
section('已申请分页切片');

const pageRows = [];
for (let i = 1; i <= 12; i++) pageRows.push({ id: i });

check("第一页返回 10 条且还有更多", orderModel.slicePage(pageRows, 0, 10), {
  list: pageRows.slice(0, 10),
  total: 12,
  hasMore: true,
});
check("第二页返回剩余 2 条且无更多", orderModel.slicePage(pageRows, 10, 10), {
  list: pageRows.slice(10),
  total: 12,
  hasMore: false,
});
check("越界 offset 返回空列表", orderModel.slicePage(pageRows, 20, 10), {
  list: [],
  total: 12,
  hasMore: false,
});
check("负数 offset 按 0 处理", orderModel.slicePage(pageRows, -5, 10).list.length, 10);
check("空列表安全", orderModel.slicePage(null, 0, 10), {
  list: [],
  total: 0,
  hasMore: false,
});

// ---------------------------------------------------------------- 用户设置
section('用户设置（归一化 / 校验）');

check("默认值：空对象回退 7 天与默认档位", settingsModel.normalizeSettings({}), {
  defaultReturnDays: 7,
  remindAdvanceDays: [3, 1, 0],
  quietHours: { start: '22:00', end: '08:00' },
  subscribeFlag: false,
});
check(
  "默认天数上限钳制到 30",
  settingsModel.normalizeSettings({ defaultReturnDays: 99 }).defaultReturnDays,
  30
);
check(
  "默认天数负数钳制到 0",
  settingsModel.normalizeSettings({ defaultReturnDays: -3 }).defaultReturnDays,
  0
);
check(
  "提醒档位去重并降序",
  settingsModel.normalizeSettings({ remindAdvanceDays: [1, 3, 3, 0] }).remindAdvanceDays,
  [3, 1, 0]
);
check(
  "提醒档位全非法时回退默认",
  settingsModel.normalizeSettings({ remindAdvanceDays: [99, -1] }).remindAdvanceDays,
  [3, 1, 0]
);
check(
  "免打扰非法时间回退默认",
  settingsModel.normalizeSettings({ quietHours: { start: '25:00', end: 'x' } }).quietHours,
  { start: '22:00', end: '08:00' }
);
check(
  "免打扰合法时间保留",
  settingsModel.normalizeSettings({ quietHours: { start: '00:30', end: '07:05' } }).quietHours,
  { start: '00:30', end: '07:05' }
);
check(
  "校验：天数越界报错",
  settingsModel.validateSettings({
    defaultReturnDays: 31,
    remindAdvanceDays: [3],
    quietHours: { start: '22:00', end: '08:00' },
  }).length,
  1
);
check(
  "校验：档位为空报错",
  settingsModel.validateSettings({
    defaultReturnDays: 7,
    remindAdvanceDays: [],
    quietHours: { start: '22:00', end: '08:00' },
  }).length,
  1
);
check(
  "校验：时间格式错误报错（8:00 不合格）",
  settingsModel.validateSettings({
    defaultReturnDays: 7,
    remindAdvanceDays: [3],
    quietHours: { start: '8:00', end: '22:00' },
  }).length,
  1
);
check(
  "校验：合法设置通过",
  settingsModel.validateSettings({
    defaultReturnDays: 7,
    remindAdvanceDays: [3, 1, 0],
    quietHours: { start: '22:00', end: '08:00' },
  }),
  []
);

// ---------------------------------------------------------------- 已取货状态
section('状态机：已取货（第三阶段）');

check(
  "已取货为终态，优先于逾期派生",
  orderModel.deriveStatus({ status: 'picked', deadline: '2020-01-01' }, '2026-10-19'),
  'picked'
);
check(
  "已取货倒计时文案",
  orderModel.getCountdown({ status: 'picked', deadline: '2026-10-20' }, '2026-10-19').countdownText,
  '已取货'
);
check(
  "已取货 remainDays 为 null",
  orderModel.getCountdown({ status: 'picked', deadline: '2026-10-20' }, '2026-10-19').remainDays,
  null
);
check(
  "归一化保留 picked 状态",
  orderModel.normalize(
    { productName: 'x', platform: 'y', receiveDate: TODAY, amount: 100, status: 'picked' },
    'u'
  ).status,
  'picked'
);
check(
  "未知状态归一为 pending",
  orderModel.normalize(
    { productName: 'x', platform: 'y', receiveDate: TODAY, amount: 100, status: 'weird' },
    'u'
  ).status,
  'pending'
);

// ---------------------------------------------------------------- 金额求和
section('金额求和（列表总额）');

check(
  "求和：正常列表",
  orderModel.sumAmount([{ amount: 1000 }, { amount: 2500 }, { amount: 99 }]),
  3599
);
check("求和：空列表返回 0", orderModel.sumAmount([]), 0);
check("求和：空值/非法值按 0 处理", orderModel.sumAmount(null), 0);
check(
  "求和：缺字段或非数字按 0 处理",
  orderModel.sumAmount([{ amount: 100 }, {}, { amount: 'abc' }, { amount: null }]),
  100
);

// ---------------------------------------------------------------- 凭证追加
section('凭证追加（识图图片入凭证）');

check('凭证：正常追加', orderModel.appendVoucher(['a'], 'b', 3), {
  list: ['a', 'b'],
  added: true,
  reason: '',
});
const voucherInput = ['a'];
orderModel.appendVoucher(voucherInput, 'b', 3);
check('凭证：不修改传入数组', voucherInput, ['a']);
check('凭证：重复不追加', orderModel.appendVoucher(['a'], 'a', 3), {
  list: ['a'],
  added: false,
  reason: 'duplicate',
});
check('凭证：满额不追加', orderModel.appendVoucher(['a', 'b', 'c'], 'd', 3), {
  list: ['a', 'b', 'c'],
  added: false,
  reason: 'full',
});
check('凭证：空 fileID 不追加', orderModel.appendVoucher([], '', 3), {
  list: [],
  added: false,
  reason: 'empty',
});

// ---------------------------------------------------------------- 跳转错误翻译
// 这层翻译一旦译错，用户会拿到一条误导性提示，比根本不给提示更糟，所以锁住。
check(
  '跳转错误：页面栈超限',
  navUtil.describe({ errMsg: 'navigateTo:fail webview count limit exceed' }),
  '页面栈已满（上限 10 层）'
);
check(
  '跳转错误：目标是 tabBar 页',
  navUtil.describe({ errMsg: 'navigateTo:fail can not navigateTo a tabbar page' }),
  '目标页是 tabBar 页，跳转方式不对'
);
check(
  '跳转错误：目标页面未注册',
  navUtil.describe({
    errMsg: 'navigateTo:fail page "pages/order-edit/order-edit" is not found',
  }),
  '目标页面未在 app.json 注册'
);
check(
  '跳转错误：已在首页还想返回',
  navUtil.describe({ errMsg: 'navigateBack:fail cannot navigate back at first page.' }),
  '已经是第一个页面，无法返回'
);
check('跳转错误：拿不到原因', navUtil.describe(null), '跳转失败，原因未知');
check('跳转错误：普通 Error 透出原文', navUtil.describe(new Error('boom')), 'boom');
check(
  '跳转错误：认不出的原文透出并截断，不吞掉真实原因',
  navUtil.describe({ errMsg: 'navigateTo:fail ' + 'x'.repeat(50) }),
  'navigateTo:fail ' + 'x'.repeat(14) + '…'
);

// ---------------------------------------------------------------- 云错误翻译
// 译错会直接误导用户：曾把「未登录」说成「请稍后重试」，导致整条链路无从排查。
// 云开发的错误形状不统一（详情有时只在 message 里，errCode 有时嵌在 errMsg 里），
// 这几种形状都要能命中。
check(
  '云错误：未登录（详情在 message 里）',
  wxcloud.normalizeError(
    {
      errMsg: 'collection.get:fail',
      message:
        'T: errCode: -501023 permission denied | errMsg: Unauthenticated access is denied',
    },
    'list:orders'
  ).message,
  '未登录，无法访问云数据'
);
check(
  '云错误：未登录（errCode 嵌在 errMsg 里）',
  wxcloud.normalizeError(
    { errMsg: 'collection.get:fail Error: errCode: -501023 permission denied' },
    'list:orders'
  ).message,
  '未登录，无法访问云数据'
);
check(
  '云错误：环境不存在',
  wxcloud.normalizeError({ errMsg: 'env not exists', errCode: -601002 }, 'x').message,
  '云环境不可用，请检查环境 ID 与 AppID'
);
check(
  '云错误：集合不存在',
  wxcloud.normalizeError({ errMsg: 'collection not exists', errCode: -502005 }, 'x')
    .message,
  '云数据库集合不存在，请先在云开发控制台创建集合'
);
check(
  '云错误：安全规则拒绝',
  wxcloud.normalizeError({ errMsg: 'permission denied', errCode: -502003 }, 'x')
    .message,
  '没有权限，请检查数据库安全规则是否为「仅创建者可读写」'
);
check(
  '云错误：认不出时兜底，不编造原因',
  wxcloud.normalizeError({ errMsg: 'something weird' }, 'x').message,
  '操作失败，请稍后重试'
);
check(
  '云错误：保留原始错误便于排查',
  wxcloud.normalizeError({ errMsg: 'x', errCode: -601002 }, 'list:orders').raw.errCode,
  -601002
);

// --------------------------------------------- 星座运势代理（api/horoscope.js）
// 锁住「Key 只在云函数侧 + 接口失败走前端兜底」链路的纯逻辑部分：
// 请求地址组装、文案提取优先级、错误形状判定。
section('星座运势代理（api/horoscope.js）');

check(
  '运势：buildRequestUrl 默认双鱼座/today',
  fortune.buildRequestUrl('mykey', '', ''),
  'https://web.juhe.cn/constellation/getAll?key=mykey&consName=' +
    encodeURIComponent('双鱼座') +
    '&type=today'
);
check(
  '运势：buildRequestUrl 编码 key 与自定义参数',
  fortune.buildRequestUrl('a b&c', '狮子座', 'week'),
  'https://web.juhe.cn/constellation/getAll?key=' +
    encodeURIComponent('a b&c') +
    '&consName=' +
    encodeURIComponent('狮子座') +
    '&type=week'
);
check(
  '运势：取 result.summary 一句话总评',
  fortune.extractFortuneText({
    error_code: 0,
    result: { summary: '今天运气不错', all: '综合运佳' },
  }),
  '今天运气不错'
);
check(
  '运势：无 summary 时取 all',
  fortune.extractFortuneText({ error_code: 0, result: { all: '整体运势平稳' } }),
  '整体运势平稳'
);
check(
  '运势：接口报错时返回空（前端走兜底）',
  fortune.extractFortuneText({ error_code: 10012, reason: 'key不正确', result: null }),
  ''
);
check('运势：无 result 返回空', fortune.extractFortuneText({ error_code: 0 }), '');
check(
  '运势：仅有分项（无 all/summary）时拼合 love/work/money',
  fortune.extractFortuneText({
    error_code: 0,
    result: { love: '有桃花', work: '效率高', money: '有进账' },
  }),
  '爱情有桃花，工作效率高，财运有进账'
);
check(
  '运势：cleanText 去 HTML/压空白',
  fortune.cleanText('  <p>今天  不错</p>\n很棒 '),
  '今天 不错 很棒'
);
check('运势：文案超 400 字截断', fortune.cleanText(new Array(501).join('好')).length, 400);

// 回归：聚合数据官方示例的 summary 约 110 字，必须完整保留
// （曾有 MAX_TEXT_LENGTH=64 把文案硬切在「……无明显阻碍，整」处）
const JUHE_SAMPLE_SUMMARY =
  '有些思考的小漩涡，可能让你忽然的放空。生活中的许多细节让你感触良多，五味杂陈，常常有时候就慢动作定格，想法在果实冻结停留，陷入一阵自我对话的沉思之中，这个时候你不喜欢被打扰或间问，也不想让某些想法曝光，个性变得有些隐晦。';
check(
  '运势：官方示例长度（约 110 字）的 summary 不被截断',
  fortune.cleanText(JUHE_SAMPLE_SUMMARY),
  JUHE_SAMPLE_SUMMARY
);
check(
  '运势：示例 summary 提取后仍是完整句（结尾不是半个字）',
  fortune
    .extractFortuneText({ error_code: 0, result: { summary: JUHE_SAMPLE_SUMMARY } })
    .slice(-3),
  '隐晦。'
);

// ---- 自检与错误码归一化（2026-10-24 修「配了 Key 不生效」时补的防护）----
// 这几条锁的是真实接口的两个坑：error_code 可能是字符串 '0'；
// all/love/work/money 是运势指数数字，不是文案。
check('运势：error_code 字符串 "0" 归一化为 0', fortune.normalizeErrorCode({ error_code: '0' }), 0);
check('运势：error_code 数字 10001 原样返回', fortune.normalizeErrorCode({ error_code: 10001 }), 10001);
check('运势：error_code 缺失时返回 null', fortune.normalizeErrorCode({ result: { summary: 'x' } }), null);
check(
  '运势：error_code 在 result 里时也能读到',
  fortune.normalizeErrorCode({ result: { error_code: '10002' } }),
  10002
);
check(
  '运势：error_code 为字符串 "0" 时仍取 summary（旧实现在这里静默失败）',
  fortune.extractFortuneText({ error_code: '0', result: { summary: '今天运气不错' } }),
  '今天运气不错'
);
check(
  '运势：只有纯数字指数时拼成分值文案',
  fortune.extractFortuneText({ error_code: 0, result: { all: '78' } }),
  '综合78分'
);
check(
  '运势：多个指数拼成分值文案',
  fortune.extractFortuneText({ error_code: 0, result: { all: 78, love: 70, work: 60, money: 90 } }),
  '综合78分 · 爱情70分 · 工作60分 · 财运90分'
);
check(
  '运势：result 被包成数组时取第一条',
  fortune.extractFortuneText({ error_code: 0, result: [{ summary: '今天适合整理订单' }] }),
  '今天适合整理订单'
);
check(
  '运势：result 为字符串时当成一句话',
  fortune.extractFortuneText({ error_code: 0, result: '今天运气不错' }),
  '今天运气不错'
);
check(
  '运势：describeShape 报出数组与字段',
  fortune.describeShape({ error_code: 0, result: [{ summary: 'x', all: '78' }] }).resultKeys.join(','),
  'summary,all'
);
check(
  '运势自检：error_code=0 但没文案时不再报「接口返回异常」',
  fortune.buildProbeConclusion({ hasKey: true, errorCode: 0, ok: false, stage: 'requested', httpStatus: 200 }).title,
  '接口通了，但没解析到文案'
);
check(
  '运势自检：该分支的 detail 带出 result 类型与字段',
  fortune.buildProbeConclusion({
    hasKey: true,
    errorCode: 0,
    ok: false,
    stage: 'requested',
    httpStatus: 200,
    resultType: 'object',
    resultKeys: ['date', 'all'],
  }).detail,
  'HTTP 200 · result 类型 object · result 字段 date/all'
);
check(
  '运势：没有 result 容器时用顶层字段解析',
  fortune.extractFortuneText({ error_code: 0, summary: '今天适合整理订单', all: '78' }),
  '今天适合整理订单'
);
check(
  '运势：容器叫 data 时也能取到',
  fortune.extractFortuneText({ error_code: 0, data: { summary: '今天运气不错' } }),
  '今天运气不错'
);
check(
  '运势自检：detail 带出顶层字段与原文，便于定位真实结构',
  fortune.buildProbeConclusion({
    hasKey: true,
    errorCode: 0,
    ok: false,
    stage: 'requested',
    httpStatus: 200,
    payloadKeys: ['error_code', 'reason'],
    resultType: 'missing',
    preview: '{"error_code":0,"reason":"ok"}',
  }).detail,
  'HTTP 200 · 顶层字段 error_code/reason · result 类型 missing · 原文 {"error_code":0,"reason":"ok"}'
);
check(
  '运势自检：result 缺失时给出「顶层字段兜底」说法',
  fortune.buildProbeConclusion({ hasKey: true, errorCode: 0, ok: false, stage: 'requested', resultType: 'missing' }).advice
    .indexOf('顶层字段兜底') > -1,
  true
);
check(
  '运势：result 为数组（错误返回）时取不到文案',
  fortune.extractFortuneText({ error_code: 0, result: [] }),
  ''
);
check('运势：isDisplayableText 拒绝纯数字', fortune.isDisplayableText('78'), false);
check('运势：isDisplayableText 接受中文', fortune.isDisplayableText('运势一般'), true);
check(
  '运势：describeError 带出 error_code 与 reason',
  fortune.describeError({ error_code: '10001', reason: 'KEY ERROR!' }),
  'error_code=10001（KEY ERROR!）'
);
check(
  '运势自检：无 key 时结论指向环境变量',
  fortune.buildProbeConclusion({ hasKey: false }).title,
  '云函数没读到 JUHE_KEY'
);
check(
  '运势自检：key 首尾带空格时单独点名',
  fortune.buildProbeConclusion({ hasKey: true, keyHasSpace: true, keyLength: 33 }).title,
  'JUHE_KEY 首尾带空格或换行'
);
check(
  '运势自检：成功时结论为 ok',
  fortune.buildProbeConclusion({ hasKey: true, ok: true, errorCode: 0, stage: 'requested' }).level,
  'ok'
);
check(
  '运势自检：10002 指向接口未开通',
  fortune.buildProbeConclusion({ hasKey: true, ok: false, errorCode: 10002, stage: 'requested' }).title,
  '接口未开通或无权限（error_code=10002）'
);
check(
  '运势自检：请求失败时结论指向出网请求',
  fortune.buildProbeConclusion({ hasKey: true, stage: 'request-failed', error: '运势接口请求超时' }).level,
  'error'
);

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(48));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(48));

process.exit(failed === 0 ? 0 : 1);
