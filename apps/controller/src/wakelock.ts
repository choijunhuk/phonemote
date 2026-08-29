/**
 * Keeps the screen awake while playing. A phone that sleeps stops sending
 * sensor events, and Android drops the lock whenever the page is hidden, so it
 * has to be taken again on the way back (ARCHITECTURE.md 7.2).
 */

let sentinel: WakeLockSentinel | null = null;

export function isWakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

export async function requestWakeLock(): Promise<boolean> {
  if (!isWakeLockSupported()) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    // Denied or not allowed right now; the game still works, the screen just dims.
    return false;
  }
}

export function watchVisibility(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sentinel === null) void requestWakeLock();
  });
}

export function releaseWakeLock(): void {
  void sentinel?.release();
  sentinel = null;
}
