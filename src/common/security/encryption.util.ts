import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'crypto';

/**
 * Lightweight AES-256-GCM helper used to protect sensitive values before
 * persisting them. The symmetric key originates from DATA_ENCRYPTION_KEY and is
 * derived in a deterministic manner so the same key works across restarts.
 */
const AES_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM
const PLAINTEXT_REGEX = /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
const ENCRYPTION_DISABLED = /^(1|true|yes)$/i.test(
  process.env.APP_ENCRYPTION_DISABLED ?? '',
);

let cachedKey: Buffer | null = null;
function deriveKey(required = true): Buffer | undefined {
  if (cachedKey) return cachedKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;

  if (!raw) {
    if (!required && ENCRYPTION_DISABLED) {
      return undefined;
    }
    throw new Error(
      'DATA_ENCRYPTION_KEY is required to encrypt sensitive fields. Provide a 32-byte key in base64, hex, or plain text.',
    );
  }

  const candidates: Array<() => Buffer | null> = [
    () => {
      try {
        const buf = Buffer.from(raw, 'base64');
        return buf.length ? buf : null;
      } catch {
        return null;
      }
    },
    () => {
      try {
        const buf = Buffer.from(raw, 'hex');
        return buf.length ? buf : null;
      } catch {
        return null;
      }
    },
    () => Buffer.from(raw, 'utf8'),
  ];

  for (const fn of candidates) {
    const buf = fn();
    if (buf && buf.length) {
      const key =
        buf.length === 32 ? buf : createHash('sha256').update(buf).digest(); // squeeze to 32 bytes
      cachedKey = key;
      return key;
    }
  }

  throw new Error('Unable to derive DATA_ENCRYPTION_KEY');
}

export function requireEncryptionKey() {
  if (ENCRYPTION_DISABLED) {
    return;
  }
  deriveKey();
}

export function isEncryptionDisabled(): boolean {
  return ENCRYPTION_DISABLED;
}

export function encryptString(plain: string): string {
  if (typeof plain !== 'string') {
    throw new TypeError('encryptString expects a string input');
  }
  if (ENCRYPTION_DISABLED) {
    return plain;
  }
  const key = deriveKey();
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY is required to encrypt data');
  }
  return encryptWithKey(plain, key);
}

function encryptWithKey(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    encrypted.toString('base64'),
    tag.toString('base64'),
  ].join('.');
}

export function decryptString(payload: string | null | undefined): string {
  if (!payload) {
    throw new Error('decryptString received empty payload');
  }
  if (!ENCRYPTION_DISABLED) {
    return decryptWithKey(payload, deriveKey());
  }
  if (PLAINTEXT_REGEX.test(payload)) {
    const key = deriveKey(false);
    if (!key) {
      throw new Error(
        'Encrypted payload encountered but DATA_ENCRYPTION_KEY is missing while APP_ENCRYPTION_DISABLED is enabled.',
      );
    }
    return decryptWithKey(payload, key);
  }
  return payload;
}

function decryptWithKey(payload: string, key?: Buffer): string {
  if (!key) {
    throw new Error(
      'DATA_ENCRYPTION_KEY is required to decrypt sensitive fields.',
    );
  }
  const [ivB64, dataB64, tagB64] = payload.split('.');
  if (!ivB64 || !dataB64 || !tagB64) {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function encryptBuffer(buf: Buffer): Buffer {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('encryptBuffer expects a Buffer');
  }
  const cipherText = encryptString(buf.toString('base64'));
  return Buffer.from(cipherText, 'utf8');
}

export function decryptBuffer(buf: Buffer): Buffer {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('decryptBuffer expects a Buffer');
  }
  const plain = decryptString(buf.toString('utf8'));
  return Buffer.from(plain, 'base64');
}

export function encryptJson(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return encryptString(json);
}

export function decryptJson<T = any>(payload: string | undefined | null): T {
  if (!payload) return undefined as unknown as T;
  const json = decryptString(payload);
  return JSON.parse(json) as T;
}

export function hashSecret(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError('hashSecret expects a string input');
  }
  const key = deriveKey(false);
  if (key) {
    return createHmac('sha256', key).update(input, 'utf8').digest('base64');
  }
  return createHash('sha256').update(input, 'utf8').digest('base64');
}

export function redact(value: string, visible = 4): string {
  if (!value) return '';
  const tail = value.slice(-visible);
  return `${'*'.repeat(Math.max(0, value.length - tail.length))}${tail}`;
}
