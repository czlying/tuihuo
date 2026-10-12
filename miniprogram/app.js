const { ENV_ID } = require('./config/env');

App({
  globalData: {
    /**
     * 云开发是否初始化成功。页面渲染前先看这个标志，
     * 失败时给出可读的提示，而不是白屏或一堆看不懂的报错。
     */
    cloudReady: false,
    cloudError: '',

    /**
     * 当前用户标识。
     * v1（微信小程序端）：uid 与 openid 同值，由云函数 whoami 获取后缓存。
     * v2（独立 App）：uid 换成自建用户体系的 ID，此处取值来源替换即可，
     *                 业务层代码无需改动。
     */
    uid: '',
    openid: '',
  },

  onLaunch() {
    this.initCloud();
  },

  /**
   * 初始化云开发。
   * 设计要点：ENV_ID 为空时不传 env，由微信客户端使用账号下的默认环境。
   * 这样用户不需要知道自己的环境 ID 也能跑起来。
   */
  initCloud() {
    if (!wx.cloud) {
      this.globalData.cloudError = '当前微信版本过低，请升级微信后再打开';
      console.error('[cloud] 基础库不支持 wx.cloud，请检查基础库版本');
      return;
    }

    const options = { traceUser: true };
    if (ENV_ID) {
      options.env = ENV_ID;
    }

    try {
      wx.cloud.init(options);
      this.globalData.cloudReady = true;
      console.log(
        '[cloud] 初始化成功，环境：' + (ENV_ID || '默认环境')
      );
    } catch (err) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = '云开发初始化失败，请确认已开通云开发';
      console.error('[cloud] 初始化失败', err);
    }
  },
});
