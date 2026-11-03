// Vibe 流光光柱：在 .vibe-thread 曲线之上叠加一道带高斯模糊和色彩渐变的光柱，
// 沿曲线匀速行进；光柱行经到某节点，对应 vibe 即模糊进入显现。
// 仅作用于 .vibe-stream 页面（vibe 页），无该节点或降低动态效果时安全退出。

const PALETTE = ['#7c9a6b', '#d98a8a', '#9a7cc4', '#5b9bd5', '#e0a85b'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const CYCLE = 5200; // 单程行进周期（ms）

let bound = false;
let resizeHandler: (() => void) | null = null;
let waitFrames = 0;

function teardown() {
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  const stream = document.querySelector<HTMLElement>('.vibe-stream');
  stream?.querySelector('.vibe-beam')?.remove();
  stream?.classList.remove('vibe-beam-active');
}

function showAllItems(stream: HTMLElement) {
  stream.querySelectorAll<HTMLElement>('[data-vibe-item]').forEach((el) => {
    el.style.opacity = '1';
    el.style.filter = 'none';
  });
}

function initVibeBeam() {
  const stream = document.querySelector<HTMLElement>('.vibe-stream');
  if (!stream || stream.dataset.vibeBeamBound === 'true') return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    showAllItems(stream);
    return;
  }

  const thread = stream.querySelector<SVGSVGElement>('.vibe-thread');
  const sourcePath = thread?.querySelector<SVGPathElement>('[data-vibe-thread-path]');
  if (!thread || !sourcePath) {
    requestAnimationFrame(initVibeBeam);
    return;
  }
  const d0 = sourcePath.getAttribute('d');
  if (!d0) {
    waitFrames += 1;
    if (waitFrames > 120) {
      showAllItems(stream);
      return;
    }
    requestAnimationFrame(initVibeBeam);
    return;
  }
  waitFrames = 0;

  stream.dataset.vibeBeamBound = 'true';
  stream.classList.add('vibe-beam-active');

  const viewBox = thread.getAttribute('viewBox') || '0 0 100 100';

  const beamSvg = document.createElementNS(SVG_NS, 'svg');
  beamSvg.setAttribute('class', 'vibe-beam');
  beamSvg.setAttribute('aria-hidden', 'true');
  beamSvg.setAttribute('viewBox', viewBox);
  beamSvg.setAttribute('preserveAspectRatio', 'none');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const gradId = 'vibe-beam-gradient';
  defs.innerHTML =
    `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${PALETTE[0]}" stop-opacity="0"/>` +
    `<stop offset="42%" stop-color="${PALETTE[1]}" stop-opacity="0.95"/>` +
    `<stop offset="70%" stop-color="${PALETTE[2]}" stop-opacity="0.95"/>` +
    `<stop offset="100%" stop-color="${PALETTE[3]}" stop-opacity="0"/>` +
    `</linearGradient>`;
  beamSvg.appendChild(defs);

  const beamPath = document.createElementNS(SVG_NS, 'path');
  beamPath.setAttribute('class', 'vibe-beam-path');
  beamPath.setAttribute('stroke', `url(#${gradId})`);
  const corePath = document.createElementNS(SVG_NS, 'path');
  corePath.setAttribute('class', 'vibe-beam-core');
  corePath.setAttribute('stroke', PALETTE[4]);
  beamSvg.appendChild(beamPath);
  beamSvg.appendChild(corePath);
  stream.appendChild(beamSvg);

  type Mark = { item: HTMLElement; len: number; revealed: boolean };
  let marks: Mark[] = [];
  let total = 0;
  let beamLen = 0;
  let animPath: Animation | null = null;
  let animCore: Animation | null = null;
  let raf = 0;
  let startTs = 0;

  // 根据当前 thread 路径同步光柱几何与每个 vibe 节点在路径上的长度位置
  const build = (): boolean => {
    const dd = sourcePath!.getAttribute('d');
    if (!dd) return false;
    beamPath.setAttribute('d', dd);
    corePath.setAttribute('d', dd);
    total = beamPath.getTotalLength();
    beamLen = Math.max(64, total * 0.16);
    const dash = `${beamLen} ${total - beamLen}`;
    beamPath.style.strokeDasharray = dash;
    corePath.style.strokeDasharray = dash;

    // 采样路径点，建立（坐标 → 长度）映射，用于把 dot 精确定位到路径长度
    const samples = 260;
    const pts: { x: number; y: number; len: number }[] = [];
    for (let i = 0; i <= samples; i += 1) {
      const len = (i / samples) * total;
      const p = beamPath.getPointAtLength(len);
      pts.push({ x: p.x, y: p.y, len });
    }

    const sb = stream!.getBoundingClientRect();
    const items = Array.from(stream!.querySelectorAll<HTMLElement>('[data-vibe-item]')).filter(
      (el) => !el.classList.contains('is-vibe-hidden'),
    );

    marks = items.map<Mark>((item) => {
      const dot = item.querySelector<HTMLElement>('[data-vibe-dot]');
      let len = total;
      if (dot) {
        const db = dot.getBoundingClientRect();
        const dx = db.left + db.width / 2 - sb.left;
        const dy = db.top + db.height / 2 - sb.top + 28; // 与 getDotPositions 一致
        let best = total;
        let bestD = Infinity;
        for (const s of pts) {
          const dd2 = (s.x - dx) ** 2 + (s.y - dy) ** 2;
          if (dd2 < bestD) {
            bestD = dd2;
            best = s.len;
          }
        }
        len = best;
      }
      const already = item.classList.contains('is-revealed-by-beam');
      if (already) item.classList.remove('vibe-pending-beam');
      else item.classList.add('vibe-pending-beam');
      return { item, len, revealed: already };
    });
    marks.sort((a, b) => a.len - b.len);
    return true;
  };

  // 光柱头部行经到某长度时，揭示对应节点
  const revealUpTo = (head: number) => {
    for (const m of marks) {
      if (!m.revealed && m.len <= head) {
        m.revealed = true;
        m.item.classList.remove('vibe-pending-beam');
        m.item.classList.add('is-revealed-by-beam');
      }
    }
  };

  const frames = [{ strokeDashoffset: 0 }, { strokeDashoffset: -total }];

  const loop = (now: number) => {
    const p = ((now - startTs) % CYCLE) / CYCLE;
    revealUpTo(p * total);
    raf = requestAnimationFrame(loop);
  };

  if (!build()) {
    showAllItems(stream);
    stream.classList.remove('vibe-beam-active');
    return;
  }

  animPath = beamPath.animate(frames, {
    duration: CYCLE,
    iterations: Infinity,
    easing: 'linear',
  });
  animCore = corePath.animate(frames, {
    duration: CYCLE,
    iterations: Infinity,
    easing: 'linear',
  });
  beamSvg.classList.add('is-running');
  startTs = performance.now();
  raf = requestAnimationFrame(loop);

  // 视口 / 布局变化（含 progressive stream 揭示更多项时触发的 resize）时重建几何
  let resizeTimer = 0;
  resizeHandler = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const head = (((performance.now() - startTs) % CYCLE) / CYCLE) * total;
      cancelAnimationFrame(raf);
      animPath?.cancel();
      animCore?.cancel();
      if (build()) {
        animPath = beamPath.animate(frames, {
          duration: CYCLE,
          iterations: Infinity,
          easing: 'linear',
        });
        animCore = corePath.animate(frames, {
          duration: CYCLE,
          iterations: Infinity,
          easing: 'linear',
        });
        const phase = (performance.now() - startTs) % CYCLE;
        animPath.currentTime = phase;
        animCore.currentTime = phase;
        revealUpTo(head);
        startTs = performance.now() - phase;
        raf = requestAnimationFrame(loop);
      }
    }, 220);
  };
  window.addEventListener('resize', resizeHandler);
}

function ensureBound() {
  if (bound) return;
  bound = true;
  document.addEventListener('astro:page-load', initVibeBeam);
  document.addEventListener('astro:before-swap', teardown);
}

ensureBound();
initVibeBeam();
