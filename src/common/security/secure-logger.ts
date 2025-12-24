import { LoggerService } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { encryptString } from './encryption.util';

const LOG_DIR = process.env.SECURE_LOG_DIR || 'logs';
const LOG_FILENAME = process.env.SECURE_LOG_FILE || 'secure.log.enc';
const LOG_PATH = join(LOG_DIR, LOG_FILENAME);

let initialized = false;

function ensureLogDir() {
  if (initialized) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  initialized = true;
}

function writeEncryptedLog(level: string, payload: Record<string, any>) {
  try {
    ensureLogDir();
    const entry = {
      level,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    const serialized = JSON.stringify(entry);
    const encrypted = encryptString(serialized);
    appendFileSync(LOG_PATH, encrypted + '\n', { encoding: 'utf8' });
  } catch (err) {
    // If the secure log writer fails we still don't want to crash the app.
    console.warn('[secure-log] failed to persist log entry', err);
  }
}

function formatConsole(
  level: string,
  context: string | undefined,
  message: string,
) {
  const prefix = context ? `[${context}] ` : '';
  return `${new Date().toISOString()} ${level.toUpperCase()}: ${prefix}${message}`;
}

class SecureLogger implements LoggerService {
  log(message: any, context?: string) {
    const text = stringify(message);
    writeEncryptedLog('log', { context, message: text });
    console.log(formatConsole('log', context, text));
  }

  error(message: any, trace?: string, context?: string) {
    if (message instanceof Error) {
      const details = formatErrorDetails(message);
      const resolvedTrace = trace || details.trace;
      writeEncryptedLog('error', {
        context,
        message: details.text,
        trace: resolvedTrace,
      });
      console.error(
        formatConsole('error', context, details.text),
        resolvedTrace || '',
      );
      return;
    }
    const text = stringify(message);
    writeEncryptedLog('error', { context, message: text, trace });
    console.error(formatConsole('error', context, text), trace || '');
  }

  warn(message: any, context?: string) {
    const text = stringify(message);
    writeEncryptedLog('warn', { context, message: text });
    console.warn(formatConsole('warn', context, text));
  }

  debug(message: any, context?: string) {
    const text = stringify(message);
    writeEncryptedLog('debug', { context, message: text });
    if (process.env.NODE_ENV !== 'production') {
      console.debug(formatConsole('debug', context, text));
    }
  }

  verbose(message: any, context?: string) {
    const text = stringify(message);
    writeEncryptedLog('verbose', { context, message: text });
    if (process.env.NODE_ENV !== 'production') {
      console.info(formatConsole('verbose', context, text));
    }
  }
}

function stringify(value: any): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return formatErrorDetails(value).text;
  }
  try {
    return safeStringify(value);
  } catch {
    return String(value);
  }
}

function safeStringify(value: any): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (val instanceof Error) {
      return serializeError(val);
    }
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

function formatErrorDetails(error: Error): { text: string; trace?: string } {
  const name = error.name || 'Error';
  const message = error.message ? `${name}: ${error.message}` : name;
  const cause = formatCause((error as { cause?: unknown }).cause);
  const text = cause ? `${message} | cause: ${cause}` : message;
  const trace = typeof error.stack === 'string' ? error.stack : undefined;
  return { text, trace };
}

function serializeError(error: Error): Record<string, string> {
  const name = error.name || 'Error';
  const message = error.message || '';
  const stack = typeof error.stack === 'string' ? error.stack : undefined;
  const cause = formatCause((error as { cause?: unknown }).cause);
  const payload: Record<string, string> = { name, message };
  if (stack) payload.stack = stack;
  if (cause) payload.cause = cause;
  return payload;
}

function formatCause(cause: unknown): string | undefined {
  if (!cause) return undefined;
  if (cause instanceof Error) {
    const name = cause.name || 'Error';
    const message = cause.message ? `: ${cause.message}` : '';
    return `${name}${message}`;
  }
  if (typeof cause === 'string') return cause;
  try {
    return safeStringify(cause);
  } catch {
    return String(cause);
  }
}

export function createSecureLogger(): LoggerService {
  return new SecureLogger();
}
