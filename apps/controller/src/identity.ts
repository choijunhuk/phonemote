/**
 * A stable id for this phone (ARCHITECTURE.md 11, Phase 4).
 *
 * The server holds a player's slot for a few seconds after a drop; this is what
 * lets the phone prove it is the same player when it comes back. Losing the
 * value is harmless — the phone simply rejoins as a new player.
 */

const STORAGE_KEY = 'phonemote.clientId';

export function clientId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    // Private mode or storage disabled: a fresh id per session still works.
    return crypto.randomUUID();
  }
}
