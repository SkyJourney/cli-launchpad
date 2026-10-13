import { describe, expect, it } from "vitest";
import {
  readFileLaunchParams,
  readPtyLaunchParams,
  writeWindowLaunchParams,
} from "./windowLaunchParams";

const PTY = {
  kind: "pty" as const,
  sessionId: "s-1",
  handoffToken: "h-1",
  instanceId: "i-1",
  sourcePaneId: "p-1",
  toolKey: "codex" as const,
  title: "Project-Codex-01",
};
const FILE = {
  kind: "file" as const,
  documentId: "d-1",
  handoffToken: "t-1",
  sourcePaneId: "p-2",
};

describe("windowLaunchParams", () => {
  it("round-trips pty launch params", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);

    expect(readPtyLaunchParams(new URLSearchParams(search.toString()))).toEqual(
      PTY,
    );
    expect(
      readFileLaunchParams(new URLSearchParams(search.toString())),
    ).toBeNull();
  });

  it("round-trips file launch params", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, FILE);

    expect(
      readFileLaunchParams(new URLSearchParams(search.toString())),
    ).toEqual(FILE);
    expect(
      readPtyLaunchParams(new URLSearchParams(search.toString())),
    ).toBeNull();
  });

  it("pty params require a session id", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);
    search.delete("detachedSessionId");

    expect(readPtyLaunchParams(search)).toBeNull();
  });

  it("pty params require a handoff token", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);
    search.delete("handoffToken");

    expect(readPtyLaunchParams(search)).toBeNull();
  });

  it("pty params require an instance id", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);
    search.delete("instanceId");

    expect(readPtyLaunchParams(search)).toBeNull();
  });

  it("file params require a document id", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, FILE);
    search.delete("detachedFileId");

    expect(readFileLaunchParams(search)).toBeNull();
  });

  it("file params require a handoff token", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, FILE);
    search.delete("fileHandoffToken");

    expect(readFileLaunchParams(search)).toBeNull();
  });

  it("a missing source pane falls back to unknown-pane", () => {
    const ptySearch = new URLSearchParams();
    writeWindowLaunchParams(ptySearch, PTY);
    ptySearch.delete("sourcePaneId");
    const fileSearch = new URLSearchParams();
    writeWindowLaunchParams(fileSearch, FILE);
    fileSearch.delete("sourcePaneId");

    expect(readPtyLaunchParams(ptySearch)?.sourcePaneId).toBe("unknown-pane");
    expect(readFileLaunchParams(fileSearch)?.sourcePaneId).toBe("unknown-pane");
  });

  it("an unknown tool key is dropped and a missing title stays undefined", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);
    search.set("detachedToolKey", "gemini");
    search.delete("detachedTitle");

    const read = readPtyLaunchParams(search);
    expect(read?.toolKey).toBeUndefined();
    expect(read?.title).toBeUndefined();
    expect(read?.sessionId).toBe("s-1");

    for (const key of ["claude", "codex", "antigravity", "grok", "hermes"]) {
      search.set("detachedToolKey", key);
      expect(readPtyLaunchParams(search)?.toolKey).toBe(key);
    }
  });

  it("writes the pty wire names exactly", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, PTY);

    expect(Object.fromEntries(search.entries())).toEqual({
      detachedSessionId: "s-1",
      handoffToken: "h-1",
      instanceId: "i-1",
      detachedTitle: "Project-Codex-01",
      detachedToolKey: "codex",
      sourcePaneId: "p-1",
    });
  });

  it("writes the file wire names exactly", () => {
    const search = new URLSearchParams();
    writeWindowLaunchParams(search, FILE);

    expect(Object.fromEntries(search.entries())).toEqual({
      detachedFileId: "d-1",
      fileHandoffToken: "t-1",
      sourcePaneId: "p-2",
    });
  });

  it("write only sets its own keys and keeps unrelated params", () => {
    const search = new URLSearchParams("keep=1");
    writeWindowLaunchParams(search, FILE);

    expect(search.get("keep")).toBe("1");
    expect(search.get("detachedSessionId")).toBeNull();
  });

  it("pty and file params do not read each other", () => {
    const ptySearch = new URLSearchParams();
    writeWindowLaunchParams(ptySearch, PTY);
    const fileSearch = new URLSearchParams();
    writeWindowLaunchParams(fileSearch, FILE);

    expect(readFileLaunchParams(ptySearch)).toBeNull();
    expect(readPtyLaunchParams(fileSearch)).toBeNull();
  });
});
