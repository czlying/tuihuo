const services = require('../../services/index');
const dateUtil = require('../../utils/date');
const { fenToYuan } = require('../../utils/format');
const nav = require('../../utils/nav');

Page({
  data: {
    keyword: '',
    results: [],
    total: 0,
    totalText: '',
    loading: false,
    loadingMore: false,
    hasMore: false,
  },

  onLoad() {
    this.search();
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer);
    this._unloaded = true;
  },

  onInput(e) {
    const keyword = (e.detail && e.detail.value) || '';
    this.setData({ keyword });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.search();
    }, 300);
  },

  onSearch() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.search();
  },

  onClear() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.setData({ keyword: '' }, () => this.search());
  },

  _mapItems(list) {
    return (list || []).map((item) => {
      const statusText =
        item.status === 'applied'
          ? '上门取件'
          : item.status === 'picked'
          ? '已取货'
          : item.considering
          ? '想退货'
          : '退货';
      const date =
        item.status === 'applied'
          ? item.appliedAt
          : item.status === 'picked'
          ? item.pickedAt
          : item.deadline;
      const dateOnly = dateUtil.toDateOnly(date);

      return Object.assign({}, item, {
        amountText: fenToYuan(item.amount),
        statusText: statusText,
        dateText: dateOnly ? dateUtil.formatCN(dateOnly) : '—',
      });
    });
  },

  _totalText(total, shown) {
    if (total > shown) return '共 ' + total + ' 笔，已显示前 ' + shown + ' 笔';
    return '共 ' + total + ' 笔';
  },

  search() {
    const keyword = String(this.data.keyword || '').trim();
    const seq = (this._seq = (this._seq || 0) + 1);
    this.setData({ loading: true, hasMore: false, loadingMore: false });

    services.orders
      .searchAll(keyword, 50, 0)
      .then((res) => {
        if (this._unloaded || seq !== this._seq) return;

        const results = this._mapItems(res.list);
        const total = res.total || results.length;
        this.setData({
          loading: false,
          results: results,
          total: total,
          hasMore: !!res.hasMore,
          totalText: this._totalText(total, results.length),
        });
      })
      .catch((err) => {
        if (this._unloaded || seq !== this._seq) return;
        console.error('[search] 搜索失败', err);
        this.setData({ loading: false, loadingMore: false });
        wx.showToast({ title: (err && err.message) || '搜索失败', icon: 'none' });
      });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;

    const keyword = String(this.data.keyword || '').trim();
    const seq = this._seq;
    this.setData({ loadingMore: true });

    services.orders
      .searchAll(keyword, 50, this.data.results.length)
      .then((res) => {
        if (this._unloaded || seq !== this._seq) return;

        const results = this.data.results.concat(this._mapItems(res.list));
        const total = res.total || results.length;
        this.setData({
          loadingMore: false,
          results: results,
          total: total,
          hasMore: !!res.hasMore,
          totalText: this._totalText(total, results.length),
        });
      })
      .catch((err) => {
        if (this._unloaded || seq !== this._seq) return;
        console.error('[search] 加载更多失败', err);
        this.setData({ loadingMore: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onReachBottom() {
    this.loadMore();
  },

  onOpenOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go('/pages/order-edit/order-edit?id=' + id);
  },
});
