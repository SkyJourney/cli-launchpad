import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspaceContentAdapter,
  registerWorkspaceContentAdapter,
} from "../components/workspaceContentAdapterRegistry";
import { resolveEditorEngine } from "../components/workspaceEditorEngineRegistry";
import { listThemes } from "../lib/themeRegistry";
import { WORKSPACE_CONTENT_ADAPTER_API_VERSION } from "../lib/extensionApiVersions";
import {
  clearContributionFailures,
  getContributionFailures,
} from "../lib/registerContribution";
import { registerBuiltinContributions } from "./registerBuiltinContributions";

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("built-in contribution bootstrap", () => {
  it("registers adapters and the editor before any view module is imported", () => {
    unregister = registerBuiltinContributions();

    expect(getWorkspaceContentAdapter("pty").id).toBe("core.pty");
    expect(getWorkspaceContentAdapter("file").id).toBe("core.file-editor");
    expect(resolveEditorEngine()?.id).toBe("core.monaco");
  });

  it("is idempotent and its cleanup permits registration again", () => {
    unregister = registerBuiltinContributions();
    expect(registerBuiltinContributions()).toBe(unregister);

    unregister();
    unregister = registerBuiltinContributions();

    expect(getWorkspaceContentAdapter("pty").id).toBe("core.pty");
  });

  it("keeps registering the other built-in contributions when one is rejected", () => {
    clearContributionFailures();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The squatter takes the "pty" content kind, so the built-in pty adapter is rejected.
    const squatter = registerWorkspaceContentAdapter({
      id: "test.squatter",
      apiVersion: WORKSPACE_CONTENT_ADAPTER_API_VERSION,
      kind: "pty",
      render: () => null,
      presentation: () => ({ title: "t", icon: null, closeLabelKey: "close" }),
      labels: {},
      projectContextOf: () => null,
    } as never);
    try {
      expect(() => {
        unregister = registerBuiltinContributions();
      }).not.toThrow();

      expect(getWorkspaceContentAdapter("file").id).toBe("core.file-editor");
      expect(resolveEditorEngine()?.id).toBe("core.monaco");
      expect(
        getContributionFailures().map(
          (failure) => `${failure.registry}:${failure.id}`,
        ),
      ).toEqual(["workspaceContentAdapter:core.pty"]);
      const rejected = error.mock.calls.filter(
        ([message]) =>
          message ===
          "[bootstrap.contribution_rejected] workspaceContentAdapter:core.pty",
      );
      expect(rejected).toHaveLength(1);
      // Reverse: the built-in pty adapter did not replace the squatter.
      expect(getWorkspaceContentAdapter("pty").id).toBe("test.squatter");
    } finally {
      squatter();
      clearContributionFailures();
      vi.restoreAllMocks();
    }
  });

  it("keeps the built-in themes registered after the bootstrap cleanup", () => {
    const dispose = registerBuiltinContributions();
    dispose();

    expect(listThemes().map((theme) => theme.id)).toEqual(["light", "dark"]);
    // Reverse: only the themes are permanent; adapters are unregistered by the cleanup.
    expect(() => getWorkspaceContentAdapter("pty")).toThrow(
      "未注册内容适配器: pty",
    );
  });
});
