// Dispatch tracker — matches Claude Code hook events to the commands the
// extension sent to the chat (Phase 4, Change 0b).
//
// The extension can't see which chat a pre-filled prompt ends up in, so a
// dispatch is matched to a session like this:
//   * if the dispatch went to a known session (spec2integration.continueSession),
//     only events from that session match it;
//   * otherwise the first event from any session after the dispatch claims it,
//     and from then on only that session's events match.
// `Stop` fires after every response, not once per command, so a dispatch stays
// "running" until a Stop arrives, and later Stops just refresh `lastStopAt`. A
// newer dispatch for the same session supersedes the older one.
//
// No `vscode` import: unit-tested in plain Node.

export interface Dispatch {
  id: number;
  /** The slash command as sent (first token, e.g. /architect). */
  command: string;
  folder?: string;
  stageId?: string;
  /** Epoch ms when it was sent. */
  sentAt: number;
  /** The Claude Code session it ran in, once known. */
  sessionId?: string;
  state: 'running' | 'idle';
  /** Latest SubagentStop's agent type, for progress display. */
  lastAgent?: string;
  lastStopAt?: number;
  /** The last assistant message from the latest Stop, if the hook sent one. */
  lastMessage?: string;
}

/** The hook event fields this module reads. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  agent_type?: string;
  last_assistant_message?: string;
}

export interface MatchResult {
  dispatch: Dispatch;
  /** True when this event moved the dispatch from running to idle. */
  finished: boolean;
}

export class DispatchTracker {
  private nextId = 1;
  private readonly dispatches: Dispatch[] = [];
  private readonly now: () => number;
  private readonly keep: number;

  // Plain fields, not parameter properties: Node's type stripping can't run those.
  constructor(now: () => number = Date.now, keep = 20) {
    this.now = now;
    this.keep = keep;
  }

  record(d: { command: string; folder?: string; stageId?: string; sessionId?: string }): Dispatch {
    const dispatch: Dispatch = {
      id: this.nextId++,
      command: d.command.trim().split(/\s+/)[0],
      folder: d.folder,
      stageId: d.stageId,
      sessionId: d.sessionId,
      sentAt: this.now(),
      state: 'running',
    };
    this.dispatches.push(dispatch);
    if (this.dispatches.length > this.keep) this.dispatches.splice(0, this.dispatches.length - this.keep);
    return dispatch;
  }

  /** Newest first. */
  list(): readonly Dispatch[] {
    return [...this.dispatches].reverse();
  }

  /** The dispatch an event belongs to, claiming an unbound one if needed. */
  private match(sessionId: string): Dispatch | undefined {
    // Newest dispatch already bound to this session.
    for (let i = this.dispatches.length - 1; i >= 0; i--) {
      if (this.dispatches[i].sessionId === sessionId) {
        // An unbound dispatch sent after it wins: the user ran the newer command here.
        const newer = this.firstUnboundAfter(this.dispatches[i].sentAt);
        if (newer) {
          newer.sessionId = sessionId;
          return newer;
        }
        return this.dispatches[i];
      }
    }
    const unbound = this.firstUnboundAfter(-Infinity);
    if (unbound) unbound.sessionId = sessionId;
    return unbound;
  }

  private firstUnboundAfter(t: number): Dispatch | undefined {
    return this.dispatches.find((d) => !d.sessionId && d.state === 'running' && d.sentAt > t);
  }

  /** Apply a hook event. Returns the dispatch it matched, or undefined. */
  handle(event: HookEvent): MatchResult | undefined {
    const sessionId = event.session_id;
    if (!sessionId) return undefined;
    const name = event.hook_event_name;
    if (name !== 'Stop' && name !== 'SubagentStop') return undefined;
    const d = this.match(sessionId);
    if (!d) return undefined;
    if (name === 'SubagentStop') {
      if (event.agent_type) d.lastAgent = event.agent_type;
      return { dispatch: d, finished: false };
    }
    const finished = d.state === 'running';
    d.state = 'idle';
    d.lastStopAt = this.now();
    if (typeof event.last_assistant_message === 'string') d.lastMessage = event.last_assistant_message;
    return { dispatch: d, finished };
  }
}
