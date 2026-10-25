const services = require('../../services/index');
const orderModel = require('../../models/order');
const dateUtil = require('../../utils/date');
const { fenToYuan } = require('../../utils/format');
const nav = require('../../utils/nav');
const pageBg = require('../../utils/page-bg');
const { DEFAULT_RETURN_DAYS, MAX_VOUCHER_COUNT } = require('../../constants/index');

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function buildDeadlineTimeRange() {
  const hours = [];
  const minutes = [];
  const seconds = [];
  for (let i = 0; i < 24; i++) hours.push(pad2(i));
  for (let i = 0; i < 60; i++) minutes.push(pad2(i));
  for (let i = 0; i < 60; i++) seconds.push(pad2(i));
  return [hours, minutes, seconds];
}

const DEADLINE_TIME_RANGE = buildDeadlineTimeRange();

function deadlineTimeToIndex(time) {
  const parts = orderModel.normalizeDeadlineTime(time).split(':');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function indexToDeadlineTime(idx) {
  const arr = idx || [0, 0, 0];
  return pad2(Number(arr[0]) || 0) + ':' + pad2(Number(arr[1]) || 0) + ':' + pad2(Number(arr[2]) || 0);
}

/** 超过这个体积先压缩再上传（上传与云函数识别都更快） */
const OCR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 识别用截图超过 5MB 时先压一次；压不动（低版本基础库/压缩失败）就用原图，
 * 不让压缩失败阻塞识别。只用于 onOcrPick 的识别链路，凭证相册上传不压缩。
 */
function compressOcrImage(filePath, size) {
  if (size <= OCR_MAX_BYTES || !wx.compressImage) return Promise.resolve(filePath);

  return new Promise(function (resolve) {
    wx.compressImage({
      src: filePath,
      quality: 70,
      success: (res) => resolve((res && res.tempFilePath) || filePath),
      fail: () => resolve(filePath),
    });
  });
}

Page({
  data: {
    mode: 'create', // create | edit
    id: '',

    today: '',
    loading: true,
    saving: false,
    errorMsg: '',
    pageBg: '',

    // 表单字段
    productName: '',
    platforms: [],
    platformNames: [],
    // ⚠️ 不能设 -1：微信 picker 的 value 必须是合法的数组下标（0 起），
    // 传 -1 会导致整个选择器点不开（点了没反应）。未选平台时靠
    // `platform || '选择购买平台'` 显示占位文案，这里只是预选高亮项。
    platformIndex: 0,
    platform: '',
    amountYuan: '',
    receiveDate: '',
    returnDays: DEFAULT_RETURN_DAYS,
    deadline: '',
    deadlineText: '',
    deadlineOverridden: false,
    deadlineTime: '00:00:00',
    deadlineTimeIndex: [0, 0, 0],
    deadlineTimeRange: DEADLINE_TIME_RANGE,
    orderNo: '',
    orderNoDupText: '',
    returnReason: '',
    pickupCode: '',
    remark: '',
    voucher: [],

    // OCR 识别状态
    ocrBusy: false,

    // 想退货（犹豫中）
    considering: false,

    // 编辑态才需要
    status: 'pending',
    appliedAtText: '',
    pickedAtText: '',

    // 上门取件时间选择
    pickupPickerVisible: false,
    pickupTimeDraft: '',
  },

  onShow() {
    pageBg.sync(this);
  },

  onLoad(options) {
    this._unloaded = false;

    // 预热 api 云函数（OCR 与业务接口在同一函数），
    // 把冷启动提前到用户选图之前，失败忽略
    services.adapter
      .getAdapter()
      .callFunction('api', { action: 'health' })
      .catch(() => {});

    const today = dateUtil.today();
    const id = (options && options.id) || '';

    this.setData({
      today: today,
      receiveDate: today,
      deadline: orderModel.calcDeadline(today, DEFAULT_RETURN_DAYS),
      deadlineTime: '00:00:00',
      deadlineTimeIndex: [0, 0, 0],
      id: id,
      mode: id ? 'edit' : 'create',
    });

    wx.setNavigationBarTitle({ title: id ? '编辑退货' : '记一笔退货' });

    // 新建时用「设置」里的默认退货天数（异步，不阻塞页面）
    this.loadDefaultReturnDays();

    this.loadPlatforms().then(() => {
      if (id) return this.loadOrder(id);
      this.setData({ loading: false });
      return null;
    });
  },

  /**
   * 新建订单时读取「设置」里的默认退货天数。
   * 编辑态不动已有订单；用户已手动改过天数时也不覆盖。
   */
  loadDefaultReturnDays() {
    if (this.data.mode !== 'create') return Promise.resolve();

    return services.settings
      .get()
      .then((settings) => {
        const days = Number(settings.defaultReturnDays);
        if (!isFinite(days) || days < 0) return;
        // 用户已手动改过天数（或选过带特殊规则的平台）则不覆盖
        if (this._daysTouched) return;

        this.setData({ returnDays: days });
        this.recalculateDeadline();
      })
      .catch((err) => {
        console.warn('[order-edit] 读取默认退货天数失败，用系统默认', err && err.message);
      });
  },

  /** 平台清单：系统预置 + 用户自建 */
  loadPlatforms() {
    return services.platform
      .listForPicker()
      .then((list) => {
        this.setData({
          platforms: list,
          platformNames: list.map((p) => p.name),
        });
      })
      .catch((err) => {
        console.warn('[order-edit] 平台列表加载失败', err);
      });
  },

  loadOrder(id) {
    return services.orders
      .getById(id)
      .then((order) => {
        if (!order) {
          this.setData({ loading: false, errorMsg: '订单不存在或已被删除' });
          return;
        }

        // indexOf 找不到时返回 -1，但 picker 的 value 不允许负下标（会点不开），
        // 兜底成 0：仅影响「预选高亮项」，展示仍由 platform 字段决定，不影响正确性。
        const index = Math.max(0, this.data.platformNames.indexOf(order.platform));

        const receiveDate =
          dateUtil.toDateOnly(order.receiveDate) || this.data.today;
        const returnDays =
          order.returnDays === undefined ? DEFAULT_RETURN_DAYS : order.returnDays;
        const autoDeadline = orderModel.calcDeadline(receiveDate, returnDays);

        // 兜底脏数据：历史订单的 deadline 可能因早期 bug 被清成空串，
        // 此时日期 picker 拿到空 value 会点不开、最晚可退日也显示空白。
        // 这里用「收货日 + 天数」自动补算，让页面可正常编辑，用户保存时再落库修复。
        const storedDeadline = dateUtil.toDateOnly(order.deadline) || autoDeadline;
        const deadlineTime = orderModel.normalizeDeadlineTime(order.deadlineTime);

        this.setData({
          loading: false,
          productName: order.productName || '',
          platform: order.platform || '',
          platformIndex: index,
          amountYuan: order.amount ? fenToYuan(order.amount, false) : '',
          receiveDate: receiveDate,
          returnDays: returnDays,
          deadline: storedDeadline,
          deadlineText: dateUtil.formatCN(storedDeadline),
          deadlineTime: deadlineTime,
          deadlineTimeIndex: deadlineTimeToIndex(deadlineTime),
          // 存的 deadline 与自动算出的不一致，说明用户手动改过；
          // 空 deadline 补算后 deadlineOverridden 为 false，保持自动计算语义
          deadlineOverridden: !!dateUtil.toDateOnly(order.deadline) &&
            dateUtil.toDateOnly(order.deadline) !== autoDeadline,
          // 订单编号：兼容旧记录的 returnNo
          orderNo: order.orderNo !== undefined ? order.orderNo : order.returnNo || '',
          returnReason: order.returnReason || '',
          pickupCode: order.pickupCode || '',
          pickupTimeDraft: order.pickupTime || '',
          remark: order.remark || '',
          voucher: order.voucher || [],
          considering: !!order.considering,
          status: order.status || 'pending',
          appliedAtText: order.appliedAt ? dateUtil.toDateOnly(order.appliedAt) : '',
          pickedAtText: order.pickedAt ? dateUtil.toDateOnly(order.pickedAt) : '',
        });
      })
      .catch((err) => {
        this.setData({ loading: false, errorMsg: (err && err.message) || '加载失败' });
      });
  },

  // ---------------------------------------------------------------- 表单交互
  onFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;

    const patch = { [field]: e.detail.value, errorMsg: '' };
    if (field === 'orderNo') {
      patch.orderNoDupText = '';
      // 输入一变就作废在途的查重响应，避免旧结果盖到新编号上
      this._dupSeq = (this._dupSeq || 0) + 1;
    }
    this.setData(patch);

    if (field === 'orderNo') this._scheduleOrderNoCheck();
  },

  /** 订单编号实时查重（防抖 400ms）：只做输入提示，保存时服务层还会强制拦截 */
  _scheduleOrderNoCheck() {
    if (this._dupTimer) clearTimeout(this._dupTimer);

    const no = orderModel.normalizeOrderNo(this.data.orderNo);
    if (!no) {
      this._dupSeq = (this._dupSeq || 0) + 1;
      this.setData({ orderNoDupText: '' });
      return;
    }

    this._dupTimer = setTimeout(() => {
      this._checkOrderNoNow(false, no);
    }, 400);
  },

  /**
   * 查订单编号是否重复。
   * 用自增序号丢弃过期响应：输入 12345 → 改成 123456789 时，
   * 前一个请求即使后返回，也不会把红字盖到新编号上。
   *
   * @param {boolean} showModal 命中时是否弹窗（OCR 回填后立即提示）
   * @param {string} [value] 指定编号；不传则取表单当前值
   */
  _checkOrderNoNow(showModal, value) {
    const no = orderModel.normalizeOrderNo(
      value !== undefined ? value : this.data.orderNo
    );
    const seq = (this._dupSeq = (this._dupSeq || 0) + 1);

    if (!no) {
      this.setData({ orderNoDupText: '' });
      return;
    }

    services.orders
      .findByOrderNo(no, this.data.mode === 'edit' ? this.data.id : '')
      .then((dups) => {
        if (this._unloaded || seq !== this._dupSeq) return; // 过期响应

        if (!dups.length) {
          this.setData({ orderNoDupText: '' });
          return;
        }

        const first = dups[0] || {};
        const text =
          '该编号已被「' + (first.productName || '未命名') + '」使用，请修改后再保存';
        this.setData({ orderNoDupText: text });

        if (showModal) {
          wx.showModal({
            title: '订单编号重复',
            content: text,
            showCancel: false,
            confirmText: '去修改',
          });
        }
      })
      .catch(() => {
        // 实时提示失败不打扰；保存时服务层还会再查一次
      });
  },

  onUnload() {
    this._unloaded = true;
    if (this._dupTimer) clearTimeout(this._dupTimer);
  },

  onPlatformChange(e) {
    const index = Number(e.detail.value);
    const platform = this.data.platforms[index];

    this.setData({
      platformIndex: index,
      platform: platform ? platform.name : '',
      errorMsg: '',
    });

    // 仅当平台有「区别于系统默认」的规则时才覆盖天数；
    // 否则保留设置里的默认天数，避免选平台把用户自定义冲掉。
    if (
      platform &&
      platform.defaultReturnDays &&
      Number(platform.defaultReturnDays) !== DEFAULT_RETURN_DAYS &&
      !this.data.deadlineOverridden
    ) {
      this.updateReturnDays(platform.defaultReturnDays);
    }
  },

  onReceiveDateChange(e) {
    this._dateTouched = true; // 用户手动选过日期，OCR 结果不再覆盖
    this.setData({ receiveDate: e.detail.value, errorMsg: '' });
    this.recalculateDeadline();
  },

  onDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(0, Number(this.data.returnDays || 0) + delta);
    this.updateReturnDays(next);
  },

  updateReturnDays(days) {
    this._daysTouched = true; // 用户手动改过，设置页的默认天数不再回填
    this.setData({ returnDays: days });
    this.recalculateDeadline();
  },

  /** 自动重算最晚可退日，仅在用户未手动覆盖时生效 */
  recalculateDeadline() {
    if (this.data.deadlineOverridden) return;
    const deadline = orderModel.calcDeadline(this.data.receiveDate, this.data.returnDays);
    this.setData({
      deadline: deadline,
      deadlineText: dateUtil.formatCN(deadline),
    });
  },

  /** 手动指定最晚可退日（F-5：支持手动修改天数或日期） */
  onDeadlineChange(e) {
    const value = e.detail.value;
    this.setData({
      deadline: value,
      deadlineText: dateUtil.formatCN(value),
      deadlineOverridden: true,
    });
  },

  onResetDeadline() {
    this.setData({ deadlineOverridden: false });
    this.recalculateDeadline();
  },

  /** 最晚可退日的时分秒（默认 00:00:00） */
  onConsideringChange(e) {
    this.setData({ considering: !!e.detail.value });
  },

  onDeadlineTimeChange(e) {
    const idx = e.detail.value || [0, 0, 0];
    this.setData({
      deadlineTime: indexToDeadlineTime(idx),
      deadlineTimeIndex: idx,
    });
  },

  /**
   * 截图 OCR 识别入口。
   * 流程：选图 → 上传云存储 → 调 api 云函数 ocrOrder → 回填表单。
   * 识别结果只是建议值，用户核对后保存（符合决策 1）。
   */
  onOcrPick() {
    if (this.data.ocrBusy) return;

    this._ocrFileID = '';
    this._ocrVoucherReason = '';

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;

        this.setData({ ocrBusy: true });
        wx.showLoading({ title: '上传图片' });

        const adapter = services.adapter.getAdapter();

        compressOcrImage(file.tempFilePath, Number(file.size) || 0)
          .then((path) => adapter.uploadFile(path))
          .then((uploadRes) => {
            this._ocrFileID = (uploadRes && uploadRes.fileID) || '';

            // 识图用的截图直接存入凭证：去重、满额不覆盖已有凭证
            const append = orderModel.appendVoucher(
              this.data.voucher,
              this._ocrFileID,
              MAX_VOUCHER_COUNT
            );
            if (append.added) {
              this.setData({ voucher: append.list });
            }
            this._ocrVoucherReason = append.reason;

            // 上传完成，进入识别阶段（两段提示，避免一直显示“识别中”却卡在上传）
            wx.hideLoading();
            wx.showLoading({ title: '识别中' });

            return adapter.callFunction('api', {
              action: 'ocrOrder',
              fileID: uploadRes.fileID,
            });
          })
          .then((result) => {
            wx.hideLoading();
            this.setData({ ocrBusy: false });

            const data = (result && result.data) || {};
            if (!result || !result.ok) {
              this._afterOcrVoucher(false);
              wx.showModal({
                title: '识别未完成',
                content: (result && result.message) || '识别失败，可改手动录入',
                showCancel: false,
              });
              return;
            }
            this.applyOcrResult(data);
            this._afterOcrVoucher(true);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ ocrBusy: false });
            console.error('[order-edit] OCR 识别失败', err);
            this._afterOcrVoucher(false);
            wx.showModal({
              title: '识别失败',
              content: (err && err.message) || '请稍后重试，或改手动录入',
              showCancel: false,
            });
          });
      },
    });
  },

  /**
   * OCR 结束后处理截图凭证：
   * - 已加入凭证 / 已存在：保留云存储文件；
   * - 凭证已满：删除这张未入凭证的截图（避免孤儿文件），识别成功时提示用户。
   */
  _afterOcrVoucher(notify) {
    const fileID = this._ocrFileID;
    const full = this._ocrVoucherReason === 'full';

    if (full && fileID) {
      services.adapter
        .getAdapter()
        .deleteFile([fileID])
        .catch(() => {});
    }

    if (full && notify) {
      wx.showModal({
        title: '凭证已满',
        content:
          '截图已识别，但凭证最多 ' +
          MAX_VOUCHER_COUNT +
          ' 张，本次截图未加入凭证。可删除一张后重新识图。',
        showCancel: false,
      });
    }

    this._ocrFileID = '';
    this._ocrVoucherReason = '';
  },

  /** 把 OCR 结果回填到表单（仅填空位，不覆盖用户已填的内容） */
  applyOcrResult(data) {
    const patch = {};

    // 版本号用于确认云端 api 是否已重传；旧版不会返回这个字段
    if (data.ocrVersion) {
      console.log('[OCR] 识别规则版本', data.ocrVersion);
    } else {
      console.warn('[OCR] 云端未返回规则版本，可能仍在运行旧版 api 云函数');
    }
    if (data.rawText) {
      console.log('[OCR] rawText', data.rawText);
    }

    // 兜底：全大写短代号（如 GG7）不是商品名，云端旧版返回也拦掉
    const looksLikeCode = /^[A-Z0-9][A-Z0-9-]{2,9}$/.test(String(data.productName || ''));
    if (data.productName && !this.data.productName && !looksLikeCode) {
      patch.productName = data.productName;
    }
    if (data.amount && !this.data.amountYuan) {
      // amount 单位是分，转回元字符串
      patch.amountYuan = fenToYuan(data.amount, false);
    }
    // 收货日期：onLoad 预置了「今天」，不能再用 !receiveDate 判断。
    // 只要用户没手动改过日期，OCR 识别出的收货日期就应该覆盖默认值。
    if (data.date && !this._dateTouched) {
      patch.receiveDate = data.date;
    }
    // 平台只在「高/中置信」时回填，且必须能在平台清单里找到；
    // 证据不足（unknown/low）宁可不填，避免把用户带到错误平台。
    if (
      data.platform &&
      !this.data.platform &&
      data.platformConfidence !== 'unknown' &&
      data.platformConfidence !== 'low'
    ) {
      const idx = this.data.platformNames.indexOf(data.platform);
      if (idx > -1) {
        patch.platform = data.platform;
        patch.platformIndex = idx;
      }
    }
    // 订单编号：优先用 OCR 识别出的订单号
    if (data.orderNo && !this.data.orderNo) {
      patch.orderNo = data.orderNo;
    }
    if (data.orderNo) {
      console.log(
        '[OCR] 订单编号',
        data.orderNo,
        data.orderNoLabel || '',
        data.orderNoIsFallback ? '(来自退货/售后号兜底)' : ''
      );
    }
    if (data.returnReason && !this.data.returnReason) {
      patch.returnReason = data.returnReason;
    }
    if (data.pickupCode && !this.data.pickupCode) {
      patch.pickupCode = data.pickupCode;
      // 非「取件码」标签命中（6 位数字兜底）时 need_confirm 为 true，
      // 识别完成的提示会点名取件码，让用户重点核对
      this._pickupNeedConfirm = !!data.need_confirm;
    }
    if (data.pickupCode) {
      console.log(
        '[OCR] 取件码',
        data.pickupCode,
        data.confidence || '',
        data.need_confirm ? '(6 位数字兜底，需核对)' : ''
      );
    }
    if (data.pickupTime && !this.data.pickupTimeDraft) {
      patch.pickupTimeDraft = data.pickupTime;
    }

    if (Object.keys(patch).length) {
      this.setData(patch);
      // 若填入了收货日期，重算最晚可退日
      if (patch.receiveDate) this.recalculateDeadline();
      // OCR 填了订单编号，立即查重；命中直接弹窗，不等用户点保存
      if (patch.orderNo) this._checkOrderNoNow(true, patch.orderNo);
      // 取件码来自 6 位数字兜底时点名提示；标签命中的走常规「已识别，请核对」
      if (patch.pickupCode && this._pickupNeedConfirm) {
        wx.showToast({ title: '已识别，请核对取件码', icon: 'none' });
      } else {
        wx.showToast({ title: '已识别，请核对', icon: 'success' });
      }
      this._pickupNeedConfirm = false;
    } else {
      wx.showToast({ title: '未识别到可填内容，请手动录入', icon: 'none' });
    }
  },

  onChooseImage() {
    const remain = MAX_VOUCHER_COUNT - this.data.voucher.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 ' + MAX_VOUCHER_COUNT + ' 张', icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' });
        const adapter = services.adapter.getAdapter();
        const tasks = res.tempFiles.map((f) => adapter.uploadFile(f.tempFilePath));

        // 用 allSettled 而不是 all：3 张图里第 1 张失败时，
        // all 会整体 reject 并丢弃后面已成功的结果，
        // 那些已上传的文件就白传了（云存储里成了孤儿）。
        Promise.allSettled(tasks)
          .then((results) => {
            const fileIds = results
              .filter((r) => r.status === 'fulfilled' && r.value)
              .map((r) => r.value.fileID)
              .filter(Boolean);

            const failed = results.length - fileIds.length;

            if (fileIds.length) {
              this.setData({ voucher: this.data.voucher.concat(fileIds) });
            }
            if (failed) {
              wx.showToast({
                title: failed + ' 张上传失败，已保留成功的',
                icon: 'none',
              });
            }
          })
          .then(() => wx.hideLoading());
      },
    });
  },

  onRemoveImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const list = this.data.voucher.slice();
    list.splice(index, 1);
    this.setData({ voucher: list });
  },

  // ---------------------------------------------------------------- 提交
  /**
   * 收集表单，产出「变更集」而不是「完整对象」。
   *
   * 这里的关键约定：**字段不存在 = 不要改它**。
   * 服务层靠 `patch.xxx === undefined` 判断字段是否被指定，
   * 所以不能用 '' / null 表达"没填"——那会被当成"要写空值"入库。
   *
   * 两个具体后果（都曾真实踩过）：
   *   1. deadline 若给 ''，服务层会跳过重算并把它写空，
   *      订单从此不再判逾期、不再提醒；
   *   2. source 若在编辑态也带上，OCR 录入的来源标记会被抹成 manual。
   */
  collectForm() {
    const form = {
      productName: this.data.productName,
      platform: this.data.platform,
      amount: Math.round(Number(this.data.amountYuan || 0) * 100),
      receiveDate: this.data.receiveDate,
      returnDays: Number(this.data.returnDays),
      deadlineTime: this.data.deadlineTime,
      orderNo: this.data.orderNo,
      considering: this.data.considering,
      returnReason: this.data.returnReason,
      pickupCode: this.data.pickupCode,
      remark: this.data.remark,
      voucher: this.data.voucher,
    };

    // 仅当用户手动改过日期时才带上 deadline；
    // 否则留给服务层按「收货日 + 天数」自动重算。
    if (this.data.deadlineOverridden) {
      form.deadline = this.data.deadline;
    }

    // 只有新建才决定来源；编辑态不携带 source，保留库中原值。
    if (this.data.mode === 'create') {
      form.source = 'manual';
    }

    return form;
  },

  onSubmit() {
    if (this.data.saving) return;

    // 编辑「已申请 / 已取货」订单时，先问是否撤销状态
    // （用户改了信息，可能意味着这单还没真正退掉，要移回未申请清单）
    if (
      this.data.mode === 'edit' &&
      (this.data.status === 'applied' || this.data.status === 'picked')
    ) {
      wx.showModal({
        title: this.data.status === 'picked' ? '这笔已取货' : '这笔已标记「上门取件」',
        content: '保存修改后，是否把它移回「退货名单」？',
        confirmText: '移回退货',
        cancelText: '只保存',
        success: (res) => {
          if (res.confirm) {
            this._revertApplied = true;
          }
          this._doSubmit();
        },
      });
      return;
    }

    this._doSubmit();
  },

  /** 真正执行保存（onSubmit 判定撤销与否后统一走这里） */
  _doSubmit() {
    if (this.data.saving) return;

    const form = this.collectForm();

    // 用户确认移回退货：显式撤销状态，并清空两个阶段时间，避免残留旧时间
    if (this._revertApplied) {
      form.status = 'pending';
      form.appliedAt = null;
      form.pickedAt = null;
      form.considering = false;
    }

    const errors = orderModel.validate(form);
    if (errors.length) {
      this._revertApplied = false;
      this.setData({ errorMsg: errors[0] });
      wx.showToast({ title: errors[0], icon: 'none' });
      return;
    }

    this._saveOrder(form);
  },

  /**
   * 落库。
   * 查重放在服务层（create/update 必经）：重复时抛 DUPLICATE_ORDER_NO，
   * 这里弹窗让用户选择「仍要保存」或「返回修改」。
   */
  _saveOrder(form) {
    if (this.data.saving) return;

    this.setData({ saving: true, errorMsg: '' });
    wx.showLoading({ title: '保存中' });

    const task =
      this.data.mode === 'edit'
        ? services.orders.update(this.data.id, form)
        : services.orders.create(form);

    task
      .then(() => {
        wx.hideLoading();
        wx.showToast({
          title: this._revertApplied ? '已移回退货' : '已保存',
          icon: 'success',
        });
        this._markOrdersDirty();
        this._revertApplied = false;
        setTimeout(() => nav.back(), 600);
      })
      .catch((err) => {
        wx.hideLoading();

        // 订单编号重复：硬拦截，不提供绕过入口
        if (err && err.code === 'DUPLICATE_ORDER_NO') {
          const dups = err.duplicates || [];
          const first = dups[0] || {};
          const name = first.productName || '未命名';
          const more = dups.length > 1 ? '等 ' + dups.length + ' 笔' : '';

          this.setData({
            saving: false,
            orderNoDupText: '该编号已被「' + name + '」使用，请修改后再保存',
          });

          wx.showModal({
            title: '订单编号重复',
            content:
              '已存在相同订单编号的订单' +
              more +
              '：「' +
              name +
              '」。请修改订单编号后再保存。',
            showCancel: false,
            confirmText: '去修改',
          });
          return;
        }

        console.error('[order-edit] 保存失败', err);
        this._revertApplied = false;
        this.setData({
          saving: false,
          errorMsg: (err && err.message) || '保存失败，请重试',
        });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /** 标记上门取件：先确认，再选取件时间 */
  onMarkApplied() {
    if (this.data.saving) return;

    wx.showModal({
      title: '标记为上门取件？',
      content: '标记后会记录取件时间，并从退回名单中移除。',
      confirmText: '确认标记',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ pickupPickerVisible: true });
      },
    });
  },

  /** 取件时间选好：真正标记上门取件 */
  onPickupTimeConfirm(e) {
    const pickupTime = (e.detail && e.detail.value) || '';
    this.setData({ pickupPickerVisible: false, saving: true });
    wx.showLoading({ title: '处理中' });

    services.orders
      .markApplied(this.data.id, pickupTime)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已标记', icon: 'success' });
        this._markOrdersDirty();
        setTimeout(() => nav.back(), 600);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  onPickupTimeCancel() {
    this.setData({ pickupPickerVisible: false });
  },

  /** 标记已取货：第三阶段终态（快递员已取走包裹） */
  onMarkPicked() {
    if (this.data.saving) return;

    wx.showModal({
      title: '确认快递已取走？',
      content: '标记后会记入「已取货」名单，这笔退货就完成了。',
      confirmText: '确认取货',
      success: (res) => {
        if (!res.confirm) return;

        this.setData({ saving: true });
        wx.showLoading({ title: '处理中' });

        services.orders
          .markPicked(this.data.id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已取货', icon: 'success' });
            this._markOrdersDirty();
            setTimeout(() => nav.back(), 600);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ saving: false });
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },

  /** 数据已变更：首页下次 onShow 重拉；预览图片等无变更场景不触发刷新 */
  _markOrdersDirty() {
    const app = getApp();
    if (app && app.globalData) app.globalData.ordersDirty = true;
  },

  onDelete() {
    wx.showModal({
      title: '删除这笔记录？',
      content: '删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#b4442f',
      success: (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中' });
        services.orders
          .remove(this.data.id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已删除', icon: 'success' });
            this._markOrdersDirty();
            setTimeout(() => nav.back(), 600);
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      },
    });
  },
});
