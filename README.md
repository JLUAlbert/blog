# Albert's Blog

基于 [astro-navfolio](https://github.com/dodolalorc/astro-navfolio) 的个人站点：博客、书架、片单、vibe 短记录、摄影项目。

## 本地开发

```bash
bun install                # 安装依赖
python3 -m venv .venv && .venv/bin/python -m pip install fonttools brotli   # 字体子集化工具（一次性）
bun run dev                # http://localhost:4321
bun run build              # 完整构建（字体 + astro + pagefind）到 dist/
```

## 内容结构

| 目录                    | 内容                                     |
| ----------------------- | ---------------------------------------- |
| `src/content/blog/`     | 长文（读书笔记、影评、思考）             |
| `src/content/vibe/`     | 短记录（诗词、碎片）                     |
| `src/content/movie/`    | 片单，`bun run media:sync` 从 Trakt 拉取 |
| `src/content/book/`     | 书架，手动维护                           |
| `src/content/projects/` | 项目文档（摄影课程等）                   |
| `src/config/site.toml`  | 站点配置：导航、文案、社交链接           |

## Trakt 片单同步

```bash
# 公开资料模式（只需 client id，见 .env）
node scripts/trakt-sync.mjs --user=<你的trakt用户名>

# OAuth 模式（资料为私密时，先 node scripts/trakt-sync.mjs --auth 授权一次）
node scripts/trakt-sync.mjs
```

生成 `src/content/movie/*.md`，评分折算为 1–5 星，封面来自 Trakt/TMDB。
`<!-- trakt:begin -->` 与 `<!-- trakt:end -->` 之间的内容由脚本管理，块外可以写自己的笔记，重跑不会丢。

## 部署

- **GitHub Pages**：push 到 `main` 即自动构建发布（`.github/workflows/deploy-pages.yml`）。仓库 Settings → Pages → Source 选 **GitHub Actions**（只需设置一次）。
- **Vercel / Netlify**：导入仓库即可，`vercel.json` / `netlify.toml` 已配置。
- **Cloudflare Pages**：连接仓库，构建命令 `bun run build`，输出目录 `dist`，框架预设选 Astro。
