import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { invokeApp } from "./invokeApp";

describe("invokeApp", () => {
  it("forwards the command name and arguments to the Tauri invoke function", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true });

    const result = await invokeApp<{ ok: boolean }>("list_directories", {
      x: 1,
    });

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("list_directories", { x: 1 });
    // @ts-expect-error 不在契约里的命令名必须在编译期被拒绝
    void invokeApp("not_a_registered_command");
  });
});
