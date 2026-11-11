const services = require('../../services/index');
const settingsModel = require('../../models/settings');
const { DEFAULT_RETURN_DAYS, BUILD_VERSION } = require('../../constants/index');
const nav = require('../../utils/nav');
const pageBg = require('../../utils/page-bg');

/** 提醒档位预设（用户自定义的其他值会动态补进去） */
const PRESET_ADVANCE = [7, 3, 1, 0];

Page({
  data: {
    loading: true,
    saving: false,
    errorMsg: '',

    defaultReturnDays: DEFAULT_RETURN_DAYS,
    advanceOptions: [],
    quietStart: '22:00',
    quietEnd: '08:00',
    subscribeFlag: false,
    buildVersion: BUILD_VERSION,

    // 运势接口自检（排查「配置了却一直显示兜底文案」）
    fortuneProbing: false,
    fortuneProbeOk: null,
    fortuneConclusion: '',
    fortuneAdvice: '',
    fortuneDetail: '',

    pageBg: '',
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '设置' });
    this.load();
  },

  onShow() {
    pageBg.sync(this);
  },

  load() {
    this.setData({ loading: true, errorMsg: '' });

    return services.settings
      .get()
      .then((settings) => {
        this.setData(Object.assign({ loading: false }, this.buildView(settings)));
      })
      .catch((err) => {
        this.setData({
          loading: false,
          errorMsg: (err && err.message) || '加载失败，请稍后重试',
        });
      });
  },

  /** 设置对象 -> 页面展示结构（含档位选中态） */
  buildView(settings) {
    const normalized = settingsModel.normalizeSettings(settings);
    const selected = normalized.remindAdvanceDays.slice();

    const values = PRESET_ADVANCE.slice();
    selected.forEach(function (d) {
      if (values.indexOf(d) === -1) values.push(d);
    });
    values.sort(function (a, b) { return b - a; });

    return {
      defaultReturnDays: normalized.defaultReturnDays,
      advanceOptions: values.map(function (d) {
        return {
          value: d,
          label: d === 0 ? '当天' : '提前' + d + '天',
          selected: selected.indexOf(d) > -1,
        };
      }),
      quietStart: normalized.quietHours.start,
      quietEnd: normalized.quietHours.end,
      subscribeFlag: normalized.subscribeFlag,
    };
  },

  onDaysStep(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.min(
      settingsModel.MAX_DEFAULT_RETURN_DAYS,
      Math.max(0, Number(this.data.defaultReturnDays || 0) + delta)
    );
    this.setData({ defaultReturnDays: next, errorMsg: '' });
  },

  /** 切换提醒档位：至少保留一个，避免"静默不提醒"的误解 */
  onToggleAdvance(e) {
    const index = Number(e.currentTarget.dataset.index);
    const options = this.data.advanceOptions.slice();
    const target = options[index];
    if (!target) return;

    const selectedCount = options.filter(function (o) { return o.selected; }).length;
    if (target.selected && selectedCount <= 1) {
      wx.showToast({ title: '至少保留一个提醒档位', icon: 'none' });
      return;
    }

    options[index] = Object.assign({}, target, { selected: !target.selected });
    this.setData({ advanceOptions: options, errorMsg: '' });
  },

  onQuietStartChange(e) {
    this.setData({ quietStart: e.detail.value, errorMsg: '' });
  },

  onQuietEndChange(e) {
    this.setData({ quietEnd: e.detail.value, errorMsg: '' });
  },

  /**
   * 更换背景图：只用官方相册选图接口，不申请其他权限。
   * 选中的是临时路径，先转存到本地用户目录，再把路径写进 data 立即生效。
   */
  onChooseBg() {
    if (this._bgPicking) return;
    this._bgPicking = true;

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) {
          this._bgPicking = false;
          return;
        }

        wx.showLoading({ title: '保存中' });

        pageBg
          .save(file.tempFilePath)
          .then((path) => {
            wx.hideLoading();
            this._bgPicking = false;
            this.setData({ pageBg: path });
            wx.showToast({ title: '已更换背景', icon: 'success' });
          })
          .catch((err) => {
            wx.hideLoading();
            this._bgPicking = false;
            wx.showToast({
              title: (err && err.message) || '背景图保存失败',
              icon: 'none',
            });
          });
      },
      fail: () => {
        // 取消选图不算失败，不弹提示
        this._bgPicking = false;
      },
    });
  },

  /** 恢复默认渐变背景 */
  onResetBg() {
    pageBg.clear();
    this.setData({ pageBg: '' });
    wx.showToast({ title: '已恢复默认背景', icon: 'none' });
  },

  /**
   * 运势接口自检。
   *
   * 云端会把「Key 有没有读到 / 带没带空格 / HTTP 状态 / 聚合数据错误码 / 耗时」
   * 一次摊开返回，并附一句中文结论。这里只做两件事：把结论原样显示，
   * 再把几个关键技术字段拼成一行细节，方便截图对照。
   */
  onProbeFortune() {
    if (this.data.fortuneProbing) return;

    this.setData({
      fortuneProbing: true,
      fortuneProbeOk: null,
      fortuneConclusion: '',
      fortuneAdvice: '',
      fortuneDetail: '',
    });

    services.fortune
      .probe()
      .then((p) => {
        const info = p || {};
        const res = info.conclusion || {};
        const bits = [];

        if (info.hasKey === false) bits.push('未读到 JUHE_KEY');
        if (info.keyLength) bits.push('Key 长度 ' + info.keyLength);
        if (info.keyHasSpace) bits.push('Key 首尾有空格');
        if (info.httpStatus) bits.push('HTTP ' + info.httpStatus);
        if (info.errorCode !== undefined && info.errorCode !== null && info.errorCode !== '') {
          bits.push('错误码 ' + info.errorCode);
        }
        if (info.elapsedMs !== undefined) bits.push('耗时 ' + info.elapsedMs + 'ms');
        if (info.reason) bits.push('reason=' + info.reason);
        // 云端若已经给出结构诊断（返回类型/字段名/原文预览），一并带上
        if (res.detail) bits.push(res.detail);

        this.setData({
          fortuneProbing: false,
          fortuneProbeOk: res.level === 'ok',
          // conclusion 是 { level, title, advice, detail } 对象，不是字符串；
          // 直接塞进 wxml 会渲染成 [object Object]（2026-11-10 实测踩到）。
          fortuneConclusion: res.title || (info.ok ? '接口正常' : '自检未通过'),
          fortuneAdvice: res.advice || '',
          fortuneDetail: bits.join(' · '),
        });
      })
      .catch((err) => {
        this.setData({
          fortuneProbing: false,
          fortuneProbeOk: false,
          fortuneConclusion: '自检请求本身失败：' + ((err && err.message) || '未知错误'),
          fortuneAdvice: '若云端返回 UNKNOWN_ACTION，说明 api 云函数没有重新部署。',
          fortuneDetail: '',
        });
      });
  },

  onSave() {
    if (this.data.saving) return;

    const payload = {
      defaultReturnDays: Number(this.data.defaultReturnDays),
      remindAdvanceDays: this.data.advanceOptions
        .filter(function (o) { return o.selected; })
        .map(function (o) { return o.value; }),
      quietHours: { start: this.data.quietStart, end: this.data.quietEnd },
      subscribeFlag: this.data.subscribeFlag,
    };

    const errors = settingsModel.validateSettings(payload);
    if (errors.length) {
      this.setData({ errorMsg: errors[0] });
      wx.showToast({ title: errors[0], icon: 'none' });
      return;
    }

    this.setData({ saving: true, errorMsg: '' });
    wx.showLoading({ title: '保存中' });

    services.settings
      .save(settingsModel.normalizeSettings(payload))
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => nav.back(), 500);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({
          saving: false,
          errorMsg: (err && err.message) || '保存失败，请重试',
        });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },
});
