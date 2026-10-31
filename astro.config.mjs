// @ts-check

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import { parse } from 'smol-toml';

import tailwindcss from '@tailwindcss/vite';

import navfolioConfig from './navfolio.config';
import { getAstroPluginConfig } from './src/plugins/config';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const siteToml = parse(fs.readFileSync(new URL('./src/config/site.toml', import.meta.url), 'utf8'));
const configToml = isRecord(siteToml.config) ? siteToml.config : {};
const siteConfig = isRecord(configToml.site) ? configToml.site : {};
const mathConfig = isRecord(configToml.math) ? configToml.math : {};
const configuredSiteUrl = siteConfig.url;
const configuredMathRenderer = mathConfig.render;
const mathRenderer = configuredMathRenderer === 'mathjax' ? 'mathjax' : 'katex';
const astroPluginConfig = getAstroPluginConfig(navfolioConfig, { mathRenderer });
/**
 * @param {unknown} value
 */
const normalizeSiteUrl = (value) => {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
const customSite = process.env.SITE_URL;
// 部署目标标记：'github-pages' 用 /blog，其它（cloudflare/netlify/本地）默认根 '/'
// 用非路径字符串做标记，避免被本地运行时劫持路径型环境变量
const deployTarget = process.env.DEPLOY_TARGET;
const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER;
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isProjectPage =
  Boolean(repositoryOwner) &&
  Boolean(repositoryName) &&
  repositoryName !== `${repositoryOwner}.github.io`;

const githubPagesSite =
  repositoryOwner && repositoryName
    ? `https://${repositoryOwner}.github.io${isProjectPage ? `/${repositoryName}` : ''}`
    : undefined;

const resolvedSite =
  normalizeSiteUrl(customSite) ||
  (isGitHubActions && githubPagesSite ? githubPagesSite : undefined) ||
  normalizeSiteUrl(configuredSiteUrl) ||
  'https://example.com';

const resolvedBase =
  // 显式指定部署目标为 github-pages 时，用仓库名做 base
  deployTarget === 'github-pages'
    ? isProjectPage && repositoryName
      ? `/${repositoryName}`
      : '/'
    : // 其它目标（cloudflare / netlify / 本地）一律根路径 '/'
      '/';

// 站内绝对路径重写：markdown 正文里的 /images/xx.png、/blog/xx 这类以 / 开头的
// img.src / a.href，在 base 为 /blog（GitHub Pages）时会 404；这里统一补上 base。
// 外链（http/https）与协议相对地址（//）不动。
const basePrefix = resolvedBase.replace(/\/$/, '');
const rewriteInternalPaths = () => (tree) => {
  const rewrite = (node, key) => {
    const v = node?.properties?.[key];
    if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && basePrefix) {
      if (!v.startsWith(basePrefix + '/')) node.properties[key] = basePrefix + v;
    }
  };
  const walk = (node) => {
    if (node.type === 'element') {
      if (node.tagName === 'img') rewrite(node, 'src');
      if (node.tagName === 'a') rewrite(node, 'href');
      if (node.tagName === 'source') rewrite(node, 'srcset');
    }
    (node.children || []).forEach(walk);
  };
  walk(tree);
};

// 不蒜子访问统计：每个页面加载统计脚本，并把访问量/访客数追加到页脚
const busuanziIntegration = {
  name: 'busuanzi-analytics',
  hooks: {
    'astro:config:setup': ({ injectScript }) => {
      injectScript(
        'page',
        `window.addEventListener('DOMContentLoaded', () => {
          const footer = document.querySelector('footer');
          if (!footer) return;
          const span = document.createElement('span');
          span.style.cssText = 'margin-left:.75rem;opacity:.65;font-size:.85em;white-space:nowrap;';
          span.innerHTML =
            '\u00b7 <span id="busuanzi_container_site_pv">Views <b id="busuanzi_value_site_pv"></b></span>' +
            ' / <span id="busuanzi_container_site_uv">Visitors <b id="busuanzi_value_site_uv"></b></span>';
          footer.appendChild(span);
          const s = document.createElement('script');
          s.async = true;
          s.src = 'https://busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js';
          document.head.appendChild(s);
        });`,
      );
    },
  },
};

// 色盘背景：把调色盘 CSS 与循环切换脚本注入到每个页面的 <head>，
// 不依赖某个布局组件，保证文章页/列表页/详情页都跟随色盘改变背景。
const paletteCss = fs.readFileSync(new URL('./src/styles/palette-bg.css', import.meta.url), 'utf8');
// 顺带隐藏被清空的 kicker / subtitle 残留空元素（Notebook archive 等已置空）。
const siteFixesCss =
  '\n[class*="kicker"]:empty,[class*="subtitle"]:empty{display:none!important;}';
const paletteRuntimeCss = paletteCss + siteFixesCss;
const paletteIntegration = {
  name: 'navfolio-palette-backgrounds',
  hooks: {
    'astro:config:setup': ({ injectScript }) => {
      injectScript(
        'head-inline',
        `(() => {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const paletteParam = params.get('palette');
  const themeParam = params.get('theme');
  if (themeParam === 'dark' || themeParam === 'light') root.dataset.theme = themeParam;
  const css = ${JSON.stringify(paletteRuntimeCss)};
  const ensurePaletteStyle = () => {
    if (css && !document.getElementById('palette-backgrounds')) {
      const style = document.createElement('style');
      style.id = 'palette-backgrounds';
      style.textContent = css;
      document.head.appendChild(style);
    }
  };
  const storageKey = 'navfolio-palette';
  const palettes = ['green-soft', 'green-vivid', 'rose-soft', 'pink-soft', 'purple-soft', 'blue-soft', 'orange-soft', 'brown-soft'];
  const stored = () => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  };
  try {
    localStorage.removeItem('navfolio-theme');
  } catch {}
  const apply = (palette) => {
    if (palettes.includes(palette)) root.dataset.palette = palette;
  };
  const preferred = () => paletteParam || stored() || root.dataset.palette;
  apply(preferred());
  const syncButtons = () => {
    const current = root.dataset.palette;
    for (const button of document.querySelectorAll('[data-palette-toggle]')) {
      const label = 'Theme color: ' + current;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
  };
  const init = () => {
    ensurePaletteStyle();
    apply(preferred());
    syncButtons();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
  if (!window.__navfolioPaletteBound) {
    window.__navfolioPaletteBound = true;
    document.addEventListener('click', (event) => {
      const button = event.target.closest ? event.target.closest('[data-palette-toggle]') : null;
      if (!button) return;
      const current = palettes.includes(root.dataset.palette) ? root.dataset.palette : palettes[0];
      const next = palettes[(palettes.indexOf(current) + 1) % palettes.length];
      apply(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {}
      syncButtons();
      window.dispatchEvent(new CustomEvent('navfolio:palette-change', { detail: { palette: next } }));
    });
  }
  document.addEventListener('astro:after-swap', init);
  document.addEventListener('astro:page-load', init);
})();`,
      );
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: resolvedSite,
  base: resolvedBase,
  markdown: {
    remarkPlugins: astroPluginConfig.remarkPlugins,
    rehypePlugins: [...astroPluginConfig.rehypePlugins, rewriteInternalPaths],
  },
  integrations: [
    ...astroPluginConfig.integrations,
    mdx(),
    sitemap(),
    busuanziIntegration,
    paletteIntegration,
  ],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        'virtual:navfolio/page-runtime': fileURLToPath(
          new URL('./src/modules/page-runtime.ts', import.meta.url),
        ),
      },
    },
  },
});
