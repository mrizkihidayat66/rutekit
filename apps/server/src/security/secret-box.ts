import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Envelope encryption for provider credentials (R5.10).
 *
 * AES-256-GCM, with the working key derived from `RUTEKIT_ENCRYPTION_KEY` by
 * scrypt and a fresh 12-byte IV per record. GCM is *authenticated*: a ciphertext
 * that has been altered fails to decrypt rather than yielding plausible garbage,
 * which is the property that matters when the plaintext is an account token.
 *
 * The envelope is a self-describing string — `v1:<iv>:<tag>:<ciphertext>`, all
 * base64url — so a record written today can still be read after the derivation
 * changes, and a version bump is a new prefix rather than a data migration.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/**
 * A fixed salt, because the input key is already 256 bits of entropy: scrypt here
 * is domain separation (this key encrypts credentials and nothing else), not
 * password stretching, and a per-record salt would add cost without adding
 * strength. `maxmem` is raised because scrypt's own default refuses the N/r pair.
 */
const KDF_SALT = 'rutekit:credentials:v1';
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function encode(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(masterKeyHex: string) {
    const master = Buffer.from(masterKeyHex, 'hex');
    if (master.length !== KEY_BYTES) {
      throw new Error('encryption key must be 32 bytes (64 hex characters)');
    }
    this.#key = scryptSync(master, KDF_SALT, KEY_BYTES, SCRYPT_OPTIONS);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join(':');
  }

  /** Throws on a tampered, truncated or foreign envelope — never returns junk. */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('unrecognised secret envelope');
    }
    const [, ivPart, tagPart, dataPart] = parts;
    if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
      throw new Error('malformed secret envelope');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, decode(ivPart));
    decipher.setAuthTag(decode(tagPart));
    return Buffer.concat([decipher.update(decode(dataPart)), decipher.final()]).toString('utf8');
  }
}
