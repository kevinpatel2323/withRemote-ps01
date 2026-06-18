/**
 * Thrown by a connector when its incremental cursor is no longer usable
 * (expired/purged/410). The orchestrator catches this and falls back to a full
 * backfill (PLAN §7). Connectors may also classify source-native errors as stale
 * via `isStaleCursorError`.
 */
export class StaleCursorError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StaleCursorError';
  }
}
