import type { CryptoPort } from '../src/codecs/types.ts';

/**
 * A deterministic stand-in for the primitives a signing codec asks for.
 *
 * **This is the reason `CryptoPort` is a port.** The translator is pure — it
 * holds no platform APIs — so a codec that signs a request takes its MD5, RSA and
 * AES from the context. Here they are replaced by arithmetic that is stable and
 * obviously not cryptography, which is what a test needs: the codec's structure
 * is under test, not the primitives, and a real hash would make every expectation
 * an unreadable constant.
 *
 * None of this is a substitute for the real thing. What proves the signature is
 * right is the server's own `nodeCrypto` against the live provider; what this
 * proves is that the codec signs the right bytes in the right order.
 */
export const testCrypto: CryptoPort = {
  md5Hex(text: string): string {
    // A cheap rolling sum, hex-encoded to the width MD5 produces. Deterministic
    // and collision-prone on purpose — nothing here depends on it being a hash.
    let sum = 0;
    for (let index = 0; index < text.length; index += 1) {
      sum = (sum * 31 + text.charCodeAt(index)) >>> 0;
    }
    return sum.toString(16).padStart(8, '0').repeat(4);
  },

  rsaEncryptPkcs1(publicKeyPem: string, data: Uint8Array): Uint8Array {
    // The key's length is what a caller can meaningfully observe, so it is what
    // this returns alongside the data — the same shape, none of the security.
    const out = new Uint8Array(data.length + publicKeyPem.length);
    out.set(data, 0);
    for (let index = 0; index < publicKeyPem.length; index += 1) {
      out[data.length + index] = publicKeyPem.charCodeAt(index) & 0xff;
    }
    return out;
  },

  aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      out[index] = (data[index] as number) ^ (key[index % key.length] as number) ^ (iv[index % iv.length] as number);
    }
    return out;
  },
};
