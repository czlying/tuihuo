const services = require('../../services/index');
const orderModel = require('../../models/order');
const dateUtil = require('../../utils/date');
const { fenToYuan } = require('../../utils/format');
const { DEFAULT_RETURN_DAYS, MAX_VOUCHER_COUNT } = require('../../constants/index');

Page({
  data: {
    mode: 'create', // create | edit
    id: '',

    today: '',
    loading: true,
    saving: false,
    errorMsg: '',

    // 表单字段
    productName: '',
    platforms: [],
    platformNames: [],
    platformIndex: -1,
    platform: '',
    amountYuan: '',
    receiveDate: '',
    returnDays: DEFAULT_RETURN_DAYS,
    deadline: '',
    deadlineText: '',
    deadlineOverridden: false,
    remark: '',
    voucher: [],

    // 编辑态才需要
    status: 'pending',
    appliedAtText: '',
  },

  onLoad(options) {
    const today = dateUtil.today();
    const id = (options && options.id) || '';

    this.setData({
      today: today,
      receiveDate: today,
      deadline: orderModel.calcDeadline(today, DEFAULT_RETURN_DAYS),
      id: id,
      mode: id ? 'edit' : 'create',
    });

    wx.setNavigationBarTitle({ title: id ? '编辑退货' : '记一笔退货' });

    this.loadPlatforms().then(() => {
      if (id) return this.loadOrder(id);
      this.setData({ loading: false });
      return null;
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

        const index = this.data.platformNames.indexOf(order.platform);
        const storedDeadline = dateUtil.toDateOnly(order.deadline);
        const autoDeadline = orderModel.calcDeadline(order.receiveDate, order.returnDays);

        this.setData({
          loading: false,
          productName: order.productName || '',
          platform: order.platform || '',
          platformIndex: index,
          amountYuan: order.amount ? fenToYuan(order.amount, false) : '',
          receiveDate: dateUtil.toDateOnly(order.receiveDate) || this.data.today,
          returnDays: order.returnDays === undefined ? DEFAULT_RETURN_DAYS : order.returnDays,
          deadline: storedDeadline,
          deadlineText: dateUtil.formatCN(storedDeadline),
          // 存的 deadline 与自动算出的不一致，说明用户手动改过
          deadlineOverridden: !!storedDeadline && storedDeadline !== autoDeadline,
          remark: order.remark || '',
          voucher: order.voucher || [],
          status: order.status || 'pending',
          appliedAtText: order.appliedAt ? dateUtil.toDateOnly(order.appliedAt) : '',
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
    this.setData({ [field]: e.detail.value, errorMsg: '' });
  },

  onPlatformChange(e) {
    const index = Number(e.detail.value);
    const platform = this.data.platforms[index];

    this.setData({
      platformIndex: index,
      platform: platform ? platform.name : '',
      errorMsg: '',
    });

    // 选平台时带出该平台的默认退货天数（仍在自动计算状态下才覆盖）
    if (platform && platform.defaultReturnDays && !this.data.deadlineOverridden) {
      this.updateReturnDays(platform.defaultReturnDays);
    }
  },

  onReceiveDateChange(e) {
    this.setData({ receiveDate: e.detail.value, errorMsg: '' });
    this.recalculateDeadline();
  },

  onDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(0, Number(this.data.returnDays || 0) + delta);
    this.updateReturnDays(next);
  },

  updateReturnDays(days) {
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

    const form = this.collectForm();
    const errors = orderModel.validate(form);
    if (errors.length) {
      this.setData({ errorMsg: errors[0] });
      wx.showToast({ title: errors[0], icon: 'none' });
      return;
    }

    this.setData({ saving: true, errorMsg: '' });
    wx.showLoading({ title: '保存中' });

    const task =
      this.data.mode === 'edit'
        ? services.orders.update(this.data.id, form)
        : services.orders.create(form);

    task
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[order-edit] 保存失败', err);
        this.setData({
          saving: false,
          errorMsg: (err && err.message) || '保存失败，请重试',
        });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /** 标记已申请（F-9 状态流转，写入 appliedAt 供时间线用） */
  onMarkApplied() {
    if (this.data.saving) return;

    wx.showModal({
      title: '标记为已申请退货？',
      content: '标记后会记录申请时间，并从未退清单中移除。',
      confirmText: '确认标记',
      success: (res) => {
        if (!res.confirm) return;

        this.setData({ saving: true });
        wx.showLoading({ title: '处理中' });

        services.orders
          .markApplied(this.data.id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已标记', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 600);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ saving: false });
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
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
            setTimeout(() => wx.navigateBack(), 600);
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      },
    });
  },
});
