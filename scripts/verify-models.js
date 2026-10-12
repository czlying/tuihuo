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

// ---------------------------------------------------------------- 格式化
section('金额格式化（分 -> 元）');

check("千分位分隔", format.fenToYuan(128600), '1,286.00');
check("零值", format.fenToYuan(0), '0.00');
check("小额", format.fenToYuan(99), '0.99');
check("无分隔模式", format.fenToYuan(128600, false), '1286.00');
check("非法值兜底", format.fenToYuan('abc'), '0.00');
check("元转分", format.yuanToFen('12.30'), 1230);
check("元转分四舍五入", format.yuanToFen('12.345'), 1235);

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

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(48));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(48));

process.exit(failed === 0 ? 0 : 1);
