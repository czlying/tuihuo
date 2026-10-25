/**
 * 自定义页面背景（本机保存，不上传云端）
 * ------------------------------------------------------------------
 * 只记录「图片路径」，不记录图片内容：把路径塞进 data 是几十字节，
 * 把图片转成 base64 塞进 data 会直接撞上 setData 单次 1MB 上限。
 *
 * 相册选出来的是临时路径，小程序重启后失效，所以必须先转存到本地
 * 用户目录（wxfile://usr/...）再记路径。换图时先记下旧路径，新路径
 * 写入成功后再删旧文件，避免长期使用把本地文件配额占满。
 * ------------------------------------------------------------------
 */

const STORAGE_KEY = 'pageBgPath';

/** 读当前背景图路径；没设置过返回空串 */
function getPath() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** 删除一张已转存的背景图；失败不影响主流程 */
function unlink(path) {
  if (!path) return;
  try {
    wx.getFileSystemManager().unlink({
      filePath: path,
      fail: function () {},
    });
  } catch (e) {
    // 文件不在了或接口不可用，忽略
  }
}

/**
 * 把相册临时文件转存到本地用户目录并记下路径。
 * @param {string} tempFilePath wx.chooseMedia 返回的临时路径
 * @returns {Promise<string>} 转存后的持久路径
 */
function save(tempFilePath) {
  const oldPath = getPath();

  return new Promise(function (resolve, reject) {
    if (!tempFilePath) {
      reject(new Error('没有选中图片'));
      return;
    }

    wx.getFileSystemManager().saveFile({
      tempFilePath: tempFilePath,
      success: function (res) {
        const path = (res && res.savedFilePath) || '';
        if (!path) {
          reject(new Error('背景图保存失败'));
          return;
        }
        try {
          wx.setStorageSync(STORAGE_KEY, path);
        } catch (e) {
          unlink(path);
          reject(new Error('背景图保存失败，本地存储空间可能不足'));
          return;
        }
        if (oldPath && oldPath !== path) unlink(oldPath);
        resolve(path);
      },
      fail: function () {
        reject(new Error('背景图保存失败，请重试'));
      },
    });
  });
}

/** 恢复默认渐变：删文件 + 清键 */
function clear() {
  unlink(getPath());
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    // 清不掉也不阻塞页面
  }
}

/**
 * 把当前背景同步进页面 data（页面 onShow 调用一次）。
 * 路径没变就不 setData，避免每次切页触发无意义渲染。
 */
function sync(page) {
  const path = getPath();
  if (page && page.data && page.data.pageBg !== path) {
    page.setData({ pageBg: path });
  }
}

module.exports = {
  STORAGE_KEY,
  getPath,
  save,
  clear,
  sync,
};
