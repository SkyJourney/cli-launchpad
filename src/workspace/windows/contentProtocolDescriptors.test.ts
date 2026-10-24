import { describe, expect, it } from "vitest";
import {
  CONTENT_KIND_ID_FIELD,
  REGISTERED_CONTENT_KINDS,
} from "../../generated/contentKinds";
import { workspaceContentKey } from "../../lib/workspaceContentKey";
import { CONTENT_PROTOCOLS, contentProtocolOf } from "./contentProtocolDescriptors";

describe("content protocol descriptors", () => {
  it("has exactly one descriptor per registered content kind", () => {
    expect(Object.keys(CONTENT_PROTOCOLS).sort()).toEqual(
      [...REGISTERED_CONTENT_KINDS].sort(),
    );
  });

  it("builds references and keys through the contract's id field", () => {
    for (const kind of REGISTERED_CONTENT_KINDS) {
      const descriptor = contentProtocolOf(kind);
      expect(descriptor.kind).toBe(kind);
      const ref = descriptor.refOf("sample-id");
      expect(ref.kind).toBe(kind);
      expect((ref as unknown as Record<string, string>)[CONTENT_KIND_ID_FIELD[kind]]).toBe("sample-id");
      // 键与工作区内容 key 一致：协议与宿主用同一套身份。
      expect(descriptor.keyOf("sample-id")).toBe(workspaceContentKey(ref));
    }
  });

  it("records the wire identity field per kind, and only pty differs from its contract field", () => {
    expect(contentProtocolOf("file").wireIdField).toBe(
      CONTENT_KIND_ID_FIELD.file,
    );
    // 已知且有意的差异：PTY 槽位模型的身份字段叫 instanceId，内容引用叫 slotId。
    expect(contentProtocolOf("pty").wireIdField).toBe("instanceId");
    expect(CONTENT_KIND_ID_FIELD.pty).toBe("slotId");
  });
});
