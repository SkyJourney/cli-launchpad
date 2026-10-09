/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import terminalSource from "../components/PtyTerminal.tsx?raw";
import {
  PTY_INPUT_MAX_CHUNK_BYTES,
  PTY_INPUT_RETRY_DELAYS_MS,
  createPtyInputWriter,
  isPtyInputBackpressure,
  splitUtf8Chunks,
} from "./ptyInputWriter";

const backpressure = { code: "pty_input_backpressure" };

// 前端 tsconfig 没有 Node 类型，所以不用 Buffer.byteLength（文档规格）；按 UTF-8 字节计数等价。
const byteLength = (text: string) => new TextEncoder().encode(text).length;

function fixture() {
  const write = vi.fn<(sessionId: string, data: string) => Promise<void>>(
    async () => {},
  );
  const onError = vi.fn();
  const writer = createPtyInputWriter({
    getSessionId: () => "s1",
    write,
    onError,
  });
  return { write, onError, writer };
}

describe("PTY input writer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("splits 70 KiB of ASCII into ordered chunks no larger than 64 KiB", async () => {
    const { write, writer } = fixture();
    const text = "a".repeat(71680);

    void writer.push(text);
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(2);
    expect(byteLength(write.mock.calls[0][1])).toBe(65536);
    expect(byteLength(write.mock.calls[1][1])).toBe(6144);
    expect(write.mock.calls[0][1] + write.mock.calls[1][1]).toBe(text);
    expect(write.mock.calls.map((call) => call[0])).toEqual(["s1", "s1"]);
  });

  it("never splits a multi-byte character across chunks", async () => {
    const { write, writer } = fixture();
    const text = "汉".repeat(30000);

    void writer.push(text);
    await vi.runAllTimersAsync();

    const segments = write.mock.calls.map((call) => call[1]);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) {
      expect(byteLength(segment)).toBeLessThanOrEqual(65536);
      expect(new TextDecoder().decode(new TextEncoder().encode(segment))).toBe(
        segment,
      );
      expect(segment).not.toContain("�");
    }
    expect(segments.join("")).toBe(text);
  });

  it("never splits a surrogate pair", async () => {
    const { write, writer } = fixture();
    const text = "😀".repeat(20000);

    void writer.push(text);
    await vi.runAllTimersAsync();

    const segments = write.mock.calls.map((call) => call[1]);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) {
      const first = segment.charCodeAt(0);
      const last = segment.charCodeAt(segment.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(segments.join("")).toBe(text);
  });

  it("retries a backpressure rejection with backoff and preserves order", async () => {
    const { write, onError, writer } = fixture();
    write.mockRejectedValueOnce(backpressure);

    void writer.push("a");
    void writer.push("b");
    await vi.advanceTimersByTimeAsync(16);

    expect(write.mock.calls.map((call) => call[1])).toEqual(["a", "a", "b"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops and reports when retries are exhausted", async () => {
    const { write, onError, writer } = fixture();
    write.mockRejectedValue(backpressure);

    const first = writer.push("x");
    await vi.advanceTimersByTimeAsync(1000);

    expect(write).toHaveBeenCalledTimes(6);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: "pty_input_backpressure",
    });
    expect(await first).toBe(false);

    // 队列随后恢复：之后的输入照常写入。
    write.mockReset();
    write.mockResolvedValue(undefined);
    expect(await writer.push("y")).toBe(true);
    expect(write.mock.calls[write.mock.calls.length - 1]).toEqual(["s1", "y"]);
  });

  it("stops and reports on a non-backpressure failure", async () => {
    const { write, onError, writer } = fixture();
    write.mockRejectedValue({ code: "pty_input_unavailable" });

    const result = writer.push("x");
    await vi.advanceTimersByTimeAsync(1000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: "pty_input_unavailable",
    });
    expect(await result).toBe(false);
  });

  it("cancels pending retries on dispose", async () => {
    const { write, onError, writer } = fixture();
    write.mockRejectedValueOnce(backpressure);

    void writer.push("a");
    await vi.advanceTimersByTimeAsync(0);
    writer.dispose();
    await vi.advanceTimersByTimeAsync(1000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // 反向断言：没有遗留计时器，dispose 之后的输入也不再写入。
    expect(vi.getTimerCount()).toBe(0);
    expect(await writer.push("z")).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is the only path PtyTerminal uses to write input", () => {
    expect(terminalSource).toContain("createPtyInputWriter(");
    expect(terminalSource).not.toMatch(/writePtySession\(/);
    expect(terminalSource).toContain("isPtyInputBackpressure(");
    expect(terminalSource).not.toContain('=== "pty_input_backpressure"');
    const onData = terminalSource.slice(
      terminalSource.indexOf("terminal.onData("),
      terminalSource.indexOf("terminal.attachCustomKeyEventHandler("),
    );
    expect(onData).toContain("inputWriter.push(data)");
    expect(onData).not.toContain("writePtySession");
  });

  it("resolves true only after every chunk of the push was written", async () => {
    const write = vi.fn<(sessionId: string, data: string) => Promise<void>>(
      async () => {},
    );
    const writer = createPtyInputWriter({
      getSessionId: () => "s1",
      write,
      onError: vi.fn(),
      maxChunkBytes: 4,
    });

    // 文档规格是 maxChunkBytes: 2 与 "abcde"（ab/cd/e），同样因 >= 4 的下限放大一倍。
    const result = writer.push("abcdefghij");
    await vi.runAllTimersAsync();

    expect(await result).toBe(true);
    expect(write.mock.calls.map((call) => call[1])).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    // 反向断言：空输入不产生写入调用。
    const callsBefore = write.mock.calls.length;
    expect(await writer.push("")).toBe(true);
    expect(write.mock.calls.length).toBe(callsBefore);
  });

  it("binds the session id when the input is pushed", async () => {
    let id: string | null = "s1";
    const write = vi.fn<(sessionId: string, data: string) => Promise<void>>(
      async () => {},
    );
    const writer = createPtyInputWriter({
      getSessionId: () => id,
      write,
      onError: vi.fn(),
    });
    write.mockRejectedValueOnce(backpressure);

    void writer.push("a");
    await vi.advanceTimersByTimeAsync(0);
    id = "s2";
    await vi.advanceTimersByTimeAsync(16);
    await writer.push("b");

    expect(write.mock.calls).toEqual([
      ["s1", "a"],
      ["s1", "a"],
      ["s2", "b"],
    ]);

    // 没有会话时不写入。
    id = null;
    expect(await writer.push("c")).toBe(false);
    expect(write.mock.calls).toHaveLength(3);
  });

  it("drops the remaining chunks of an exhausted push but keeps later pushes", async () => {
    // 文档规格用 maxChunkBytes: 2（分片 ab/cd），但同一文档的实现与 E5 要求 maxChunkBytes >= 4，
    // 所以字节数整体放大一倍：分片 abcd/efgh，其余断言语义不变。
    const write = vi.fn<(sessionId: string, data: string) => Promise<void>>();
    write.mockImplementation(async (_sessionId, data) => {
      if (data === "abcd") throw backpressure;
    });
    const onError = vi.fn();
    const writer = createPtyInputWriter({
      getSessionId: () => "s1",
      write,
      onError,
      maxChunkBytes: 4,
    });

    const first = writer.push("abcdefgh");
    const second = writer.push("z");
    await vi.advanceTimersByTimeAsync(1000);

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    const sent = write.mock.calls.map((call) => call[1]);
    // 被丢弃的后半段 efgh 从未发送；z 恰好发送一次；abcd 共尝试 6 次。
    expect(sent).not.toContain("efgh");
    expect(sent.filter((data) => data === "z")).toHaveLength(1);
    expect(sent.filter((data) => data === "abcd")).toHaveLength(6);
  });

  it("rejects a chunk size smaller than the largest UTF-8 character", () => {
    const write = vi.fn<(sessionId: string, data: string) => Promise<void>>(
      async () => {},
    );
    const onError = vi.fn();

    expect(() =>
      createPtyInputWriter({
        getSessionId: () => "s1",
        write,
        onError,
        maxChunkBytes: 3,
      }),
    ).toThrow(RangeError);
    expect(() => splitUtf8Chunks("a", 3)).toThrow(RangeError);
    expect(splitUtf8Chunks("", 4)).toEqual([]);
    expect(splitUtf8Chunks("😀😀", 4)).toEqual(["😀", "😀"]);
    expect(PTY_INPUT_MAX_CHUNK_BYTES).toBe(65536);
    expect([...PTY_INPUT_RETRY_DELAYS_MS]).toEqual([16, 32, 64, 128, 256]);
  });

  it("retries the dotted backpressure code alias as well", async () => {
    const { write, onError, writer } = fixture();
    write.mockRejectedValueOnce({ code: "pty.input_backpressure" });

    void writer.push("a");
    await vi.advanceTimersByTimeAsync(16);

    expect(write.mock.calls.map((call) => call[1])).toEqual(["a", "a"]);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("PTY input backpressure classification", () => {
  it("recognizes both backpressure code spellings and nothing else", () => {
    expect(isPtyInputBackpressure({ code: "pty_input_backpressure" })).toBe(
      true,
    );
    expect(isPtyInputBackpressure({ code: "pty.input_backpressure" })).toBe(
      true,
    );
    expect(isPtyInputBackpressure({ code: "pty_input_unavailable" })).toBe(
      false,
    );
    expect(isPtyInputBackpressure({ code: "pty.input_unavailable" })).toBe(
      false,
    );
    expect(isPtyInputBackpressure({})).toBe(false);
    expect(isPtyInputBackpressure(null)).toBe(false);
    expect(isPtyInputBackpressure("pty_input_backpressure")).toBe(false);
    expect(isPtyInputBackpressure(new Error("pty_input_backpressure"))).toBe(
      false,
    );
  });
});
