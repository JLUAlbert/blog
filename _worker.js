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

async function gh(path, { method = 'GET', body, token, signal } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'blog-publisher',
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
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

/* ---------------- 超时控制 + 并发限制（历史列表要拉很多文件，必须可中断） ---------------- */

// 用 AbortController 给异步调用加超时：超时/网络错误一律返回 null，由调用方跳过
async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 限制并发数的 map：避免一次性对 GitHub 发上百个请求触发限流或拖垮整体耗时
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = [];
  const n = Math.min(limit, arr.length);
  for (let k = 0; k < n; k++) {
    workers.push(
      (async () => {
        while (i < arr.length) {
          const idx = i++;
          out[idx] = await fn(arr[idx]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

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
    const listRes = await withTimeout(
      (signal) =>
        gh(`/repos/${owner}/${repo}/contents/src/content/${section}?ref=${branch}`, {
          token,
          signal,
        }),
      8000,
    );
    if (!listRes || !listRes.ok || !Array.isArray(listRes.json)) continue;
    const files = listRes.json.filter((f) => f.name && f.name.endsWith('.md'));

    // 并发（上限 20）拉取每个文件内容，取出标题/日期/sha；单文件 5s 超时则跳过
    const got = await mapLimit(files, 20, async (f) => {
      const r = await withTimeout(
        (signal) =>
          gh(`/repos/${owner}/${repo}/contents/${encodeURI(f.path)}?ref=${branch}`, {
            token,
            signal,
          }),
        5000,
      );
      if (!r || !r.ok || !r.json || !r.json.content) return null;
      return { f, raw: decodeBase64(r.json.content), sha: r.json.sha };
    });

    for (const g of got) {
      if (!g) continue;
      const { data } = parseFrontmatter(g.raw);
      // 优先用 frontmatter 日期；否则回退到文件名里的日期前缀（发布台生成的文件都有）
      let date = data.date || '';
      if (!date) {
        const m = g.f.name.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) date = m[1];
      }
      items.push({
        section,
        slug: g.f.name.replace(/\.md$/, ''),
        path: g.f.path,
        sha: g.sha,
        title: data.title || g.f.name.replace(/\.md$/, ''),
        date,
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
  let section =
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
  :root {
    color-scheme: dark;
    --bg: #0a0c10;
    --surface: #11151c;
    --surface-2: #161b22;
    --border: #232a33;
    --border-soft: rgba(255,255,255,.07);
    --text: #e6edf3;
    --muted: #8b949e;
    --muted-2: #6e7681;
    --accent: #3dba7a;
    --accent-hi: #4acb88;
    --accent-soft: rgba(61,186,122,.14);
    --danger: #e5534b;
    --radius: 16px;
    --radius-sm: 10px;
    --shadow: 0 18px 50px rgba(0,0,0,.45);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font: 16px/1.6 var(--font);
         background:
           radial-gradient(120% 80% at 50% -10%, rgba(61,186,122,.06), transparent 60%),
           var(--bg);
         color: var(--text); min-height: 100vh; overflow-x: hidden; }

  /* ===== 解锁门（黑屏） ===== */
  #gate { position: fixed; inset: 0; overflow: hidden; background: #07080a; display: flex; flex-direction: column;
          align-items: center; justify-content: center; padding: 24px; text-align: center;
          z-index: 50; transition: opacity .7s ease, visibility .7s ease, transform .8s cubic-bezier(.2,.7,.2,1), filter .7s ease; }
  #gate.hidden { opacity: 0; visibility: hidden; pointer-events: none; transform: scale(1.06); filter: blur(12px); }
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
  .platforms { display: flex; gap: 14px; margin-bottom: 36px; flex-wrap: wrap; justify-content: center; }
  .plat { padding: 10px 20px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
          color: #d6d9de; text-decoration: none; font-size: 13px; letter-spacing: .4px;
          opacity: 0; transform: translateY(16px); animation: rise .9s cubic-bezier(.2,.7,.2,1) forwards;
          transition: border-color .3s, color .3s, transform .3s, box-shadow .3s; }
  .plat:hover { border-color: #3dba7a; color: #fff; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(61,186,122,.18); }
  .plat:nth-child(1) { animation-delay: .15s; }
  .plat:nth-child(2) { animation-delay: .3s; }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); filter: blur(6px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
  @keyframes fadeup { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }

  .gate-card { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.1);
               backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
               border-radius: 20px; padding: 26px 28px; display: flex; flex-direction: column;
               align-items: center; gap: 16px; max-width: 320px; width: 100%;
               box-shadow: 0 20px 60px rgba(0,0,0,.5);
               opacity: 0; animation: fadeup .9s ease .35s forwards; }
  .gate-mono { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center;
               font-size: 26px; font-weight: 700; color: #06210f;
               background: linear-gradient(135deg, #4acb88, #2a9c63);
               box-shadow: 0 8px 22px rgba(61,186,122,.35); }
  .brand { font-size: 22px; font-weight: 300; letter-spacing: .4px; }
  .brand b { font-weight: 600; }
  .brand .dot { color: #3dba7a; animation: dotPulse 2.6s ease-in-out infinite; }
  @keyframes dotPulse {
    0%, 100% { opacity: .55; text-shadow: 0 0 0 rgba(61,186,122,0); }
    50%      { opacity: 1; text-shadow: 0 0 16px rgba(61,186,122,.75); }
  }
  .prompt { width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
            padding: 10px 16px; border-radius: 12px; background: rgba(0,0,0,.28);
            border: 1px solid rgba(255,255,255,.12); transition: border-color .25s, box-shadow .25s; }
  .prompt:focus-within { border-color: #3dba7a; box-shadow: 0 0 0 3px rgba(61,186,122,.14); }
  .cursor { display: inline-block; width: 9px; height: 22px; border-radius: 2px; background: #3dba7a;
            animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { opacity: .35; box-shadow: 0 0 0 0 rgba(61,186,122,0); }
    50%      { opacity: 1; box-shadow: 0 0 14px 3px rgba(61,186,122,.55); }
  }
  #gate-input { background: transparent; border: 0; outline: 0; color: #e8eaed; font-size: 20px;
                caret-color: #3dba7a; width: 100%; letter-spacing: 8px; text-align: left; }
  #gate-input::placeholder { color: #4a4f57; letter-spacing: 2px; }
  .gate-hint { color: #565c66; font-size: 12px; }
  .shake { animation: shake .5s cubic-bezier(.36,.07,.19,.97); }
  @keyframes shake {
    10%, 90% { transform: translateX(-2px); }
    20%, 80% { transform: translateX(4px); }
    30%, 50%, 70% { transform: translateX(-8px); }
    40%, 60% { transform: translateX(8px); }
  }

  /* ===== 发布台 ===== */
  #studio { max-width: 680px; margin: 0 auto; padding: max(16px, env(safe-area-inset-top)) 14px 56px;
            opacity: 0; transform: translateY(18px) scale(.99); transition: opacity .7s ease .08s, transform .8s cubic-bezier(.2,.7,.2,1) .08s; }
  #studio.show { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    #gate, #gate::before, .brand, .brand .dot, .plat, .cursor, #studio, .gate-card { animation: none !important; }
    .brand, .plat, .gate-card { opacity: 1 !important; transform: none !important; filter: none !important; }
    #gate.hidden { transform: none; filter: none; }
    #studio { transform: none; transition: opacity .3s ease !important; }
    * { transition-duration: .2s !important; }
  }

  .panel { background: var(--surface); border: 1px solid var(--border);
           border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }

  /* 应用栏 */
  .app-bar { display: flex; align-items: center; gap: 12px; padding: 14px 16px;
             border-bottom: 1px solid var(--border-soft); background: linear-gradient(180deg, rgba(255,255,255,.02), transparent); }
  .mono { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center;
          font-size: 18px; font-weight: 700; color: #06210f; flex: none;
          background: linear-gradient(135deg, #4acb88, #2a9c63); box-shadow: 0 4px 14px rgba(61,186,122,.3); }
  .app-bar .who { flex: 1; min-width: 0; }
  .app-bar .who .n { font-size: 15px; font-weight: 600; line-height: 1.2; }
  .app-bar .who .s { font-size: 11.5px; color: var(--muted); }
  .relock { background: rgba(255,255,255,.05); border: 1px solid var(--border); color: var(--muted);
            font-size: 12.5px; border-radius: 9px; padding: 7px 12px; cursor: pointer; margin: 0; width: auto;
            transition: border-color .2s, color .2s, background .2s; }
  .relock:hover { border-color: var(--accent); color: var(--text); background: var(--accent-soft); }

  /* 标题区 */
  .title-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
               padding: 18px 18px 4px; }
  .title-row h1 { font-size: 21px; font-weight: 600; margin: 0; letter-spacing: .3px; }
  .title-row .sub { color: var(--muted); font-size: 12.5px; margin: 5px 0 0; }
  .hist-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.16);
              color: var(--text); font-size: 12.5px; padding: 7px 14px; border-radius: 999px;
              cursor: pointer; display: inline-flex; align-items: center; gap: 6px; flex: none;
              transition: border-color .25s, color .25s, background .25s, transform .15s; }
  .hist-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
  .hist-btn:active { transform: scale(.97); }
  .hist-btn .ic { font-size: 13px; }

  /* 分组卡片 */
  form { padding: 14px 16px 18px; }
  .group { background: var(--surface-2); border: 1px solid var(--border-soft);
           border-radius: var(--radius-sm); padding: 14px 14px 16px; margin-top: 12px; }
  .group-head { display: flex; align-items: center; gap: 8px; margin: 0 0 12px;
                font-size: 12px; font-weight: 600; letter-spacing: .6px; color: var(--muted);
                text-transform: uppercase; }
  .group-head .g-ic { font-size: 14px; filter: saturate(.9); }
  .group-head::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); margin-left: 6px; }

  label { display: block; margin: 12px 0 6px; font-size: 13px; color: #c6c9ce; }
  .group .group-head + label { margin-top: 0; }
  input[type=text], input[type=date], input[type=password], textarea, select {
    width: 100%; padding: 12px 13px; font-size: 16px; font-family: inherit; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: #0e1218; color: var(--text); outline: none;
    transition: border-color .2s, box-shadow .2s, background .2s; }
  input::placeholder, textarea::placeholder { color: #5b626c; }
  input:hover, textarea:hover, select:hover { border-color: #303841; }
  input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: #0c1016; }
  textarea { min-height: 42vh; resize: vertical; line-height: 1.65; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.5; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; min-width: 0; }

  /* 分段控件 */
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px;
         background: #0e1218; border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 6px; }
  .seg-btn { border: 0; background: transparent; color: var(--muted); font-size: 14px; font-weight: 500;
             padding: 10px 8px; border-radius: 8px; cursor: pointer; font-family: inherit;
             transition: background .2s, color .2s; }
  .seg-btn.active { background: var(--accent); color: #06210f; font-weight: 600;
                    box-shadow: 0 4px 14px rgba(61,186,122,.25); }

  /* 开关 */
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                margin-top: 4px; padding: 12px 13px; background: #0e1218; border: 1px solid var(--border);
                border-radius: var(--radius-sm); }
  .switch-row .lbl b { display: block; font-size: 14px; font-weight: 600; color: var(--text); }
  .switch-row .lbl small { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
  .switch { position: relative; width: 46px; height: 26px; flex: none; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch .track { position: absolute; inset: 0; border-radius: 999px; background: #2a323c;
                   transition: background .2s; }
  .switch .track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
                          border-radius: 50%; background: #cdd3da; transition: transform .2s, background .2s; }
  .switch input:checked + .track { background: var(--accent); }
  .switch input:checked + .track::after { transform: translateX(20px); background: #06210f; }

  /* 文件上传 */
  .file { position: relative; }
  .file input[type=file] { padding: 11px 13px; color: var(--muted); font-size: 13px; }
  .file input[type=file]::file-selector-button { margin-right: 12px; padding: 7px 12px; border-radius: 8px;
        border: 1px solid var(--border); background: rgba(255,255,255,.05); color: var(--text);
        font-family: inherit; font-size: 13px; cursor: pointer; transition: border-color .2s, background .2s; }
  .file input[type=file]::file-selector-button:hover { border-color: var(--accent); background: var(--accent-soft); }

  /* 发布按钮 */
  button.submit { margin-top: 18px; width: 100%; padding: 15px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 12px; color: #06210f; cursor: pointer; font-family: inherit;
           background: linear-gradient(135deg, #4acb88, #34a96d);
           box-shadow: 0 10px 28px rgba(61,186,122,.28);
           display: inline-flex; align-items: center; justify-content: center; gap: 8px;
           transition: transform .15s, box-shadow .2s, filter .2s; }
  button.submit:hover { filter: brightness(1.05); box-shadow: 0 12px 34px rgba(61,186,122,.36); }
  button.submit:active { transform: scale(.985); }
  button.submit:disabled { opacity: .6; cursor: default; filter: none; }

  /* 进度 & 结果 */
  #progress { display: none; margin-top: 16px; }
  #progress.show { display: block; }
  .bar { height: 6px; background: #1c2026; border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; border-radius: 999px;
           background: linear-gradient(90deg,#3dba7a,#62dca0,#3dba7a); background-size: 200% 100%;
           animation: barflow 1.7s linear infinite; transition: width .3s ease; }
  @keyframes barflow { to { background-position: -200% 0; } }
  #progress .label { font-size: 12.5px; color: #9aa0a6; margin-top: 8px; text-align: center; }
  #result { display: none; margin-top: 16px; padding: 16px; border-radius: 12px; font-size: 14px;
            background: var(--surface-2); border: 1px solid var(--border); white-space: pre-wrap; word-break: break-word; }
  #result.ok { display: block; border-color: var(--accent); }
  #result.err { display: block; border-color: var(--danger); }
  #result a { color: var(--accent-hi); word-break: break-all; }

  /* 历史面板 */
  #history { position: fixed; inset: 0; z-index: 60; background: rgba(7,8,10,.97);
             backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
             display: none; flex-direction: column; opacity: 0; transition: opacity .4s ease; }
  #history.show { display: flex; opacity: 1; }
  .hist-head { display: flex; align-items: center; justify-content: space-between;
               padding: max(18px, env(safe-area-inset-top)) 18px 10px; }
  .hist-head h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: .3px; }
  .hist-head .sub { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
  .hist-close { background: rgba(255,255,255,.05); border: 1px solid var(--border); color: var(--muted);
                font-size: 20px; line-height: 1; cursor: pointer; width: auto; margin: 0; padding: 4px 12px;
                border-radius: 9px; transition: color .2s, border-color .2s; }
  .hist-close:hover { color: #fff; border-color: var(--accent); }
  .hist-search { padding: 0 14px 8px; }
  .hist-search input { width: 100%; padding: 11px 14px; font-size: 14px; border-radius: 10px;
        border: 1px solid var(--border); background: #0e1218; color: var(--text); outline: none;
        transition: border-color .2s, box-shadow .2s; }
  .hist-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .hist-list { flex: 1; overflow-y: auto; padding: 4px 14px 28px; -webkit-overflow-scrolling: touch; }
  .hist-month { font-size: 11.5px; color: var(--muted-2); letter-spacing: .5px; margin: 16px 4px 8px;
               display: flex; align-items: center; gap: 8px; }
  .hist-month::after { content: ''; flex: 1; height: 1px; background: var(--border-soft); }
  .hist-item { display: block; width: 100%; text-align: left; background: var(--surface-2);
               border: 1px solid var(--border-soft); border-radius: 12px; padding: 13px 14px;
               margin-bottom: 9px; cursor: pointer; color: var(--text);
               transition: border-color .2s, transform .12s, background .2s; position: relative; }
  .hist-item:hover { border-color: var(--accent); background: #1a212a; }
  .hist-item:active { transform: scale(.99); }
  .hist-item .t { font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .hist-item .meta { font-size: 12px; color: var(--muted); margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; min-width: 0; }
  .hist-item .meta .p { opacity: .7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
                        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hist-item .go { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); color: var(--muted-2); font-size: 13px; opacity: 0; transition: opacity .2s, color .2s; }
  .hist-item:hover .go { opacity: 1; color: var(--accent-hi); }
  .badge { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; font-weight: 500; }
  .badge.blog { background: rgba(61,186,122,.16); color: #62dca0; }
  .badge.vibe { background: rgba(86,196,255,.16); color: #86c8ff; }
  .badge.draft { background: rgba(229,83,75,.18); color: #ff9a93; }
  .hist-empty, .hist-loading { color: var(--muted); text-align: center; margin-top: 48px; font-size: 14px; }
  .hist-editing { text-align: center; color: #62dca0; font-size: 12.5px; margin: 12px 16px 16px;
                  padding: 10px 12px; background: var(--accent-soft); border: 1px solid rgba(61,186,122,.25);
                  border-radius: 10px; }
  .hist-editing:empty { display: none; }
  .hist-editing button { background: transparent; border: 1px solid rgba(255,255,255,.2); color: #c6c9ce;
        border-radius: 8px; padding: 2px 10px; font-size: 12px; cursor: pointer; margin-left: 6px; font-family: inherit; }
</style>
</head>
<body>
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
      <div class="gate-hint">输入发布口令以进入</div>
    </div>
  </div>

  <!-- 发布台 -->
  <div id="studio">
    <div class="panel">
      <div class="app-bar">
        <div class="mono">A</div>
        <div class="who">
          <div class="n">Albert's Blog</div>
          <div class="s">发布台 · Publish Console</div>
        </div>
        <button class="relock" id="relock" type="button">🔒 锁定</button>
      </div>

      <div class="title-row">
        <div>
          <h1>写点什么</h1>
          <p class="sub">提交后自动 commit 到 GitHub，两平台重新构建上线</p>
        </div>
        <button class="hist-btn" id="hist-btn" type="button"><span class="ic">🕑</span> 历史</button>
      </div>

      <form id="f">
        <input type="hidden" name="password" id="pw-field" />
        <input type="hidden" name="unlock" value="false" />
        <input type="hidden" name="editPath" id="edit-path" />
        <input type="hidden" name="editSha" id="edit-sha" />

        <div class="group">
          <div class="group-head"><span class="g-ic">✏️</span> 基本信息</div>
          <label>标题 *</label>
          <input type="text" name="title" placeholder="例如：财富自由 · 第二章" required />

          <label>栏目 / 分类</label>
          <div class="seg" id="seg">
            <button type="button" class="seg-btn active" data-val="blog">📝 博客</button>
            <button type="button" class="seg-btn" data-val="vibe">🌿 意境</button>
            <input type="hidden" name="section" value="blog" />
          </div>
          <div class="hint">博客为独立文章页；意境为时间线信息流。</div>
        </div>

        <div class="group">
          <div class="group-head"><span class="g-ic">🗂️</span> 归档与标签</div>
          <div class="row">
            <div>
              <label>日期</label>
              <input type="date" name="date" />
              <div class="hint">留空 = 发布这一刻（精确到秒）</div>
            </div>
            <div>
              <label>系列 / 笔记</label>
              <input type="text" name="series" list="series-list" placeholder="留空 = 独立" />
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

          <label>网址别名 slug（可选）</label>
          <input type="text" name="slug" placeholder="留空 = 日期前缀自动生成" />
          <div class="hint">只填英文/数字/连字符，例如 wealth-freedom-ch2。</div>
        </div>

        <div class="group">
          <div class="group-head"><span class="g-ic">📄</span> 正文</div>
          <label>内容（Markdown）</label>
          <textarea name="content" placeholder="在这里写内容…支持 # 标题、**加粗**、- 列表 等 Markdown 语法"></textarea>
        </div>

        <div class="group">
          <div class="group-head"><span class="g-ic">🚀</span> 媒体与发布</div>
          <label>封面 / 配图（可选）</label>
          <div class="file"><input type="file" name="image" accept="image/*" /></div>
          <div class="hint">图片会存到 public/images，并自动插入到正文顶部。</div>

          <div class="switch-row" style="margin-top:14px;">
            <span class="lbl"><b>存为草稿</b><small>不进首页，仍可凭链接访问预览</small></span>
            <label class="switch">
              <input type="checkbox" name="draft" value="true" />
              <span class="track"></span>
            </label>
          </div>

          <button type="submit" class="submit">↑ 发布</button>
        </div>
      </form>

      <div id="progress" style="padding:0 16px 8px;"><div class="bar"><i id="bar-fill"></i></div><div class="label" id="progress-label">正在发布…</div></div>
      <div id="result" style="margin:0 16px 18px;"></div>
      <p class="hist-editing" id="hist-editing"></p>
    </div>
  </div>

  <!-- 历史面板 -->
  <div id="history">
    <div class="hist-head">
      <div>
        <h2>历史文章</h2>
        <p class="sub" id="hist-count">按发布时间倒序 · 点击任意一篇可编辑并重发</p>
      </div>
      <button class="hist-close" id="hist-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="hist-search"><input id="hist-search-input" type="text" placeholder="🔍 搜索标题…" autocomplete="off" /></div>
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
    const histCount = document.getElementById('hist-count');
    const histSearchInput = document.getElementById('hist-search-input');

    let passcode = '';
    let unlocking = false;
    let unlockTimer = null;
    let lastTried = '';
    const KEY = 'abp_unlocked';
    const PW_KEY = 'abp_pw';

    /* 分段控件同步 */
    const seg = document.getElementById('seg');
    const sectionInput = form.querySelector('[name=section]');
    const segBtns = seg.querySelectorAll('.seg-btn');
    function syncSection() {
      const v = sectionInput.value;
      segBtns.forEach((b) => b.classList.toggle('active', b.dataset.val === v));
    }
    segBtns.forEach((b) => b.addEventListener('click', () => {
      sectionInput.value = b.dataset.val;
      syncSection();
    }));

    async function unlock(pw) {
      pw = (pw || '').trim();
      if (!pw) return;
      if (unlocking) return;
      if (pw === lastTried) return;
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
          sessionStorage.setItem(PW_KEY, pw);
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
    gateInput.addEventListener('change', scheduleUnlock);
    gateInput.addEventListener('blur', () => {
      if (gateInput.value.trim()) unlock(gateInput.value);
    });

    relock.addEventListener('click', relockNow);

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
          syncSection();
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
        btn.disabled = false; btn.textContent = '↑ 发布';
      }
    });

    /* ---------------- 历史：列表 + 编辑回填 ---------------- */

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    let histLoaded = false;
    let allItems = [];

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
        allItems = j.items;
        histCount.textContent = '共 ' + j.items.length + ' 篇 · 点击任意一篇可编辑并重发';
        renderHistory('');
      } catch (err) {
        histList.innerHTML = '<div class="hist-loading">网络错误：' + escapeHtml(err.message) + '</div>';
      }
    }

    function renderHistory(query) {
      const q = (query || '').trim().toLowerCase();
      const items = q ? allItems.filter((it) => (it.title || '').toLowerCase().includes(q)) : allItems;
      if (!items.length) { histList.innerHTML = '<div class="hist-empty">没有匹配的文章</div>'; return; }
      histList.innerHTML = '';
      let lastMonth = null;
      for (const it of items) {
        const month = (it.date || '').slice(0, 7);
        if (month && month !== lastMonth) {
          lastMonth = month;
          const d = document.createElement('div');
          d.className = 'hist-month';
          const parts = month.split('-');
          d.textContent = parts[0] + ' 年 ' + parseInt(parts[1], 10) + ' 月';
          histList.appendChild(d);
        }
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
          '<div class="meta"><span>' + dateStr + '</span><span class="p">' + escapeHtml(it.path) + '</span></div>' +
          '<span class="go">编辑 →</span>';
        b.addEventListener('click', () => loadArticle(it));
        histList.appendChild(b);
      }
    }

    histSearchInput.addEventListener('input', () => renderHistory(histSearchInput.value));

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
        syncSection();
        form.querySelector('[name=date]').value = j.date || '';
        form.querySelector('[name=series]').value = j.series || '';
        form.querySelector('[name=description]').value = j.description || '';
        form.querySelector('[name=tags]').value = j.tags || '';
        form.querySelector('[name=content]').value = j.content || '';
        form.querySelector('[name=draft]').checked = !!j.draft;
        form.querySelector('[name=slug]').value = '';
        editPathField.value = j.path;
        editShaField.value = j.sha;
        histEditing.innerHTML = '✎ 正在编辑：' + escapeHtml(j.title) +
          '（重新发布将覆盖原文件） <button type="button" id="cancel-edit">取消（改为新建）</button>';
        historyEl.classList.remove('show');
        histLoaded = false;
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
</html>
`;
