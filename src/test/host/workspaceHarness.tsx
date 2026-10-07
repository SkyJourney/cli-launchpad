/**
 * 宿主测试 harness 使用规则（M6 收口规格 HX-6）：
 * 1. 测试文件第一行写 `// @vitest-environment jsdom`。
 * 2. mock 声明必须写在测试文件里（会被提升；下面 <vi> 指 vitest 的 vi 对象）：
 *    <vi>.mock("react-i18next", async () => (await import("../test/host/hostMocks")).reactI18nextMock);
 *    <vi>.mock("sonner", async () => (await import("../test/host/hostMocks")).sonnerMock);
 *    <vi>.mock("./PtyTerminal", async () => (await import("../test/host/hostMocks")).ptyTerminalMock);
 *    路径相对于测试文件，宿主测试与 PtyWorkspace.tsx 同放在 src/components/。
 *    需要真实 i18n 的测试（FE-T08、FE-T09、FE-T36b）不 mock react-i18next，改为 import { i18n } from "../i18n"。
 *    （原文把 <vi> 写作 vi 本身；改写只为让门禁 H4 的 grep 不命中本注释。）
 * 3. afterEach 依次执行 host.dispose()、cleanup()、resetFakeTerminals()、vi.useRealTimers()，
 *    然后 `await flush()`（卸载时的监听注销是异步的），最后
 *    expect(tauriMock.state.eventListeners).toHaveLength(0)（无监听泄漏）。
 *    vitest 2.1 的 sequence.hooks 默认值是 stack，所以测试文件里的 afterEach 先于
 *    setup 文件里的 tauriMock.reset() 执行。
 * 4. fake timers 只在挂载和 launchPty 之后开启：
 *    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })。
 *    不要 fake rAF、queueMicrotask、MessageChannel。
 *    推进时间用 await act(async () => { await vi.advanceTimersByTimeAsync(ms) })。
 * 5. 修改 tauriMock 的 vi.fn 实现时只用 mockImplementationOnce，或在 finally 中恢复原实现
 *    （vi.clearAllMocks 不会还原实现）。
 * 6. 断言文案时用 expect.stringContaining("<i18n key>")。
 * 7. 主窗口和子窗口不能在同一个测试里同时渲染（当前 label 是全局状态）。
 *    跨窗协议的两端用 src/test/host/handoffFixtures.ts 中的金样载荷对齐
 *    （该文件尚未创建，README 总表未分配目标）。
 */
import { Component, StrictMode, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { App } from "../../App";
import {
  PtyWorkspaceProvider,
  PtyWorkspaceRegion,
  usePtyWorkspace,
} from "../../components/PtyWorkspace";
import { StandalonePtyWindow } from "../../components/StandalonePtyWindow";
import { StandaloneWorkspaceFileWindow } from "../../components/StandaloneWorkspaceFileWindow";
import {
  registerWorkspaceContentAdapter,
  type WorkspaceContentAdapter,
} from "../../components/workspaceContentAdapterRegistry";
import { registerBuiltinWorkspaceContentAdapters } from "../../components/workspaceContentAdapters/builtins";
import {
  registerWorkspaceEditorEngine,
  type WorkspaceEditorEngineProps,
} from "../../components/workspaceEditorEngineRegistry";
import type {
  Directory,
  ToolKey,
  WorkspaceLayoutDocument,
  WorkspaceLayoutStateRead,
} from "../../lib/tauri";
import { WorkspaceContentCoordinator } from "../../lib/workspaceContentCoordinator";
import { WORKSPACE_CONTENT_WINDOW_EVENT } from "../../lib/workspaceContentWindowProtocol";
import type { WorkspaceFileBuffer } from "../../lib/workspaceFileBuffer";
import { useAppStore } from "../../store/appStore";
import { tauriMock } from "../tauriMock";
import { installDomPolyfills } from "./domPolyfills";
import type { FakeTerminalHandle } from "./hostMocks";

export type WorkspaceContext = ReturnType<typeof usePtyWorkspace>;

export const DIRECTORY: Directory = {
  id: 1,
  name: "Project",
  path: "C:/project",
  sortOrder: 0,
  pinned: false,
  lastUsedAt: null,
  note: null,
};

export const DEFAULT_FILE_WINDOW_LABEL =
  "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
export const DEFAULT_PTY_WINDOW_LABEL =
  "terminal-8e783338-f464-4b10-b15e-b534748c6241";

export class CapturingBoundary extends Component<
  { errors: unknown[]; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.errors.push(error);
  }
  render() {
    return this.state.failed ? (
      <div role="alert">host crashed</div>
    ) : (
      this.props.children
    );
  }
}

function Probe({ onValue }: { onValue: (value: WorkspaceContext) => void }) {
  onValue(usePtyWorkspace());
  return null;
}

export interface HostBackend {
  layout: WorkspaceLayoutStateRead;
  saved: Array<{ revision: number; layout: WorkspaceLayoutDocument }>;
  files: Map<string, { content: string; revision: string }>;
  handlers: Map<string, (args: any) => unknown>;
}

export function createBackend(
  layout?: Partial<WorkspaceLayoutStateRead>,
): HostBackend {
  return {
    layout: {
      status: { status: "missing" },
      revision: 0,
      schemaVersion: null,
      updatedAtMs: null,
      layout: null,
      slotStates: [],
      ...layout,
    },
    saved: [],
    files: new Map([
      ["a.txt", { content: "hello", revision: "r1" }],
      ["b.txt", { content: "bee", revision: "r1" }],
      ["c.txt", { content: "sea", revision: "r1" }],
    ]),
    handlers: new Map(),
  };
}

export function installBackend(backend: HostBackend) {
  const readFile = (relativePath: string) => {
    const file = backend.files.get(relativePath);
    if (!file) throw { code: "file.not_found", message: "missing" };
    return { kind: "text", ...file };
  };
  const saveFile = (args: { content: string; expectedRevision: string }) => ({
    kind: "saved",
    content: args.content,
    revision: `${args.expectedRevision}+`,
    warning: null,
  });
  tauriMock.setInvokeHandler((command, rawArgs) => {
    const args = rawArgs as any;
    const override = backend.handlers.get(command);
    if (override) return override(args);
    switch (command) {
      case "list_directories":
        return [DIRECTORY];
      case "get_workspace_layout":
        return backend.layout;
      case "save_workspace_layout":
        backend.saved.push({ revision: args.revision, layout: args.layout });
        return { saved: true, revision: args.revision };
      case "open_project_file":
        return readFile(args.relativePath);
      case "save_project_text_file":
        return saveFile(args);
      case "open_granted_file":
        return readFile("a.txt");
      case "save_granted_text_file":
        return saveFile(args);
      case "grant_content_window_file":
      case "revoke_content_window_file":
      case "confirm_app_exit":
        return undefined;
      case "get_pty_session_window_status":
        return "running";
      case "list_workspace_layout_presets":
      case "detect_cli_status":
      case "list_execution_tasks":
        return [];
      default:
        return undefined;
    }
  });
}

export async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * 反复 flush，直到条件成立；超过 maxRounds 轮仍不成立时抛错（带 label）。
 * 比固定轮数的 flush 稳：慢速 CI（例如 Ubuntu runner）上查询、effect 的完成轮数不确定。
 */
export async function flushUntil(
  done: () => boolean,
  label: string,
  maxRounds = 200,
) {
  for (let round = 0; round < maxRounds; round += 1) {
    if (done()) return;
    await flush(1);
  }
  if (!done()) {
    throw new Error(
      `flushUntil: ${label} was not reached after ${maxRounds} rounds`,
    );
  }
}

/** 至少发起过一个查询，并且所有查询都已离开 pending 与 fetching。 */
function queriesSettled(queryClient: QueryClient) {
  const queries = queryClient.getQueryCache().getAll();
  return (
    queries.length > 0 &&
    queries.every(
      (query) =>
        query.state.fetchStatus === "idle" && query.state.status !== "pending",
    )
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

// ---------- 假编辑器引擎与内容 adapter 的注册
let throwOnRender = false;

function FakeEditorView({
  value,
  onChange,
  readOnly,
}: WorkspaceEditorEngineProps) {
  if (throwOnRender) throw new Error("engine exploded");
  return (
    <textarea
      aria-label="editor"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function registerHostContributions(
  adapters: "builtin" | WorkspaceContentAdapter[],
) {
  const unregisterAdapters: Array<() => void> = [];
  if (adapters === "builtin") {
    unregisterAdapters.push(registerBuiltinWorkspaceContentAdapters());
  } else {
    for (const adapter of adapters) {
      unregisterAdapters.push(registerWorkspaceContentAdapter(adapter));
    }
  }
  const releaseDocument = vi.fn();
  const unregisterEngine = registerWorkspaceEditorEngine({
    id: "core.monaco",
    apiVersion: 1,
    releaseDocument,
    View: FakeEditorView,
  });
  return {
    editor: {
      releaseDocument,
      setThrowOnRender(value: boolean) {
        throwOnRender = value;
      },
    },
    unregister() {
      unregisterEngine();
      unregisterAdapters.reverse().forEach((dispose) => dispose());
      throwOnRender = false;
    },
  };
}

function clearLocalStorage() {
  try {
    window.localStorage.clear();
  } catch {
    // jsdom 之外的环境可能没有 localStorage，harness 不依赖它。
  }
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ---------- 挂载
export interface MountWorkspaceOptions {
  backend?: HostBackend;
  adapters?: "builtin" | WorkspaceContentAdapter[];
  coordinator?: WorkspaceContentCoordinator;
  strict?: boolean;
}

export interface WorkspaceHost {
  view: ReturnType<typeof render>;
  ctx: () => WorkspaceContext;
  errors: unknown[];
  backend: HostBackend;
  editor: {
    releaseDocument: ReturnType<typeof vi.fn>;
    setThrowOnRender: (value: boolean) => void;
  };
  coordinator: WorkspaceContentCoordinator | undefined;
  dispose: () => void;
}

export async function mountWorkspace(
  options: MountWorkspaceOptions = {},
): Promise<WorkspaceHost> {
  const backend = options.backend ?? createBackend();
  installBackend(backend);
  const restoreDom = installDomPolyfills();
  const contributions = registerHostContributions(
    options.adapters ?? "builtin",
  );
  useAppStore.setState({
    view: "detail",
    selectedDirectoryId: DIRECTORY.id,
    ptySessionsById: {},
  });
  clearLocalStorage();
  const errors: unknown[] = [];
  const context: { current: WorkspaceContext | null } = { current: null };
  const queryClient = newQueryClient();
  const tree = (
    <QueryClientProvider client={queryClient}>
      <CapturingBoundary errors={errors}>
        <PtyWorkspaceProvider coordinator={options.coordinator}>
          <Probe onValue={(value) => (context.current = value)} />
          <PtyWorkspaceRegion />
        </PtyWorkspaceProvider>
      </CapturingBoundary>
    </QueryClientProvider>
  );
  const view = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  await flush();
  // 项目目录等查询没有返回时，launchSession 会静默返回；先等查询稳定再把宿主交给测试。
  await flushUntil(
    () => queriesSettled(queryClient),
    "workspace queries settled",
  );
  // 查询缓存稳定之后，订阅者的重渲染还要再过几个 tick（notifyManager 与 React 调度），
  // 此时 launchSession 等回调才拿到最新的目录列表。
  await flush();
  let disposed = false;
  return {
    view,
    ctx: () => {
      if (!context.current) throw new Error("workspace context unavailable");
      return context.current;
    },
    errors,
    backend,
    editor: contributions.editor,
    coordinator: options.coordinator,
    dispose() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      contributions.unregister();
      restoreDom();
      queryClient.clear();
    },
  };
}

/** 渲染完整 <App/>，只适用于主窗口退出类测试；文件编辑通过 screen.getByLabelText("editor") 驱动。 */
export async function mountApp(options: { backend?: HostBackend } = {}) {
  const backend = options.backend ?? createBackend();
  installBackend(backend);
  const restoreDom = installDomPolyfills();
  const contributions = registerHostContributions("builtin");
  useAppStore.setState({
    view: "projects",
    selectedDirectoryId: null,
    ptySessionsById: {},
  });
  clearLocalStorage();
  const errors: unknown[] = [];
  const queryClient = newQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CapturingBoundary errors={errors}>
        <App />
      </CapturingBoundary>
    </QueryClientProvider>,
  );
  await flush(10);
  let disposed = false;
  return {
    view,
    errors,
    backend,
    editor: contributions.editor,
    dispose() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      contributions.unregister();
      restoreDom();
      queryClient.clear();
    },
  };
}

export interface MountFileWindowOptions {
  label?: string;
  documentId?: string;
  token?: string;
  sourcePaneId?: string;
  backend?: HostBackend;
}

export async function mountFileWindow(options: MountFileWindowOptions = {}) {
  tauriMock.setCurrentWindowLabel(options.label ?? DEFAULT_FILE_WINDOW_LABEL);
  const backend = options.backend ?? createBackend();
  installBackend(backend);
  const restoreDom = installDomPolyfills();
  const contributions = registerHostContributions("builtin");
  clearLocalStorage();
  const errors: unknown[] = [];
  const queryClient = newQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CapturingBoundary errors={errors}>
        <StandaloneWorkspaceFileWindow
          documentId={options.documentId ?? "doc-1"}
          token={options.token ?? "tok-1"}
          sourcePaneId={options.sourcePaneId ?? "pane-1"}
        />
      </CapturingBoundary>
    </QueryClientProvider>,
  );
  await flush();
  let disposed = false;
  return {
    view,
    errors,
    backend,
    editor: contributions.editor,
    dispose() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      contributions.unregister();
      restoreDom();
      queryClient.clear();
    },
  };
}

export interface MountPtyWindowOptions {
  label?: string;
  sessionId?: string;
  handoffToken?: string;
  instanceId?: string;
  sourcePaneId?: string;
  title?: string;
  toolKey?: ToolKey;
  backend?: HostBackend;
}

export async function mountPtyWindow(options: MountPtyWindowOptions = {}) {
  tauriMock.setCurrentWindowLabel(options.label ?? DEFAULT_PTY_WINDOW_LABEL);
  const backend = options.backend ?? createBackend();
  installBackend(backend);
  const restoreDom = installDomPolyfills();
  const contributions = registerHostContributions("builtin");
  clearLocalStorage();
  const errors: unknown[] = [];
  const queryClient = newQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CapturingBoundary errors={errors}>
        <StandalonePtyWindow
          sessionId={options.sessionId ?? "session-1"}
          handoffToken={options.handoffToken ?? "handoff-1"}
          instanceId={options.instanceId ?? "slot-1"}
          sourcePaneId={options.sourcePaneId ?? "pane-1"}
          title={options.title ?? "Claude"}
          toolKey={options.toolKey}
        />
      </CapturingBoundary>
    </QueryClientProvider>,
  );
  await flush();
  let disposed = false;
  return {
    view,
    errors,
    backend,
    editor: contributions.editor,
    dispose() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      contributions.unregister();
      restoreDom();
      queryClient.clear();
    },
  };
}

// ---------- 事件
export async function emitToWindow(
  label: string,
  type: string,
  payload: unknown,
) {
  await act(async () => {
    tauriMock.emitEvent(
      WORKSPACE_CONTENT_WINDOW_EVENT,
      { apiVersion: 1, type, payload },
      label,
    );
  });
}

export function emitToMain(type: string, payload: unknown) {
  return emitToWindow("main", type, payload);
}

export async function emitBackendEvent(name: string, payload: unknown) {
  await act(async () => {
    tauriMock.emitEvent(name, payload, "main");
  });
}

// ---------- 流程辅助
export function invokes(command: string) {
  return tauriMock.state.invokeCalls.filter((call) => call.command === command);
}

export function savedLayouts(host: Pick<WorkspaceHost, "backend">) {
  return host.backend.saved;
}

export async function openFile(host: WorkspaceHost, path = "a.txt") {
  await act(async () => {
    await host.ctx().openProjectFile(DIRECTORY.id, DIRECTORY.path, path);
  });
  await flush();
  const document = host
    .ctx()
    .fileDocuments.find((candidate) => candidate.relativePath === path);
  if (!document) throw new Error(`openFile: document ${path} was not created`);
  return document;
}

export async function launchPty(host: WorkspaceHost, tool: ToolKey = "claude") {
  await act(async () => {
    host.ctx().launchSession(DIRECTORY.id, tool);
  });
  const runningSlot = () => {
    const slots = host.ctx().slots;
    const last = slots[slots.length - 1];
    return last?.sessionId ? last : undefined;
  };
  await flushUntil(() => {
    const running = runningSlot();
    return Boolean(
      running && host.ctx().terminalRefs.current.get(running.instanceId),
    );
  }, "launchPty: a running slot with a fake terminal handle");
  const slot = runningSlot();
  if (!slot) throw new Error("launchPty: no running slot was created");
  const terminal = host.ctx().terminalRefs.current.get(slot.instanceId);
  if (!terminal)
    throw new Error("launchPty: the fake terminal handle is missing");
  return { slot, terminal: terminal as unknown as FakeTerminalHandle };
}

export async function detachFileToWindow(
  host: WorkspaceHost,
  documentId: string,
) {
  let detachPromise!: Promise<void>;
  await act(async () => {
    detachPromise = host.ctx().detachFile(documentId);
  });
  detachPromise.catch(() => undefined);
  await flush();
  const createdWindows = tauriMock.state.createdWindows;
  const created = createdWindows[createdWindows.length - 1];
  if (!created) throw new Error("detachFileToWindow: no window was created");
  const url = new URL(
    (created.options as { url: string }).url,
    "http://localhost",
  );
  const token = url.searchParams.get("fileHandoffToken");
  if (!token)
    throw new Error("detachFileToWindow: fileHandoffToken is missing");
  const windowLabel = created.label;
  await emitToMain("workspace-file-window-ready", {
    documentId,
    token,
    windowLabel,
  });
  await flush();
  const init = tauriMock.state.emittedEvents.find(
    (event) =>
      event.target === windowLabel &&
      (event.payload as { type?: string }).type ===
        "workspace-file-window-init",
  );
  if (!init) throw new Error("detachFileToWindow: the init event was not sent");
  const initBuffer = (
    init.payload as { payload: { fileBuffer: WorkspaceFileBuffer } }
  ).payload.fileBuffer;
  await emitToMain("workspace-file-window-attached", {
    documentId,
    token,
    windowLabel,
  });
  await flush();
  return { token, windowLabel, initBuffer, detachPromise };
}

export async function detachPtyToWindow(
  host: WorkspaceHost,
  instanceId: string,
) {
  const slot = host
    .ctx()
    .slots.find((candidate) => candidate.instanceId === instanceId);
  if (!slot) {
    throw new Error(`detachPtyToWindow: slot ${instanceId} does not exist`);
  }
  let detachPromise!: Promise<void>;
  await act(async () => {
    detachPromise = host.ctx().detachSession(instanceId);
  });
  detachPromise.catch(() => undefined);
  await flush();
  const createdWindows = tauriMock.state.createdWindows;
  const created = createdWindows[createdWindows.length - 1];
  if (!created) throw new Error("detachPtyToWindow: no window was created");
  const windowLabel = created.label;
  await emitToMain("pty-detached-ready", {
    instanceId,
    sessionId: slot.sessionId,
    windowLabel,
  });
  await flush();
  return { windowLabel, detachPromise };
}
