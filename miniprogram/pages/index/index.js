const services = require('../../services/index');
const { fenToYuan } = require('../../utils/format');
const dateUtil = require('../../utils/date');

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    loading: true,
    errorMsg: '',
    cloudError: '',

    todayLabel: '',
    monthLabel: '',

    pendingCount: 0,
    pendingAmountText: '0.00',

    dueThisWeekCount: 0,

    overdueCount: 0,
    overdueAmountText: '0.00',

    appliedCountThisMonth: 0,
    appliedAmountText: '0.00',

    preview: [],
    hasMore: false,
    moreCount: 0,
  },

  onLoad() {
    const now = new Date();
    const todayStr = dateUtil.today();
    const app = getApp();

    this.setData({
      todayLabel:
        now.getFullYear() +
        '年' +
        (now.getMonth() + 1) +
        '月' +
        now.getDate() +
        '日 ' +
        WEEKDAYS[now.getDay()],
      monthLabel: dateUtil.formatMonthCN(todayStr),
      cloudError: (app && app.globalData && app.globalData.cloudError) || '',
    });
  },

  // 用 onShow 而不是 onLoad：
  // 从录入页返回时要立刻看到最新数据，onShow 每次回到页面都会触发。
  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true);
  },

  /**
   * 拉取看板数据。
   * 页面不直接调用云开发，全部经服务层；金额与日期的展示文案在
   * 这里一次性算好，WXML 里不做运算（WXML 不支持函数调用）。
   */
  refresh(fromPullDown) {
    this.setData({ loading: true, errorMsg: '' });

    return services.orders
      .getDashboard()
      .then((data) => {
        const preview = (data.preview || []).map((item) =>
          Object.assign({}, item, {
            amountText: fenToYuan(item.amount),
          })
        );

        this.setData({
          loading: false,
          monthLabel: data.monthLabel || this.data.monthLabel,

          pendingCount: data.pendingCount,
          pendingAmountText: fenToYuan(data.pendingAmount),

          dueThisWeekCount: data.dueThisWeekCount,

          overdueCount: data.overdueCount,
          overdueAmountText: fenToYuan(data.overdueAmount),

          appliedCountThisMonth: data.appliedCountThisMonth,
          appliedAmountText: fenToYuan(data.appliedAmountThisMonth),

          preview: preview,
          hasMore: data.pendingCount > preview.length,
          moreCount: data.pendingCount - preview.length,
        });
      })
      .catch((err) => {
        console.error('[index] 看板加载失败', err);
        this.setData({
          loading: false,
          errorMsg: (err && err.message) || '加载失败，请下拉重试',
        });
      })
      .then(() => {
        if (fromPullDown) wx.stopPullDownRefresh();
      });
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/order-edit/order-edit' });
  },

  onOpenOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/order-edit/order-edit?id=' + id });
  },

  onRetry() {
    this.refresh();
  },
});
