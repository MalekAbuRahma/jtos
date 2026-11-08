import { createHash, randomBytes, randomInt } from 'crypto';
import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (p: string) => hash(p);
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const randomToken = () => randomBytes(32).toString('base64url');
