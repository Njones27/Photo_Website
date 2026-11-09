import { createHash, timingSafeEqual } from 'node:crypto';

/** Secrets shorter than this are treated as missing: setup_initial.sh makes 64 hex characters. */
export const MIN_SECRET_LENGTH = 32;

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Compares two secrets without leaking how much of them matched, whatever their lengths. */
export const secretsEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));
