import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

/**
 * Phase 2 DoD: whatever the lobby renders must decode back to the exact URL
 * the server sent. The lobby never assembles that URL itself, so a mismatch
 * here would mean the QR itself is lying.
 *
 * The code is rendered straight from the module matrix into an RGBA buffer,
 * which keeps an image decoder out of the test.
 */

const SCALE = 4;
const QUIET_ZONE = 4;

async function renderToPixels(text: string): Promise<{
  data: Uint8ClampedArray;
  size: number;
}> {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const size = (moduleCount + QUIET_ZONE * 2) * SCALE;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);

  for (let row = 0; row < moduleCount; row++) {
    for (let column = 0; column < moduleCount; column++) {
      if (!qr.modules.get(row, column)) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const x = (column + QUIET_ZONE) * SCALE + dx;
          const y = (row + QUIET_ZONE) * SCALE + dy;
          const offset = (y * size + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    }
  }

  return { data, size };
}

async function roundTrip(text: string): Promise<string | null> {
  const { data, size } = await renderToPixels(text);
  return jsQR(data, size, size)?.data ?? null;
}

describe('lobby QR code', () => {
  it('decodes back to the controller URL', async () => {
    const controllerUrl = 'https://192.168.0.2:5174/?room=GVLF';
    expect(await roundTrip(controllerUrl)).toBe(controllerUrl);
  });

  it('survives the room codes the server can generate', async () => {
    for (const code of ['AAAA', 'ZZZZ', '2345', 'X7Q9']) {
      const url = `https://10.0.0.42:5174/?room=${code}`;
      expect(await roundTrip(url)).toBe(url);
    }
  });
});
