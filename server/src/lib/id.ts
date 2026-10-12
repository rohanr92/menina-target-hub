import { randomBytes } from 'node:crypto';
// Short, sortable-ish unique ids (time prefix + random)
export function createId(): string {
  return Date.now().toString(36) + randomBytes(6).toString('hex');
}
