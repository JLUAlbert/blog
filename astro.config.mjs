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
const customBase = process.env.SITE_BASE;const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER;
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
  customBase || (isGitHubActions && isProjectPage && repositoryName ? `/${repositoryName}` : '/');

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

// https://astro.build/config
export default defineConfig({
  site: resolvedSite,
  base: resolvedBase,
  markdown: {
    remarkPlugins: astroPluginConfig.remarkPlugins,
    rehypePlugins: astroPluginConfig.rehypePlugins,
  },
  integrations: [...astroPluginConfig.integrations, mdx(), sitemap(), busuanziIntegration],

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
