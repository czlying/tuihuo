/**
 * 兼容占位文件 —— 真正的实现在 ../utils/fortune-local.js
 * ==================================================================
 * 为什么这里还有一份：
 *   微信开发者工具的「编译文件列表」曾收录过这个路径（当时文案模块建在
 *   miniprogram/data/ 下）。把文件挪到 utils/ 并把目录删掉之后，编译前
 *   的 precompile 阶段仍按旧清单来读这个路径，直接抛
 *       ENOENT: no such file or directory, open '...\miniprogram\data\fortune-local.js'
 *   清 cleanProjectFileListCache / cleanCompileCache 都没能去掉这条残留，
 *   所以在这里放一个转发文件兜住那个路径，让读取不再失败。
 *
 * 注意：
 *   - 本文件不被任何代码 require，不参与运势逻辑。
 *   - 维护运势文案请改 utils/fortune-local.js，不要改这里。
 *   - 若某天 IDE 不再报这条错误，可以删掉本文件与 data 目录。
 * ==================================================================
 */

module.exports = require('../utils/fortune-local');
