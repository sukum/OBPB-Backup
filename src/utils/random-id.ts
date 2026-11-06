import { Hasher } from '../hashing/hasher';

export function generateRandomId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return Hasher.hexToPocketBaseId(hex);
}
