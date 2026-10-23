// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { beginPtyHandoff } from "./tauri";
import { tauriMock } from "../test/tauriMock";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const production = Object.entries(sources).filter(
  ([path]) => !path.includes(".test.") && !path.includes("/test/"),
);

describe("PTY handoff target", () => {
  it("begin handoff sends the reserved target window label to the backend", async () => {
    tauriMock.setCurrentWindowLabel("main");
    tauriMock.setInvokeResult({ token: "t", sequence: 1 });
    const target = "terminal-8e783338-f464-4b10-b15e-b534748c6241";

    await beginPtyHandoff("session-1", target);

    const calls = tauriMock.state.invokeCalls.filter(
      (call) => call.command === "begin_pty_handoff",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      sessionId: "session-1",
      targetWindowLabel: target,
    });
    // 反向：参数名恰好是这两个。
    expect(Object.keys(calls[0].args as object).sort()).toEqual([
      "sessionId",
      "targetWindowLabel",
    ]);
  });

  it("has no capture or begin handoff call without a target", () => {
    expect(production.length).toBeGreaterThan(50);
    const noTarget = production
      .filter(
        ([, text]) =>
          /\bcaptureHandoff\(\s*\)/.test(text) ||
          /\bbeginPtyHandoff\(\s*[A-Za-z0-9_.]+\s*\)/.test(text),
      )
      .map(([path]) => path);

    expect(noTarget).toEqual([]);
    // 反向：确实存在带目标的调用，且接口声明带参数。
    expect(
      production.some(([, text]) =>
        /\bbeginPtyHandoff\([^)]*,[^)]*\)/.test(text),
      ),
    ).toBe(true);
    const terminal = production.find(([path]) =>
      path.endsWith("/components/PtyTerminal.tsx"),
    );
    expect(terminal?.[1]).toContain(
      "captureHandoff(targetWindowLabel: string)",
    );
  });
});
