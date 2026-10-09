import { getAppErrorCode } from "./appErrors";

export const PTY_INPUT_MAX_CHUNK_BYTES = 65536;
export const PTY_INPUT_RETRY_DELAYS_MS = [16, 32, 64, 128, 256] as const;

export function isPtyInputBackpressure(reason: unknown): boolean {
  const code = getAppErrorCode(reason);
  return code === "pty_input_backpressure" || code === "pty.input_backpressure";
}

export interface PtyInputWriterOptions {
  getSessionId: () => string | null | undefined;
  write: (sessionId: string, data: string) => Promise<void>;
  onError: (reason: unknown) => void;
  maxChunkBytes?: number;
  retryDelaysMs?: readonly number[];
}

export interface PtyInputWriter {
  /** Resolves true when every chunk of this push was written, false otherwise. */
  push(data: string): Promise<boolean>;
  dispose(): void;
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Splits by UTF-8 byte size without splitting a code point or surrogate pair. */
export function splitUtf8Chunks(data: string, maxChunkBytes: number): string[] {
  if (maxChunkBytes < 4) {
    throw new RangeError("maxChunkBytes must be at least 4");
  }
  const chunks: string[] = [];
  let start = 0;
  let unitIndex = 0;
  let bytes = 0;
  for (const character of data) {
    const size = utf8Length(character.codePointAt(0) ?? 0);
    if (bytes + size > maxChunkBytes) {
      chunks.push(data.slice(start, unitIndex));
      start = unitIndex;
      bytes = 0;
    }
    bytes += size;
    unitIndex += character.length;
  }
  if (unitIndex > start) chunks.push(data.slice(start, unitIndex));
  return chunks;
}

interface Batch {
  remaining: number;
  failed: boolean;
  settled: boolean;
  resolve: (written: boolean) => void;
}

interface QueuedChunk {
  sessionId: string;
  chunk: string;
  batch: Batch;
}

export function createPtyInputWriter(
  options: PtyInputWriterOptions,
): PtyInputWriter {
  const maxChunkBytes = options.maxChunkBytes ?? PTY_INPUT_MAX_CHUNK_BYTES;
  if (maxChunkBytes < 4) {
    throw new RangeError("maxChunkBytes must be at least 4");
  }
  const retryDelays = options.retryDelaysMs ?? PTY_INPUT_RETRY_DELAYS_MS;
  const queue: QueuedChunk[] = [];
  let sending = false;
  let disposed = false;
  let retryCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const settle = (batch: Batch, written: boolean) => {
    if (batch.settled) return;
    batch.settled = true;
    batch.resolve(written);
  };

  const dropBatch = (batch: Batch) => {
    batch.failed = true;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].batch === batch) queue.splice(index, 1);
    }
    settle(batch, false);
  };

  const pump = async () => {
    if (sending || disposed) return;
    sending = true;
    try {
      while (!disposed && queue.length > 0) {
        const item = queue[0];
        try {
          await options.write(item.sessionId, item.chunk);
        } catch (reason) {
          if (disposed) return;
          if (isPtyInputBackpressure(reason)) {
            if (retryCount < retryDelays.length) {
              const delay = retryDelays[retryCount];
              retryCount += 1;
              await new Promise<void>((resolve) => {
                wake = resolve;
                timer = setTimeout(() => {
                  timer = undefined;
                  wake = undefined;
                  resolve();
                }, delay);
              });
              continue;
            }
            retryCount = 0;
            dropBatch(item.batch);
          } else {
            retryCount = 0;
            while (queue.length > 0) dropBatch(queue[0].batch);
          }
          options.onError(reason);
          continue;
        }
        retryCount = 0;
        queue.shift();
        item.batch.remaining -= 1;
        if (item.batch.remaining === 0) {
          settle(item.batch, !item.batch.failed);
        }
      }
    } finally {
      sending = false;
    }
  };

  return {
    push(data) {
      if (disposed) return Promise.resolve(false);
      if (data.length === 0) return Promise.resolve(true);
      const sessionId = options.getSessionId();
      if (!sessionId) return Promise.resolve(false);
      const chunks = splitUtf8Chunks(data, maxChunkBytes);
      return new Promise<boolean>((resolve) => {
        const batch: Batch = {
          remaining: chunks.length,
          failed: false,
          settled: false,
          resolve,
        };
        for (const chunk of chunks) queue.push({ sessionId, chunk, batch });
        void pump();
      });
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      wake?.();
      wake = undefined;
      while (queue.length > 0) dropBatch(queue[0].batch);
    },
  };
}
