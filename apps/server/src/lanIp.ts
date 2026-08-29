import { networkInterfaces } from 'node:os';

/**
 * LAN IP resolution (ARCHITECTURE.md 2.1).
 *
 * The phone has to reach the PC by IP, and the certificate has to carry that
 * exact IP in its SAN list, so every process must agree on one address.
 */

export interface LanIpCandidate {
  readonly name: string;
  readonly address: string;
}

export interface LanIpResolution {
  readonly host: string;
  readonly source: 'env' | 'auto';
  readonly candidates: readonly LanIpCandidate[];
}

/** Interfaces that are up but never the LAN a phone can reach. */
const VIRTUAL_INTERFACE_PATTERNS = [
  'docker',
  'veth',
  'vmnet',
  'vethernet',
  'tailscale',
  'wsl',
  'br-',
];

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_INTERFACE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function listLanIpCandidates(): LanIpCandidate[] {
  const candidates: LanIpCandidate[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses || isVirtualInterface(name)) continue;
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isPrivateIpv4(address.address)) continue;
      candidates.push({ name, address: address.address });
    }
  }
  return candidates;
}

/**
 * PHONEMOTE_HOST always wins. Otherwise the first private, non-virtual IPv4
 * address is used and every candidate is reported so the caller can print them.
 */
export function resolveLanIp(): LanIpResolution {
  const fromEnv = process.env['PHONEMOTE_HOST']?.trim();
  const candidates = listLanIpCandidates();
  if (fromEnv) {
    return { host: fromEnv, source: 'env', candidates };
  }
  const first = candidates[0];
  if (!first) {
    throw new Error(
      'No private LAN IPv4 address found. Connect to your Wi-Fi/LAN, or set ' +
        'PHONEMOTE_HOST=<ip> explicitly.',
    );
  }
  return { host: first.address, source: 'auto', candidates };
}
