// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import events from "../../contracts/events.json";
import messages from "../../contracts/window-messages.json";
import {
  APP_PREFERENCES_REPLY_MESSAGE,
  APP_PREFERENCES_REQUEST_MESSAGE,
} from "./appPreferences";
import { RUST_EVENTS } from "./eventNames";
import { WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES } from "./workspaceContentWindowProtocol";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const production = Object.entries(sources).filter(
  ([path]) => !path.includes(".test.") && !path.includes("/test/"),
);

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

const DIRECTIONS: ReadonlyArray<
  readonly [string, readonly string[], readonly string[], string]
> = [
  ["app-preferences-reply", ["main"], ["terminal", "workspaceContent"], "app"],
  [
    "app-preferences-requested",
    ["terminal", "workspaceContent"],
    ["main"],
    "app",
  ],
  ["pty-detached-exited", ["terminal"], ["main"], "pty"],
  ["pty-detached-failed", ["terminal"], ["main"], "pty"],
  ["pty-detached-ready", ["terminal"], ["main"], "pty"],
  ["pty-return-requested", ["terminal"], ["main"], "pty"],
  ["pty-return-complete", ["main"], ["terminal"], "pty"],
  ["pty-return-drop-requested", ["main"], ["terminal"], "pty"],
  ["pty-return-failed", ["main"], ["terminal"], "pty"],
  [
    "workspace-file-window-attach-failed",
    ["workspaceContent"],
    ["main"],
    "file",
  ],
  ["workspace-file-window-attached", ["workspaceContent"], ["main"], "file"],
  [
    "workspace-file-window-buffer-changed",
    ["workspaceContent"],
    ["main"],
    "file",
  ],
  [
    "workspace-file-window-flush-complete",
    ["workspaceContent"],
    ["main"],
    "file",
  ],
  ["workspace-file-window-ready", ["workspaceContent"], ["main"], "file"],
  [
    "workspace-file-window-return-requested",
    ["workspaceContent"],
    ["main"],
    "file",
  ],
  [
    "workspace-file-window-flush-requested",
    ["main"],
    ["workspaceContent"],
    "file",
  ],
  ["workspace-file-window-init", ["main"], ["workspaceContent"], "file"],
  [
    "workspace-file-window-return-complete",
    ["main"],
    ["workspaceContent"],
    "file",
  ],
  [
    "workspace-file-window-return-drop-requested",
    ["main"],
    ["workspaceContent"],
    "file",
  ],
  [
    "workspace-file-window-return-failed",
    ["main"],
    ["workspaceContent"],
    "file",
  ],
];

describe("window message contract", () => {
  it("lists exactly the protocol message types plus the two preference types", () => {
    const contract = messages.messages.map((message) => message.type).sort();
    const expected = [
      ...WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES,
      APP_PREFERENCES_REQUEST_MESSAGE,
      APP_PREFERENCES_REPLY_MESSAGE,
    ].sort();

    expect(contract).toEqual(expected);
    expect(contract).toHaveLength(20);
    expect(WORKSPACE_CONTENT_WINDOW_MESSAGE_TYPES).toHaveLength(18);
  });

  it("declares the protocol directions literally", () => {
    expect(messages.messages).toHaveLength(DIRECTIONS.length);
    for (const [type, from, to, contentKind] of DIRECTIONS) {
      const entry = messages.messages.find((message) => message.type === type);
      expect(entry, type).toBeDefined();
      expect(entry?.from, `${type} from`).toEqual(from);
      expect(entry?.to, `${type} to`).toEqual(to);
      expect(entry?.contentKind, `${type} contentKind`).toBe(contentKind);
    }
    // No type is both sent and received by terminal windows.
    for (const message of messages.messages) {
      expect(
        message.from.includes("terminal") && message.to.includes("terminal"),
        message.type,
      ).toBe(false);
    }
  });

  it("never uses emitTo and keeps emit to the preferences publisher", () => {
    expect(production.length).toBeGreaterThan(50);
    const emitTo = production
      .filter(([, text]) => /\bemitTo\b/.test(text))
      .map(([path]) => fileName(path));
    // `emit` is only imported by the preferences publisher.
    const importsEmit = production
      .filter(([, text]) =>
        /import\s*\{[^}]*\bemit\b[^}]*\}\s*from\s*"@tauri-apps\/api\/event"/.test(
          text,
        ),
      )
      .map(([path]) => fileName(path));

    expect(emitTo).toEqual([]);
    expect(importsEmit).toEqual(["appPreferencesMain.ts"]);
    const protocol = production.find(([path]) =>
      path.endsWith("/workspaceContentWindowProtocol.ts"),
    );
    expect(protocol?.[1]).toContain("sendWindowMessage(");
  });

  it("matches every send call site to the contract direction", () => {
    const byType = new Map(messages.messages.map((m) => [m.type, m]));
    const pattern =
      /(?:\.emit|emitWorkspaceContentWindowEvent|sendWindowMessage)\(\s*([^,]+?),\s*"([a-z0-9-]+)"/g;
    const violations: string[] = [];
    const seenTypes = new Set<string>();
    let sites = 0;
    for (const [path, text] of production) {
      for (const match of text.matchAll(pattern)) {
        const [, target, type] = match;
        if (!/^(pty-|workspace-file-window-|app-preferences-)/.test(type)) {
          continue;
        }
        sites += 1;
        seenTypes.add(type);
        const rule = byType.get(type);
        if (!rule) {
          violations.push(`${fileName(path)}: ${type} is not in the contract`);
          continue;
        }
        const toMain = target.includes('"main"') || /\bMAIN/.test(target);
        if (toMain && !rule.to.includes("main")) {
          violations.push(`${fileName(path)}: ${type} is sent to main`);
        }
        if (!toMain && !rule.from.includes("main")) {
          violations.push(
            `${fileName(path)}: ${type} is sent to a child window by a non-main sender`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
    // Guard against a scan that reads nothing: the call sites at the time of m6-062.
    expect(sites).toBeGreaterThanOrEqual(25);
    expect(seenTypes.size).toBeGreaterThanOrEqual(18);
  });

  it("lists the relay event in the TypeScript registry", () => {
    const names = events.events.map((event) => event.name);

    expect(RUST_EVENTS.windowMessage).toBe("window-message");
    expect(names).toContain("window-message");
    expect(names).not.toContain("workspace-content-window-event");
    expect(names).not.toContain("app-preferences-requested");
  });
});
