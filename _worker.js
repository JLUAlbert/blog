// Cloudflare Pages Worker — 手机博客发布台（wrangler 4 用 _worker.js）
// 处理 /publish 路由：GET 返回表单，POST 校验密码后 commit 到 GitHub。
// 其它路径原样回退到静态资产。
//
// 环境变量：GH_TOKEN / PUBLISH_PASSWORD / GH_OWNER / GH_REPO / GH_BRANCH
// 口令优先读环境变量 PUBLISH_PASSWORD；未设置时回退到下方默认值。

const API = 'https://api.github.com';
const ownerOf = (env) => env.GH_OWNER || 'JLUAlbert';
const repoOf = (env) => env.GH_REPO || 'blog';
const branchOf = (env) => env.GH_BRANCH || 'main';
const passwordOf = (env) => env.PUBLISH_PASSWORD || 'chensq0620';

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

function slugify(desired) {
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
  // 若标题转出的是纯中文（无 a-z0-9），用日期+随机短码
  if (!/[a-z0-9]/.test(t)) {
    return `${d}-${Math.random().toString(36).slice(2, 6)}`;
  }
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

function buildFrontmatter({ title, description, date, tags, series, draft, section }) {
  const lines = [];
  lines.push('title: ' + quoteScalar(title || 'Untitled'));
  // 意境(Vibe) 集合只需 title/date/tags/draft，不写 description / series
  if (section !== 'vibe') {
    lines.push('description: ' + quoteScalar(description || title || ''));
    const seriesArr = normalizeTags(series);
    if (seriesArr.length) lines.push('series:', ...seriesArr.map((t) => '  - ' + quoteListItem(t)));
  }
  // 日期留空 → 自动取发布时刻（精确到秒）；否则用用户填写的值
  lines.push('date: ' + quoteScalar((date || '').toString().trim() || nowIso()));
  const tagArr = normalizeTags(tags);
  if (tagArr.length) lines.push('tags:', ...tagArr.map((t) => '  - ' + quoteListItem(t)));
  lines.push('draft: ' + (draft ? 'true' : 'false'));
  return lines.join('\n');
}

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

/* ---------------- 读取文章：frontmatter 解析 ---------------- */

function unquote(s) {
  s = (s || '').trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

// 解析 Markdown 文件的 frontmatter 与正文，兼容标量与列表字段
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const fmText = m[1];
  const body = m[2] || '';
  const data = {};
  let curKey = null;
  const lines = fmText.split(/\r?\n/);
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (kv && !/^\s/.test(line)) {
      const key = kv[1];
      const val = kv[2];
      if (val.trim() === '') {
        data[key] = [];
        curKey = key;
      } else {
        data[key] = unquote(val);
        curKey = null;
      }
    } else if (/^\s+-\s+/.test(line) && curKey && Array.isArray(data[curKey])) {
      data[curKey].push(unquote(line.replace(/^\s+-\s+/, '')));
    } else {
      curKey = null;
    }
  }
  return { data, body: body.trim() };
}

// GitHub contents API 返回带换行的标准 base64，需清理后按 UTF-8 解码（保中文）
function decodeBase64(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------- 历史：列出全部文章（blog + vibe），按时间倒序 ---------------- */

async function handleList(request, env) {
  const token = env.GH_TOKEN;
  const password = passwordOf(env);
  const pw = request.headers.get('x-publish-pw') || '';
  if (!password || pw !== password) return json({ error: '口令错误' }, 401);
  if (!token) return json({ error: '服务端未配置 GH_TOKEN' }, 500);

  const owner = ownerOf(env);
  const repo = repoOf(env);
  const branch = branchOf(env);
  const sections = ['blog', 'vibe'];
  const items = [];

  for (const section of sections) {
    const listRes = await gh(
      `/repos/${owner}/${repo}/contents/src/content/${section}?ref=${branch}`,
      {
        token,
      },
    );
    if (!listRes.ok || !Array.isArray(listRes.json)) continue;
    const files = listRes.json.filter((f) => f.name && f.name.endsWith('.md'));
    // 并发拉取每个文件内容，取出标题/日期/sha（按 frontmatter 的 date 排序）
    const got = await Promise.all(
      files.map((f) =>
        gh(`/repos/${owner}/${repo}/contents/${encodeURI(f.path)}?ref=${branch}`, { token })
          .then((r) => ({ f, r }))
          .catch(() => ({ f, r: null })),
      ),
    );
    for (const { f, r } of got) {
      if (!r || !r.ok || !r.json || !r.json.content) continue;
      const { data } = parseFrontmatter(decodeBase64(r.json.content));
      items.push({
        section,
        slug: f.name.replace(/\.md$/, ''),
        path: f.path,
        sha: r.json.sha,
        title: data.title || f.name,
        date: data.date || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        draft: data.draft === true || data.draft === 'true',
      });
    }
  }

  items.sort((a, b) => {
    const d = (b.date || '').localeCompare(a.date || '');
    return d !== 0 ? d : b.path.localeCompare(a.path);
  });
  return json({ ok: true, items });
}

/* ---------------- 单篇：按路径读取，供编辑回填 ---------------- */

async function handleArticle(request, env) {
  const token = env.GH_TOKEN;
  const password = passwordOf(env);
  const pw = request.headers.get('x-publish-pw') || '';
  if (!password || pw !== password) return json({ error: '口令错误' }, 401);
  if (!token) return json({ error: '服务端未配置 GH_TOKEN' }, 500);

  const url = new URL(request.url);
  const path = (url.searchParams.get('path') || '').trim();
  if (!/^src\/content\/(blog|vibe)\/[^/]+\.md$/.test(path)) {
    return json({ error: '无效的文章路径' }, 400);
  }
  const owner = ownerOf(env);
  const repo = repoOf(env);
  const branch = branchOf(env);
  const cr = await gh(`/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`, {
    token,
  });
  if (!cr.ok || !cr.json || !cr.json.content) return json({ error: '文章读取失败' }, 404);

  const { data, body } = parseFrontmatter(decodeBase64(cr.json.content));
  const join = (v) => (Array.isArray(v) ? v.join(', ') : String(v || ''));
  return json({
    ok: true,
    path,
    sha: cr.json.sha,
    section: path.includes('/vibe/') ? 'vibe' : 'blog',
    title: data.title || '',
    description: data.description || '',
    date: String(data.date || '').slice(0, 10),
    tags: join(data.tags),
    series: join(data.series),
    draft: data.draft === true || data.draft === 'true',
    content: body,
  });
}

async function handlePublish(request, env) {
  const token = env.GH_TOKEN;
  const password = passwordOf(env);
  if (!token) return json({ error: '服务端未配置 GH_TOKEN' }, 500);

  if (request.method === 'GET') {
    return new Response(FORM_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (request.method !== 'POST') return json({ error: '方法不支持' }, 405);

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

  // 可选配图
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

  // 编辑模式：直接覆盖原文件（用最新 sha，避免并发冲突）
  const editPath = (form.get('editPath') || '').toString().trim();
  const isEdit = /^src\/content\/(blog|vibe)\/[^\/]+\.md$/.test(editPath);
  // 编辑时锁定板块为原文件所在目录，避免误改 section 导致 frontmatter 字段（description/series）丢失
  if (isEdit) section = editPath.includes('/vibe/') ? 'vibe' : 'blog';

  const fm = buildFrontmatter({ title, description, date, tags, series, draft, section });
  const fileContent = `---\n${fm}\n---\n\n${content}\n`;

  let finalPath, message;
  if (isEdit) {
    finalPath = editPath;
    message = `update: ${title}`;
  } else {
    let sha = await getSha(owner, repo, branch, `src/content/${section}/${slug}.md`, token);
    if (sha && !form.get('overwrite')) {
      // 已存在同名文章：加随机短码避免覆盖（同一天同标题也能区分）
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }
    finalPath = `src/content/${section}/${slug}.md`;
    message = `publish: ${title}`;
  }
  const sha = await getSha(owner, repo, branch, finalPath, token);
  const r = await commit(
    owner,
    repo,
    branch,
    finalPath,
    toBase64(fileContent),
    message,
    token,
    sha,
  );
  if (!r.ok) return json({ error: '提交失败: ' + (r.json.message || r.status) }, 500);

  const baseGh = `https://${owner}.github.io/${repo}`;
  const baseCf = env.CF_SITE_URL || 'https://jlualbert-blog.pages.dev';
  // 实际落盘路径决定板块：意境(Vibe) 无独立详情页，只渲染在 /vibe 时间线；博客有独立文章页
  const actualSection = finalPath.includes('/vibe/') ? 'vibe' : 'blog';
  const displaySlug = finalPath.split('/').pop().replace(/\.md$/, '');
  const links =
    actualSection === 'vibe'
      ? { githubPages: `${baseGh}/vibe/`, cloudflare: `${baseCf}/vibe/` }
      : {
          githubPages: `${baseGh}/blog/${displaySlug}/`,
          cloudflare: `${baseCf}/blog/${displaySlug}/`,
        };
  return json({
    ok: true,
    slug: displaySlug,
    path: finalPath,
    section: actualSection,
    edited: isEdit,
    ...links,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/publish' || url.pathname === '/publish/') {
      if (request.method === 'GET') {
        const action = url.searchParams.get('action');
        if (action === 'history') return handleList(request, env);
        if (action === 'article') return handleArticle(request, env);
      }
      return handlePublish(request, env);
    }
    // 其它路径交给静态资产
    return env.ASSETS.fetch(request);
  },
};

const FORM_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Albert's blog Publish</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #0b0d10; color: #e8eaed; min-height: 100vh; overflow-x: hidden; }
  /* ===== 解锁门（黑屏） ===== */
  #gate { position: fixed; inset: 0; overflow: hidden; background: #07080a; display: flex; flex-direction: column;
          align-items: center; justify-content: center; padding: 24px; text-align: center;
          z-index: 50; transition: opacity .7s ease, visibility .7s ease, transform .8s cubic-bezier(.2,.7,.2,1), filter .7s ease; }
  #gate.hidden { opacity: 0; visibility: hidden; pointer-events: none; transform: scale(1.06); filter: blur(12px); }
  /* 极光呼吸：缓慢流动的低饱和光晕 */
  #gate::before { content: ''; position: absolute; inset: -35%; z-index: 0; opacity: .9;
                  background:
                    radial-gradient(38% 38% at 28% 32%, rgba(61,186,122,.20), transparent 60%),
                    radial-gradient(34% 34% at 72% 58%, rgba(86,196,255,.14), transparent 60%),
                    radial-gradient(30% 30% at 52% 82%, rgba(61,186,122,.12), transparent 62%);
                  filter: blur(50px);
                  animation: aurora 20s ease-in-out infinite alternate; }
  @keyframes aurora {
    0%   { transform: translate3d(-4%, -2%, 0) scale(1.05) rotate(0deg); }
    50%  { transform: translate3d(5%, 3%, 0) scale(1.18) rotate(7deg); }
    100% { transform: translate3d(-3%, 4%, 0) scale(1.1) rotate(-6deg); }
  }
  #gate > * { position: relative; z-index: 1; }
  .platforms { display: flex; gap: 14px; margin-bottom: 40px; flex-wrap: wrap; justify-content: center; }
  .plat { padding: 10px 20px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
          color: #d6d9de; text-decoration: none; font-size: 13px; letter-spacing: .4px;
          opacity: 0; transform: translateY(16px); animation: rise .9s cubic-bezier(.2,.7,.2,1) forwards;
          transition: border-color .3s, color .3s, transform .3s, box-shadow .3s; }
  .plat:hover { border-color: #3dba7a; color: #fff; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(61,186,122,.18); }
  .plat:nth-child(1) { animation-delay: .15s; }
  .plat:nth-child(2) { animation-delay: .3s; }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); filter: blur(6px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
  .brand { font-size: clamp(26px, 6vw, 40px); font-weight: 300; letter-spacing: .5px;
           opacity: 0; animation: brandIn 1.2s cubic-bezier(.2,.7,.2,1) .4s forwards; }
  .brand b { font-weight: 600; }
  .brand .dot { color: #3dba7a; animation: dotPulse 2.6s ease-in-out infinite; }
  @keyframes brandIn {
    from { opacity: 0; letter-spacing: .42em; transform: translateY(12px); filter: blur(8px); }
    to   { opacity: 1; letter-spacing: .5px; transform: none; filter: blur(0); }
  }
  @keyframes dotPulse {
    0%, 100% { opacity: .55; text-shadow: 0 0 0 rgba(61,186,122,0); }
    50%      { opacity: 1; text-shadow: 0 0 16px rgba(61,186,122,.75); }
  }
  @keyframes fadeup { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .prompt { margin-top: 40px; display: flex; align-items: center; gap: 10px; opacity: 0;
            animation: fadeup .8s ease .7s forwards; }
  .cursor { display: inline-block; width: 9px; height: 22px; border-radius: 2px; background: #3dba7a;
            animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { opacity: .35; box-shadow: 0 0 0 0 rgba(61,186,122,0); }
    50%      { opacity: 1; box-shadow: 0 0 14px 3px rgba(61,186,122,.55); }
  }
  #gate-input { background: transparent; border: 0; outline: 0; color: #e8eaed; font-size: 20px;
                caret-color: transparent; width: 140px; letter-spacing: 8px; text-align: left; }
  #gate-input::placeholder { color: #4a4f57; letter-spacing: 2px; }
  .gate-hint { margin-top: 16px; color: #565c66; font-size: 12px; opacity: 0; animation: fadeup .8s ease .9s forwards; }
  .shake { animation: shake .5s cubic-bezier(.36,.07,.19,.97); }
  @keyframes shake {
    10%, 90% { transform: translateX(-2px); }
    20%, 80% { transform: translateX(4px); }
    30%, 50%, 70% { transform: translateX(-8px); }
    40%, 60% { transform: translateX(8px); }
  }

  /* ===== 发布台 ===== */
  #studio { max-width: 640px; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 18px 48px;
            opacity: 0; transform: translateY(18px) scale(.99); transition: opacity .7s ease .08s, transform .8s cubic-bezier(.2,.7,.2,1) .08s; }
  #studio.show { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    #gate, #gate::before, .brand, .brand .dot, .plat, .prompt, .gate-hint, .cursor, #studio { animation: none !important; }
    #gate.hidden { transform: none; filter: none; }
    #studio { transform: none; transition: opacity .3s ease !important; }
    * { transition-duration: .2s !important; }
  }
  .head { text-align: center; margin: 8px 0 24px; position: relative; }
  .head h1 { font-size: 22px; font-weight: 300; margin: 0; letter-spacing: .4px; }
  .head h1 b { font-weight: 600; }
  .head .sub { color: #8b919b; font-size: 12.5px; margin: 6px 0 0; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; color: #c6c9ce; }
  input, textarea, select { width: 100%; padding: 12px; font-size: 16px; border-radius: 10px;
         border: 1px solid #262b33; background: #14171c; color: #e8eaed; outline: none;
         transition: border-color .25s, box-shadow .25s; }
  input:focus, textarea:focus { border-color: #3dba7a; box-shadow: 0 0 0 3px rgba(61,186,122,.14); }
  textarea { min-height: 40vh; resize: vertical; line-height: 1.6; }
  input[type=checkbox] { width: auto; transform: scale(1.3); margin-right: 8px; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  button { margin-top: 24px; width: 100%; padding: 15px; font-size: 17px; font-weight: 600;
           border: 0; border-radius: 12px; background: #3dba7a; color: #08130d; cursor: pointer;
           transition: transform .15s, background .2s; }
  button:hover { background: #4acb88; }
  button:active { transform: scale(.98); }
  button:disabled { opacity: .6; cursor: default; }
  .hint { font-size: 12px; color: #8b919b; margin-top: 4px; }

  /* ===== 进度条 & 结果 ===== */
  #progress { display: none; margin-top: 20px; }
  #progress.show { display: block; }
  .bar { height: 6px; background: #1c2026; border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; border-radius: 999px;
           background: linear-gradient(90deg,#3dba7a,#62dca0,#3dba7a);
           background-size: 200% 100%; animation: barflow 1.7s linear infinite;
           transition: width .3s ease; }
  @keyframes barflow { to { background-position: -200% 0; } }
  #progress .label { font-size: 12.5px; color: #9aa0a6; margin-top: 8px; text-align: center; }
  #result { display: none; margin-top: 18px; padding: 16px; border-radius: 12px; font-size: 14px;
            background: #14171c; border: 1px solid #262b33; white-space: pre-wrap; }
  #result.ok { display: block; border-color: #3dba7a; }
  #result.err { display: block; border-color: #e5534b; }
  #result a { color: #3dba7a; word-break: break-all; }
  .lockbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .relock { background: transparent; border: 0; color: #8b919b; font-size: 12px; cursor: pointer;
            padding: 4px 8px; margin: 0; width: auto; }

  /* ===== 历史按钮（标题右上角） ===== */
  .hist-btn { position: absolute; top: -4px; right: 0; background: rgba(255,255,255,.06);
              border: 1px solid rgba(255,255,255,.16); color: #c6c9ce; font-size: 12.5px;
              padding: 6px 13px; border-radius: 999px; cursor: pointer;
              display: inline-flex; align-items: center; gap: 5px;
              transition: border-color .25s, color .25s, background .25s, transform .15s; }
  .hist-btn:hover { border-color: #3dba7a; color: #fff; }
  .hist-btn:active { transform: scale(.97); }
  .hist-btn .ic { font-size: 13px; }

  /* ===== 历史面板（全屏覆盖） ===== */
  #history { position: fixed; inset: 0; z-index: 60; background: rgba(7,8,10,.97);
             backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
             display: none; flex-direction: column; opacity: 0;
             transition: opacity .4s ease; }
  #history.show { display: flex; opacity: 1; }
  .hist-head { display: flex; align-items: center; justify-content: space-between;
               padding: max(18px, env(safe-area-inset-top)) 18px 10px; }
  .hist-head h2 { margin: 0; font-size: 18px; font-weight: 400; letter-spacing: .3px; }
  .hist-head .sub { color: #8b919b; font-size: 12px; margin: 4px 0 0; }
  .hist-close { background: transparent; border: 0; color: #8b919b; font-size: 24px; line-height: 1;
                cursor: pointer; width: auto; margin: 0; padding: 2px 10px; }
  .hist-close:hover { color: #fff; }
  .hist-list { flex: 1; overflow-y: auto; padding: 6px 14px 28px; -webkit-overflow-scrolling: touch; }
  .hist-item { display: block; width: 100%; text-align: left; background: #14171c;
               border: 1px solid #262b33; border-radius: 12px; padding: 12px 14px;
               margin-bottom: 10px; cursor: pointer; color: #e8eaed;
               transition: border-color .2s, transform .12s, background .2s; }
  .hist-item:hover { border-color: #3dba7a; }
  .hist-item:active { transform: scale(.99); }
  .hist-item .t { font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 8px;
                  flex-wrap: wrap; }
  .hist-item .meta { font-size: 12px; color: #8b919b; margin-top: 5px; display: flex; gap: 12px;
                     flex-wrap: wrap; align-items: center; }
  .hist-item .meta .p { opacity: .7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .badge { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge.blog { background: rgba(61,186,122,.16); color: #62dca0; }
  .badge.vibe { background: rgba(86,196,255,.16); color: #86c8ff; }
  .badge.draft { background: rgba(229,83,75,.18); color: #ff9a93; }
  .hist-empty, .hist-loading { color: #8b919b; text-align: center; margin-top: 48px; font-size: 14px; }
  .hist-editing { text-align: center; color: #62dca0; font-size: 12.5px; margin: 8px 0 0; min-height: 16px; }
</style>
</head>
<body>
  <!-- 解锁门 -->
  <div id="gate">
    <div class="platforms">
      <a class="plat" href="https://jlualbert.github.io/blog/" target="_blank" rel="noreferrer">GitHub</a>
      <a class="plat" href="https://jlualbert-blog.pages.dev" target="_blank" rel="noreferrer">Cloudflare</a>
    </div>
    <div class="brand">Albert's blog <b>Publish</b><span class="dot">.</span></div>
    <div class="prompt">
      <span class="cursor"></span>
      <input id="gate-input" type="password" placeholder="passcode" autocomplete="off" autocapitalize="off" />
    </div>
  </div>

  <!-- 发布台 -->
  <div id="studio">
    <div class="lockbar"><span></span><button class="relock" id="relock" type="button">🔒 锁定</button></div>
    <div class="head">
      <button class="hist-btn" id="hist-btn" type="button"><span class="ic">🕑</span> 历史</button>
      <h1>Albert's blog <b>Publish</b></h1>
      <p class="sub">提交后自动 commit 到 GitHub，两平台重新构建上线</p>
    </div>
    <form id="f">
      <input type="hidden" name="password" id="pw-field" />
      <input type="hidden" name="unlock" value="false" />
      <input type="hidden" name="editPath" id="edit-path" />
      <input type="hidden" name="editSha" id="edit-sha" />

      <label>标题 *</label>
      <input type="text" name="title" placeholder="例如：财富自由 · 第二章" required />

      <label>栏目 / 分类</label>
      <select name="section">
        <option value="blog" selected>博客 · Blog（长文 / 笔记）</option>
        <option value="vibe">意境 · Vibe（诗词 / 随笔）</option>
      </select>
      <div class="hint">选择发布到的板块：博客为独立文章页；意境为时间线信息流。</div>

      <div class="row">
        <div>
          <label>日期</label>
          <input type="date" name="date" />
          <div class="hint">留空 = 自动用发布这一刻（精确到秒）</div>
        </div>
        <div>
          <label>系列 / 笔记</label>
          <input type="text" name="series" list="series-list" placeholder="留空 = 独立博客" />
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

      <label>网址别名 slug（可选，留空自动生成）</label>
      <input type="text" name="slug" placeholder="留空 = 日期前缀自动生成" />
      <div class="hint">只填英文/数字/连字符，例如 wealth-freedom-ch2。</div>

      <label>正文（Markdown）</label>
      <textarea name="content" placeholder="在这里写内容…支持 # 标题、**加粗**、- 列表 等 Markdown 语法"></textarea>

      <label>封面 / 配图（可选）</label>
      <input type="file" name="image" accept="image/*" />
      <div class="hint">图片会存到 public/images，并自动插入到正文顶部。</div>

      <label style="display:flex;align-items:center;"><input type="checkbox" name="draft" value="true" />存为草稿（不进首页，仍可凭链接访问预览）</label>

      <button type="submit">发布</button>
    </form>
    <div id="progress"><div class="bar"><i id="bar-fill"></i></div><div class="label" id="progress-label">正在发布…</div></div>
    <div id="result"></div>
    <p class="hist-editing" id="hist-editing"></p>
  </div>

  <!-- 历史面板 -->
  <div id="history">
    <div class="hist-head">
      <div>
        <h2>历史文章</h2>
        <p class="sub">按发布时间倒序 · 点击任意一篇可编辑并重发</p>
      </div>
      <button class="hist-close" id="hist-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="hist-list" id="hist-list">
      <div class="hist-loading">加载中…</div>
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
    const editPathField = document.getElementById('edit-path');
    const editShaField = document.getElementById('edit-sha');
    const histBtn = document.getElementById('hist-btn');
    const histClose = document.getElementById('hist-close');
    const historyEl = document.getElementById('history');
    const histList = document.getElementById('hist-list');
    const histEditing = document.getElementById('hist-editing');

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
      result.className = ''; result.style.display = 'none';
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
          const verb = j.edited ? '更新' : '发布';
          progressLabel.textContent = j.edited ? '已更新' : '已发布';
          setTimeout(() => progress.classList.remove('show'), 600);
          result.className = 'ok';
          result.innerHTML = '✅ ' + verb + '成功！\\nslug: ' + j.slug +
            '\\n<a href="' + j.githubPages + '" target="_blank">GitHub Pages</a>' +
            ' · <a href="' + j.cloudflare + '" target="_blank">Cloudflare</a>';
          histEditing.textContent = '';
          editPathField.value = '';
          editShaField.value = '';
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

    /* ---------------- 历史：列表 + 编辑回填 ---------------- */

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    let histLoaded = false;

    async function openHistory() {
      if (!passcode) { relockNow(); return; }
      historyEl.classList.add('show');
      if (!histLoaded) { await loadHistory(); histLoaded = true; }
    }

    async function loadHistory() {
      histList.innerHTML = '<div class="hist-loading">加载中…</div>';
      try {
        const r = await fetch('/publish?action=history', { headers: { 'x-publish-pw': passcode } });
        const j = await r.json();
        if (!j.ok) { histList.innerHTML = '<div class="hist-loading">加载失败：' + escapeHtml(j.error || '') + '</div>'; return; }
        if (!j.items.length) { histList.innerHTML = '<div class="hist-empty">还没有文章</div>'; return; }
        histList.innerHTML = '';
        for (const it of j.items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hist-item';
          const secBadge = it.section === 'vibe'
            ? '<span class="badge vibe">意境</span>'
            : '<span class="badge blog">博客</span>';
          const draftBadge = it.draft ? '<span class="badge draft">草稿</span>' : '';
          const dateStr = it.date ? it.date.slice(0, 10) : '无日期';
          b.innerHTML =
            '<div class="t">' + escapeHtml(it.title) + secBadge + draftBadge + '</div>' +
            '<div class="meta"><span>' + dateStr + '</span><span class="p">' + escapeHtml(it.path) + '</span></div>';
          b.addEventListener('click', () => loadArticle(it));
          histList.appendChild(b);
        }
      } catch (err) {
        histList.innerHTML = '<div class="hist-loading">网络错误：' + escapeHtml(err.message) + '</div>';
      }
    }

    async function loadArticle(it) {
      histList.innerHTML = '<div class="hist-loading">读取「' + escapeHtml(it.title) + '」中…</div>';
      try {
        const r = await fetch('/publish?action=article&path=' + encodeURIComponent(it.path), {
          headers: { 'x-publish-pw': passcode },
        });
        const j = await r.json();
        if (!j.ok) { alert('读取失败：' + (j.error || '')); await loadHistory(); return; }
        form.querySelector('[name=title]').value = j.title || '';
        form.querySelector('[name=section]').value = j.section === 'vibe' ? 'vibe' : 'blog';
        form.querySelector('[name=date]').value = j.date || '';
        form.querySelector('[name=series]').value = j.series || '';
        form.querySelector('[name=description]').value = j.description || '';
        form.querySelector('[name=tags]').value = j.tags || '';
        form.querySelector('[name=content]').value = j.content || '';
        form.querySelector('[name=draft]').checked = !!j.draft;
        form.querySelector('[name=slug]').value = ''; // 编辑沿用原文件名，不重新生成 slug
        editPathField.value = j.path;
        editShaField.value = j.sha;
        histEditing.innerHTML = '✎ 正在编辑：' + escapeHtml(j.title) +
          '（重新发布将覆盖原文件） <button type="button" id="cancel-edit" style="background:transparent;border:1px solid rgba(255,255,255,.2);color:#c6c9ce;border-radius:8px;padding:2px 10px;font-size:12px;cursor:pointer;margin-left:4px;">取消（改为新建）</button>';
        historyEl.classList.remove('show');
        histLoaded = false; // 内容可能已变，下次打开重新拉取
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => form.querySelector('[name=title]').focus(), 320);
      } catch (err) {
        alert('网络错误：' + err.message);
        await loadHistory();
      }
    }

    histBtn.addEventListener('click', openHistory);
    histClose.addEventListener('click', () => historyEl.classList.remove('show'));
    histEditing.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'cancel-edit') {
        editPathField.value = '';
        editShaField.value = '';
        histEditing.textContent = '';
        form.querySelector('[name=slug]').value = '';
      }
    });
  </script>
</body>
</html>`;
