// 发布台整页 HTML 装在 _worker.js 的模板字符串里：一个被吞掉的反斜杠
// 就会让浏览器里的整段 <script> 语法失效，页面看着正常但口令、按钮全部失灵。
// 这里在部署前把 HTML 真实渲染出来，抽出脚本做语法与关键节点检查。
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const src = fs.readFileSync(new URL('_worker.js', root), 'utf8');
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const res = await mod.default.fetch(new Request('https://example.com/publish'), {});
const html = await res.text();

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('发布台页面里没有脚本');

for (const [i, m] of scripts.entries()) {
  try {
    new vm.Script(m[1]);
  } catch (err) {
    throw new Error(`发布台脚本 #${i + 1} 语法错误：${err.message}`);
  }
}

const ids = [
  'gate-input',
  'f',
  'insert-btn',
  'inline-toast',
  'studio',
  'history',
  'sync-btn',
  'sync-label',
  'sync-meta',
];
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) throw new Error(`发布台缺少节点 #${id}`);
}
for (const cls of ['gate-open', 'inert', 'tools-bar', 'wlogo']) {
  if (!html.includes(cls)) throw new Error(`发布台缺少 ${cls} 标记`);
}
// 字标：锁界面与顶栏各一处，都指向博客首页；旧的渐变方块不应再出现
const marks = html.match(/class="wlogo"/g) || [];
if (marks.length !== 2) throw new Error(`发布台字标应出现在锁界面与顶栏，实际 ${marks.length} 处`);
if (!html.includes('href="https://jlualbert.github.io/blog/"')) {
  throw new Error('发布台字标未指向博客站点');
}
if (!html.includes('placeholder="password"')) throw new Error('锁界面 password 占位文字缺失');
for (const banned of ['gate-mono', 'class="mono"', 'class="brand"']) {
  if (html.includes(banned)) throw new Error(`发布台仍残留旧标识：${banned}`);
}
for (const needle of [
  'sync-start',
  'sync-finish',
  'sync-status',
  'trakt-sync.yml/dispatches',
  'scripts/.trakt-fixture.json',
  'TRAKT_USER',
  '/watched/movies',
]) {
  if (!src.includes(needle)) throw new Error(`发布台缺少片单同步接口 ${needle}`);
}
// 片单同步必须保持纯公开只读：任何账号授权回退都会占掉免费账户唯一的社区应用名额
for (const banned of ['oauth/token', '/sync/history', 'traktEncrypt', 'traktDecrypt']) {
  if (src.includes(banned)) throw new Error(`片单同步不应再使用账号授权：${banned}`);
}

// 维护动作必须口令保护：没有口令时两个新接口都应拒绝，且不会真的去触发同步
const checkEnv = { PUBLISH_PASSWORD: 'check-only' };
for (const [label, action, init] of [
  ['状态', 'sync-status', { method: 'GET' }],
  ['启动', 'sync-start', { method: 'GET' }],
  ['写回', 'sync-finish', { method: 'POST' }],
]) {
  const res = await mod.default.fetch(
    new Request('https://example.com/publish?action=' + action, init),
    checkEnv,
  );
  if (res.status !== 401) {
    throw new Error(`片单同步${label}接口没有正确拒绝无口令请求：${res.status}`);
  }
}

console.log(
  `发布台页面检查通过：${scripts.length} 段脚本语法正常，${ids.length} 个关键节点齐全，片单同步已口令保护且保持公开只读`,
);
