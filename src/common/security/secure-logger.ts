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
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createSecureLogger(): LoggerService {
  return new SecureLogger();
}
