const { ENV_ID, APP_ID } = require('./config/env');

App({
  globalData: {
    /**
     * 云开发是否初始化成功。页面渲染前先看这个标志，
     * 失败时给出可读的提示，而不是白屏或一堆看不懂的报错。
     */
    cloudReady: false,
    cloudError: '',

    /**
     * 首页数据是否需要刷新。
     * 只有录入页保存/标记/删除成功后置 true；index.onShow 只在这种情况下重拉，
     * 避免预览图片关闭、切后台回来等场景触发全量刷新。
     */
    ordersDirty: false,

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

    /**
     * 参数名要按运行端分开看：
     *   小程序运行时  -> env   （appid 由宿主自带，可不填）
     *   多端应用运行时 -> envid + appid（独立客户端，SDK 猜不出环境归属）
     * 两个键同时下发，各自只取认识的那个，多出来的会被忽略。
     * 只传 env 的写法在小程序里一直正常，切到多端后环境解析不出来，
     * 全部云调用会报 errCode -601002（环境不存在 / 无访问权限）。
     */
    const options = { traceUser: true };
    if (ENV_ID) {
      options.env = ENV_ID;
      options.envid = ENV_ID;
    }
    if (APP_ID) {
      options.appid = APP_ID;
    }

    try {
      wx.cloud.init(options);
      this.globalData.cloudReady = true;
      // 注意：init 不做校验，参数错了也不会抛，真正的失败要到首次云调用才暴露。
      // 所以这里不能写「初始化成功」，否则会误导排查方向。
      console.log(
        '[cloud] 已初始化，环境：' +
          (ENV_ID || '默认环境') +
          '，AppID：' +
          (APP_ID || '宿主自带')
      );
    } catch (err) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = '云开发初始化失败，请确认已开通云开发';
      console.error('[cloud] 初始化失败', err);
    }
  },
});
