// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "react-i18next",
  async () => (await import("../../test/host/hostMocks")).reactI18nextMock,
);

import { usePtyWorkspace, useWorkspaceCommands } from "./workspaceContexts";

describe("workspace contexts without a provider", () => {
  it("useWorkspaceCommands throws when no commands provider is mounted", () => {
    // React 在抛错时会向控制台输出错误，这里静音以免干扰输出。
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useWorkspaceCommands())).toThrow(
        "WorkspaceCommandsContext is missing",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("usePtyWorkspace throws when no workspace provider is mounted", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => usePtyWorkspace())).toThrow(
        "PtyWorkspaceProvider is missing",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
