// Tauri API mock shared by every frontend test (vitest setup file).
//
// 1. Event targets follow real Tauri v2: the global `listen` from
//    `@tauri-apps/api/event` registers an `any` listener that receives every
//    `emitTo(<any label>)` and `emit`; `listen/once/on*` on a window object
//    register a `window` listener that only receives events sent to that
//    window's label.
// 2. Capability (ACL) enforcement is ON by default. Calls are judged against
//    the caller's window kind (`contracts/window-kinds.json` plus the matching
//    `src-tauri/capabilities/*.json`). Only the dedicated case in
//    `tauriMock.test.tsx` may switch it off through `setEnforceCapabilities`
//    (passing false); `reset()` turns it back on. Denied calls are not recorded and do not reach
//    the invoke handler; they are appended to `state.aclViolations`.
// 3. `plugin:` commands are not judged here (plugin permissions are covered by
//    the static contract tests).
import { afterEach, vi } from "vitest";
import windowKindsManifest from "../../contracts/window-kinds.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";
import terminalCapability from "../../src-tauri/capabilities/terminal-window.json";
import workspaceContentCapability from "../../src-tauri/capabilities/workspace-content-window.json";
import { windowKindOf, type WindowKind } from "../lib/windowKinds";

type MockEvent = {
  id: number;
  event: string;
  payload: unknown;
  preventDefault: () => void;
};

type ListenerTarget = { kind: "any" } | { kind: "window"; label: string };

type MockListener = {
  eventName: string;
  target: ListenerTarget;
  callback: (event: MockEvent) => void;
};

const mockState = vi.hoisted(() => ({
  currentWindowLabel: "main",
  invokeCalls: [] as Array<{
    command: string;
    args?: unknown;
    windowLabel: string;
  }>,
  invokeResult: undefined as unknown,
  invokeError: undefined as unknown,
  invokeHandler: undefined as
    | ((command: string, args?: unknown) => unknown)
    | undefined,
  eventListeners: [] as MockListener[],
  emittedEvents: [] as Array<{
    windowLabel: string;
    target: string | null;
    eventName: string;
    payload: unknown;
  }>,
  windowActions: [] as Array<{
    windowLabel: string;
    callerLabel: string;
    action: string;
    args: unknown[];
  }>,
  createdWindows: [] as Array<{ label: string; options: unknown }>,
  channelMessages: [] as unknown[],
  windows: new Map<string, Record<string, unknown>>(),
  nextEventId: 1,
  aclViolations: [] as Array<{
    windowLabel: string;
    api: string;
    required: string;
  }>,
  enforceCapabilities: true,
  listenFailures: new Map<string, unknown[]>(),
}));

// core:default 展开集合。手工同步：src-tauri/gen/schemas/acl-manifests.json 没有入库，
// CI 执行 pnpm test 时读不到它，所以这里硬编码。若升级 Tauri 后 core:default 的内容
// 变化，必须人工核对并同步本集合与 M6-closure-test-spec.md 的 HX-1 说明。
export const CORE_DEFAULT_IMPLIES = [
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "core:event:allow-emit",
  "core:event:allow-emit-to",
  "core:window:allow-is-maximized",
  "core:webview:allow-get-all-webviews",
];

const CAPABILITY_BY_KIND: Record<
  WindowKind,
  { permissions: ReadonlyArray<string | { identifier: string }> }
> = {
  main: defaultCapability,
  terminal: terminalCapability,
  workspaceContent: workspaceContentCapability,
};

const API_PERMISSIONS = {
  setTheme: "core:window:allow-set-theme",
  setFocus: "core:window:allow-set-focus",
  close: "core:window:allow-close",
  destroy: "core:window:allow-destroy",
  minimize: "core:window:allow-minimize",
  toggleMaximize: "core:window:allow-toggle-maximize",
  startDragging: "core:window:allow-start-dragging",
  startResizeDragging: "core:window:allow-start-resize-dragging",
  isMaximized: "core:window:allow-is-maximized",
  listen: "core:event:allow-listen",
  unlisten: "core:event:allow-unlisten",
  emitTo: "core:event:allow-emit-to",
  emit: "core:event:allow-emit",
  createWebviewWindow: "core:webview:allow-create-webview-window",
  getByLabel: "core:webview:allow-get-all-webviews",
} as const;

type AclApi = keyof typeof API_PERMISSIONS;

function isAclApi(name: string): name is AclApi {
  return Object.prototype.hasOwnProperty.call(API_PERMISSIONS, name);
}

function resolveCaller(label = mockState.currentWindowLabel): {
  label: string;
  kind: WindowKind;
} {
  const kind = windowKindOf(label);
  if (kind === null) {
    throw new Error(`tauriMock: unknown window label ${label}`);
  }
  return { label, kind };
}

export function grantedPermissions(kind: WindowKind): Set<string> {
  const granted = new Set<string>();
  for (const permission of CAPABILITY_BY_KIND[kind].permissions) {
    const identifier =
      typeof permission === "string" ? permission : permission.identifier;
    granted.add(identifier);
    if (identifier === "core:default") {
      for (const implied of CORE_DEFAULT_IMPLIES) {
        granted.add(implied);
      }
    }
  }
  return granted;
}

function denyAcl(
  windowLabel: string,
  api: string,
  required: string,
  message: string,
): { code: string; message: string } {
  mockState.aclViolations.push({ windowLabel, api, required });
  return { code: "acl.denied", message };
}

function checkCommand(command: string): void {
  if (!mockState.enforceCapabilities || command.startsWith("plugin:")) {
    return;
  }
  const { label, kind } = resolveCaller();
  const commands = windowKindsManifest.kinds.find(
    (candidate) => candidate.id === kind,
  )?.appCommands;
  if (commands === "all") {
    return;
  }
  if (Array.isArray(commands) && commands.includes(command)) {
    return;
  }
  throw denyAcl(
    label,
    `invoke:${command}`,
    `app-command:${command}`,
    `${command} not allowed for ${label}`,
  );
}

function checkApi(
  api: AclApi,
  callerLabel: string = mockState.currentWindowLabel,
): void {
  if (!mockState.enforceCapabilities) {
    return;
  }
  const { label, kind } = resolveCaller(callerLabel);
  if (!grantedPermissions(kind).has(API_PERMISSIONS[api])) {
    throw denyAcl(
      label,
      api,
      API_PERMISSIONS[api],
      `${api} not allowed for ${label}`,
    );
  }
}

function registerListener(
  eventName: string,
  target: ListenerTarget,
  callerLabel: string,
  callback: (event: MockEvent) => void,
): () => void {
  const listener = { eventName, target, callback };
  mockState.eventListeners.push(listener);
  return () => {
    // 违规时抛出且不移除监听，保留泄漏的可见性。
    checkApi("unlisten", callerLabel);
    const index = mockState.eventListeners.indexOf(listener);
    if (index >= 0) {
      mockState.eventListeners.splice(index, 1);
    }
  };
}

async function addListener(
  eventName: string,
  target: ListenerTarget,
  callback: (event: MockEvent) => void,
): Promise<() => void> {
  checkApi("listen");
  const failures = mockState.listenFailures.get(eventName);
  if (failures && failures.length > 0) {
    const failure = failures.shift();
    if (failures.length === 0) {
      mockState.listenFailures.delete(eventName);
    }
    throw failure;
  }
  return registerListener(
    eventName,
    target,
    mockState.currentWindowLabel,
    callback,
  );
}

function createEvent(eventName: string, payload: unknown): MockEvent {
  return {
    id: mockState.nextEventId++,
    event: eventName,
    payload,
    preventDefault: vi.fn(),
  };
}

function dispatchEvent(
  eventName: string,
  payload: unknown,
  targetLabel: string | null,
): void {
  const event = createEvent(eventName, payload);
  const listeners = [...mockState.eventListeners].filter(
    (listener) =>
      listener.eventName === eventName &&
      (targetLabel === null ||
        listener.target.kind === "any" ||
        (listener.target.kind === "window" &&
          listener.target.label === targetLabel)),
  );
  for (const listener of listeners) {
    listener.callback(event);
  }
}

function dispatchToWindowListeners(
  eventName: string,
  payload: unknown,
  label: string,
): void {
  const event = createEvent(eventName, payload);
  const listeners = [...mockState.eventListeners].filter(
    (listener) =>
      listener.eventName === eventName &&
      listener.target.kind === "window" &&
      listener.target.label === label,
  );
  for (const listener of listeners) {
    listener.callback(event);
  }
}

function getWindowMock(label: string): Record<string, unknown> {
  const existing = mockState.windows.get(label);
  if (existing) {
    return existing;
  }

  const action = async (name: string, ...args: unknown[]) => {
    if (isAclApi(name)) {
      checkApi(name);
    }
    mockState.windowActions.push({
      windowLabel: label,
      callerLabel: mockState.currentWindowLabel,
      action: name,
      args,
    });
    return undefined;
  };
  const listen = async (
    eventName: string,
    callback: (event: MockEvent) => void,
  ) => addListener(eventName, { kind: "window", label }, callback);
  const once = async (
    eventName: string,
    callback: (event: MockEvent) => void,
  ) => {
    let unlisten: (() => void) | undefined;
    unlisten = await addListener(
      eventName,
      { kind: "window", label },
      (event) => {
        callback(event);
        unlisten?.();
      },
    );
    return unlisten;
  };
  const windowMock: Record<string, unknown> = {
    label,
    close: vi.fn(() => action("close")),
    destroy: vi.fn(() => action("destroy")),
    hide: vi.fn(() => action("hide")),
    show: vi.fn(() => action("show")),
    setFocus: vi.fn(() => action("setFocus")),
    setTheme: vi.fn((theme: unknown) => action("setTheme", theme)),
    minimize: vi.fn(() => action("minimize")),
    toggleMaximize: vi.fn(() => action("toggleMaximize")),
    startDragging: vi.fn(() => action("startDragging")),
    startResizeDragging: vi.fn((direction: unknown) =>
      action("startResizeDragging", direction),
    ),
    isMaximized: vi.fn(async () => {
      checkApi("isMaximized");
      return false;
    }),
    listen: vi.fn(listen),
    once: vi.fn(once),
    onResized: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://resize", callback),
    ),
    onMoved: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://move", callback),
    ),
    onCloseRequested: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://close-requested", callback),
    ),
    onThemeChanged: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://theme-changed", callback),
    ),
    onFocusChanged: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://focus", callback),
    ),
    onMaximizedChange: vi.fn((callback: (event: MockEvent) => void) =>
      listen("tauri://scale-change", callback),
    ),
  };
  mockState.windows.set(label, windowMock);
  return windowMock;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    checkCommand(command);
    mockState.invokeCalls.push({
      command,
      args,
      windowLabel: mockState.currentWindowLabel,
    });
    if (mockState.invokeError !== undefined) {
      throw mockState.invokeError;
    }
    if (mockState.invokeHandler) {
      return mockState.invokeHandler(command, args);
    }
    return mockState.invokeResult;
  }),
  Channel: class MockChannel<T = unknown> {
    onmessage: ((message: T) => void) | null = null;

    send(message: T): void {
      mockState.channelMessages.push(message);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (eventName: string, callback: (event: MockEvent) => void) =>
      addListener(eventName, { kind: "any" }, callback),
  ),
  emit: vi.fn(async (eventName: string, payload?: unknown) => {
    checkApi("emit");
    mockState.emittedEvents.push({
      windowLabel: mockState.currentWindowLabel,
      target: null,
      eventName,
      payload,
    });
    dispatchEvent(eventName, payload, null);
  }),
  emitTo: vi.fn(
    async (target: string, eventName: string, payload?: unknown) => {
      checkApi("emitTo");
      mockState.emittedEvents.push({
        windowLabel: mockState.currentWindowLabel,
        target,
        eventName,
        payload,
      });
      dispatchEvent(eventName, payload, target);
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => getWindowMock(mockState.currentWindowLabel)),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() =>
    getWindowMock(mockState.currentWindowLabel),
  ),
  WebviewWindow: class MockWebviewWindow {
    label: string;

    constructor(label: string, options: unknown) {
      checkApi("createWebviewWindow");
      this.label = label;
      mockState.createdWindows.push({ label, options });
      Object.assign(this, getWindowMock(label));
    }

    static async getByLabel(label: string): Promise<unknown> {
      checkApi("getByLabel");
      return mockState.windows.get(label) ?? null;
    }
  },
}));

export const tauriMock = {
  state: mockState,
  setCurrentWindowLabel(label: string): void {
    mockState.currentWindowLabel = label;
  },
  setInvokeResult(result: unknown): void {
    mockState.invokeResult = result;
  },
  setInvokeError(error: unknown): void {
    mockState.invokeError = error;
  },
  setInvokeHandler(
    handler: (command: string, args?: unknown) => unknown,
  ): void {
    mockState.invokeHandler = handler;
  },
  setEnforceCapabilities(enabled: boolean): void {
    mockState.enforceCapabilities = enabled;
  },
  failNextListen(eventName: string, error: unknown): void {
    const queue = mockState.listenFailures.get(eventName);
    if (queue) {
      queue.push(error);
    } else {
      mockState.listenFailures.set(eventName, [error]);
    }
  },
  destroyWindow(label: string): void {
    // 不移除该窗口已注册的监听：泄漏要保持可见，由宿主测试的 eventListeners 空检查发现。
    dispatchToWindowListeners("tauri://destroyed", null, label);
    mockState.windows.delete(label);
  },
  getWindow(label: string): Record<string, unknown> {
    return getWindowMock(label);
  },
  emitEvent(
    eventName: string,
    payload: unknown,
    targetLabel: string | null = null,
  ): void {
    // 模拟 Rust 或其他窗口发来的事件，不属于被测窗口的权限。
    dispatchEvent(eventName, payload, targetLabel);
  },
  reset(): void {
    mockState.currentWindowLabel = "main";
    mockState.invokeCalls.length = 0;
    mockState.invokeResult = undefined;
    mockState.invokeError = undefined;
    mockState.invokeHandler = undefined;
    mockState.eventListeners.length = 0;
    mockState.emittedEvents.length = 0;
    mockState.windowActions.length = 0;
    mockState.createdWindows.length = 0;
    mockState.channelMessages.length = 0;
    mockState.windows.clear();
    mockState.nextEventId = 1;
    mockState.aclViolations.length = 0;
    mockState.enforceCapabilities = true;
    mockState.listenFailures.clear();
  },
};

afterEach(() => {
  tauriMock.reset();
  vi.clearAllMocks();
});
