import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';

/**
 * Column encryption for passport / ID numbers (AES-256-GCM).
 * Key: DATA_KEY (32 bytes, base64). Staging falls back to a key derived from JWT_SECRET.
 */
function key(): Buffer {
  const k = process.env.DATA_KEY;
  if (k) {
    const b = Buffer.from(k, 'base64');
    if (b.length !== 32) throw new Error('DATA_KEY must be 32 bytes (base64)');
    return b;
  }
  return createHash('sha256').update(`jtos-data:${process.env.JWT_SECRET ?? 'test-secret-at-least-16'}`).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Keyed hash so the same document can be matched without storing the number. */
export function docHash(docNumber: string): string {
  return createHmac('sha256', key()).update(docNumber.replace(/\s/g, '').toUpperCase()).digest('hex');
}

export function maskDoc(n: string): string {
  return n.length <= 3 ? '***' : `${'•'.repeat(Math.max(0, n.length - 3))}${n.slice(-3)}`;
}
