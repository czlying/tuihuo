/**
 * 项目静态校验脚本
 * ------------------------------------------------------------------
 * 运行：
 *   node scripts/verify-project.js
 *
 * 检查四类「编译期不报错、运行时才暴露」的问题：
 *   1. WXML 里绑定的事件处理函数，在页面 JS 里是否真实存在
 *      （写错了编译能过，点下去没任何反应，最难查）
 *   2. JS 里的 require 路径是否都能解析到真实文件
 *   3. app.json 声明的页面，文件是否齐全
 *   4. 云函数目录结构与依赖声明是否完整
 *
 * 第 [5] 段是校验器自检：用已知的错误样本确认上面的检测逻辑
 * 真的会报错。没有这一段，「全部通过」就只是没查出来的同义词。
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

let problems = 0;
let checked = 0;

function fail(msg) {
  problems++;
  console.log('  FAIL ' + msg);
}

function ok(msg) {
  checked++;
  console.log('  OK   ' + msg);
}

function walk(dir, ext, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  });
  return out;
}

/**
 * 去掉注释后再扫描。
 *
 * 为什么必须做：注释里经常出现示例代码（例如「页面这样引：
 * const services = require('../../services/index')」），
 * 不去注释就会把注释当真实代码报错 —— 那是误报，会掩盖真问题。
 * 校验器自身准，结论才可信。
 */
function stripComments(src) {
  let s = String(src).replace(/\/\*[\s\S]*?\*\//g, '');

  s = s
    .split('\n')
    .map(function (line) {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      if (line.charAt(idx - 1) === ':') return line; // 协议写法，非注释
      return line.slice(0, idx);
    })
    .join('\n');

  return s;
}

/** 去掉 WXML 注释 <!-- ... --> */
function stripWxmlComments(src) {
  return String(src).replace(/<!--[\s\S]*?-->/g, '');
}

/** 提取 WXML 中绑定的事件处理函数名 */
function extractHandlers(wxmlSrc) {
  const re = /(?:bind|catch):?[a-zA-Z]+="([A-Za-z_$][A-Za-z0-9_$]*)"/g;
  const set = new Set();
  let m;
  while ((m = re.exec(wxmlSrc)) !== null) set.add(m[1]);
  return set;
}

/** 判断 JS 源码里是否声明了某个方法 */
function hasDeclaration(jsSrc, name) {
  const n = String(name).replace(/\$/g, '\\$');
  return (
    new RegExp('\\b' + n + '\\s*\\(').test(jsSrc) ||
    new RegExp('\\b' + n + '\\s*:').test(jsSrc) ||
    new RegExp('\\b' + n + '\\s*=').test(jsSrc)
  );
}

/** 提取 JS 中的全部 require 路径 */
function extractRequires(jsSrc) {
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const list = [];
  let m;
  while ((m = re.exec(jsSrc)) !== null) list.push(m[1]);
  return list;
}

/** 相对 require 路径能否解析到真实文件 */
function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [base, base + '.js', path.join(base, 'index.js')].some((p) => fs.existsSync(p));
}


/**
 * 页面用到 orderModel.xxx 时必须真实 require models/order。
 * 漏导入编译不报错，运行时会抛 orderModel is not defined，整页数据加载失败。
 */
function hasOrderModelImport(src) {
  const code = stripComments(src);
  const uses = /\borderModel\s*\./.test(code);
  const imports = /require\(['"][^'"]*models\/order['"]\)/.test(code);
  return !uses || imports;
}

/** 页面是否直接调用 wx.navigateTo（应统一走 utils/nav.js） */
function hasBareNavigate(src) {
  return /\bwx\.navigateTo\s*\(/.test(stripComments(src));
}

/** 收集所有页面/全局 usingComponents 的引用路径 */
function collectComponentRefs() {
  const refs = new Set();
  walk(MP, '.json').forEach(function (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = data && data.usingComponents;
      if (map && typeof map === 'object') {
        Object.keys(map).forEach(function (k) {
          if (map[k]) refs.add(String(map[k]));
        });
      }
    } catch (e) {
      // JSON 解析失败由其他检查负责
    }
  });
  return refs;
}

/** 组件名是否被某个 usingComponents 引用 */
function isComponentReferenced(name, refs) {
  let hit = false;
  refs.forEach(function (ref) {
    if (ref.indexOf('/components/' + name + '/') >= 0 || ref === name) hit = true;
  });
  return hit;
}

// ============================================================ 1. 事件绑定
console.log('\n[1] WXML 事件绑定 -> JS 方法');

walk(MP, '.wxml').forEach(function (wxml) {
  const rel = path.relative(ROOT, wxml);
  const jsFile = wxml.replace(/\.wxml$/, '.js');

  if (!fs.existsSync(jsFile)) {
    fail(rel + ' 缺少同名 .js，页面不完整');
    return;
  }

  const handlers = extractHandlers(stripWxmlComments(fs.readFileSync(wxml, 'utf8')));
  const jsSrc = stripComments(fs.readFileSync(jsFile, 'utf8'));

  const missing = [];
  handlers.forEach(function (name) {
    if (!hasDeclaration(jsSrc, name)) missing.push(name);
  });

  if (missing.length) fail(rel + ' 绑定了不存在的方法：' + missing.join(', '));
  else ok(rel + '（' + handlers.size + ' 个事件处理函数全部存在）');
});

// ============================================================ 2. require 解析
console.log('\n[2] JS require 路径解析');

const jsFiles = walk(MP, '.js').concat(walk(path.join(ROOT, 'cloudfunctions'), '.js'));

jsFiles.forEach(function (file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  // 只校验相对路径；wx-server-sdk 这类包依赖由云端安装
  const bad = extractRequires(src).filter(
    (spec) => spec.charAt(0) === '.' && !resolveRequire(file, spec)
  );

  const rel = path.relative(ROOT, file);
  if (bad.length) fail(rel + ' require 无法解析：' + bad.join(', '));
  else ok(rel);
});

// ============================================================ 3. 页面文件完整性
console.log('\n[3] app.json 页面文件完整性');

const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));

(appJson.pages || []).forEach(function (page) {
  const base = path.join(MP, page);
  const miss = ['.js', '.wxml', '.json'].filter((ext) => !fs.existsSync(base + ext));

  if (miss.length) fail(page + ' 缺少：' + miss.join(', '));
  else ok(page + '（.js / .wxml / .json 齐全）');
});

// ============================================================ 4. 云函数结构
console.log('\n[4] 云函数结构');

const cfRoot = path.join(ROOT, 'cloudfunctions');
if (fs.existsSync(cfRoot)) {
  fs.readdirSync(cfRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .forEach(function (d) {
      const dir = path.join(cfRoot, d.name);
      const miss = ['index.js', 'package.json'].filter((f) => !fs.existsSync(path.join(dir, f)));

      if (miss.length) {
        fail('cloudfunctions/' + d.name + ' 缺少：' + miss.join(', '));
        return;
      }

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (!(pkg.dependencies && pkg.dependencies['wx-server-sdk'])) {
        fail('cloudfunctions/' + d.name + ' package.json 未声明 wx-server-sdk 依赖');
      } else {
        ok('cloudfunctions/' + d.name);
      }
    });
}

// ============================================================ 5. 页面模型导入
console.log('\n[5] 页面使用 orderModel 的导入完整性');
walk(path.join(MP, 'pages'), '.js').forEach(function (file) {
  if (hasOrderModelImport(fs.readFileSync(file, 'utf8'))) {
    ok(path.relative(ROOT, file) + ' orderModel 导入检查');
  } else {
    fail(path.relative(ROOT, file) + ' 使用 orderModel 但未导入 models/order');
  }
});

// ============================================================ 6. 页面跳转收口
console.log('\n[6] 页面禁止裸 wx.navigateTo');
walk(path.join(MP, 'pages'), '.js').forEach(function (file) {
  if (hasBareNavigate(fs.readFileSync(file, 'utf8'))) {
    fail(path.relative(ROOT, file) + ' 直接调用 wx.navigateTo，请改用 utils/nav.js');
  } else {
    ok(path.relative(ROOT, file) + ' 跳转收口检查');
  }
});

// ============================================================ 7. 组件引用
console.log('\n[7] components 下的组件必须被页面引用');
const componentRefs = collectComponentRefs();
const componentRoot = path.join(MP, 'components');
if (fs.existsSync(componentRoot)) {
  fs.readdirSync(componentRoot, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory();
    })
    .forEach(function (entry) {
      const name = entry.name;
      if (isComponentReferenced(name, componentRefs)) {
        ok('components/' + name + ' 已被页面引用');
      } else {
        fail('components/' + name + ' 未被任何页面 usingComponents 引用');
      }
    });
}

// ============================================================ 8. 校验器自检
console.log('\n[8] 校验器自检（用已知错误样本确认检测真的生效）');

(function selfTest() {
  const cases = [];

  // 样本 A：WXML 绑定了 JS 里不存在的方法，应被抓出
  cases.push({
    name: '能抓出不存在的绑定方法',
    pass: (function () {
      const h = extractHandlers('<view bindtap="onGhostTap"></view>');
      return h.has('onGhostTap') && !hasDeclaration('Page({ onReal(){} })', 'onGhostTap');
    })(),
  });

  // 样本 B：方法存在时不应误报（防假阳性）
  cases.push({
    name: '不误报真实存在的方法',
    pass: hasDeclaration('Page({ onAdd() {} })', 'onAdd'),
  });

  // 样本 C：行注释里的 require 不应被当成真实依赖
  cases.push({
    name: '忽略行注释中的 require',
    pass: extractRequires(stripComments("// require('./not-exist')\nconst a = 1;")).length === 0,
  });

  // 样本 D：块注释里的 require 同样应被忽略
  cases.push({
    name: '忽略块注释中的 require',
    pass:
      extractRequires(stripComments("/**\n * const x = require('./nope');\n */\nconst b = 2;"))
        .length === 0,
  });

  // 样本 E：真实 require 必须被提取出来（防漏报）
  cases.push({
    name: '正常提取真实 require',
    pass: extractRequires("const a = require('./real');").length === 1,
  });

  // 样本 F：http:// 这类协议写法不能被误当注释切断
  cases.push({
    name: '不误伤 http:// 协议写法',
    pass: stripComments("const u = 'https://a.com';").indexOf('https') > -1,
  });

  // 样本 G：WXML 注释里的绑定不应被计入
  cases.push({
    name: '忽略 WXML 注释中的绑定',
    pass: extractHandlers(stripWxmlComments('<!-- bindtap="ghost" -->')).size === 0,
  });

  cases.push({
    name: 'orderModel 导入完整',
    pass: hasOrderModelImport(
      "const orderModel = require('../../models/order');\norderModel.calcDeadline('2026-01-01', 7);"
    ),
  });

  cases.push({
    name: 'orderModel 漏导入会报警',
    pass: !hasOrderModelImport("orderModel.calcDeadline('2026-01-01', 7);"),
  });

  cases.push({
    name: '能抓出裸 wx.navigateTo',
    pass: hasBareNavigate("wx.navigateTo({ url: '/pages/search/search' });"),
  });

  cases.push({
    name: 'nav.go 不被误报',
    pass: !hasBareNavigate("nav.go('/pages/search/search');"),
  });

  cases.push({
    name: '组件被引用时通过',
    pass: isComponentReferenced(
      'pickup-time',
      new Set(['/components/pickup-time/pickup-time'])
    ),
  });

  cases.push({
    name: '组件零引用时报警',
    pass: !isComponentReferenced('watermark', new Set(['/components/pickup-time/pickup-time'])),
  });

  cases.forEach(function (c) {
    if (c.pass) ok(c.name);
    else fail('自检未通过：' + c.name + '（校验器本身有缺陷，本次结论不可信）');
  });
})();

// ============================================================ 文档与实现一致性
// 教训（2026-10-28）：代码 schema 改了三轮，规则文档还停在旧字段，用户问「有没有更新到文档」才发现。
// 这里把「pickup 输出字段」与手册 §15.6 的字段清单绑起来，任一侧改漏都会红。
(function checkDocSchemaSync() {
  const docPath = path.join(ROOT, 'docs', '2026-10-20-OCR平台识别规则手册.md');
  if (!fs.existsSync(docPath)) {
    fail('规则手册缺失：docs/2026-10-20-OCR平台识别规则手册.md');
    return;
  }
  const doc = fs.readFileSync(docPath, 'utf8');

  let keys = [];
  try {
    const pickup = require(path.join(ROOT, 'cloudfunctions', 'api', 'pickup-extract.js'));
    keys = Object.keys(pickup.extractPickupStructured({ page_text: 'x' }));
  } catch (err) {
    fail('pickup-extract 无法加载：' + (err && err.message));
    return;
  }

  const missing = keys.filter(function (k) { return doc.indexOf(k) < 0; });
  if (missing.length) fail('手册缺字段说明：' + missing.join(', '));
  else ok('手册已覆盖 pickup 全部 ' + keys.length + ' 个字段');

  const legacy = ['express_no', 'pickup_type'].filter(function (k) {
    return doc.indexOf(k) > -1;
  });
  if (legacy.length) fail('手册仍描述已移除字段：' + legacy.join(', '));
  else ok('手册未残留已移除字段（express_no / pickup_type）');
})();

// ============================================================ 汇总
console.log('\n' + '='.repeat(56));
if (problems === 0) {
  console.log('静态校验通过：' + checked + ' 项检查 + 自检全部通过，无问题');
} else {
  console.log('发现 ' + problems + ' 个问题（通过 ' + checked + ' 项）');
}
console.log('='.repeat(56));

process.exit(problems === 0 ? 0 : 1);
