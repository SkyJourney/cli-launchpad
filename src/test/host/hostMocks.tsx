import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
} from "react";
import { vi } from "vitest";

// ---------- react-i18next：t 的身份必须稳定。
// 如果每次渲染产生新的 t，所有依赖 [t] 的 effect 每次渲染都会重跑。
// 输出格式：没有参数时为 key，有参数时为 key:JSON(options)。
const t = (key: string, options?: Record<string, unknown>) =>
  options && Object.keys(options).length > 0
    ? `${key}:${JSON.stringify(options)}`
    : key;
const i18n = {
  language: "en",
  resolvedLanguage: "en",
  changeLanguage: async () => undefined,
};
export const reactI18nextMock = {
  useTranslation: () => ({ t, i18n }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
  Trans: ({ children }: { children?: unknown }) => children ?? null,
};

// ---------- sonner
export const toastSpy = Object.assign(vi.fn(), {
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
});
export const sonnerMock = {
  toast: toastSpy,
  Toaster: () => null,
};

// ---------- PtyTerminal 假实现
export interface FakeTerminalHandle {
  startSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  captureHandoff: ReturnType<typeof vi.fn>;
  cancelHandoff: ReturnType<typeof vi.fn>;
  attachHandoff: ReturnType<typeof vi.fn>;
  reattachLostSession: ReturnType<typeof vi.fn>;
  getSessionState: ReturnType<typeof vi.fn>;
  /** 直接调用最新的 props.onSessionChange。 */
  emitSessionChange: (session: unknown) => void;
}

export const fakeTerminals: FakeTerminalHandle[] = [];
let nextSession = 1;
let nextHandoff = 1;
const createdListeners = new Set<(handle: FakeTerminalHandle) => void>();

/** 在 handle 创建时同步回调，用来在子窗 effect 运行前预设行为。返回取消订阅函数。 */
export function onFakeTerminalCreated(
  callback: (handle: FakeTerminalHandle) => void,
): () => void {
  createdListeners.add(callback);
  return () => {
    createdListeners.delete(callback);
  };
}

export function resetFakeTerminals() {
  fakeTerminals.length = 0;
  nextSession = 1;
  nextHandoff = 1;
  createdListeners.clear();
}

interface FakeTerminalProps {
  onSessionChange?: (session: unknown) => void;
}

export const FakePtyTerminal = forwardRef(function FakePtyTerminal(
  props: FakeTerminalProps,
  ref: ForwardedRef<FakeTerminalHandle>,
) {
  const latestProps = useRef(props);
  latestProps.current = props;
  useImperativeHandle(ref, () => {
    let state: string | null = null;
    const handle: FakeTerminalHandle = {
      startSession: vi.fn(async (directoryId: number, toolKey: string) => {
        const session = {
          sessionId: `session-${nextSession++}`,
          directoryId,
          toolKey,
          workingDirectory: "C:/project",
          state: "running",
          startedAtMs: 1,
          endedAtMs: null,
          exitCode: null,
        };
        state = "running";
        latestProps.current.onSessionChange?.(session);
      }),
      closeSession: vi.fn(async () => "closed"),
      captureHandoff: vi.fn(async () => ({
        token: `handoff-${nextHandoff++}`,
      })),
      cancelHandoff: vi.fn(async () => undefined),
      attachHandoff: vi.fn(async (sessionId: string) => ({
        sessionId,
        state: "running",
      })),
      reattachLostSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        state: "running",
      })),
      getSessionState: vi.fn(() => state),
      emitSessionChange: (session: unknown) =>
        latestProps.current.onSessionChange?.(session),
    };
    fakeTerminals.push(handle);
    createdListeners.forEach((listener) => listener(handle));
    return handle;
  }, []);
  return <div data-testid="fake-pty-terminal" />;
});
export const ptyTerminalMock = { PtyTerminal: FakePtyTerminal };
