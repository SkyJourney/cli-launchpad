import { UNKNOWN_PATH_SEMANTICS, type PathSemantics } from "./pathKey";
import { getProjectPathSemantics } from "./tauri";

export type FetchPathSemantics = (
  directoryId: number,
  directoryPath: string,
) => Promise<PathSemantics>;

/**
 * The path semantics the host knows per project. Unloaded projects are `unknown`, which never
 * folds. `load` is single-flight per project; a failed load answers `unknown` and registers
 * nothing, so the next call tries again. A known answer is never replaced by `unknown`.
 */
export class ProjectPathSemanticsRegistry {
  private readonly semantics = new Map<number, PathSemantics>();
  private readonly loading = new Map<number, Promise<PathSemantics>>();
  /** Bumped by `clear`: an answer that arrives after it belongs to the old layout. */
  private generation = 0;

  constructor(
    private readonly fetch: FetchPathSemantics = getProjectPathSemantics,
  ) {}

  get(directoryId: number): PathSemantics {
    return this.semantics.get(directoryId) ?? UNKNOWN_PATH_SEMANTICS;
  }

  /** Records an answer the host already holds (for example from a directory listing). */
  set(directoryId: number, semantics: PathSemantics): void {
    const known = this.semantics.get(directoryId);
    if (semantics.case === "unknown" && known && known.case !== "unknown") {
      return;
    }
    this.semantics.set(directoryId, semantics);
  }

  load(directoryId: number, directoryPath: string): Promise<PathSemantics> {
    const running = this.loading.get(directoryId);
    if (running) return running;
    const generation = this.generation;
    const request = (async () => {
      try {
        const loaded = await this.fetch(directoryId, directoryPath);
        if (generation !== this.generation) return UNKNOWN_PATH_SEMANTICS;
        this.set(directoryId, loaded);
        return this.get(directoryId);
      } catch {
        return UNKNOWN_PATH_SEMANTICS;
      }
    })();
    this.loading.set(directoryId, request);
    const done = () => {
      if (this.loading.get(directoryId) === request) {
        this.loading.delete(directoryId);
      }
    };
    void request.then(done, done);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.semantics.clear();
    this.loading.clear();
  }
}
