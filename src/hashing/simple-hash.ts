/**
 * Used in UI activity view's renderRow to check if a displayed row is dirty
 * and needs replacing. Without a simple dirty check all rows will keep on being replaced unnecessarily.
 */
const OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function simpleHash(str: string): string {

  // Serialize deterministic key/values (sorts keys to avoid false positives)
  // const str = JSON.stringify(obj, Object.keys(obj).sort());

  // 32-bit FNV-1a hash
  let hash = OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME); // 32-bit integer multiplication
  }

  // Convert to unsigned 32-bit hex string
  return (hash >>> 0).toString(16);
}
