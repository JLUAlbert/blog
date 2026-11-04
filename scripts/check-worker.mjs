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

const ids = ['gate-input', 'f', 'insert-btn', 'inline-toast', 'studio', 'history'];
for (const id of ids) {
  if (!html.includes(`id="${id}"`)) throw new Error(`发布台缺少节点 #${id}`);
}
for (const cls of ['gate-open', 'inert']) {
  if (!html.includes(cls)) throw new Error(`发布台缺少 ${cls} 标记`);
}

console.log(`发布台页面检查通过：${scripts.length} 段脚本语法正常，${ids.length} 个关键节点齐全`);
