// Rolling Number Odometer —— 机械滚轮数字翻牌器
// 将多位数字拆分为独立竖列，每列含 0-9 序列，通过 translateY 平滑滚动至目标数字，
// 各列错开 transition-delay 营造机械翻牌效果。

type OdometerOptions = {
  duration?: number;
  stagger?: number;
  startDelay?: number;
};

const DEFAULTS: Required<OdometerOptions> = {
  duration: 1100,
  stagger: 90,
  startDelay: 140,
};

class Odometer {
  private el: HTMLElement;
  private cols: HTMLElement[] = [];
  private ribbons: HTMLElement[] = [];
  private digits: number[] = [];
  private opts: Required<OdometerOptions>;
  private reduced: boolean;

  constructor(el: HTMLElement, opts: OdometerOptions = {}) {
    this.el = el;
    this.opts = { ...DEFAULTS, ...opts };
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build();
  }

  // 列通常由 SSR 预渲染，这里只缓存引用；缺失时按需创建
  private build() {
    this.cols = Array.from(this.el.querySelectorAll<HTMLElement>('.odo-col'));
    this.ribbons = this.cols.map((c) => c.querySelector<HTMLElement>('.odo-ribbon')!);
    this.digits = this.ribbons.map(() => 0);
  }

  private columnCount(): number {
    return this.cols.length;
  }

  // 从 0 滚到目标值（入场动画）
  roll(target: number) {
    const str = String(Math.max(0, Math.floor(target)));
    while (this.columnCount() < str.length) this.appendColumn();
    const padded = str.padStart(this.columnCount(), '0');

    if (this.reduced) {
      this.apply(padded, 0, false);
      return;
    }
    // 先归零（无过渡），再下一帧滚动到目标
    this.apply('0'.repeat(this.columnCount()), 0, false);
    requestAnimationFrame(() => this.apply(padded, this.opts.startDelay, true));
  }

  // 持续更新（如已运行天数进位），仅变动的列平滑滚动
  setValue(target: number) {
    const str = String(Math.max(0, Math.floor(target)));
    while (this.columnCount() < str.length) this.appendColumn();
    const padded = str.padStart(this.columnCount(), '0');
    this.apply(padded, this.opts.startDelay, !this.reduced);
  }

  private apply(code: string, delayBase: number, animate: boolean) {
    const chars = code.split('').map(Number);
    chars.forEach((digit, i) => {
      if (digit === this.digits[i]) return;
      this.digits[i] = digit;
      const ribbon = this.ribbons[i];
      if (!ribbon) return;
      if (animate) {
        ribbon.style.transition = `transform ${this.opts.duration}ms cubic-bezier(0.22, 1, 0.36, 1) ${delayBase + i * this.opts.stagger}ms`;
      } else {
        ribbon.style.transition = 'none';
      }
      ribbon.style.transform = `translateY(${-digit}em)`;
    });
  }

  private appendColumn() {
    const col = document.createElement('span');
    col.className = 'odo-col';
    const ribbon = document.createElement('span');
    ribbon.className = 'odo-ribbon';
    for (let n = 0; n <= 9; n += 1) {
      const d = document.createElement('span');
      d.className = 'odo-digit';
      d.textContent = String(n);
      ribbon.appendChild(d);
    }
    col.appendChild(ribbon);
    this.el.appendChild(col);
    this.cols.push(col);
    this.ribbons.push(ribbon);
    this.digits.push(0);
  }
}

const instances = new WeakMap<HTMLElement, Odometer>();

export function getOdometer(el: HTMLElement): Odometer | undefined {
  return instances.get(el);
}

export function mountOdometers(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-odometer]').forEach((el) => {
    if (instances.has(el)) return;
    const odo = new Odometer(el);
    instances.set(el, odo);
    const value = Number(el.dataset.value ?? '0');
    odo.roll(value);
  });
}

export function mountOdometerOn(el: HTMLElement): Odometer {
  let odo = instances.get(el);
  if (!odo) {
    odo = new Odometer(el);
    instances.set(el, odo);
  }
  return odo;
}
