import * as CryptoJS from 'crypto-js';

/**
 * The encrypted string embeds its own IV and key:
 *   [0..31]   → IV (32 hex chars)
 *   [32..-32] → ciphertext (hex-encoded)
 *   [-32..]   → AES key (32 UTF-8 chars)
 */
export function decrypt(data: string): unknown {
  const iv = CryptoJS.enc.Hex.parse(data.slice(0, 32));
  const secret = CryptoJS.enc.Utf8.parse(data.slice(-32));
  const encryptedData = data.slice(32, -32);

  const bytes = CryptoJS.AES.decrypt(encryptedData, secret, {
    iv,
    mode: CryptoJS.mode.CBC,
    format: CryptoJS.format.Hex,
  });

  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
}
