// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../test/host/hostMocks")).reactI18nextMock,
);
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);
vi.mock(
  "./PtyTerminal",
  async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
);

import { tauriMock } from "../test/tauriMock";
import { resetFakeTerminals } from "../test/host/hostMocks";
import { FakeResizeObserver, geometry } from "../test/host/domPolyfills";
import {
  DIRECTORY,
  flush,
  launchPty,
  mountWorkspace,
  openFile,
  type WorkspaceHost,
} from "../test/host/workspaceHarness";
import { WorkspaceContentCoordinator } from "../lib/workspaceContentCoordinator";
import { qk } from "../lib/queryKeys";

let host: WorkspaceHost | undefined;
let installed: ReturnType<typeof geometry.install> | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;

afterEach(async () => {
  host?.dispose();
  host = undefined;
  installed?.restore();
  installed = undefined;
  if (originalResizeObserver)
    globalThis.ResizeObserver = originalResizeObserver;
  originalResizeObserver = undefined;
  FakeResizeObserver.instances.clear();
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function installObservers() {
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
}

function liveObservers() {
  return [...FakeResizeObserver.instances];
}

function renderedTabKeys() {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-workspace-content-key]"),
  ]
    .map((element) => element.dataset.workspaceContentKey ?? "")
    .filter(Boolean);
}

function unobservedRenderedKeys() {
  const observed = new Set<Element>();
  for (const observer of liveObservers()) {
    for (const element of observer.observed) observed.add(element);
  }
  return [
    ...document.querySelectorAll<HTMLElement>("[data-workspace-content-key]"),
  ]
    .filter((element) => !observed.has(element))
    .map((element) => element.dataset.workspaceContentKey ?? "");
}

function triggerAll() {
  for (const observer of liveObservers()) observer.trigger();
}

function overflowButton() {
  return document.querySelector<HTMLButtonElement>(
    '[aria-label*="pty.overflowContents"]',
  );
}

describe("tab overflow measurement", () => {
  it("observes every rendered tab element after a partition change remounts it", async () => {
    installObservers();
    installed = geometry.install({
      stripWidth: 400,
      widthOf: (text) => 10 * (text?.length ?? 0),
    });
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    await openFile(host, "a.txt");
    await openFile(host, "b.txt");
    await openFile(host, "c.txt");
    triggerAll();

    act(() => {
      installed?.setStripWidth(60);
    });
    triggerAll();
    await flush();

    expect(renderedTabKeys().length).toBeGreaterThan(0);
    expect(overflowButton()).not.toBeNull();
    // 反向：没有任何已渲染的标签元素未被存活的观察器观察。
    expect(unobservedRenderedKeys()).toEqual([]);
  });

  it("creates the tab resize observer once and keeps it across re-renders", async () => {
    // 每次构造 FakeResizeObserver 都会调用 instances.add；监视它即可计数构造次数，
    // 不依赖全局 ResizeObserver 的替换时序（挂载时 installDomPolyfills 会重新安装）。
    installed = geometry.install({
      stripWidth: 400,
      widthOf: (text) => 10 * (text?.length ?? 0),
    });
    const addSpy = vi.spyOn(FakeResizeObserver.instances, "add");
    try {
      host = await mountWorkspace({
        coordinator: new WorkspaceContentCoordinator(),
      });
      await openFile(host, "a.txt");
      await flush();
      const afterFirstRender = addSpy.mock.calls.length;
      // 反向：挂载后至少构造过一个观察器，否则计数无意义。
      expect(afterFirstRender).toBeGreaterThan(0);

      await openFile(host, "b.txt");
      await openFile(host, "c.txt");
      await flush();
      expect(addSpy.mock.calls.length).toBe(afterFirstRender);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("re-partitions when an observed tab's title width changes", async () => {
    installObservers();
    installed = geometry.install({
      stripWidth: 400,
      widthOf: (text) => 10 * (text?.length ?? 0),
    });
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    await openFile(host, "a.txt");
    await openFile(host, "b.txt");
    await openFile(host, "c.txt");
    triggerAll();

    // 1) 宽度收窄：分区必须重算，溢出入口出现。
    act(() => {
      installed?.setStripWidth(60);
    });
    triggerAll();
    await flush();
    expect(overflowButton()).not.toBeNull();

    // 2) 宽度放宽：三个文件可以全部放下，溢出入口消失。
    act(() => {
      installed?.setStripWidth(400);
    });
    triggerAll();
    await flush();
    expect(overflowButton()).toBeNull();

    // 3) 标题变宽：PTY 标签的实测宽度增大，分区随之重算，溢出入口重新出现。
    const { slot } = await launchPty(host);
    await flush();
    const ptyKey = `pty:${slot.instanceId}`;
    const ptyElement = document.querySelector<HTMLElement>(
      `[data-workspace-content-key="${ptyKey}"]`,
    );
    if (!ptyElement) throw new Error("PTY tab is not rendered");
    const widthBefore = ptyElement.getBoundingClientRect().width;
    host.queryClient.setQueryData(qk.directories(), [
      { ...DIRECTORY, name: "Renamed project with a much longer name" },
    ]);
    await flush();
    const observers = liveObservers().filter((observer) =>
      observer.observed.has(ptyElement),
    );
    // 反向：PTY 标签必须已被存活的观察器观察，否则下面的触发无意义。
    expect(observers.length).toBeGreaterThan(0);
    for (const observer of observers) observer.trigger([ptyElement]);
    await flush();

    expect(ptyElement.getBoundingClientRect().width).toBeGreaterThan(
      widthBefore,
    );
    expect(overflowButton()).not.toBeNull();
    // 反向：没有任何已渲染的标签元素未被观察。
    expect(unobservedRenderedKeys()).toEqual([]);
  });
});

describe("overflow stack", () => {
  function stackList() {
    const list = document.querySelector<HTMLElement>(
      ".pty-pane-session-stack-list",
    );
    if (!list) throw new Error("overflow stack list is not rendered");
    return list;
  }
  function stackItems() {
    return [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".pty-pane-session-stack-session",
      ),
    ];
  }
  async function openStack() {
    if (document.querySelector(".pty-pane-session-stack-list")) return;
    await act(async () => {
      fireEvent.click(overflowButton()!);
    });
    await flush();
  }

  it("activates, closes and opens menus for PTY and file entries from the keyboard", async () => {
    host = await mountWorkspace({
      coordinator: new WorkspaceContentCoordinator(),
    });
    await openFile(host, "a.txt");
    await openFile(host, "b.txt");
    await launchPty(host);
    await flush();

    // 1) 打开堆叠列表。
    await openStack();

    // 2) 方向键把焦点移到第二项。
    act(() => {
      fireEvent.keyDown(stackList(), { key: "ArrowDown" });
    });
    expect(document.activeElement?.getAttribute("data-stack-index")).toBe("1");

    // 3) 激活当前焦点项（jsdom 中用 click 模拟回车激活按钮）。
    const focused = document.activeElement as HTMLElement;
    await act(async () => {
      fireEvent.click(focused);
    });
    await flush();
    expect(host.ctx().focusedPaneId).toBeTruthy();

    // 4) 对第一项按 Delete：关闭干净的 a.txt，不影响未聚焦的 b.txt。
    await openStack();
    await act(async () => {
      fireEvent.focus(stackItems()[0]);
    });
    await act(async () => {
      fireEvent.keyDown(stackItems()[0], { key: "Delete" });
    });
    await flush();
    const paths = host.ctx().fileDocuments.map((d) => d.relativePath);
    expect(paths).not.toContain("a.txt");
    expect(paths).toContain("b.txt");

    // 5) 右键某一项打开菜单，菜单包含该项标题。
    await openStack();
    const remaining = stackItems();
    expect(remaining.length).toBeGreaterThan(0);
    const rightTitle = remaining[0].getAttribute("title") ?? "";
    await act(async () => {
      fireEvent.contextMenu(remaining[0]);
    });
    await flush();
    expect(screen.getByRole("menu").textContent).toContain(rightTitle);
    expect(host.errors).toEqual([]);
  });
});
