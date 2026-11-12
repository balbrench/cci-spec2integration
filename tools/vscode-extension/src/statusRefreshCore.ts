// Status refresh scheduling — decides which integration folder a file change
// belongs to and runs scripts/refresh-status.ps1 for it, debounced.
//
// This is the extension-side stand-in for the PostToolUse hook, which a managed
// policy (allowManagedHooksOnly) can switch off. It also sees edits the hook
// never could: shell and script writes, git checkouts, and edits made outside
// Claude Code. Where the hook does run, both refreshes are harmless: the
// script is idempotent.
//
// No `vscode` import: unit-tested in plain Node.

/** Key for "every integration" (a change to an input shared by all of them). */
export const ALL = '*';

const IGNORED_SEGMENTS = new Set(['bin', 'obj', 'node_modules', '.azurite', '.git', '.vs']);

/**
 * What a change to `rel` (a repo-relative path, either slash) should refresh:
 * an integration folder (`specs/<d>/NNN-x` or `specs/NNN-x`), ALL, or nothing.
 */
export function refreshTargetFor(rel: string): string | undefined {
  const parts = rel.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return undefined;

  // Inputs shared by every integration (mirrors the hook's global inputs).
  const p = parts.join('/');
  if (p === '.spec2integration/state.json') return ALL;
  if (parts[0] !== 'specs') return undefined;
  if (parts.length === 2 && parts[1] === 'PRD.md') return ALL;
  if (parts.length === 3 && parts[1] === 'biztalk' && parts[2].endsWith('.md')) return ALL;

  if (parts.some((s) => IGNORED_SEGMENTS.has(s))) return undefined;
  const nnn = (s: string) => /^\d{3}-/.test(s);
  let folderParts: string[] | undefined;
  if (parts.length >= 3 && nnn(parts[1])) folderParts = parts.slice(0, 2);
  else if (parts.length >= 4 && nnn(parts[2])) folderParts = parts.slice(0, 3);
  if (!folderParts) return undefined;

  // The script's own output must not trigger another run.
  const inside = parts.slice(folderParts.length).join('/');
  if (inside === 'status.json') return undefined;
  return folderParts.join('/');
}

export interface SchedulerOptions {
  /** Quiet period after the last change before running, in ms. */
  delayMs: number;
  /** Refresh one target (a folder, or ALL). Resolves when done; may reject. */
  run(target: string): Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Per-target debounce with no overlap: a burst of changes gives one run after
 * the quiet period; changes during a run give exactly one follow-up run. An ALL
 * run covers every pending folder, so they are dropped when it is queued.
 */
export class RefreshScheduler {
  private readonly opts: Required<SchedulerOptions>;
  private readonly timers = new Map<string, unknown>();
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();
  private disposed = false;

  constructor(opts: SchedulerOptions) {
    this.opts = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  /** Note a change to a target. */
  touch(target: string): void {
    if (this.disposed) return;
    if (target === ALL) {
      for (const k of [...this.timers.keys()]) if (k !== ALL) this.cancel(k);
    } else if (this.timers.has(ALL)) {
      return; // the pending ALL run covers it
    }
    if (this.running.has(target)) {
      this.again.add(target);
      return;
    }
    this.cancel(target);
    this.timers.set(target, this.opts.setTimer(() => void this.fire(target), this.opts.delayMs));
  }

  private cancel(target: string): void {
    const t = this.timers.get(target);
    if (t !== undefined) {
      this.opts.clearTimer(t);
      this.timers.delete(target);
    }
  }

  private async fire(target: string): Promise<void> {
    this.timers.delete(target);
    this.running.add(target);
    try {
      await this.opts.run(target);
    } catch {
      // The runner reports its own errors; a failure must not stop later runs.
    } finally {
      this.running.delete(target);
    }
    if (this.again.delete(target)) this.touch(target);
  }

  /** True while anything is pending or running. */
  get busy(): boolean {
    return this.timers.size > 0 || this.running.size > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const k of [...this.timers.keys()]) this.cancel(k);
    this.again.clear();
  }
}
