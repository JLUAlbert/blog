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

function defaultSlug(title) {
  const d = new Date().toISOString().slice(0, 10);
  const t = slugify(title);
  if (!/[a-z0-9]/.test(t)) return `${d}-${Math.random().toString(36).slice(2, 6)}`;
  return `${d}-${t}`;
}

// 当前时刻的完整 ISO 时间戳（含时分秒 + 时区），留空日期时使用，精确到“发布那刻”
function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const tz = sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds()) +
    tz
  );
}

export function buildFrontmatter({ title, description, date, tags, series, draft }) {
  const lines = [];
  lines.push('title: ' + quoteScalar(title || 'Untitled'));
  lines.push('description: ' + quoteScalar(description || title || ''));
  lines.push('date: ' + quoteScalar((date || '').toString().trim() || nowIso()));
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

  return json({
    ok: true,
    slug,
    path: finalPath,
    githubPages: `https://${owner}.github.io/${repo}/blog/${slug}/`,
    cloudflare: `${env.CF_SITE_URL || 'https://jlualbert-blog.pages.dev'}/blog/${slug}/`,
    netlify: `${env.NETLIFY_SITE_URL || 'https://jlualbert-blog.netlify.app'}/blog/${slug}/`,
  });
}

/* ---------------- 表单 HTML（移动优先） ---------------- */

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
  #gate { position: fixed; inset: 0; background: #07080a; display: flex; flex-direction: column;
          align-items: center; justify-content: center; padding: 24px; text-align: center;
          z-index: 50; transition: opacity .5s ease, visibility .5s ease; }
  #gate.hidden { opacity: 0; visibility: hidden; pointer-events: none; }
  .platforms { display: flex; gap: 14px; margin-bottom: 40px; flex-wrap: wrap; justify-content: center; }
  .plat { padding: 10px 20px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
          color: #d6d9de; text-decoration: none; font-size: 13px; letter-spacing: .4px;
          opacity: 0; transform: translateY(14px); animation: rise .7s ease forwards;
          transition: border-color .3s, color .3s, transform .3s; }
  .plat:hover { border-color: #3dba7a; color: #fff; transform: translateY(-2px); }
  .plat:nth-child(1) { animation-delay: .1s; }
  .plat:nth-child(2) { animation-delay: .22s; }
  .plat:nth-child(3) { animation-delay: .34s; }
  @keyframes rise { to { opacity: 1; transform: translateY(0); } }
  .brand { font-size: clamp(26px, 6vw, 40px); font-weight: 300; letter-spacing: .5px;
           opacity: 0; animation: fadeup .9s ease .4s forwards; }
  .brand b { font-weight: 600; }
  .brand .dot { color: #3dba7a; }
  @keyframes fadeup { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  .prompt { margin-top: 40px; display: flex; align-items: center; gap: 10px; opacity: 0;
            animation: fadeup .8s ease .7s forwards; }
  .cursor { display: inline-block; width: 10px; height: 22px; background: #3dba7a;
            animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  #gate-input { background: transparent; border: 0; outline: 0; color: #e8eaed; font-size: 20px;
                caret-color: transparent; width: 140px; letter-spacing: 8px; text-align: left; }
  #gate-input::placeholder { color: #4a4f57; letter-spacing: 2px; }
  .gate-hint { margin-top: 16px; color: #565c66; font-size: 12px; opacity: 0; animation: fadeup .8s ease .9s forwards; }
  .shake { animation: shake .4s ease; }
  @keyframes shake { 20%,60% { transform: translateX(-6px); } 40%,80% { transform: translateX(6px); } }

  /* ===== 发布台 ===== */
  #studio { max-width: 640px; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 18px 48px;
            opacity: 0; transition: opacity .5s ease; }
  #studio.show { opacity: 1; }
  .head { text-align: center; margin: 8px 0 24px; }
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
  .bar i { display: block; height: 100%; width: 0; background: #3dba7a; border-radius: 999px;
           transition: width .3s ease; }
  #progress .label { font-size: 12.5px; color: #9aa0a6; margin-top: 8px; text-align: center; }
  #result { display: none; margin-top: 18px; padding: 16px; border-radius: 12px; font-size: 14px;
            background: #14171c; border: 1px solid #262b33; white-space: pre-wrap; }
  #result.ok { display: block; border-color: #3dba7a; }
  #result.err { display: block; border-color: #e5534b; }
  #result a { color: #3dba7a; word-break: break-all; }
  .lockbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .relock { background: transparent; border: 0; color: #8b919b; font-size: 12px; cursor: pointer;
            padding: 4px 8px; margin: 0; width: auto; }
</style>
</head>
<body>
  <!-- 解锁门 -->
  <div id="gate">
    <div class="platforms">
      <a class="plat" href="https://github.com/JLUAlbert" target="_blank" rel="noreferrer">GitHub</a>
      <a class="plat" href="https://jlualbert-blog.pages.dev" target="_blank" rel="noreferrer">Cloudflare</a>
      <a class="plat" href="https://jlualbert-blog.netlify.app" target="_blank" rel="noreferrer">Netlify</a>
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
      <h1>Albert's blog <b>Publish</b></h1>
      <p class="sub">提交后自动 commit 到 GitHub，三平台重新构建上线</p>
    </div>
    <form id="f">
      <input type="hidden" name="password" id="pw-field" />
      <input type="hidden" name="unlock" value="false" />

      <label>标题 *</label>
      <input type="text" name="title" placeholder="例如：财富自由 · 第二章" required />

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

    // 若本会话已解锁则直接进入
    if (sessionStorage.getItem(KEY) === '1') {
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
          progressLabel.textContent = '已发布';
          setTimeout(() => progress.classList.remove('show'), 600);
          result.className = 'ok';
          result.innerHTML = '✅ 发布成功！\\nslug: ' + j.slug +
            '\\n<a href="' + j.githubPages + '" target="_blank">GitHub Pages</a>' +
            ' · <a href="' + j.cloudflare + '" target="_blank">Cloudflare</a>' +
            ' · <a href="' + j.netlify + '" target="_blank">Netlify</a>';
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
