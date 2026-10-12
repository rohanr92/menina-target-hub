// UPC / EAN rules from Target's "Barcode Requirements" doc.
import { randomInt } from 'node:crypto';

export function checkDigit(body: string): number {
  // GS1 mod-10: weights 3,1,3,1... from the right of the body
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function hasValidChecksum(code: string): boolean {
  return /^\d+$/.test(code) && checkDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

export interface BarcodeCheck { ok: boolean; level: 'error' | 'warning' | 'ok'; message: string }

export function validateBarcode(raw: string | null | undefined): BarcodeCheck {
  const code = (raw ?? '').trim();
  if (!code) return { ok: false, level: 'error', message: 'Barcode is required for SA and VC items' };
  if (!/^\d+$/.test(code)) return { ok: false, level: 'error', message: 'Barcode must be digits only' };
  if (code.length === 11 || code.length === 14) return { ok: false, level: 'error', message: `${code.length}-digit codes are invalid for Target (use 12-digit UPC or 13-digit EAN)` };
  if (code.length === 12) {
    if (!hasValidChecksum(code)) return { ok: false, level: 'error', message: 'UPC checksum is invalid' };
    if ('245'.includes(code[0])) return { ok: false, level: 'error', message: `UPCs starting with ${code[0]} are rejected` };
    if (code[0] === '3') return { ok: true, level: 'warning', message: 'UPCs starting with 3 need Category Manager approval' };
    return { ok: true, level: 'ok', message: 'Valid UPC' };
  }
  if (code.length === 13) {
    if (!hasValidChecksum(code)) return { ok: false, level: 'error', message: 'EAN checksum is invalid' };
    if (code[0] === '0') return { ok: false, level: 'error', message: 'EANs starting with 0 are invalid' };
    if (code.startsWith('99')) return { ok: false, level: 'error', message: 'EANs starting with 99 are coupon codes' };
    return { ok: true, level: 'ok', message: 'Valid EAN' };
  }
  return { ok: false, level: 'error', message: 'Barcode must be a 12-digit UPC or 13-digit EAN' };
}

/** Random UPC-A with valid checksum, for the STAGE environment only. */
export function mockUpc(): string {
  const first = ['6', '7', '8', '9'][randomInt(4)];
  let body = first;
  while (body.length < 11) body += String(randomInt(10));
  return body + checkDigit(body);
}
