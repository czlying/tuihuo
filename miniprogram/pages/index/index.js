const services = require('../../services/index');
const { fenToYuan, truncate } = require('../../utils/format');
const fortuneCache = require('../../utils/fortune-cache');
const dateUtil = require('../../utils/date');
const nav = require('../../utils/nav');

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const FORTUNE_FALLBACK = [
  '直觉敏锐，适合整理订单，退换货顺利~',
  '适合断舍离，把犹豫的订单理一理，今天做决定更轻松。',
  '沟通运不错，和客服确认细节，退货流程会更顺。',
  '财运平稳，适合核对金额和退款进度，别让小钱漏掉。',
  '情绪细腻的一天，先处理重要的事，退换货会有好消息。',
  '灵感在线，适合整理凭证和待办，事情会越理越清楚。',
  '耐心值在线，遇到售后问题别急，今天容易谈拢。',
  '适合收尾旧事，把该退的退掉，心里会轻很多。',
];

/** 按日期选一条兜底文案，保证每天变化、同一天稳定 */
function pickDailyFortune(dateOnly) {
  const text = String(dateOnly || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return FORTUNE_FALLBACK[hash % FORTUNE_FALLBACK.length];
}

/**
 * 卡片可见字数：文本框固定三行。
 * 算式：卡片内容宽 ≈ 163rpx（右栏 210 − 左内距 22 − 卡片左右内距 24），
 * 字号 16rpx 即每行约 10 字，三行约 30 字；留出省略号位置取 26。
 * 取 36 会让「…」落到第四行被裁掉，看起来就是「显示不全但没有省略号」。
 */
const FORTUNE_PEEK_LENGTH = 26;

Page({
  data: {
    loading: true,
    errorMsg: '',
    cloudError: '',
    fortuneText: '',
    fortunePeek: '',
    fortuneOpen: false,

    todayLabel: '',

    pendingCount: 0,
    pendingAmountText: '0.00',

    // 三个名单合计（顶部大额）
    totalAmountText: '0.00',
    totalCount: 0,
    // 各列表全量总额与笔数（列表头展示）
    appliedAllText: '0.00',
    appliedCountAll: 0,
    pickedAllText: '0.00',
    pickedCountAll: 0,

    pendingDueSoonCount: 0,
    decidedDueSoonCount: 0,
    pickupDueSoonCount: 0,

    // 已申请退货：内联展开列表（不跳新页面）
    appliedList: [],
    appliedTotalText: '0.00',
    appliedExpanded: false,
    // 已申请搜索：按商品名/平台筛选，列表最多展示 10 条
    appliedKeyword: '',
    appliedHasMore: false,
    appliedMatchedCount: 0,
    appliedLoadingMore: false,

    // 已取货列表（同样只取第一页）
    pickedList: [],
    pickedTotalText: '0.00',
    pickedExpanded: false,
    pickedKeyword: '',
    pickedHasMore: false,
    pickedMatchedCount: 0,
    pickedLoadingMore: false,

    preview: [],
    hasMore: false,
    moreCount: 0,

    // 名单收起状态
    consideringExpanded: true,
    pendingExpanded: true,

    // 想退货名单（犹豫中）
    consideringPreview: [],
    consideringCount: 0,
    consideringAmountText: '0.00',
    consideringHasMore: false,
    consideringMoreCount: 0,

    // 上门取件时间选择
    pickupPickerVisible: false,
    pickupTimeDraft: '',

    // 临期名单搜索
    pendingKeyword: '',
    pendingDisplay: [],
    swipeId: '',
    pendingSearchHasMore: false,
    pendingSearchTotal: 0,
    pendingSearching: false,
  },

  onLoad() {
    this._firstShow = true;
    const now = new Date();
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
      cloudError: (app && app.globalData && app.globalData.cloudError) || '',
    });
  },

  // 用 onShow 而不是 onLoad：
  // 从录入页返回时要立刻看到最新数据；但预览图片关闭、切后台回来
  // 并没有数据变化，不能每次都全量重拉（3 个查询 + 图片重载）。
  onShow() {
    this.loadFortune();

    if (this._firstShow) {
      this._firstShow = false;
      this.refresh();
      return;
    }

    const app = getApp();
    if (app && app.globalData && app.globalData.ordersDirty) {
      app.globalData.ordersDirty = false;
      this.refresh();
    }
  },

  /**
   * 今日双鱼座运势。
   *
   * 取数顺序：
   *   1. 本地当日缓存（落盘）——冷启动也能直接用，不再请求接口；
   *   2. 缓存没有 → 先显示按日期兜底文案，再经云函数代理请求聚合数据
   *      （consName=双鱼座&type=today），成功则覆盖并写入当日缓存。
   *
   * 展示：卡片文本框固定三行，超出补「…」；点卡片弹浮层看全文。
   * Key 只存在于云函数环境变量 JUHE_KEY，前端不接触；失败/超时保持兜底，
   * 不白屏不报错，且失败不写缓存——下次进页面还会重试。
   */
  loadFortune() {
    const today = dateUtil.today();
    if (this._fortuneDate === today) return;

    const cached = fortuneCache.read();
    if (fortuneCache.isFresh(cached, today)) {
      this._fortuneDate = today;
      this.setFortune(cached.text);
      return;
    }

    this.setFortune(pickDailyFortune(today));

    services.fortune
      .getToday()
      .then((text) => {
        if (this._unloaded) return; // 页面已卸载，不再 setData
        // 只有成功才写缓存（内存 + 落盘）：失败时下次进页面还能重试，
        // 否则会被「同日只请求一次」挡住，看起来像配置没生效
        this._fortuneDate = today;
        fortuneCache.write(fortuneCache.make(text, today));
        this.setFortune(text);
      })
      .catch((err) => {
        console.warn('[fortune] 运势接口不可用，使用当日兜底文案', err && err.message);
      });
  },

  /** 一次写入完整文案与卡片可见截断，避免两处分别计算导致不一致 */
  setFortune(text) {
    const full = String(text || '');
    this.setData({
      fortuneText: full,
      fortunePeek: truncate(full, FORTUNE_PEEK_LENGTH),
    });
  },

  onOpenFortune() {
    if (!this.data.fortuneText) return;
    this.setData({ fortuneOpen: true });
  },

  onCloseFortune() {
    if (!this.data.fortuneOpen) return;
    this.setData({ fortuneOpen: false });
  },

  /** 浮层内部点击/滑动不关闭（阻止事件冒泡到遮罩） */
  onFortunePopTap() {},

  onPullDownRefresh() {
    this.refresh(true);
  },

  /**
   * 拉取看板数据。
   * 页面不直接调用云开发，全部经服务层；金额与日期的展示文案在
   * 这里一次性算好，WXML 里不做运算（WXML 不支持函数调用）。
   */
  refresh(fromPullDown) {
    this.setData({ loading: true, errorMsg: '', swipeId: '' });

    // 已申请第一页与看板并行拉取（带当前关键词）
    const appliedSeq = (this._appliedSeq = (this._appliedSeq || 0) + 1);
    const appliedTask = services.orders
      .listApplied({ keyword: this.data.appliedKeyword, offset: 0 })
      .catch((err) => {
        console.warn('[index] 已申请列表加载失败，按空处理', err && err.message);
        return { list: [], total: 0, hasMore: false, keyword: this.data.appliedKeyword };
      });

    // 已取货第一页（并行）
    const pickedSeq = (this._pickedSeq = (this._pickedSeq || 0) + 1);
    const pickedTask = services.orders
      .listPicked({ keyword: this.data.pickedKeyword, offset: 0 })
      .catch((err) => {
        console.warn('[index] 已取货列表加载失败，按空处理', err && err.message);
        return { list: [], total: 0, hasMore: false, keyword: this.data.pickedKeyword };
      });

    return services.orders
      .getDashboard()
      .then((data) => {
        const preview = (data.preview || []).map((item) =>
          Object.assign({}, item, {
            amountText: fenToYuan(item.amount),
          })
        );
        const considering = (data.consideringPreview || []).map((item) =>
          Object.assign({}, item, {
            amountText: fenToYuan(item.amount),
          })
        );

        return Promise.all([appliedTask, pickedTask]).then((results) => {
          const applied = results[0];
          const picked = results[1];

          // 期间若关键词变了（seq 变化），丢弃这次结果，避免旧数据覆盖新搜索
          if (appliedSeq === this._appliedSeq) {
            this._applyAppliedPage(applied, false);
          }
          if (pickedSeq === this._pickedSeq) {
            this._applyPickedPage(picked, false);
          }

          this.setData({
            loading: false,

            pendingCount: data.pendingCount,
            pendingAmountText: fenToYuan(data.pendingAmount),
            consideringPreview: considering,
            consideringCount: data.consideringCount || 0,
            consideringAmountText: fenToYuan(data.consideringAmount || 0),
            consideringHasMore: (data.consideringCount || 0) > considering.length,
            consideringMoreCount: Math.max(
              0,
              (data.consideringCount || 0) - considering.length
            ),

            totalAmountText: fenToYuan(data.totalAmount),
            totalCount: data.totalCount,
            appliedAllText: fenToYuan(data.appliedAmountAll),
            appliedCountAll: data.appliedCountAll,
            pickedAllText: fenToYuan(data.pickedAmountAll),
            pickedCountAll: data.pickedCountAll,

            pendingDueSoonCount: data.pendingDueSoonCount,
            decidedDueSoonCount: data.decidedDueSoonCount,
            pickupDueSoonCount: data.pickupDueSoonCount,

            preview: preview,
            // 搜索中保留当前结果，避免刷新瞬间闪回全量预览
            pendingDisplay: this.data.pendingKeyword ? this.data.pendingDisplay : preview,
            hasMore: data.pendingCount > preview.length,
            moreCount: Math.max(0, data.pendingCount - preview.length),

          });

          // 有搜索词时，刷新后同步刷新搜索结果
          if (this.data.pendingKeyword) {
            this.reloadPendingSearch();
          }
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
    nav.go('/pages/order-edit/order-edit');
  },

  /** 打开设置页 */
  onOpenSearch() {
    nav.go('/pages/search/search');
  },

  onOpenSettings() {
    nav.go('/pages/settings/settings');
  },

  // ---------------------------------------------------------------- 左滑删除
  onRowTouchStart(e) {
    const t = (e.touches && e.touches[0]) || null;
    if (!t) return;
    this._swipeMoved = false;
    this._touchStartX = t.clientX;
    this._touchStartY = t.clientY;
  },

  onRowTouchMove(e) {
    const t = (e.touches && e.touches[0]) || null;
    if (!t || this._touchStartX === undefined) return;

    const dx = t.clientX - this._touchStartX;
    const dy = t.clientY - this._touchStartY;
    // 只认横向手势，纵向留给页面滚动
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
      this._swipeMoved = true;
    }
  },

  onRowTouchEnd(e) {
    const id = e.currentTarget.dataset.id;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (!id || !t || this._touchStartX === undefined) return;

    const dx = t.clientX - this._touchStartX;
    this._touchStartX = undefined;

    if (!this._swipeMoved) return;
    if (dx < -30) {
      this.setData({ swipeId: id });
    } else if (dx > 30) {
      this.setData({ swipeId: '' });
    }
  },

  /** 左滑后触发的 tap 不应再进详情；点已展开的行则先收起 */
  _isSwipeConsumed() {
    if (this._swipeMoved) {
      this._swipeMoved = false;
      return true;
    }
    if (this.data.swipeId) {
      this.setData({ swipeId: '' });
      return true;
    }
    return false;
  },

  /** 左滑露出的删除按钮（catchtap，不会触发进入详情） */
  onDeleteOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '删除这笔记录？',
      content: '删除后无法恢复，凭证图片也会一并清理。',
      confirmText: '删除',
      confirmColor: '#b4442f',
      success: (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中' });
        services.orders
          .remove(id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ swipeId: '' });
            this.refresh();
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      },
    });
  },

  onToggleConsidering() {
    this.setData({ consideringExpanded: !this.data.consideringExpanded });
  },

  onTogglePending() {
    this.setData({ pendingExpanded: !this.data.pendingExpanded });
  },

  /** 想退货名单「决定退」：输入取件码后移入退货名单 */
  onDecideReturn(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._deciding) return;

    const target = this.data.consideringPreview.find((item) => item._id === id);
    if (!target) return;

    wx.showModal({
      title: '决定退',
      editable: true,
      placeholderText: '取件码（没有可留空）',
      content: target.pickupCode || '',
      confirmText: '确认',
      success: (res) => {
        if (!res.confirm) return;

        const pickupCode = String(res.content || '').trim();
        this._deciding = true;
        services.orders
          .update(id, { considering: false, pickupCode: pickupCode })
          .then(() => {
            wx.showToast({ title: '已移到退货名单', icon: 'success' });
            this.refresh();
          })
          .catch((err) => {
            console.error('[index] 移入退货名单失败', err);
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          })
          .then(() => {
            this._deciding = false;
          });
      },
    });
  },

  /** 退货名单「标记上门取件」：确认后选取件时间，转入上门取件 */
  onQuickMarkApplied(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._marking) return;

    const target = this.data.pendingDisplay.find((item) => item._id === id);
    if (!target) return;

    wx.showModal({
      title: '标记为上门取件？',
      content: '「' + target.productName + '」将移到上门取件名单，并记录取件时间。',
      confirmText: '确认标记',
      success: (res) => {
        if (!res.confirm) return;
        this._pickupTargetId = id;
        this.setData({
          pickupPickerVisible: true,
          pickupTimeDraft: target.pickupTime || '',
        });
      },
    });
  },

  onPickupTimeConfirm(e) {
    const id = this._pickupTargetId;
    const pickupTime = (e.detail && e.detail.value) || '';
    this._pickupTargetId = '';
    this.setData({ pickupPickerVisible: false });
    if (!id || this._marking) return;

    this._marking = true;
    services.orders
      .markApplied(id, pickupTime)
      .then(() => {
        wx.showToast({ title: '已标记', icon: 'success' });
        this.refresh();
      })
      .catch((err) => {
        console.error('[index] 标记上门取件失败', err);
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      })
      .then(() => {
        this._marking = false;
      });
  },

  onPickupTimeCancel() {
    this._pickupTargetId = '';
    this.setData({ pickupPickerVisible: false });
  },

  onHide() {
    if (this.data.pickupPickerVisible) {
      this.setData({ pickupPickerVisible: false });
    }
  },

  onOpenOrder(e) {
    if (this._isSwipeConsumed()) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go('/pages/order-edit/order-edit?id=' + id);
  },

  /**
   * 已申请行内快捷「取货」：标记为已取货，该笔从已申请移入已取货名单。
   * catchtap 阻止冒泡，避免点按钮时误触进入详情页。
   */
  onQuickMarkPicked(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._picking) return;

    const target = this.data.appliedList.find((item) => item._id === id);
    if (!target) return;

    wx.showModal({
      title: '确认快递已取走？',
      content: '「' + target.productName + '」将移入「已取货」名单。',
      confirmText: '确认取货',
      success: (res) => {
        if (!res.confirm) return;

        this._picking = true;
        this.setData({
          appliedList: this.data.appliedList.map((item) =>
            item._id === id ? Object.assign({}, item, { marking: true }) : item
          ),
        });

        services.orders
          .markPicked(id)
          .then(() => {
            wx.showToast({ title: '已取货', icon: 'success' });
            this.refresh();
          })
          .catch((err) => {
            console.error('[index] 快捷取货失败', err);
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
            this.refresh();
          })
          .then(() => {
            this._picking = false;
          });
      },
    });
  },

  /** 展开 / 收起「已申请退货」列表（原地展开，不跳新页面） */
  onOpenApplied() {
    this.setData({ appliedExpanded: !this.data.appliedExpanded });
  },

  /** 点已申请列表里的某笔，进详情编辑 */
  onOpenAppliedOrder(e) {
    if (this._isSwipeConsumed()) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go('/pages/order-edit/order-edit?id=' + id);
  },

  /** 点击列表缩略图：预览该订单的全部凭证图 */
  onPreviewVoucher(e) {
    const urls = e.currentTarget.dataset.urls || [];
    const index = Number(e.currentTarget.dataset.index) || 0;
    if (!urls.length) return;

    wx.showLoading({ title: '加载图片' });
    services.adapter
      .getAdapter()
      .getTempFileURL(urls)
      .then((list) => {
        wx.hideLoading();
        const valid = (list || []).filter(Boolean);
        if (!valid.length) {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
          return;
        }
        wx.previewImage({
          current: list[index] || valid[0],
          urls: valid,
        });
      })
      .catch(() => {
        wx.hideLoading();
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      });
  },

  /** 把一行订单转成展示结构 */
  _mapAppliedRow(item) {
    const appliedDate = dateUtil.toDateOnly(item.appliedAt);
    return Object.assign({}, item, {
      amountText: fenToYuan(item.amount),
      appliedAtText: dateUtil.formatCN(appliedDate),
    });
  },

  /**
   * 应用一页已申请数据。
   * @param {object} result 服务层返回 { list, total, hasMore }
   * @param {boolean} append true=追加（滚动加载更多），false=替换（首屏/搜索）
   */
  _applyAppliedPage(result, append) {
    const mapped = ((result && result.list) || []).map((item) => this._mapAppliedRow(item));
    const appliedList = append ? this.data.appliedList.concat(mapped) : mapped;

    let total = 0;
    appliedList.forEach((item) => {
      total += Number(item.amount) || 0;
    });

    this.setData({
      appliedList: appliedList,
      appliedTotalText: fenToYuan(total),
      appliedHasMore: !!(result && result.hasMore),
      appliedMatchedCount: (result && result.total) || 0,
      appliedLoadingMore: false,
    });
  },

  /** 重新加载已申请第一页（搜索/清空时用，避免整个看板闪烁） */
  reloadApplied() {
    const seq = (this._appliedSeq = (this._appliedSeq || 0) + 1);

    return services.orders
      .listApplied({ keyword: this.data.appliedKeyword, offset: 0 })
      .then((applied) => {
        if (seq !== this._appliedSeq) return;
        this._applyAppliedPage(applied, false);
      })
      .catch((err) => {
        console.warn('[index] 已申请搜索失败', err && err.message);
      });
  },

  /**
   * 滚动加载下一页（每页 10 条，按申请时间倒序）。
   * 用 _appliedSeq 丢弃「翻页途中改了关键词/刷新」的过期结果。
   */
  loadMoreApplied() {
    if (!this.data.appliedExpanded) return;
    if (!this.data.appliedHasMore) return;
    if (this.data.appliedLoadingMore || this._appliedLoading) return;

    const seq = this._appliedSeq || 0;
    const offset = this.data.appliedList.length;

    this._appliedLoading = true;
    this.setData({ appliedLoadingMore: true });

    services.orders
      .listApplied({ keyword: this.data.appliedKeyword, offset: offset })
      .then((applied) => {
        if (seq !== this._appliedSeq) return;
        this._applyAppliedPage(applied, true);
      })
      .catch((err) => {
        console.warn('[index] 加载更多已申请失败', err && err.message);
      })
      .then(() => {
        this._appliedLoading = false;
        if (this.data.appliedLoadingMore) this.setData({ appliedLoadingMore: false });
      });
  },

  /** 页面触底：优先加载「已取货」，其次「已申请」 */
  onReachBottom() {
    if (this.data.pickedExpanded) {
      this.loadMorePicked();
      return;
    }
    this.loadMoreApplied();
  },

  /** 关键词输入：300ms 防抖，避免每敲一个字都查一次 */
  onAppliedKeywordInput(e) {
    const keyword = (e.detail && e.detail.value) || '';
    this.setData({ appliedKeyword: keyword });

    if (this._appliedTimer) clearTimeout(this._appliedTimer);
    this._appliedTimer = setTimeout(() => {
      this._appliedTimer = null;
      this.reloadApplied();
    }, 300);
  },

  /** 键盘点「搜索」时立即查，不等防抖 */
  onAppliedKeywordConfirm() {
    if (this._appliedTimer) {
      clearTimeout(this._appliedTimer);
      this._appliedTimer = null;
    }
    this.reloadApplied();
  },

  /** 清空关键词并恢复默认列表 */
  onAppliedKeywordClear() {
    if (this._appliedTimer) {
      clearTimeout(this._appliedTimer);
      this._appliedTimer = null;
    }
    this.setData({ appliedKeyword: '' }, () => this.reloadApplied());
  },

  // ---------------------------------------------------------------- 已取货
  /** 点已取货列表里的某笔，进详情编辑 */
  onOpenPickedOrder(e) {
    if (this._isSwipeConsumed()) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go('/pages/order-edit/order-edit?id=' + id);
  },

  /** 展开 / 收起「已取货」列表 */
  onOpenPicked() {
    this.setData({ pickedExpanded: !this.data.pickedExpanded });
  },

  /** 把一行已取货订单转成展示结构 */
  _mapPickedRow(item) {
    return Object.assign({}, item, {
      amountText: fenToYuan(item.amount),
      pickedAtText: dateUtil.formatCN(dateUtil.toDateOnly(item.pickedAt)),
    });
  },

  /** 应用一页已取货数据（append=true 为滚动加载追加） */
  _applyPickedPage(result, append) {
    const mapped = ((result && result.list) || []).map((item) => this._mapPickedRow(item));
    const pickedList = append ? this.data.pickedList.concat(mapped) : mapped;

    let total = 0;
    pickedList.forEach((item) => {
      total += Number(item.amount) || 0;
    });

    this.setData({
      pickedList: pickedList,
      pickedTotalText: fenToYuan(total),
      pickedHasMore: !!(result && result.hasMore),
      pickedMatchedCount: (result && result.total) || 0,
      pickedLoadingMore: false,
    });
  },

  /** 重新加载已取货第一页 */
  reloadPicked() {
    const seq = (this._pickedSeq = (this._pickedSeq || 0) + 1);

    return services.orders
      .listPicked({ keyword: this.data.pickedKeyword, offset: 0 })
      .then((picked) => {
        if (seq !== this._pickedSeq) return;
        this._applyPickedPage(picked, false);
      })
      .catch((err) => {
        console.warn('[index] 已取货搜索失败', err && err.message);
      });
  },

  /** 已取货滚动加载下一页 */
  loadMorePicked() {
    if (!this.data.pickedExpanded) return;
    if (!this.data.pickedHasMore) return;
    if (this.data.pickedLoadingMore || this._pickedLoading) return;

    const seq = this._pickedSeq || 0;
    const offset = this.data.pickedList.length;

    this._pickedLoading = true;
    this.setData({ pickedLoadingMore: true });

    services.orders
      .listPicked({ keyword: this.data.pickedKeyword, offset: offset })
      .then((picked) => {
        if (seq !== this._pickedSeq) return;
        this._applyPickedPage(picked, true);
      })
      .catch((err) => {
        console.warn('[index] 加载更多已取货失败', err && err.message);
      })
      .then(() => {
        this._pickedLoading = false;
        if (this.data.pickedLoadingMore) this.setData({ pickedLoadingMore: false });
      });
  },

  onPickedKeywordInput(e) {
    const keyword = (e.detail && e.detail.value) || '';
    this.setData({ pickedKeyword: keyword });

    if (this._pickedTimer) clearTimeout(this._pickedTimer);
    this._pickedTimer = setTimeout(() => {
      this._pickedTimer = null;
      this.reloadPicked();
    }, 300);
  },

  onPickedKeywordConfirm() {
    if (this._pickedTimer) {
      clearTimeout(this._pickedTimer);
      this._pickedTimer = null;
    }
    this.reloadPicked();
  },

  onPickedKeywordClear() {
    if (this._pickedTimer) {
      clearTimeout(this._pickedTimer);
      this._pickedTimer = null;
    }
    this.setData({ pickedKeyword: '' }, () => this.reloadPicked());
  },

  // ---------------------------------------------------------------- 临期名单搜索
  /** 把待退订单行转成展示结构 */
  _mapPendingRow(item) {
    return Object.assign({}, item, { amountText: fenToYuan(item.amount) });
  },

  /** 执行临期名单搜索；关键词为空则恢复默认预览 */
  reloadPendingSearch() {
    const keyword = this.data.pendingKeyword;
    const seq = (this._pendingSeq = (this._pendingSeq || 0) + 1);

    if (!keyword) {
      this.setData({
        pendingDisplay: this.data.preview,
        pendingSearchHasMore: false,
        pendingSearchTotal: 0,
        pendingSearching: false,
      });
      return Promise.resolve();
    }

    this.setData({ pendingSearching: true });

    return services.orders
      .searchPending({ keyword: keyword })
      .then((result) => {
        if (seq !== this._pendingSeq) return; // 期间关键词已变，丢弃过期结果
        const list = ((result && result.list) || []).map((item) => this._mapPendingRow(item));

        this.setData({
          pendingDisplay: list,
          pendingSearchHasMore: !!(result && result.hasMore),
          pendingSearchTotal: (result && result.total) || 0,
          pendingSearching: false,
        });
      })
      .catch((err) => {
        console.warn('[index] 临期名单搜索失败', err && err.message);
        this.setData({ pendingSearching: false });
      });
  },

  /** 临期名单关键词输入（300ms 防抖） */
  onPendingKeywordInput(e) {
    const keyword = (e.detail && e.detail.value) || '';
    this.setData({ pendingKeyword: keyword });

    if (this._pendingTimer) clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      this.reloadPendingSearch();
    }, 300);
  },

  /** 键盘点「搜索」立即查 */
  onPendingKeywordConfirm() {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this.reloadPendingSearch();
  },

  /** 清空临期名单关键词 */
  onPendingKeywordClear() {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this.setData({ pendingKeyword: '' }, () => this.reloadPendingSearch());
  },

  onUnload() {
    this._unloaded = true;
    if (this._appliedTimer) {
      clearTimeout(this._appliedTimer);
      this._appliedTimer = null;
    }
    if (this._pickedTimer) {
      clearTimeout(this._pickedTimer);
      this._pickedTimer = null;
    }
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  },

  onRetry() {
    this.refresh();
  },
});
