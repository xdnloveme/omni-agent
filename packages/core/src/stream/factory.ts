import { StreamSession } from "./stream-session.js";
import type { StreamCallbacks } from "./types.js";

/**
 * Factory function to create a StreamSession with the given callbacks.
 *
 * This is the primary entry point for consumers:
 * - TUI passes rendering callbacks
 * - Harness passes JSON-line / recording callbacks
 * - Tests pass mock callbacks
 */
export function createStreamSession(callbacks: StreamCallbacks = {}): StreamSession {
  return new StreamSession(callbacks);
}
