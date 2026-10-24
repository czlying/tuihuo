/**
 * 服务层统一出口
 * ------------------------------------------------------------------
 * 页面这样引：
 *   const services = require('../../services/index');
 *   services.orders.getDashboard()
 *
 * 页面不直接 require wx.cloud，也不直接 require 具体 adapter。
 * 这是「换后端只改一层」的边界。
 * ------------------------------------------------------------------
 */

module.exports = {
  orders: require('./order.service'),
  settings: require('./settings.service'),
  platform: require('./platform.service'),
  fortune: require('./fortune.service'),
  adapter: require('./adapters/index'),
};
