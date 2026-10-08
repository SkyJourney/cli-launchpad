/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import { en } from "../i18n/locales/en";
import type {
  LatestVersion,
  ProjectFileOpenResult,
  WorkspaceLayoutDocument,
  WorkspaceLayoutSaveResult,
} from "./tauri";
import { createWorkspaceFileBuffer } from "./workspaceFileBuffer";
import {
  createWorkspaceLayoutDocument,
  WorkspaceLayoutSaveQueue,
} from "./workspaceLayoutPersistence";

interface FixtureFile {
  schema: number;
  type: string;
  cases: Array<{ name: string; value: Record<string, unknown> }>;
}

const REGENERATE =
  "先运行 Rust 测试生成 fixture：UPDATE_CONTRACT_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --locked golden_fixtures";

const fixtures = import.meta.glob("../../contracts/fixtures/*.json", {
  eager: true,
  import: "default",
}) as Record<string, FixtureFile>;

// 期望的 12 个 fixture 文件与对应的 Rust 类型名；这里独立声明，不从 Rust 侧映射推导。
const EXPECTED_FIXTURES: Record<string, string> = {
  "app-error.json": "AppError",
  "cli-status.json": "CliStatus",
  "execution-task.json": "ExecutionTask",
  "install-plan.json": "InstallPlan",
  "managed-update-status.json": "ManagedUpdateStatus",
  "project-file-open-result.json": "ProjectFileOpenResult",
  "project-text-file-save-result.json": "ProjectTextFileSaveResult",
  "pty-event.json": "PtyEvent",
  "pty-session-window-status.json": "PtySessionWindowStatus",
  "workspace-layout-apply-plan.json": "WorkspaceLayoutApplyPlan",
  "workspace-layout-save-result.json": "WorkspaceLayoutSaveResult",
  "workspace-layout-state-read.json": "WorkspaceLayoutStateRead",
};

// 前端按判别键读取的 4 个联合类型：fixture 里的分支必须与这里的字面量一一对应。
const DISCRIMINATED_UNIONS: Array<{
  file: string;
  key: string;
  branches: string[];
}> = [
  {
    file: "project-file-open-result.json",
    key: "kind",
    branches: ["text", "image", "unsupported"],
  },
  {
    file: "project-text-file-save-result.json",
    key: "kind",
    branches: ["saved", "conflict"],
  },
  {
    file: "managed-update-status.json",
    key: "status",
    branches: ["allowed", "denied", "notApplicable"],
  },
  {
    file: "pty-event.json",
    key: "type",
    branches: ["output", "snapshot", "exited", "failed"],
  },
];

function fixtureFile(file: string): FixtureFile {
  const entry = Object.entries(fixtures).find(([path]) =>
    path.endsWith(`/${file}`),
  );
  expect(entry, `${file} 不存在。${REGENERATE}`).toBeDefined();
  return entry![1];
}

function fixtureCase(file: string, name: string) {
  const found = fixtureFile(file).cases.find((item) => item.name === name);
  expect(found, `${file} 缺少 case ${name}`).toBeDefined();
  return found!.value;
}

describe("IPC DTO golden fixtures", () => {
  it("builds an image preview data URL from the Rust-serialized image result", () => {
    const value = fixtureCase("project-file-open-result.json", "image");
    const image = value as {
      kind: "image";
      mimeType: string;
      base64Data: string;
    };
    const file: ProjectFileOpenResult = image;

    const buffer = createWorkspaceFileBuffer(file, 0);

    expect(buffer.kind).toBe("image");
    if (buffer.kind !== "image") throw new Error("expected an image buffer");
    const preview = buffer.previewDataUrl ?? "";
    expect(preview.startsWith("data:image/")).toBe(true);
    expect(preview).not.toContain("undefined");
    // 反向：Rust 侧不能再输出 snake_case 键。
    const raw = JSON.stringify(value);
    expect(raw).not.toContain("mime_type");
    expect(raw).not.toContain("base64_data");
  });

  it("exposes the managed update denial reason key from the Rust-serialized status", () => {
    const value = fixtureCase("managed-update-status.json", "denied");
    const denied = value as { status: "denied"; reasonKey: string };
    const typed: Extract<LatestVersion["managedUpdate"], { status: "denied" }> =
      denied;

    expect(typeof typed.reasonKey).toBe("string");
    expect(typed.reasonKey.length).toBeGreaterThan(0);
    // 与 SettingsView 读取 managedUpdate.reasonKey 的方式一致：用它去翻译字典里取文案。
    const message = typed.reasonKey
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en,
      );
    expect(typeof message).toBe("string");
    expect((message as string).length).toBeGreaterThan(0);
    expect("reason_key" in value).toBe(false);
  });

  it("covers every variant fixture exported by the Rust golden fixture generator", () => {
    const paths = Object.keys(fixtures);
    expect(paths.length, REGENERATE).toBe(12);
    const names = paths.map((path) => path.split("/").pop() as string).sort();
    expect(names).toEqual(Object.keys(EXPECTED_FIXTURES).sort());

    for (const [file, typeName] of Object.entries(EXPECTED_FIXTURES)) {
      const fixture = fixtureFile(file);
      expect(fixture.schema, file).toBe(1);
      expect(fixture.type, file).toBe(typeName);
      expect(fixture.cases.length, file).toBeGreaterThan(0);
      const caseNames = fixture.cases.map((item) => item.name);
      expect(new Set(caseNames).size, `${file} case 名重复`).toBe(
        caseNames.length,
      );
    }

    for (const { file, key, branches } of DISCRIMINATED_UNIONS) {
      const seen = new Set(
        fixtureFile(file).cases.map((item) => String(item.value[key])),
      );
      expect([...seen].sort(), `${file} 的 ${key} 分支`).toEqual(
        [...branches].sort(),
      );
    }

    // 反向：任何 fixture 都不能含 snake_case 键。
    for (const [path, fixture] of Object.entries(fixtures)) {
      expect(JSON.stringify(fixture), path).not.toMatch(
        /"[a-z0-9]+_[a-z0-9_]+"\s*:/,
      );
    }
  });

  it("drives the layout save queue from the Rust-serialized save results", async () => {
    const result = (name: string) =>
      fixtureCase(
        "workspace-layout-save-result.json",
        name,
      ) as unknown as WorkspaceLayoutSaveResult;
    const document: WorkspaceLayoutDocument = createWorkspaceLayoutDocument({
      tree: {
        kind: "pane",
        id: "pane-1",
        paneNumber: 1,
        contents: [],
        activeContent: null,
      },
      focusedPaneId: "pane-1",
      slots: [],
      documents: [],
      detachedContents: [],
    });

    // reason 只能是前端联合类型里声明的两个取值（或缺省）。
    for (const { value } of fixtureFile("workspace-layout-save-result.json")
      .cases) {
      expect([undefined, "stale", "incompatible"]).toContain(value.reason);
    }
    expect(result("saved").saved).toBe(true);
    expect("reason" in result("saved")).toBe(false);

    // saved：只触发 onSaved，不报错。
    const onSaved = vi.fn();
    const onError = vi.fn();
    const savedQueue = new WorkspaceLayoutSaveQueue(
      2,
      vi.fn(async () => result("saved")),
      onError,
      onSaved,
    );
    savedQueue.enqueue(document);
    await savedQueue.flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // stale：以返回的 revision 为基准再试一次，随后成功。
    const staleSave = vi
      .fn()
      .mockResolvedValueOnce(result("stale"))
      .mockResolvedValueOnce(result("saved"));
    const staleQueue = new WorkspaceLayoutSaveQueue(2, staleSave, onError);
    staleQueue.enqueue(document);
    await staleQueue.flush();
    expect(staleSave).toHaveBeenCalledTimes(2);
    expect(staleSave.mock.calls[0]?.[0]).toBe(3);
    expect(staleSave.mock.calls[1]?.[0]).toBe(result("stale").revision + 1);
    expect(onError).not.toHaveBeenCalled();

    // incompatible：不重试，上报一次 layout.schema_incompatible。
    const incompatibleSave = vi.fn(async () => result("incompatible"));
    const incompatibleQueue = new WorkspaceLayoutSaveQueue(
      2,
      incompatibleSave,
      onError,
    );
    incompatibleQueue.enqueue(document);
    await incompatibleQueue.flush();
    expect(incompatibleSave).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].code).toBe("layout.schema_incompatible");
  });
});
