/**
 * UUIDv7 generator (RFC 9562 draft) — opaque, time-ordered string IDs.
 *
 * Used by V2 schema records (anchor bindings, optical sources, ports, etc.)
 * The first 48 bits are unix-ms time, so ids generated later sort
 * lexicographically after earlier ones.
 *
 * Output: 36-char canonical hyphenated string.
 */

export function uuid7(): string {
  const tsMs = Date.now();
  // 48-bit timestamp, big-endian
  const tsHex = tsMs.toString(16).padStart(12, "0");

  // 10 bytes of randomness for rand_a (12 bits) + rand_b (62 bits + 2 variant bits)
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  // First 12 bits of randomness (rand_a) — combined with version 7 nibble
  const randA = ((rand[0] << 8) | rand[1]) & 0x0fff;
  const verRandA = (0x7 << 12) | randA;

  // Next 62 bits — first 2 bits replaced with variant 10
  let high62 = (rand[2] & 0x3f) | 0x80; // top byte: variant 10 + 6 random bits
  const randBHex =
    high62.toString(16).padStart(2, "0") +
    [...rand.slice(3, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return [
    tsHex.slice(0, 8),                    // 8 hex = 32 bits
    tsHex.slice(8, 12),                   // 4 hex = 16 bits  → first 48 bits = ts
    verRandA.toString(16).padStart(4, "0"), // 4 hex = 16 bits (ver + rand_a)
    randBHex.slice(0, 4),                 // 4 hex = 16 bits (variant + 14 rand)
    randBHex.slice(4),                    // 12 hex = 48 bits (rand_b tail)
  ].join("-");
}
