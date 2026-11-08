/**
 * 页面切换方向 + 外链纸页转场。
 * 由 astro.config.mjs 的 motionEnhancementIntegration 注入到所有页面（含主题生成的 vibe 页）。
 * ClientRouter 下模块脚本只执行一次，因此所有监听只绑定一次并加幂等守卫。
 */

const DIRECTION_ATTR = 'data-nav-dir';
const SHEET_DURATION = 760;

type NavDirection = 'up' | 'right' | 'left';

interface PageSheetHost extends Window {
  __pageSheetNavBound?: boolean;
}

const host = window as PageSheetHost;
if (!host.__pageSheetNavBound) {
  host.__pageSheetNavBound = true;
  install();
}

function install() {
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // swapRootAttributes 会清空 <html> 上所有非 Astro 属性（只保留 data-astro-transition*），
  // 所以方向要存一份内存态，在 astro:after-swap（View Transition 动画开始前）恢复。
  let pendingDirection: NavDirection = 'up';
  const setDirection = (direction: NavDirection) => {
    pendingDirection = direction;
    document.documentElement.setAttribute(DIRECTION_ATTR, direction);
  };

  // 导航栏顺序：Home → Blog → Vibe → Movies。点右侧项向右进，点左侧项向左进。
  const directionForNavClick = (anchor: HTMLAnchorElement): NavDirection => {
    if (anchor.classList.contains('brand')) return 'left';

    const selector = anchor.matches('.mobile-menu-link')
      ? 'a.mobile-menu-link'
      : '.nav-links a.nav-link';
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
    const current = links.findIndex((link) => link.classList.contains('active'));
    const target = links.indexOf(anchor);
    if (current === -1 || target === -1 || target === current) return 'up';
    return target > current ? 'right' : 'left';
  };

  const isExternal = (anchor: HTMLAnchorElement): boolean => {
    const raw = anchor.getAttribute('href') ?? '';
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return false;
    if (/^(mailto|tel):/i.test(raw)) return true;
    if (anchor.hasAttribute('download') || anchor.target === '_blank') return true;
    try {
      return new URL(anchor.href, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };

  const openSheet = (anchor: HTMLAnchorElement) => {
    const href = anchor.href;
    const raw = anchor.getAttribute('href') ?? '';
    const isMail = /^(mailto|tel):/i.test(raw);
    const newTab = anchor.target === '_blank' && !isMail;

    // 空白标签必须在用户手势内打开，否则 760ms 后的 window.open 会被弹窗拦截。
    const win = newTab ? window.open('', '_blank') : null;
    if (win) {
      try {
        win.opener = null;
      } catch {
        // 部分浏览器不允许改写 opener，忽略即可。
      }
    }

    const sheet = document.createElement('div');
    sheet.className = 'page-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML = '<div class="page-sheet-inner"><span class="page-sheet-mark"></span></div>';
    document.body.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add('is-open'));

    const dismiss = () => {
      sheet.classList.remove('is-open');
      window.setTimeout(() => sheet.remove(), SHEET_DURATION);
    };

    window.setTimeout(() => {
      if (win) {
        try {
          win.location.href = href;
        } catch {
          win.close();
          window.open(href, '_blank', 'noopener,noreferrer');
        }
        dismiss();
        return;
      }
      if (isMail) {
        window.location.href = href;
        dismiss();
        return;
      }
      // 同窗口跳转（或新标签被拦截时退化），页面即将卸载，纸页留在原地。
      window.location.assign(href);
    }, SHEET_DURATION);
  };

  document.addEventListener(
    'click',
    (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('data-no-sheet')) return;

      if (isExternal(anchor)) {
        if (reducedMotion()) return;
        event.preventDefault();
        openSheet(anchor);
        return;
      }

      if (anchor.matches('.nav-link, .mobile-menu-link, .brand')) {
        setDirection(directionForNavClick(anchor));
        return;
      }

      // 主页导航卡、最新文章等站内链接：与 About 面板一致，从下往上。
      setDirection('up');
    },
    true,
  );

  // 浏览器前进 / 后退按历史方向走左右，与导航栏的方向观感保持一致。
  document.addEventListener('astro:before-preparation', ((event: Event) => {
    const detail = event as Event & { direction?: string; navigationType?: string };
    if (detail.navigationType === 'traverse') {
      setDirection(detail.direction === 'back' ? 'left' : 'right');
    }
  }) as EventListener);

  // head/根属性交换完成后、View Transition 动画开始前恢复方向标记。
  document.addEventListener('astro:after-swap', () => {
    document.documentElement.setAttribute(DIRECTION_ATTR, pendingDirection);
  });
}
