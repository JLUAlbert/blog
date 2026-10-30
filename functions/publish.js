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
    s === 'true' || s === 'false' || s === 'null' || s === '~';
  return needs ? "'" + s.replace(/'/g, "''") + "'" : s;
}

function normalizeTags(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v == null ? '' : v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

export function slugify(desired) {
  let s = String(desired || '').trim().toLowerCase();
  s = s.replace(/[^a-z0-9一-鿿_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}

export function buildFrontmatter({ title, description, date, tags, series, draft }) {
  const lines = [];
  lines.push('title: ' + quoteScalar(title || 'Untitled'));
  lines.push('description: ' + quoteScalar(description || title || ''));
  lines.push('date: ' + quoteScalar(date || new Date().toISOString().slice(0, 10)));
  const tagArr = normalizeTags(tags);
  if (tagArr.length) lines.push('tags:', ...tagArr.map((t) => '  - ' + quoteListItem(t)));
  const seriesArr = normalizeTags(series);
  if (seriesArr.length) lines.push('series:', ...seriesArr.map((t) => '  - ' + quoteListItem(t)));
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
  try { json = JSON.parse(text); } catch { json = { message: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function getSha(owner, repo, branch, path, token) {
  const r = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`, { token });
  return r.ok && r.json.sha ? r.json.sha : null;
}

async function commit(owner, repo, branch, path, content, message, token, sha) {
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  return gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { method: 'PUT', body, token });
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
  const password = env.PUBLISH_PASSWORD;
  if (!token) return json({ error: '服务端未配置 GH_TOKEN' }, 500);

  let form;
  try { form = await request.formData(); } catch { return json({ error: '表单解析失败' }, 400); }

  const pw = form.get('password') || '';
  if (!password || pw !== password) return json({ error: '口令错误', ok: false }, 401);

  const title = (form.get('title') || '').toString().trim();
  if (!title) return json({ error: '标题不能为空' }, 400);

  const description = (form.get('description') || '').toString().trim() || title;
  const date = (form.get('date') || '').toString().trim();
  const tags = form.get('tags') || '';
  const series = form.get('series') || '';
  const draft = form.get('draft') === 'true' || form.get('draft') === 'on';
  let content = (form.get('content') || '').toString();
  let slug = slugify((form.get('slug') || '').toString().trim() || title);
  if (!slug) return json({ error: '无法生成 slug' }, 400);

  const owner = ownerOf(env);
  const repo = repoOf(env);
  const branch = branchOf(env);

  // 可选配图：上传到 public/images，并在正文顶部插入图片引用
  const image = form.get('image');
  if (image && typeof image === 'object' && image.size > 0) {
    const buf = new Uint8Array(await image.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    const ext = (image.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const imgName = `${slug}.${ext || 'png'}`;
    const imgPath = `public/images/${imgName}`;
    const imgSha = await getSha(owner, repo, branch, imgPath, token);
    const ir = await commit(owner, repo, branch, imgPath, toBase64(binary), `add image ${imgName}`, token, imgSha);
    if (!ir.ok) return json({ error: '图片上传失败: ' + (ir.json.message || ir.status) }, 500);
    content = `![${title}](/images/${imgName})\n\n` + content;
  }

  const fm = buildFrontmatter({ title, description, date, tags, series, draft });
  const fileContent = `---\n${fm}\n---\n\n${content}\n`;
  const filePath = `src/content/blog/${slug}.md`;

  let sha = await getSha(owner, repo, branch, filePath, token);
  if (sha && !form.get('overwrite')) {
    // slug 撞名：追加日期后缀，避免覆盖既有文章
    slug = `${slug}-${new Date().toISOString().slice(0, 10)}`;
  }
  const finalPath = `src/content/blog/${slug}.md`;
  sha = await getSha(owner, repo, branch, finalPath, token);
  const r = await commit(owner, repo, branch, finalPath, fileContent, `publish: ${title}`, token, sha);
  if (!r.ok) return json({ error: '提交失败: ' + (r.json.message || r.status) }, 500);

  return json({
    ok: true,
    slug,
    path: finalPath,
    githubPages: `https://${owner}.github.io/${repo}/blog/${slug}/`,
    cloudflare: `https://jlualbert-blog.pages.dev/blog/${slug}/`,
    netlify: `https://jlualbert-blog.netlify.app/blog/${slug}/`,
  });
}

/* ---------------- 表单 HTML（移动优先） ---------------- */

const FORM_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>手机发布 · Albert's Blog</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #0f1115; color: #e8eaed; padding: max(16px, env(safe-area-inset-top)) 16px 32px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  p.sub { color: #9aa0a6; margin: 0 0 18px; font-size: 13px; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; color: #c6c9ce; }
  input, textarea, select { width: 100%; padding: 12px; font-size: 16px; border-radius: 10px;
         border: 1px solid #2a2e35; background: #171a1f; color: #e8eaed; }
  textarea { min-height: 42vh; resize: vertical; line-height: 1.6; }
  input[type=checkbox] { width: auto; transform: scale(1.3); margin-right: 8px; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  button { margin-top: 22px; width: 100%; padding: 15px; font-size: 17px; font-weight: 600;
           border: 0; border-radius: 12px; background: #2ea66b; color: #fff; cursor: pointer; }
  button:active { transform: scale(.99); }
  #msg { margin-top: 16px; padding: 12px; border-radius: 10px; font-size: 14px; white-space: pre-wrap;
         background: #171a1f; border: 1px solid #2a2e35; display: none; }
  #msg.ok { border-color: #2ea66b; }
  #msg.err { border-color: #e5534b; }
  .hint { font-size: 12px; color: #9aa0a6; margin-top: 4px; }
</style>
</head>
<body>
  <h1>📝 手机发布博客</h1>
  <p class="sub">提交后会自动 commit 到 GitHub，三平台自动重新构建上线。</p>
  <form id="f">
    <label>访问口令</label>
    <input type="password" name="password" placeholder="发布口令" autocomplete="off" required />

    <label>标题 *</label>
    <input type="text" name="title" placeholder="例如：财富自由 · 第二章" required />

    <div class="row">
      <div>
        <label>日期</label>
        <input type="date" name="date" />
      </div>
      <div>
        <label>系列 / 笔记</label>
        <input type="text" name="series" list="series-list" placeholder="财富自由" />
        <datalist id="series-list">
          <option value="财富自由"></option>
          <option value="摄影"></option>
        </datalist>
      </div>
    </div>

    <label>摘要</label>
    <input type="text" name="description" placeholder="留空则等于标题" />

    <label>标签（逗号分隔）</label>
    <input type="text" name="tags" placeholder="读书, 思考" />

    <label>正文（Markdown）</label>
    <textarea name="content" placeholder="在这里写内容…支持 # 标题、**加粗**、- 列表 等 Markdown 语法"></textarea>

    <label>封面 / 配图（可选）</label>
    <input type="file" name="image" accept="image/*" />
    <div class="hint">图片会存到 public/images，并自动插入到正文顶部。</div>

    <label style="display:flex;align-items:center;"><input type="checkbox" name="draft" value="true" />存为草稿（不进首页，仍可凭链接访问预览）</label>

    <button type="submit">🚀 发布</button>
  </form>
  <div id="msg"></div>

  <script>
    const form = document.getElementById('f');
    const msg = document.getElementById('msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = '发布中…';
      msg.style.display = 'none';
      try {
        const data = new FormData(form);
        const r = await fetch('/publish', { method: 'POST', body: data });
        const j = await r.json();
        msg.style.display = 'block';
        if (j.ok) {
          msg.className = 'ok';
          msg.textContent = '✅ 已发布！\\nslug: ' + j.slug + '\\nGitHub Pages: ' + j.githubPages + '\\nCloudflare: ' + j.cloudflare;
          form.reset();
        } else {
          msg.className = 'err';
          msg.textContent = '❌ ' + (j.error || '未知错误');
        }
      } catch (err) {
        msg.style.display = 'block'; msg.className = 'err';
        msg.textContent = '❌ 网络错误：' + err.message;
      } finally {
        btn.disabled = false; btn.textContent = '🚀 发布';
      }
    });
  </script>
</body>
</html>`;
