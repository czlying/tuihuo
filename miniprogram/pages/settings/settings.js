const services = require('../../services/index');
const settingsModel = require('../../models/settings');
const { DEFAULT_RETURN_DAYS, BUILD_VERSION } = require('../../constants/index');
const nav = require('../../utils/nav');

/** 提醒档位预设（用户自定义的其他值会动态补进去） */
const PRESET_ADVANCE = [7, 3, 1, 0];

/**
 * 云函数自检返回值 -> 页面展示结构。
 *
 * 特判 UNKNOWN_ACTION：说明云端 api 还是旧代码（没有 horoscopeProbe 动作），
 * 这正是「配了 Key 却不生效」最常见的原因，必须单独点名，
 * 否则用户只会看到一句「未识别返回」。
 */
function describeProbe(res) {
  if (!res) {
    return {
      level: 'error',
      title: '云函数没有返回结果',
      advice: '请确认 api 云函数已部署，检查网络后重试。',
    };
  }

  if (res.code === 'UNKNOWN_ACTION' || res.code === 'NO_ACTION') {
    return {
      level: 'error',
      title: '云端 api 不是最新代码',
      advice:
        '云函数里还没有 horoscopeProbe 动作，说明新代码没上传。在开发者工具右键 cloudfunctions/api → 上传并部署（云端安装依赖），再点一次检测。',
    };
  }

  if (res.ok && res.data && res.data.conclusion) return res.data.conclusion;

  return {
    level: 'error',
    title: '自检返回异常',
    advice: (res && res.message) || '未识别的返回结构，请查看云函数日志。',
  };
}

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

    probing: false,
    probeResult: null,
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '设置' });
    this.load();
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
   * 运势接口自检：真实请求一次聚合数据接口，把失败原因摊在页面上。
   * 结果不落库、不改任何设置，纯排查用。
   */
  onProbeFortune() {
    if (this.data.probing) return;

    this.setData({ probing: true, probeResult: null });

    services.fortune
      .probe()
      .then((res) => {
        this.setData({ probing: false, probeResult: describeProbe(res) });
      })
      .catch((err) => {
        this.setData({
          probing: false,
          probeResult: {
            level: 'error',
            title: '自检请求失败',
            advice: (err && err.message) || '请检查网络后重试',
          },
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
