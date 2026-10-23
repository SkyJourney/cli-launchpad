// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "./test/tauriMock";

vi.mock(
  "react-i18next",
  async () => (await import("./test/host/hostMocks")).reactI18nextMock,
);
vi.mock("./hooks/useThemeSync", () => ({ useThemeSync: () => {} }));
vi.mock("./components/StandaloneWorkspaceFileWindow", () => ({
  StandaloneWorkspaceFileWindow: () => <div>file-window</div>,
}));
vi.mock("./components/StandalonePtyWindow", () => ({
  StandalonePtyWindow: () => <div>pty-window</div>,
}));

const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const CONTENT = "workspace-content-11111111-2222-4333-8444-555555555555";

async function mountApp(label: string, search: string) {
  tauriMock.setCurrentWindowLabel(label);
  window.history.replaceState({}, "", `/${search}`);
  vi.resetModules();
  const { App } = await import("./App");
  return render(<App />);
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("App window routing", () => {
  it("renders the file window only for a workspace-content label with file params", async () => {
    await mountApp(
      CONTENT,
      "?detachedFileId=doc-1&fileHandoffToken=tok-1&sourcePaneId=p1",
    );

    expect(await screen.findByText("file-window")).toBeTruthy();
    expect(screen.queryByText("pty-window")).toBeNull();
  });

  it("renders nothing for a terminal label without handoff params", async () => {
    const { container } = await mountApp(TERMINAL, "");

    expect(container.innerHTML).toBe("");
    expect(tauriMock.state.invokeCalls).toEqual([]);
  });

  it("renders the PTY window for a terminal label with handoff params", async () => {
    await mountApp(
      TERMINAL,
      "?detachedSessionId=s1&handoffToken=t1&instanceId=i1&sourcePaneId=p1",
    );

    expect(await screen.findByText("pty-window")).toBeTruthy();
    expect(screen.queryByText("file-window")).toBeNull();
  });

  it("does not render the PTY window for a workspace-content label with PTY params", async () => {
    const { container } = await mountApp(
      CONTENT,
      "?detachedSessionId=s1&handoffToken=t1&instanceId=i1&sourcePaneId=p1",
    );

    expect(screen.queryByText("pty-window")).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});
