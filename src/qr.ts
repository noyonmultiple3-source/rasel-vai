// src/qr.ts
// QR code image generator — returns a PNG Buffer from a URI string.

import QRCode from 'qrcode';

/**
 * Generates a QR code PNG buffer from the given text/URI.
 */
export async function generateQrBuffer(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}
