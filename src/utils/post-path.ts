import type { CollectionEntry } from 'astro:content';

/**
 * 文章 URL 规则
 * ------------------------------------------------------------
 * 默认：/blog/<发布日期 YYYY-MM-DD>/
 * 例外：frontmatter 显式写了 `slug` 字段，则使用该值（可含中文/英文短名）
 *
 * URL 与文件名解耦——文件名只用于内容管理，链接一律走这里，
 * 保证列表、归档、RSS、搜索、上一篇/下一篇的口径完全一致。
 */

type PostLike = {
  id: string;
  data: {
    date: Date | string;
    slug?: string;
  };
};

const SLUG_PAD = (n: number) => String(n).padStart(2, '0');

/** 发布日期（按北京时间取日，避免晚间发布跨到 UTC 前一天） */
export function getPostDateSlug(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.valueOf())) return '';
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${cn.getUTCFullYear()}-${SLUG_PAD(cn.getUTCMonth() + 1)}-${SLUG_PAD(cn.getUTCDate())}`;
}

/** 归一化显式 slug：去首尾斜杠与空白，空白转连字符 */
export function normalizeSlug(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-');
}

/** 文章 URL 段：显式 slug 优先，否则日期 */
export function getPostSlug(post: PostLike): string {
  const custom = normalizeSlug(post.data.slug ?? '');
  if (custom) return custom;
  return getPostDateSlug(post.data.date) || post.id;
}

/** 站内路径（不带 basePath），形如 /blog/2023-11-17/ */
export function getPostPath(post: PostLike): string {
  return `/blog/${getPostSlug(post)}/`;
}

/** 构建期校验：同一 slug 出现了多篇时给出可执行的报错 */
export function assertUniquePostSlugs(posts: Pick<PostLike, 'id' | 'data'>[]): void {
  const seen = new Map<string, string[]>();

  for (const post of posts) {
    const slug = getPostSlug(post);
    seen.set(slug, [...(seen.get(slug) ?? []), post.id]);
  }

  const conflicts = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  if (conflicts.length === 0) return;

  const detail = conflicts
    .map(([slug, ids]) => `  /blog/${slug}/  ←  ${ids.join(', ')}`)
    .join('\n');

  throw new Error(
    `文章 URL 冲突：以下文章生成了相同的地址。给其中一篇的 frontmatter 加 slug 字段即可解决。\n${detail}`,
  );
}

export type BlogPostWithPath = CollectionEntry<'blog'> & { postSlug: string };
