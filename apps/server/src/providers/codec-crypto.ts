import {
  createCipheriv,
  createHash,
  constants,
  publicEncrypt,
} from 'node:crypto';
import type { CryptoPort } from '@translator';

/**
 * The cryptographic primitives a signing codec asks for (C4.6).
 *
 * The translator is pure — it never imports `node:*` — so the three primitives a
 * request signer cannot compute arrive through a port, and this is the server's
 * implementation of it. Keeping them here rather than in the codec is what lets
 * the codec run against a deterministic stand-in in a test and against the real
 * primitives in production.
 *
 * **None of these is a security primitive in the sense the rest of the codebase
 * means.** MD5 is here because a provider chose it for a request signature, not
 * because anything is hashed with it for protection; the RSA key is the
 * provider's own public key, so the encryption is obfuscation of a session key
 * rather than a secret being kept. Password hashing and credential storage live
 * in `security/` and use argon2 and AES-GCM, which is where the real ones belong.
 */
export const nodeCrypto: CryptoPort = {
  md5Hex(text: string): string {
    return createHash('md5').update(text, 'utf8').digest('hex');
  },

  rsaEncryptPkcs1(publicKeyPem: string, data: Uint8Array): Uint8Array {
    return new Uint8Array(
      publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(data),
      ),
    );
  },

  aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    return new Uint8Array(
      Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]),
    );
  },
};
