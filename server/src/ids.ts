import crypto from 'node:crypto';

export function newId(): string {
  return crypto.randomUUID();
}
