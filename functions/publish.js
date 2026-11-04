// Cloudflare Pages Function — 手机博客发布台
// GET  /publish        → 返回移动优先的发布表单
// POST /publish        → 校验密码后把文章 commit 到 GitHub 仓库（可选配图）
//
// 环境变量（在 Cloudflare Pages 后台设置）：
//   GH_TOKEN           GitHub Personal Access Token（需 repo 权限）
//   PUBLISH_PASSWORD   访问发布表单的口令
//   GH_OWNER           仓库所有者（默认 JLUAlbert）
//   GH_REPO            仓库名（默认 blog）
//   GH_BRANCH          分支（默认 main）

const API = 'https://api.github.com';
const ownerOf = (env) => env.GH_OWNER || 'JLUAlbert';
const repoOf = (env) => env.GH_REPO || 'blog';
const branchOf = (env) => env.GH_BRANCH || 'main';
const passwordOf = (env) => env.PUBLISH_PASSWORD || 'chensq0620';

/* ---------------- 纯函数：与发布台完全一致的 frontmatter 序列化 ---------------- */

function quoteScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v == null ? '' : v);
  return "'" + s.replace(/'/g, "''") + "'";
}

function quoteListItem(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v == null ? '' : v);
  if (s === '') return "''";
  const needs =
    /[:#[\]{}',&*!?|>%@`"]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^-?\d/.test(s) ||
    s === 'true' ||
    s === 'false' ||
    s === 'null' ||
    s === '~';
  return needs ? "'" + s.replace(/'/g, "''") + "'" : s;
}

function normalizeTags(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v == null ? '' : v)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slugify(desired) {
  let s = String(desired || '')
    .trim()
    .toLowerCase();
  s = s.replace(/[^a-z0-9一-鿿_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}

// 北京时间当天日期 YYYY-MM-DD（Worker 运行在 UTC，手动偏移 +8 小时）
function todayCn() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 默认 slug：日期前缀，避免纯中文 URL（纯中文在部分 CDN/GitHub 上有编码兼容问题）
function defaultSlug(title) {
  const d = todayCn();
  const t = slugify(title);
  if (!/[a-z0-9]/.test(t)) return `${d}-${Math.random().toString(36).slice(2, 6)}`;
  return `${d}-${t}`;
}

// 当前时刻的完整 ISO 时间戳（北京时间 UTC+8），留空日期时使用，精确到“发布那刻”
// 注意：Cloudflare Worker 运行在 UTC，需手动偏移到 +08:00
function nowIso() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ':' +
    pad(d.getUTCSeconds()) +
    '+08:00'
  );
}

export function buildFrontmatter({ title, description, date, tags, series, draft, section }) {
  const lines = [];
  lines.push('title: ' + quoteScalar(title || 'Untitled'));
  // 意境(Vibe) 集合只需 title/date/tags/draft，不写 description / series
  if (section !== 'vibe') {
    lines.push('description: ' + quoteScalar(description || title || ''));
    const seriesArr = normalizeTags(series);
    if (seriesArr.length) lines.push('series:', ...seriesArr.map((t) => '  - ' + quoteListItem(t)));
  }
  lines.push('date: ' + quoteScalar((date || '').toString().trim() || nowIso()));
  const tagArr = normalizeTags(tags);
  if (tagArr.length) lines.push('tags:', ...tagArr.map((t) => '  - ' + quoteListItem(t)));
  lines.push('draft: ' + (draft ? 'true' : 'false'));
  return lines.join('\n');
}

/* ---------------- GitHub 辅助 ---------------- */

async function gh(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'blog-publisher',
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { message: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function getSha(owner, repo, branch, path, token) {
  const r = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`, {
    token,
  });
  return r.ok && r.json.sha ? r.json.sha : null;
}

async function commit(owner, repo, branch, path, content, message, token, sha) {
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  return gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { method: 'PUT', body, token });
}

function bytesToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

function toBase64(str) {
  return bytesToBase64(new TextEncoder().encode(str));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ---------------- 路由 ---------------- */

export async function onRequestGet() {
  return new Response(FORM_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = env.GH_TOKEN;
  const password = passwordOf(env);
  if (!token) return json({ error: '服务端未配置 GH_TOKEN' }, 500);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: '表单解析失败' }, 400);
  }

  const pw = form.get('password') || '';
  if (!password || pw !== password) return json({ error: '口令错误', ok: false }, 401);

  // 解锁模式：只验证口令，进入发布台（不发布）
  if (form.get('unlock') === 'true') {
    return json({ ok: true, unlocked: true });
  }

  const title = (form.get('title') || '').toString().trim();
  if (!title) return json({ error: '标题不能为空' }, 400);

  const description = (form.get('description') || '').toString().trim() || title;
  const date = (form.get('date') || '').toString().trim();
  const tags = form.get('tags') || '';
  const series = form.get('series') || '';
  const draft = form.get('draft') === 'true' || form.get('draft') === 'on';
  const section =
    (form.get('section') || 'blog').toString().trim().toLowerCase() === 'vibe' ? 'vibe' : 'blog';
  let content = (form.get('content') || '').toString();
  let slug = slugify((form.get('slug') || '').toString().trim());
  if (!slug) slug = defaultSlug(title);
  if (!slug) return json({ error: '无法生成 slug' }, 400);

  const owner = ownerOf(env);
  const repo = repoOf(env);
  const branch = branchOf(env);

  // 可选配图：上传到 public/images，并在正文顶部插入图片引用
  const image = form.get('image');
  if (image && typeof image === 'object' && image.size > 0) {
    const buf = new Uint8Array(await image.arrayBuffer());
    const ext = (image.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const imgName = `${slug}.${ext || 'png'}`;
    const imgPath = `public/images/${imgName}`;
    const imgSha = await getSha(owner, repo, branch, imgPath, token);
    const ir = await commit(
      owner,
      repo,
      branch,
      imgPath,
      bytesToBase64(buf),
      `add image ${imgName}`,
      token,
      imgSha,
    );
    if (!ir.ok) return json({ error: '图片上传失败: ' + (ir.json.message || ir.status) }, 500);
    content = `![${title}](/images/${imgName})\n\n` + content;
  }

  const fm = buildFrontmatter({ title, description, date, tags, series, draft, section });
  const fileContent = `---\n${fm}\n---\n\n${content}\n`;
  const filePath = `src/content/${section}/${slug}.md`;

  let sha = await getSha(owner, repo, branch, filePath, token);
  if (sha && !form.get('overwrite')) {
    // 已存在同名文章：加随机短码避免覆盖（同一天同标题也能区分）
    slug = `${slug}-${new Date().toISOString().slice(0, 10)}`;
  }
  const finalPath = `src/content/${section}/${slug}.md`;
  sha = await getSha(owner, repo, branch, finalPath, token);
  const r = await commit(
    owner,
    repo,
    branch,
    finalPath,
    toBase64(fileContent),
    `publish: ${title}`,
    token,
    sha,
  );
  if (!r.ok) return json({ error: '提交失败: ' + (r.json.message || r.status) }, 500);

  const baseGh = `https://${owner}.github.io/${repo}`;
  const baseCf = env.CF_SITE_URL || 'https://jlualbert-blog.pages.dev';
  // 意境(Vibe) 没有独立详情页，只渲染在 /vibe 时间线；博客则有独立文章页
  const links =
    section === 'vibe'
      ? { githubPages: `${baseGh}/vibe/`, cloudflare: `${baseCf}/vibe/` }
      : { githubPages: `${baseGh}/blog/${slug}/`, cloudflare: `${baseCf}/blog/${slug}/` };
  return json({
    ok: true,
    slug,
    path: finalPath,
    section,
    ...links,
  });
}

/* ---------------- 表单 HTML（移动优先） ---------------- */

const FORM_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Albert's blog Publish</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<style>
:root {
  color-scheme: dark;
  --bg:#000000;
  --fg:#F5F5F7;
  --muted:rgba(255,255,255,.6);
  --muted-2:rgba(255,255,255,.45);
  --glass:rgba(255,255,255,.08);
  --glass-hover:rgba(255,255,255,.12);
  --glass-dark:rgba(255,255,255,.04);
  --border:rgba(255,255,255,.1);
  --border-strong:rgba(255,255,255,.18);
  --accent:#2997FF;
  --accent-2:#BF5AF2;
  --accent-3:#FF375F;
  --r-outer:32px;
  --r-inner:20px;
  --r-pill:9999px;
  --font:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
* { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body { margin:0; font:16px/1.6 var(--font); background:var(--bg); color:var(--fg);
       min-height:100vh; overflow-x:hidden; -webkit-font-smoothing:antialiased; letter-spacing:-.01em; }

/* 动态 mesh 渐变：色彩来自背景，玻璃只负责聚焦 */
.mesh-bg { position:fixed; inset:0; z-index:-2; overflow:hidden; background:#000; }
.mesh-blob { position:absolute; border-radius:50%; filter:blur(80px); opacity:.55;
             will-change:transform; animation:blob 18s ease-in-out infinite; }
.mesh-blob.b1 { width:560px; height:560px; background:#2997FF; top:-10%; left:-8%; }
.mesh-blob.b2 { width:520px; height:520px; background:#BF5AF2; top:30%; right:-10%; animation-delay:-4s; }
.mesh-blob.b3 { width:480px; height:480px; background:#FF375F; bottom:-12%; left:25%; animation-delay:-8s; }
.mesh-blob.b4 { width:420px; height:420px; background:#FF9F0A; top:55%; left:5%; animation-delay:-12s; opacity:.4; }
.mesh-blob.b5 { width:380px; height:380px; background:#30D158; bottom:10%; right:15%; animation-delay:-6s; opacity:.35; }
.mesh-bg::after { content:''; position:absolute; inset:0;
  background-image:radial-gradient(rgba(255,255,255,.02) 1px,transparent 1px);
  background-size:3px 3px; opacity:.5; }
@keyframes blob {
  0%,100% { transform:translate(0,0) scale(1); }
  33% { transform:translate(40px,-30px) scale(1.1); }
  66% { transform:translate(-30px,40px) scale(.95); }
}

/* ===== 解锁门 ===== */
#gate { position:fixed; inset:0; overflow:hidden; display:flex; flex-direction:column;
        align-items:center; justify-content:center; padding:24px; text-align:center; z-index:50;
        background:rgba(0,0,0,.6);
        transition:opacity .7s ease,visibility .7s ease,transform .8s cubic-bezier(.2,.7,.2,1),filter .7s ease; }
#gate.hidden { opacity:0; visibility:hidden; pointer-events:none; transform:scale(1.06); filter:blur(12px); }
#gate > * { position:relative; z-index:1; }
.platforms { display:flex; gap:14px; margin-bottom:36px; flex-wrap:wrap; justify-content:center; }
.plat { padding:10px 20px; border-radius:var(--r-pill); border:1px solid var(--border);
        color:var(--fg); text-decoration:none; font-size:13px; letter-spacing:.4px;
        background:var(--glass); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
        opacity:0; transform:translateY(16px); animation:rise .9s cubic-bezier(.2,.7,.2,1) forwards;
        transition:border-color .3s,color .3s,transform .3s,background .3s; }
.plat:hover { border-color:var(--border-strong); background:var(--glass-hover); transform:translateY(-2px); }
.plat:nth-child(1) { animation-delay:.15s; }
.plat:nth-child(2) { animation-delay:.3s; }
@keyframes rise { from { opacity:0; transform:translateY(16px); filter:blur(6px); } to { opacity:1; transform:translateY(0); filter:blur(0); } }
@keyframes fadeup { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
.gate-card { background:var(--glass); backdrop-filter:blur(50px) saturate(180%);
  -webkit-backdrop-filter:blur(50px) saturate(180%); border:1px solid var(--border);
  border-radius:var(--r-outer); padding:32px 30px; display:flex; flex-direction:column;
  align-items:center; gap:18px; max-width:340px; width:100%; box-shadow:0 24px 70px rgba(0,0,0,.45);
  opacity:0; animation:fadeup .9s ease .35s forwards; }
.gate-mono { width:56px; height:56px; border-radius:16px; display:grid; place-items:center;
  font-size:26px; font-weight:700; color:#fff; background:linear-gradient(135deg,#2997FF,#BF5AF2);
  box-shadow:0 8px 24px rgba(41,151,255,.35); }
.brand { font-size:21px; font-weight:300; letter-spacing:-.01em; }
.brand b { font-weight:600; }
.brand .dot { color:var(--accent); animation:dotPulse 2.6s ease-in-out infinite; }
@keyframes dotPulse { 0%,100% { opacity:.55; } 50% { opacity:1; text-shadow:0 0 16px rgba(41,151,255,.75); } }
.prompt { width:100%; display:flex; align-items:center; justify-content:center; gap:10px;
  padding:10px 16px; border-radius:14px; background:var(--glass-dark);
  border:1px solid var(--border); transition:border-color .25s,box-shadow .25s; }
.prompt:focus-within { border-color:rgba(41,151,255,.5); box-shadow:0 0 0 3px rgba(41,151,255,.14); }
.cursor { display:inline-block; width:9px; height:22px; border-radius:2px; background:var(--accent);
  animation:breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 0%,100% { opacity:.35; } 50% { opacity:1; box-shadow:0 0 14px 3px rgba(41,151,255,.55); } }
#gate-input { background:transparent; border:0; outline:0; color:var(--fg); font-size:20px;
  padding:0; caret-color:var(--accent); width:100%; letter-spacing:8px; text-align:left; font-family:inherit; }
#gate-input::placeholder { color:var(--muted-2); letter-spacing:2px; }
.shake { animation:shake .5s cubic-bezier(.36,.07,.19,.97); }
@keyframes shake { 10%,90% { transform:translateX(-2px); } 20%,80% { transform:translateX(4px); }
  30%,50%,70% { transform:translateX(-8px); } 40%,60% { transform:translateX(8px); } }

/* ===== 发布台 ===== */
#studio { max-width:720px; margin:0 auto; padding:max(20px,env(safe-area-inset-top)) 16px 56px;
  position:relative; z-index:1; opacity:0; transform:translateY(18px) scale(.99);
  transition:opacity .7s ease .08s,transform .8s cubic-bezier(.2,.7,.2,1) .08s; }
#studio.show { opacity:1; transform:none; }
.panel { background:var(--glass); backdrop-filter:blur(50px) saturate(180%);
  -webkit-backdrop-filter:blur(50px) saturate(180%); border:1px solid var(--border);
  border-radius:var(--r-outer); padding:28px; box-shadow:0 24px 80px rgba(0,0,0,.4); overflow:hidden; }

.app-bar { display:flex; align-items:center; gap:12px; padding-bottom:20px;
  border-bottom:1px solid var(--border); margin-bottom:6px; }
.mono { width:38px; height:38px; border-radius:11px; display:grid; place-items:center;
  font-size:18px; font-weight:700; color:#fff; flex:none;
  background:linear-gradient(135deg,#2997FF,#BF5AF2); box-shadow:0 4px 16px rgba(41,151,255,.3); }
.app-bar .who { flex:1; min-width:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }
.app-bar .actions { display:flex; gap:8px; flex:none; }
.gbtn { background:var(--glass); border:1px solid var(--border); color:var(--muted);
  font-size:12.5px; border-radius:var(--r-pill); padding:8px 14px; cursor:pointer; margin:0;
  width:auto; font-family:inherit; white-space:nowrap;
  transition:background .3s,color .3s,border-color .3s,transform .3s; }
.gbtn:hover { background:var(--glass-hover); color:var(--fg); border-color:var(--border-strong); transform:translateY(-2px); }

form { display:flex; flex-direction:column; }
label:not(.switch) { display:block; margin:18px 0 8px; font-size:12.5px; font-weight:500;
  letter-spacing:.04em; color:var(--muted); }
input[type=text],input[type=date],input[type=password],textarea,select {
  width:100%; padding:13px 15px; font-size:16px; font-family:inherit; color:var(--fg);
  background:var(--glass-dark); border:1px solid var(--border); border-radius:14px; outline:none;
  backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  transition:border-color .25s,box-shadow .25s,background .25s; }
input:hover,textarea:hover,select:hover { border-color:var(--border-strong); }
input:focus,textarea:focus,select:focus { border-color:rgba(41,151,255,.55);
  box-shadow:0 0 0 3px rgba(41,151,255,.16); background:var(--glass-hover); }
textarea { min-height:42vh; resize:vertical; line-height:1.65; }
.row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.row > div { min-width:0; }
.row label { margin-top:18px; }

.seg { display:grid; grid-template-columns:1fr 1fr; gap:4px; padding:4px;
  background:var(--glass-dark); border:1px solid var(--border); border-radius:14px; margin-top:8px; }
.seg-btn { border:0; background:transparent; color:var(--muted); font-size:14px; font-weight:500;
  padding:11px 8px; border-radius:10px; cursor:pointer; font-family:inherit;
  transition:background .25s,color .25s,box-shadow .25s; }
.seg-btn.active { background:linear-gradient(135deg,rgba(41,151,255,.9),rgba(191,90,242,.9));
  color:#fff; font-weight:600; box-shadow:0 8px 24px rgba(41,151,255,.35); }

.switch-row { display:flex; align-items:center; justify-content:space-between; gap:12px;
  margin-top:20px; padding:12px 15px; background:var(--glass-dark);
  border:1px solid var(--border); border-radius:14px; }
.switch-row .lbl { margin:0; font-size:14px; font-weight:500; color:var(--fg); letter-spacing:0; }
.switch { position:relative; width:46px; height:26px; flex:none; margin:0; display:block; }
.switch input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
.switch .track { position:absolute; inset:0; border-radius:var(--r-pill); background:rgba(255,255,255,.16); transition:background .25s; }
.switch .track::after { content:''; position:absolute; top:3px; left:3px; width:20px; height:20px;
  border-radius:50%; background:#fff; transition:transform .25s,background .25s; }
.switch input:checked + .track { background:linear-gradient(135deg,#2997FF,#BF5AF2); }
.switch input:checked + .track::after { transform:translateX(20px); }
.switch input:focus-visible + .track { box-shadow:0 0 0 3px rgba(41,151,255,.35); }

.file input[type=file] { padding:11px 15px; color:var(--muted); font-size:13px; }
.file input[type=file]::file-selector-button { margin-right:12px; padding:8px 14px; border-radius:var(--r-pill);
  border:1px solid var(--border); background:var(--glass); color:var(--fg); font-family:inherit;
  font-size:13px; cursor:pointer; transition:background .25s,border-color .25s; }
.file input[type=file]::file-selector-button:hover { background:var(--glass-hover); border-color:var(--border-strong); }

button.submit { margin-top:24px; width:100%; padding:15px; font-size:16px; font-weight:600;
  border:0; border-radius:var(--r-pill); color:#fff; cursor:pointer; font-family:inherit;
  background:linear-gradient(135deg,rgba(41,151,255,.9),rgba(191,90,242,.9));
  box-shadow:0 8px 24px rgba(41,151,255,.35);
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  transition:transform .3s,box-shadow .3s,background .3s; }
button.submit:hover { transform:translateY(-2px); box-shadow:0 12px 32px rgba(41,151,255,.5);
  background:linear-gradient(135deg,rgba(41,151,255,1),rgba(191,90,242,1)); }
button.submit:active { transform:scale(.985); }
button.submit:disabled { opacity:.6; cursor:default; transform:none; box-shadow:none; }

#progress { display:none; margin-top:18px; }
#progress.show { display:block; }
.bar { height:6px; background:var(--glass-dark); border-radius:var(--r-pill); overflow:hidden; }
.bar i { display:block; height:100%; width:0; border-radius:var(--r-pill);
  background:linear-gradient(90deg,#2997FF,#BF5AF2,#2997FF); background-size:200% 100%;
  animation:barflow 1.7s linear infinite; transition:width .3s ease; }
@keyframes barflow { to { background-position:-200% 0; } }
#progress .label { font-size:12.5px; color:var(--muted); margin-top:8px; text-align:center; }
#result { display:none; margin-top:16px; padding:16px; border-radius:var(--r-inner); font-size:14px;
  background:var(--glass); border:1px solid var(--border); white-space:pre-wrap; word-break:break-word; }
#result.ok { display:block; border-color:rgba(41,151,255,.45); }
#result.err { display:block; border-color:rgba(255,55,95,.5); }
#result a { color:#7cc0ff; word-break:break-all; }

/* ===== 历史面板 ===== */
#history { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.72);
  backdrop-filter:blur(40px) saturate(180%); -webkit-backdrop-filter:blur(40px) saturate(180%);
  display:none; flex-direction:column; opacity:0; transition:opacity .4s ease; }
#history.show { display:flex; opacity:1; }
.hist-head { display:flex; align-items:center; justify-content:space-between;
  padding:max(22px,env(safe-area-inset-top)) 22px 12px; }
.hist-head h2 { margin:0; font-size:19px; font-weight:600; letter-spacing:-.02em; }
.hist-head .sub { color:var(--muted); font-size:12px; margin:4px 0 0; }
.hist-close { background:var(--glass); border:1px solid var(--border); color:var(--muted);
  font-size:20px; line-height:1; cursor:pointer; width:auto; margin:0; padding:4px 14px;
  border-radius:var(--r-pill); transition:color .2s,border-color .2s,background .2s; }
.hist-close:hover { color:var(--fg); background:var(--glass-hover); border-color:var(--border-strong); }
.hist-search { padding:0 16px 10px; }
.hist-search input { width:100%; padding:12px 16px; font-size:14px; border-radius:14px;
  border:1px solid var(--border); background:var(--glass-dark); color:var(--fg); outline:none;
  transition:border-color .2s,box-shadow .2s; }
.hist-search input:focus { border-color:rgba(41,151,255,.55); box-shadow:0 0 0 3px rgba(41,151,255,.16); }
.hist-list { flex:1; overflow-y:auto; padding:4px 16px 28px; -webkit-overflow-scrolling:touch; }
.hist-month { font-size:11.5px; color:var(--muted-2); letter-spacing:.5px; margin:16px 4px 8px;
  display:flex; align-items:center; gap:8px; }
.hist-month::after { content:''; flex:1; height:1px; background:var(--border); }
.hist-item { display:block; width:100%; text-align:left; background:var(--glass);
  border:1px solid var(--border); border-radius:var(--r-inner); padding:14px 16px;
  margin-bottom:10px; cursor:pointer; color:var(--fg); font-family:inherit;
  transition:background .3s,border-color .3s,transform .3s; position:relative; }
.hist-item:hover { background:var(--glass-hover); border-color:var(--border-strong); transform:translateY(-2px); }
.hist-item .t { font-size:15px; font-weight:500; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.hist-item .meta { font-size:12px; color:var(--muted); margin-top:6px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; min-width:0; }
.hist-item .meta .p { opacity:.7; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
  max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hist-item .go { position:absolute; right:16px; top:50%; transform:translateY(-50%); color:var(--muted-2); font-size:13px; opacity:0; transition:opacity .2s,color .2s; }
.hist-item:hover .go { opacity:1; color:var(--accent); }
.badge { font-size:10.5px; padding:2px 8px; border-radius:var(--r-pill); white-space:nowrap; font-weight:500; }
.badge.blog { background:rgba(41,151,255,.16); color:#7cc0ff; }
.badge.vibe { background:rgba(191,90,242,.16); color:#d9a3ff; }
.badge.draft { background:rgba(255,55,95,.18); color:#ff9a93; }
.hist-empty,.hist-loading { color:var(--muted); text-align:center; margin-top:48px; font-size:14px; }
.hist-editing { text-align:center; color:#7cc0ff; font-size:12.5px; margin:14px 0 0;
  padding:10px 12px; background:rgba(41,151,255,.1); border:1px solid rgba(41,151,255,.25);
  border-radius:14px; }
.hist-editing:empty { display:none; }
.hist-editing button { background:transparent; border:1px solid var(--border-strong); color:var(--fg);
  border-radius:var(--r-pill); padding:2px 10px; font-size:12px; cursor:pointer; margin-left:6px; font-family:inherit; }

@media (max-width:600px) {
  .panel { padding:20px 18px; border-radius:24px; }
  textarea { min-height:38vh; }
}
@media (prefers-reduced-motion:reduce) {
  *,*::before,*::after { animation:none !important; transition-duration:.2s !important; }
  #gate.hidden { transform:none; filter:none; }
  #studio { transform:none; transition:opacity .3s ease !important; }
  .brand,.plat,.gate-card { opacity:1 !important; transform:none !important; filter:none !important; }
}
</style>
</head>
<body>
  <div class="mesh-bg" aria-hidden="true">
    <div class="mesh-blob b1"></div>
    <div class="mesh-blob b2"></div>
    <div class="mesh-blob b3"></div>
    <div class="mesh-blob b4"></div>
    <div class="mesh-blob b5"></div>
  </div>

  <!-- 解锁门 -->
  <div id="gate">
    <div class="platforms">
      <a class="plat" href="https://jlualbert.github.io/blog/" target="_blank" rel="noreferrer">GitHub</a>
      <a class="plat" href="https://jlualbert-blog.pages.dev" target="_blank" rel="noreferrer">Cloudflare</a>
    </div>
    <div class="gate-card">
      <div class="gate-mono">A</div>
      <div class="brand">Albert's blog <b>Publish</b><span class="dot">.</span></div>
      <div class="prompt">
        <span class="cursor"></span>
        <input id="gate-input" type="password" placeholder="passcode" autocomplete="off" autocapitalize="off" />
      </div>
    </div>
  </div>

  <!-- 发布台 -->
  <div id="studio">
    <div class="panel">
      <div class="app-bar">
        <div class="mono">A</div>
        <div class="who">Albert's Blog</div>
        <div class="actions">
          <button class="gbtn" id="relock" type="button">锁定</button>
        </div>
      </div>

      <form id="f">
        <input type="hidden" name="password" id="pw-field" />
        <input type="hidden" name="unlock" value="false" />

        <label>栏目</label>
        <select name="section">
          <option value="blog" selected>博客</option>
          <option value="vibe">意境</option>
        </select>

        <label>标题</label>
        <input type="text" name="title" required />

        <label>正文</label>
        <textarea name="content"></textarea>

        <label>摘要</label>
        <input type="text" name="description" />

        <label>标签</label>
        <input type="text" name="tags" />

        <div class="row">
          <div>
            <label>系列</label>
            <input type="text" name="series" list="series-list" />
            <datalist id="series-list">
              <option value="财富自由"></option>
              <option value="摄影"></option>
            </datalist>
          </div>
          <div>
            <label>日期</label>
            <input type="date" name="date" />
          </div>
        </div>

        <label>网址别名</label>
        <input type="text" name="slug" />

        <label>配图</label>
        <div class="file"><input type="file" name="image" accept="image/*" /></div>

        <div class="switch-row">
          <span class="lbl">草稿</span>
          <label class="switch">
            <input type="checkbox" name="draft" value="true" />
            <span class="track"></span>
          </label>
        </div>

        <button type="submit" class="submit">发布</button>
      </form>

      <div id="progress"><div class="bar"><i id="bar-fill"></i></div><div class="label" id="progress-label">正在发布…</div></div>
      <div id="result"></div>
    </div>
  </div>

  <script>
    const gate = document.getElementById('gate');
    const gateInput = document.getElementById('gate-input');
    const studio = document.getElementById('studio');
    const pwField = document.getElementById('pw-field');
    const relock = document.getElementById('relock');
    const form = document.getElementById('f');
    const result = document.getElementById('result');
    const progress = document.getElementById('progress');
    const barFill = document.getElementById('bar-fill');
    const progressLabel = document.getElementById('progress-label');

    let passcode = '';
    let unlocking = false;
    let unlockTimer = null;
    let lastTried = '';
    const KEY = 'abp_unlocked';
    const PW_KEY = 'abp_pw';

    async function unlock(pw) {
      pw = (pw || '').trim();
      if (!pw) return;
      if (unlocking) return;
      if (pw === lastTried) return; // 同一个值不重复请求
      lastTried = pw;
      unlocking = true;
      try {
        const fd = new FormData();
        fd.append('password', pw);
        fd.append('unlock', 'true');
        const r = await fetch('/publish', { method: 'POST', body: fd });
        const j = await r.json();
        if (j.ok) {
          passcode = pw;
          pwField.value = pw;
          sessionStorage.setItem(KEY, '1');
          sessionStorage.setItem(PW_KEY, pw); // 刷新后可恢复口令，避免直接进表单却发不了
          gate.classList.add('hidden');
          studio.classList.add('show');
          setTimeout(() => document.querySelector('input[name=title]').focus(), 420);
        } else {
          gateInput.classList.remove('shake'); void gateInput.offsetWidth; gateInput.classList.add('shake');
        }
      } catch (err) {
        gateInput.classList.remove('shake'); void gateInput.offsetWidth; gateInput.classList.add('shake');
      } finally {
        unlocking = false;
      }
    }

    function relockNow() {
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(PW_KEY);
      gate.classList.remove('hidden');
      studio.classList.remove('show');
      gateInput.value = '';
      passcode = '';
      unlocking = false;
      lastTried = '';
    }

    // 即输即验：每次输入停顿 500ms 后自动验证（无需回车）
    // 用 lastTried 去重，避免同一残缺值反复请求；失败后保留输入内容便于纠正
    function scheduleUnlock() {
      const v = gateInput.value.trim();
      if (!v) return;
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => unlock(v), 500);
    }
    gateInput.addEventListener('input', scheduleUnlock);
    gateInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); unlock(gateInput.value); }
    });
    // 手机端某些输入法不触发 input 的 change 兜底
    gateInput.addEventListener('change', scheduleUnlock);
    // 失焦兜底
    gateInput.addEventListener('blur', () => {
      if (gateInput.value.trim()) unlock(gateInput.value);
    });

    relock.addEventListener('click', relockNow);

    // 若本会话已解锁则直接进入（恢复口令，刷新后也能正常发布）
    if (sessionStorage.getItem(KEY) === '1') {
      const savedPw = sessionStorage.getItem(PW_KEY) || '';
      passcode = savedPw;
      pwField.value = savedPw;
      gate.classList.add('hidden');
      studio.classList.add('show');
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!passcode) { relockNow(); return; }
      pwField.value = passcode;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = '发布中…';
      result.className = '';
      progress.classList.add('show');
      // 进度条动画
      let p = 0;
      const timer = setInterval(() => {
        p = Math.min(p + Math.random() * 22, 90);
        barFill.style.width = p + '%';
      }, 220);
      try {
        const data = new FormData(form);
        const r = await fetch('/publish', { method: 'POST', body: data });
        const j = await r.json();
        clearInterval(timer);
        if (j.ok) {
          barFill.style.width = '100%';
          progressLabel.textContent = '已发布';
          setTimeout(() => progress.classList.remove('show'), 600);
          result.className = 'ok';
          result.innerHTML = '✅ 发布成功！\\nslug: ' + j.slug +
            '\\n<a href="' + j.githubPages + '" target="_blank">GitHub Pages</a>' +
            ' · <a href="' + j.cloudflare + '" target="_blank">Cloudflare</a>';
          form.reset();
        } else {
          progress.classList.remove('show');
          result.className = 'err';
          result.textContent = '❌ ' + (j.error || '未知错误');
        }
      } catch (err) {
        clearInterval(timer);
        progress.classList.remove('show');
        result.className = 'err';
        result.textContent = '❌ 网络错误：' + err.message;
      } finally {
        btn.disabled = false; btn.textContent = '发布';
      }
    });
  </script>
</body>
</html>`;
