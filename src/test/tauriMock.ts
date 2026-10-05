import { afterEach, vi } from "vitest";

type MockEvent = {
  id: number;
  event: string;
  payload: unknown;
};

type MockListener = {
  eventName: string;
  ownerLabel: string;
  callback: (event: MockEvent) => void;
};

const mockState = vi.hoisted(() => ({
  currentWindowLabel: "main",
  invokeCalls: [] as Array<{ command: string; args?: unknown }>,
  invokeResult: undefined as unknown,
  invokeError: undefined as unknown,
  invokeHandler: undefined as
    | ((command: string, args?: unknown) => unknown)
    | undefined,
  eventListeners: [] as MockListener[],
  emittedEvents: [] as Array<{
    target: string | null;
    eventName: string;
    payload: unknown;
  }>,
  windowActions: [] as Array<{
    windowLabel: string;
    action: string;
    args: unknown[];
  }>,
  createdWindows: [] as Array<{ label: string; options: unknown }>,
  channelMessages: [] as unknown[],
  windows: new Map<string, Record<string, unknown>>(),
  nextEventId: 1,
}));

function registerListener(
  eventName: string,
  ownerLabel: string,
  callback: (event: MockEvent) => void,
): () => void {
  const listener = { eventName, ownerLabel, callback };
  mockState.eventListeners.push(listener);
  return () => {
    const index = mockState.eventListeners.indexOf(listener);
    if (index >= 0) {
      mockState.eventListeners.splice(index, 1);
    }
  };
}

function dispatchEvent(
  eventName: string,
  payload: unknown,
  targetLabel: string | null,
): void {
  const event = {
    id: mockState.nextEventId++,
    event: eventName,
    payload,
  };
  const listeners = [...mockState.eventListeners].filter(
    (listener) =>
      listener.eventName === eventName &&
      (targetLabel === null || listener.ownerLabel === targetLabel),
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

  const action = (name: string, ...args: unknown[]) => {
    mockState.windowActions.push({ windowLabel: label, action: name, args });
    return Promise.resolve(undefined);
  };
  const listen = async (
    eventName: string,
    callback: (event: MockEvent) => void,
  ) => registerListener(eventName, label, callback);
  const once = async (
    eventName: string,
    callback: (event: MockEvent) => void,
  ) => {
    let unlisten: (() => void) | undefined;
    unlisten = registerListener(eventName, label, (event) => {
      callback(event);
      unlisten?.();
    });
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
    isMaximized: vi.fn(async () => false),
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
    mockState.invokeCalls.push({ command, args });
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
      registerListener(eventName, mockState.currentWindowLabel, callback),
  ),
  emit: vi.fn(async (eventName: string, payload?: unknown) => {
    mockState.emittedEvents.push({ target: null, eventName, payload });
    dispatchEvent(eventName, payload, null);
  }),
  emitTo: vi.fn(
    async (target: string, eventName: string, payload?: unknown) => {
      mockState.emittedEvents.push({ target, eventName, payload });
      dispatchEvent(eventName, payload, target);
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => getWindowMock(mockState.currentWindowLabel)),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class MockWebviewWindow {
    label: string;

    constructor(label: string, options: unknown) {
      this.label = label;
      mockState.createdWindows.push({ label, options });
      Object.assign(this, getWindowMock(label));
    }

    static async getByLabel(label: string): Promise<unknown> {
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
  getWindow(label: string): Record<string, unknown> {
    return getWindowMock(label);
  },
  emitEvent(
    eventName: string,
    payload: unknown,
    targetLabel: string | null = null,
  ): void {
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
  },
};

afterEach(() => {
  tauriMock.reset();
  vi.clearAllMocks();
});
