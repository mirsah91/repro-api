import { createHmac, timingSafeEqual } from 'crypto';

const BASE64_URL_REGEX = /^[A-Za-z0-9_-]+$/;

export interface JwtSignOptions {
  expiresInSeconds?: number;
  issuer?: string;
  subject?: string;
  audience?: string;
}

export interface JwtVerifyOptions {
  issuer?: string;
  audience?: string;
  subject?: string;
}

export function signJwt<T = Record<string, unknown>>(
  payload: T,
  secret: string,
  options: JwtSignOptions = {},
): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const issuedAt = Math.floor(Date.now() / 1000);
  const fullPayload: Record<string, unknown> = {
    ...payload,
    iat: issuedAt,
  };

  if (
    typeof options.expiresInSeconds === 'number' &&
    options.expiresInSeconds > 0
  ) {
    fullPayload.exp = issuedAt + Math.floor(options.expiresInSeconds);
  }
  if (options.issuer) fullPayload.iss = options.issuer;
  if (options.subject) fullPayload.sub = options.subject;
  if (options.audience) fullPayload.aud = options.audience;

  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = createSignature(
    `${headerEncoded}.${payloadEncoded}`,
    secret,
  );
  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

export function verifyJwt<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  options: JwtVerifyOptions = {},
): T {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  if (
    !BASE64_URL_REGEX.test(headerPart) ||
    !BASE64_URL_REGEX.test(payloadPart)
  ) {
    throw new Error('Invalid JWT encoding');
  }

  const expectedSignature = createSignature(
    `${headerPart}.${payloadPart}`,
    secret,
  );
  if (expectedSignature.length !== signaturePart.length) {
    throw new Error('Invalid JWT signature');
  }
  if (
    !timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signaturePart))
  ) {
    throw new Error('Invalid JWT signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadPart)) as T & {
    exp?: number;
    nbf?: number;
    iss?: string;
    aud?: string;
    sub?: string;
  };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new Error('JWT not active yet');
  }
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('JWT expired');
  }
  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error('Unexpected JWT issuer');
  }
  if (options.audience && payload.aud !== options.audience) {
    throw new Error('Unexpected JWT audience');
  }
  if (options.subject && payload.sub !== options.subject) {
    throw new Error('Unexpected JWT subject');
  }

  return payload as T;
}

function createSignature(content: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(content).digest();
  return base64UrlEncode(digest);
}

function base64UrlEncode(value: string | Buffer): string {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  return buffer
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized + '='.repeat(padding);
  return Buffer.from(padded, 'base64').toString('utf8');
}
