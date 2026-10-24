function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

Component({
  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer: function (v) {
        if (v) this.init();
      },
    },
    value: {
      type: String,
      value: '',
      observer: function () {
        if (this.data.visible) this.init();
      },
    },
  },

  data: {
    date: '',
    time: '09:00',
    minDate: '',
    maxDate: '',
  },

  methods: {
    init() {
      const now = new Date();
      let date = formatDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      let time = '09:00';

      // 已有取件时间（OCR 或上次选择）时优先回填
      const m = String(this.data.value || '').match(
        /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/
      );
      if (m) {
        date = m[1];
        time = m[2];
      }

      this.setData({
        date: date,
        time: time,
        minDate: formatDate(now),
        maxDate: formatDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)),
      });
    },

    onDateChange(e) {
      this.setData({ date: e.detail.value });
    },

    onTimeChange(e) {
      this.setData({ time: e.detail.value });
    },

    onCancel() {
      this.triggerEvent('cancel');
    },

    onConfirm() {
      this.triggerEvent('confirm', {
        value: this.data.date + ' ' + this.data.time,
      });
    },

    noop() {},
  },
});
