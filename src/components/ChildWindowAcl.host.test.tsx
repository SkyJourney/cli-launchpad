// @vitest-environment jsdom
/// <reference types="vite/client" />
import { Channel } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cleanup, fireEvent, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThemeSync } from "../hooks/useThemeSync";
import { publishAppPreferences } from "../lib/appPreferencesMain";
import {
  acknowledgePtyOutput,
  beginPtyHandoff,
  cancelPtyHandoff,
  completePtyHandoff,
  createPtySession,
  finalizePtyHandoff,
  getPtySessionWindowStatus,
  listDirectories,
  openGrantedFile,
  openProjectFile,
  reattachPtySession,
  reportPtyFrontendStage,
  resizePtySession,
  saveGrantedTextFile,
  saveProjectTextFile,
  setTrayMenuLabels,
  stagePtyHandoffSnapshot,
  terminatePtySession,
  writePtySession,
  type PtyEvent,
} from "../lib/tauri";
import appCommandsContractSource from "../lib/appCommands.contract.test.ts?raw";
import { MAIN_ONLY_MODULES } from "../test/windowClosures";
import { tauriMock } from "../test/tauriMock";
import {
  DEFAULT_FILE_WINDOW_LABEL,
  DEFAULT_PTY_WINDOW_LABEL,
  emitToWindow,
  flush,
  flushUntil,
  invokes,
  mountFileWindow,
  mountPtyWindow,
} from "../test/host/workspaceHarness";
import { resetFakeTerminals } from "../test/host/hostMocks";

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

const TERMINAL = DEFAULT_PTY_WINDOW_LABEL;
const WORKSPACE = DEFAULT_FILE_WINDOW_LABEL;
const SIZE = { cols: 80, rows: 24, pixelWidth: 640, pixelHeight: 480 };
const SNAPSHOT = { data: "", cols: 80, rows: 24 };
const FILE_INIT = {
  documentId: "doc-1",
  token: "tok-1",
  windowLabel: WORKSPACE,
  fileDocument: {
    id: "doc-1",
    directoryId: 1,
    directoryPath: "C:/project",
    relativePath: "a.txt",
  },
  fileBuffer: {
    kind: "text",
    epoch: 0,
    version: 0,
    content: "hello",
    savedContent: "hello",
    revision: "r1",
    saving: false,
  },
};

// 键是命令名（字面量），值通过真实封装触发该命令。用例会同时核对“封装实际发出的命令名等于键”。
const CALLS: Record<string, () => Promise<unknown>> = {
  begin_pty_handoff: () => beginPtyHandoff("s"),
  stage_pty_handoff_snapshot: () =>
    stagePtyHandoffSnapshot("s", "t", 1, SNAPSHOT),
  complete_pty_handoff: () =>
    completePtyHandoff("s", "t", new Channel<PtyEvent>()),
  finalize_pty_handoff: () => finalizePtyHandoff("s", "t", SIZE),
  cancel_pty_handoff: () => cancelPtyHandoff("s", "t"),
  get_pty_session_window_status: () => getPtySessionWindowStatus("s"),
  write_pty_session: () => writePtySession("s", "x"),
  resize_pty_session: () => resizePtySession("s", SIZE),
  acknowledge_pty_output: () => acknowledgePtyOutput("s", 1),
  report_pty_frontend_stage: () =>
    reportPtyFrontendStage("s", "outputReceived"),
  terminate_pty_session: () => terminatePtySession("s"),
  open_granted_file: () => openGrantedFile(),
  save_granted_text_file: () => saveGrantedTextFile("x", "r1"),
  create_pty_session: () =>
    createPtySession(1, "claude", SIZE, new Channel<PtyEvent>()),
  reattach_pty_session: () =>
    reattachPtySession("s", new Channel<PtyEvent>(), SNAPSHOT, 1, SIZE),
  set_tray_menu_labels: () => setTrayMenuLabels({ show: "a", quit: "b" }),
  open_project_file: () => openProjectFile(1, "C:/project", "a.txt"),
  save_project_text_file: () =>
    saveProjectTextFile(1, "C:/project", "a.txt", "x", "r1"),
  list_directories: () => listDirectories(),
};

const TERMINAL_ALLOWED = [
  "begin_pty_handoff",
  "stage_pty_handoff_snapshot",
  "complete_pty_handoff",
  "finalize_pty_handoff",
  "cancel_pty_handoff",
  "get_pty_session_window_status",
  "write_pty_session",
  "resize_pty_session",
  "acknowledge_pty_output",
  "report_pty_frontend_stage",
  "terminate_pty_session",
];
const WORKSPACE_ALLOWED = ["open_granted_file", "save_granted_text_file"];
const MAIN_ONLY = [
  "create_pty_session",
  "reattach_pty_session",
  "set_tray_menu_labels",
  "open_project_file",
  "save_project_text_file",
  "list_directories",
];
const KINDS = {
  terminal: {
    label: TERMINAL,
    allowed: TERMINAL_ALLOWED,
    denied: [...WORKSPACE_ALLOWED, ...MAIN_ONLY],
  },
  workspaceContent: {
    label: WORKSPACE,
    allowed: WORKSPACE_ALLOWED,
    denied: [...TERMINAL_ALLOWED, ...MAIN_ONLY],
  },
} as const;

const PREFERENCES = { apiVersion: 1, theme: "dark", language: "en" } as const;

const disposers: Array<() => void> = [];
afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  cleanup();
  resetFakeTerminals();
  vi.useRealTimers();
  await flush();
  expect(tauriMock.state.eventListeners).toHaveLength(0);
});

function eventsTo(target: string | null, type: string) {
  return tauriMock.state.emittedEvents.filter(
    (event) =>
      event.target === target &&
      (event.payload as { type?: string }).type === type,
  );
}

/** flushUntil 的包装：超时时把已记录的 ACL 违规一并带进错误信息，便于判断是权限缺口还是别的原因。 */
async function waitUntil(done: () => boolean, label: string) {
  try {
    await flushUntil(done, label);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}; aclViolations=${JSON.stringify(tauriMock.state.aclViolations)}`,
    );
  }
}

function hasEvent(target: string | null, type: string) {
  return eventsTo(target, type).length > 0;
}

function hasWindowAction(label: string, action: string) {
  return tauriMock.state.windowActions.some(
    (entry) => entry.windowLabel === label && entry.action === action,
  );
}

function silenceWarnings() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  disposers.push(() => warn.mockRestore());
  return warn;
}

describe("child window ACL at runtime", () => {
  it("completes init, edit, save and return without ACL violations", async () => {
    const warn = silenceWarnings();
    const win = await mountFileWindow();
    disposers.push(win.dispose);
    const hook = renderHook(() => useThemeSync());
    disposers.push(hook.unmount);
    await waitUntil(
      () =>
        hasEvent("main", "workspace-file-window-ready") &&
        hasWindowAction(WORKSPACE, "setTheme"),
      "the file window announced itself and useThemeSync called setTheme",
    );

    await emitToWindow(WORKSPACE, "workspace-file-window-init", FILE_INIT);
    await waitUntil(
      () =>
        Boolean(screen.queryByLabelText("editor")) &&
        hasEvent("main", "workspace-file-window-attached"),
      "the file window rendered the editor and reported attached",
    );
    fireEvent.change(screen.getByLabelText("editor"), {
      target: { value: "x" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /workspaceFiles\.save/ }),
    );
    await waitUntil(
      () => invokes("save_granted_text_file").length >= 1,
      "the file window saved the edited content",
    );
    fireEvent.click(screen.getByTitle("pty.returnToWorkspace"));
    await waitUntil(
      () => hasEvent("main", "workspace-file-window-return-requested"),
      "the file window requested to return",
    );

    expect(
      eventsTo("main", "workspace-file-window-return-requested"),
    ).not.toHaveLength(0);
    await emitToWindow(WORKSPACE, "workspace-file-window-return-complete", {
      documentId: "doc-1",
      token: "tok-1",
    });
    await waitUntil(
      () => hasWindowAction(WORKSPACE, "destroy"),
      "the file window destroyed itself after return-complete",
    );

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).startsWith("[window.theme_sync_failed]"),
      ),
    ).toHaveLength(0);
    expect(
      tauriMock.state.emittedEvents.filter((event) => event.target === null),
    ).toEqual([]);
    const saves = invokes("save_granted_text_file");
    expect(saves).toHaveLength(1);
    expect(saves[0].args).toMatchObject({ content: "x" });
    for (const type of [
      "workspace-file-window-ready",
      "workspace-file-window-attached",
      "workspace-file-window-return-requested",
    ]) {
      expect(eventsTo("main", type).length).toBeGreaterThanOrEqual(1);
    }
    expect(
      tauriMock.state.windowActions.some(
        (action) =>
          action.windowLabel === WORKSPACE && action.action === "destroy",
      ),
    ).toBe(true);
    expect(win.errors).toEqual([]);
  });

  it("completes attach and return without ACL violations", async () => {
    const warn = silenceWarnings();
    const win = await mountPtyWindow();
    disposers.push(win.dispose);
    const hook = renderHook(() => useThemeSync());
    disposers.push(hook.unmount);
    await waitUntil(
      () =>
        hasEvent("main", "pty-detached-ready") &&
        hasWindowAction(TERMINAL, "setTheme"),
      "the terminal window announced itself and useThemeSync called setTheme",
    );

    const ready = eventsTo("main", "pty-detached-ready");
    expect(ready).toHaveLength(1);
    expect((ready[0].payload as { payload: unknown }).payload).toEqual({
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: TERMINAL,
    });
    fireEvent.click(screen.getByTitle("pty.returnToWorkspace"));
    await waitUntil(
      () => hasEvent("main", "pty-return-requested"),
      "the terminal window requested to return",
    );

    const returned = eventsTo("main", "pty-return-requested");
    expect(returned).toHaveLength(1);
    const { token } = (returned[0].payload as { payload: { token: string } })
      .payload;
    await emitToWindow(TERMINAL, "pty-return-complete", {
      instanceId: "slot-1",
      token,
    });
    await waitUntil(
      () => hasWindowAction(TERMINAL, "destroy"),
      "the terminal window destroyed itself after return-complete",
    );

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).startsWith("[window.theme_sync_failed]"),
      ),
    ).toHaveLength(0);
    expect(
      tauriMock.state.emittedEvents.filter((event) => event.target === null),
    ).toEqual([]);
    expect(
      tauriMock.state.windowActions.some(
        (action) =>
          action.windowLabel === TERMINAL && action.action === "destroy",
      ),
    ).toBe(true);
    expect(win.errors).toEqual([]);
  });

  it.each(["terminal", "workspaceContent"] as const)(
    "allows exactly the declared commands for %s windows",
    async (kind) => {
      const { label, allowed } = KINDS[kind];
      tauriMock.setCurrentWindowLabel(label);
      tauriMock.setInvokeHandler(() => undefined);

      for (const command of allowed) {
        await expect(CALLS[command]()).resolves.not.toThrow();
      }

      expect(tauriMock.state.aclViolations).toEqual([]);
      expect(tauriMock.state.invokeCalls.map((call) => call.command)).toEqual(
        allowed,
      );
      for (const call of tauriMock.state.invokeCalls) {
        expect(call.windowLabel).toBe(label);
      }
      expect(KINDS.terminal.allowed).toHaveLength(11);
      expect(KINDS.workspaceContent.allowed).toHaveLength(2);
    },
  );

  it.each(["terminal", "workspaceContent"] as const)(
    "denies every other known command for %s windows and records each violation",
    async (kind) => {
      const { label, allowed, denied } = KINDS[kind];
      tauriMock.setCurrentWindowLabel(label);
      tauriMock.setInvokeHandler(() => undefined);

      for (const command of denied) {
        await expect(CALLS[command]()).rejects.toEqual({
          code: "acl.denied",
          message: `${command} not allowed for ${label}`,
        });
      }

      expect(tauriMock.state.aclViolations).toEqual(
        denied.map((command) => ({
          windowLabel: label,
          api: `invoke:${command}`,
          required: `app-command:${command}`,
        })),
      );
      expect(tauriMock.state.invokeCalls).toHaveLength(0);
      expect(new Set([...allowed, ...denied]).size).toBe(
        allowed.length + denied.length,
      );
      expect(KINDS.terminal.denied).toHaveLength(8);
      expect(KINDS.workspaceContent.denied).toHaveLength(17);
    },
  );

  it.each(["terminal", "workspaceContent"] as const)(
    "denies the main-only modules in %s windows",
    async (kind) => {
      const { label } = KINDS[kind];
      tauriMock.setCurrentWindowLabel(label);

      await expect(publishAppPreferences(PREFERENCES)).rejects.toEqual({
        code: "acl.denied",
        message: `emit not allowed for ${label}`,
      });
      await expect(WebviewWindow.getByLabel("main")).rejects.toEqual({
        code: "acl.denied",
        message: `getByLabel not allowed for ${label}`,
      });

      expect(tauriMock.state.aclViolations).toEqual([
        { windowLabel: label, api: "emit", required: "core:event:allow-emit" },
        {
          windowLabel: label,
          api: "getByLabel",
          required: "core:webview:allow-get-all-webviews",
        },
      ]);
      expect(tauriMock.state.emittedEvents).toEqual([]);
    },
  );

  it("allows the same calls in the main window", async () => {
    tauriMock.setInvokeHandler(() => undefined);

    for (const command of MAIN_ONLY) {
      await expect(CALLS[command]()).resolves.not.toThrow();
    }
    await expect(publishAppPreferences(PREFERENCES)).resolves.not.toThrow();
    await expect(WebviewWindow.getByLabel("main")).resolves.not.toThrow();

    expect(tauriMock.state.aclViolations).toEqual([]);
    expect(tauriMock.state.emittedEvents).toHaveLength(1);
    expect(tauriMock.state.emittedEvents[0]).toEqual(
      expect.objectContaining({
        windowLabel: "main",
        target: null,
        eventName: "app-preferences",
      }),
    );
    expect(tauriMock.state.invokeCalls.map((call) => call.command)).toEqual(
      MAIN_ONLY,
    );
  });

  it("records a violation when a mounted child window calls a main-only wrapper", async () => {
    const win = await mountFileWindow();
    disposers.push(win.dispose);
    await waitUntil(
      () => hasEvent("main", "workspace-file-window-ready"),
      "the mounted file window announced itself",
    );
    expect(tauriMock.state.aclViolations).toEqual([]);

    await expect(CALLS.create_pty_session()).rejects.toEqual({
      code: "acl.denied",
      message: `create_pty_session not allowed for ${WORKSPACE}`,
    });

    expect(tauriMock.state.aclViolations).toEqual([
      {
        windowLabel: WORKSPACE,
        api: "invoke:create_pty_session",
        required: "app-command:create_pty_session",
      },
    ]);
    expect(invokes("create_pty_session")).toHaveLength(0);
  });

  it("keeps the runtime main-only lists in sync with the static contract tests", () => {
    expect(MAIN_ONLY_MODULES).toEqual(["src/lib/appPreferencesMain.ts"]);

    const match = appCommandsContractSource.match(
      /const MAIN_ONLY_CALLS[^=]*=\s*\{([\s\S]*?)\n\};/,
    );
    expect(match).not.toBeNull();
    const literals = [
      ...(match as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g),
    ].map((entry) => entry[1]);
    expect(new Set(literals)).toEqual(
      new Set([
        "src/components/PtyTerminal.tsx",
        "createPtySession",
        "reattachPtySession",
        "src/hooks/useThemeSync.ts",
        "setTrayMenuLabels",
      ]),
    );
    for (const command of [
      "create_pty_session",
      "reattach_pty_session",
      "set_tray_menu_labels",
    ]) {
      expect(MAIN_ONLY).toContain(command);
    }
  });
});
