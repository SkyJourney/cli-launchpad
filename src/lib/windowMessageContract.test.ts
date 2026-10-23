// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import events from "../../contracts/events.json";
import messages from "../../contracts/window-messages.json";
import {
  APP_PREFERENCES_REPLY_MESSAGE,
  APP_PREFERENCES_REQUEST_MESSAGE,
} from "./appPreferences";
import { RUST_EVENTS } from "./eventNames";
import {
  CONTENT_HANDOFF_MESSAGE_TYPES,
  CONTENT_HANDOFF_PHASES,
} from "./workspaceContentWindowProtocol";

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

// The m6-091 table: (type, from, to, contentKinds), written out literally.
const DIRECTIONS: ReadonlyArray<
  readonly [
    string,
    readonly string[],
    readonly string[],
    string,
    Record<string, string> | null,
  ]
> = [
  [
    "app-preferences-reply",
    ["main"],
    ["terminal", "workspaceContent"],
    "app",
    null,
  ],
  [
    "app-preferences-requested",
    ["terminal", "workspaceContent"],
    ["main"],
    "app",
    null,
  ],
  [
    "content-handoff-attached",
    ["workspaceContent"],
    ["main"],
    "content",
    { file: "workspaceContent" },
  ],
  [
    "content-handoff-exited",
    ["terminal"],
    ["main"],
    "content",
    { pty: "terminal" },
  ],
  [
    "content-handoff-failed",
    ["terminal", "workspaceContent"],
    ["main"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-flush-complete",
    ["workspaceContent"],
    ["main"],
    "content",
    { file: "workspaceContent" },
  ],
  [
    "content-handoff-flush-requested",
    ["main"],
    ["workspaceContent"],
    "content",
    { file: "workspaceContent" },
  ],
  [
    "content-handoff-init",
    ["main"],
    ["workspaceContent"],
    "content",
    { file: "workspaceContent" },
  ],
  [
    "content-handoff-ready",
    ["terminal", "workspaceContent"],
    ["main"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-return-complete",
    ["main"],
    ["terminal", "workspaceContent"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-return-drop-requested",
    ["main"],
    ["terminal", "workspaceContent"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-return-failed",
    ["main"],
    ["terminal", "workspaceContent"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-return-requested",
    ["terminal", "workspaceContent"],
    ["main"],
    "content",
    { pty: "terminal", file: "workspaceContent" },
  ],
  [
    "content-handoff-state-changed",
    ["workspaceContent"],
    ["main"],
    "content",
    { file: "workspaceContent" },
  ],
];

// The send call shapes: the fixed pattern of the m6-091 table, and a whitespace-tolerant
// variant, because prettier breaks port calls after `ports`.
const SEND_CALL =
  /(?:sendContentHandoff|ports\.emit)\(\s*([^,]+?),\s*"(pty|file)",\s*"([a-z-]+)"/g;
const SEND_CALL_TOLERANT =
  /(?:sendContentHandoff|\bports\s*\.emit)\(\s*([^,]+?),\s*"(pty|file)",\s*"([a-z-]+)"/g;

describe("window message contract", () => {
  it("lists exactly the protocol message types plus the two preference types", () => {
    const contract = messages.items.map((message) => message.type).sort();
    const expected = [
      "content-handoff-attached",
      "content-handoff-exited",
      "content-handoff-failed",
      "content-handoff-flush-complete",
      "content-handoff-flush-requested",
      "content-handoff-init",
      "content-handoff-ready",
      "content-handoff-return-complete",
      "content-handoff-return-drop-requested",
      "content-handoff-return-failed",
      "content-handoff-return-requested",
      "content-handoff-state-changed",
      APP_PREFERENCES_REQUEST_MESSAGE,
      APP_PREFERENCES_REPLY_MESSAGE,
    ].sort();

    expect(contract).toEqual(expected);
    expect(contract).toHaveLength(14);
    expect([...CONTENT_HANDOFF_MESSAGE_TYPES].sort()).toEqual(
      expected.filter((type) => type.startsWith("content-handoff-")),
    );
    expect(CONTENT_HANDOFF_MESSAGE_TYPES).toHaveLength(12);
    // Every kind and phase has a contract entry that declares that content kind.
    let declared = 0;
    for (const kind of ["pty", "file"] as const) {
      for (const phase of CONTENT_HANDOFF_PHASES[kind]) {
        const entry = messages.items.find(
          (message) => message.type === `content-handoff-${phase}`,
        );
        expect(entry?.contentKinds, `${kind}:${phase}`).toHaveProperty(kind);
      }
    }
    for (const message of messages.items) {
      declared += Object.keys(message.contentKinds ?? {}).length;
    }
    expect(declared).toBe(18);
  });

  it("declares the protocol directions literally", () => {
    expect(messages.items).toHaveLength(DIRECTIONS.length);
    for (const [type, from, to, contentKind, contentKinds] of DIRECTIONS) {
      const entry = messages.items.find((message) => message.type === type);
      expect(entry, type).toBeDefined();
      expect(entry?.from, `${type} from`).toEqual(from);
      expect(entry?.to, `${type} to`).toEqual(to);
      expect(entry?.contentKind, `${type} contentKind`).toBe(contentKind);
      if (contentKinds === null) {
        expect(entry, `${type} has no contentKinds`).not.toHaveProperty(
          "contentKinds",
        );
      } else {
        expect(entry?.contentKinds, `${type} contentKinds`).toEqual(
          contentKinds,
        );
      }
    }
    // No type is both sent and received by terminal windows.
    for (const message of messages.items) {
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
    const byType = new Map(messages.items.map((m) => [m.type, m]));
    const violations: string[] = [];
    const combos = new Set<string>();
    let sites = 0;
    for (const [path, text] of production) {
      for (const match of text.matchAll(SEND_CALL_TOLERANT)) {
        const [, target, kind, phase] = match;
        const type = `content-handoff-${phase}`;
        sites += 1;
        combos.add(`${kind}:${phase}`);
        const rule = byType.get(type);
        if (!rule) {
          violations.push(`${fileName(path)}: ${type} is not in the contract`);
          continue;
        }
        if (!rule.contentKinds || !(kind in rule.contentKinds)) {
          violations.push(`${fileName(path)}: ${type} does not carry ${kind}`);
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
    // Guard against a scan that reads nothing: 28 send calls and 18 (kind, phase) pairs at m6-091.
    expect(sites).toBe(28);
    expect(combos.size).toBe(18);
    // The fixed pattern sees the single-line calls only.
    let fixed = 0;
    for (const [, text] of production) {
      fixed += [...text.matchAll(SEND_CALL)].length;
    }
    expect(fixed).toBe(17);
  });

  it("lists the relay event in the TypeScript registry", () => {
    const names = events.items.map((event) => event.name);

    expect(RUST_EVENTS.windowMessage).toBe("window-message");
    expect(names).toContain("window-message");
    expect(names).not.toContain("workspace-content-window-event");
    expect(names).not.toContain("app-preferences-requested");
  });
});
