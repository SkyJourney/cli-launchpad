import { act } from "@testing-library/react";

type ResizeCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

export class FakeResizeObserver {
  static instances = new Set<FakeResizeObserver>();
  observed = new Set<Element>();

  constructor(private readonly callback: ResizeCallback) {
    FakeResizeObserver.instances.add(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    FakeResizeObserver.instances.delete(this);
  }

  /** 只对仍在 observed 中的 target 回调；调用前包 act。 */
  trigger(targets?: Element[]) {
    const pending = (targets ?? [...this.observed]).filter((target) =>
      this.observed.has(target),
    );
    if (pending.length === 0) return;
    act(() => {
      this.callback(
        pending.map(
          (target) =>
            ({
              target,
              contentRect: target.getBoundingClientRect(),
            }) as unknown as ResizeObserverEntry,
        ),
        this as unknown as ResizeObserver,
      );
    });
  }
}

/** 安装 ResizeObserver 与 matchMedia 的假实现，返回恢复函数。 */
export function installDomPolyfills(): () => void {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalMatchMedia = window.matchMedia;
  FakeResizeObserver.instances.clear();
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    globalThis.ResizeObserver = originalResizeObserver;
    window.matchMedia = originalMatchMedia;
  };
}

export interface GeometryOptions {
  stripWidth: number;
  widthOf: (text: string) => number;
}

export const geometry = {
  /**
   * 给 jsdom 补几何：带 pty-pane-tabs 类名的元素 clientWidth 为 stripWidth，
   * 带 data-workspace-content-key 的元素宽度为 widthOf(textContent)。
   */
  install({ stripWidth, widthOf }: GeometryOptions) {
    let currentStripWidth = stripWidth;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains("pty-pane-tabs")
          ? currentStripWidth
          : 0;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute("data-workspace-content-key")) {
        const width = widthOf(this.textContent ?? "");
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          width,
          height: 0,
          toJSON() {},
        } as DOMRect;
      }
      return originalRect.call(this);
    };
    return {
      restore() {
        delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
        HTMLElement.prototype.getBoundingClientRect = originalRect;
      },
      setStripWidth(next: number) {
        currentStripWidth = next;
      },
    };
  },
};
