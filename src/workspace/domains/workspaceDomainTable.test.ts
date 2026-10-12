import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceDomainTable,
  getWorkspaceDomain,
  workspaceDomainKinds,
  type WorkspaceContentDomain,
} from "./workspaceDomainTable";

describe("workspaceDomainTable", () => {
  it("keeps the key order of the table it was created with", () => {
    const fileDomain = {
      kind: "file",
      closeInput: vi.fn(),
      close: vi.fn(),
    } as unknown as WorkspaceContentDomain<"file">;
    const ptyDomain = {
      kind: "pty",
      closeInput: vi.fn(),
      close: vi.fn(),
    } as unknown as WorkspaceContentDomain<"pty">;

    const table = createWorkspaceDomainTable({
      file: fileDomain,
      pty: ptyDomain,
    });

    expect(workspaceDomainKinds(table)).toEqual(["file", "pty"]);
    expect(table.file).toBe(fileDomain);
    expect(table.pty).toBe(ptyDomain);
    // 反向：顺序由传入对象决定，宿主负责传入 file 在前。
    const reversed = createWorkspaceDomainTable({
      pty: ptyDomain,
      file: fileDomain,
    });
    expect(workspaceDomainKinds(reversed)).toEqual(["pty", "file"]);
  });

  it("getWorkspaceDomain returns the domain for a registered kind and undefined otherwise", () => {
    const fileDomain = {
      kind: "file",
      closeInput: vi.fn(),
      close: vi.fn(),
    } as unknown as WorkspaceContentDomain<"file">;
    const ptyDomain = {
      kind: "pty",
      closeInput: vi.fn(),
      close: vi.fn(),
    } as unknown as WorkspaceContentDomain<"pty">;
    const table = createWorkspaceDomainTable({
      file: fileDomain,
      pty: ptyDomain,
    });

    expect(getWorkspaceDomain(table, "file")).toBe(fileDomain);
    expect(getWorkspaceDomain(table, "pty")).toBe(ptyDomain);
    expect(getWorkspaceDomain(table, "unknown")).toBeUndefined();
    expect(getWorkspaceDomain(table, "markdownPreview")).toBeUndefined();
  });
});
