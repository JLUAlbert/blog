// Blur In —— 元素进入视口时透明度 0→1、高斯模糊→清晰（配合 .blur-in 类）。
// 仅作渐进增强：无 IntersectionObserver 时直接全部显现；无 JS 时由全局
// `html.js` 门控保证内容默认可见（无障碍 / SEO 安全）。

let observer: IntersectionObserver | null = null;
let bound = false;

function revealAll(root: ParentNode) {
  root
    .querySelectorAll<HTMLElement>('.blur-in:not(.is-revealed)')
    .forEach((el) => el.classList.add('is-revealed'));
}

export function initBlurIn(root: ParentNode = document) {
  const targets = root.querySelectorAll<HTMLElement>('.blur-in:not(.is-revealed)');
  if (targets.length === 0) return;

  if (typeof IntersectionObserver === 'undefined') {
    revealAll(root);
    return;
  }

  if (observer) observer.disconnect();

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          (entry.target as HTMLElement).classList.add('is-revealed');
          observer?.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.08 },
  );

  targets.forEach((el) => observer!.observe(el));

  // 兜底：1.6s 后强制显现已进入视口的项，避免测算异常导致永久隐藏
  window.setTimeout(() => {
    root.querySelectorAll<HTMLElement>('.blur-in:not(.is-revealed)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('is-revealed');
    });
  }, 1600);
}

function ensureBound() {
  if (bound) return;
  bound = true;
  document.addEventListener('astro:page-load', () => initBlurIn());
}

ensureBound();
initBlurIn();
