import type { SensorSnapshot } from './sensors.js';

/**
 * Raw readout for the phone (ARCHITECTURE.md 7.2, Phase 1).
 *
 * Deliberately raw: this is the value the PC receives, so if the canonical
 * numbers on the game screen look wrong, comparing the two ends says whether
 * the phone or the normaliser is at fault.
 */

const ORIENTATION_NAMES = ['portrait', 'landscape', 'portrait-2', 'landscape-2'] as const;

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits).padStart(7);
}

export function formatSnapshot(snapshot: SensorSnapshot, sent: number, hz: number): string {
  const { orientation, rotationRate, acceleration, screenOrientation } = snapshot;
  return [
    `orient  a${fixed(orientation.alpha)} b${fixed(orientation.beta)} g${fixed(orientation.gamma)}`,
    `rate    a${fixed(rotationRate.alpha)} b${fixed(rotationRate.beta)} g${fixed(rotationRate.gamma)}`,
    `accel   x${fixed(acceleration.x, 2)} y${fixed(acceleration.y, 2)} z${fixed(acceleration.z, 2)}`,
    `screen  ${ORIENTATION_NAMES[screenOrientation] ?? '?'} (${screenOrientation})`,
    `sent    ${sent} frames @ ${hz.toFixed(0)} Hz`,
  ].join('\n');
}
