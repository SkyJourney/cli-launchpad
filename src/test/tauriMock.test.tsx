// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriMock } from "./tauriMock";

afterEach(() => {
  cleanup();
});

describe("Tauri DOM test environment", () => {
  it("renders React and records invocations while allowing events to be triggered", async () => {
    const onEvent = vi.fn();
    await listen("contract-test-event", onEvent);

    render(
      <button onClick={() => void invoke("contract_test_command", { id: 7 })}>
        Run command
      </button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));

    expect(tauriMock.state.invokeCalls).toEqual([
      { command: "contract_test_command", args: { id: 7 } },
    ]);

    tauriMock.emitEvent("contract-test-event", { ready: true }, "main");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { ready: true } }),
    );
  });
});
