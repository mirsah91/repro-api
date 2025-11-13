import {
  decryptJson,
  encryptJson,
  isEncryptionDisabled,
} from '../../common/security/encryption.util';

export function encryptField(value: any): any {
  if (typeof value === 'undefined') {
    return undefined;
  }
  const normalized = value ?? null;
  if (isEncryptionDisabled()) {
    if (
      normalized !== null &&
      typeof normalized === 'object' &&
      typeof normalized.toJSON === 'function'
    ) {
      return normalized.toJSON();
    }
    if (normalized !== null && typeof normalized === 'object') {
      return JSON.parse(JSON.stringify(normalized));
    }
    return normalized as any;
  }
  return encryptJson(normalized);
}

export function decryptField<T = any>(payload: any): T | undefined {
  if (typeof payload === 'undefined') {
    return undefined;
  }
  if (payload === null) {
    return null as T;
  }
  if (typeof payload === 'string') {
    try {
      return decryptJson<T>(payload);
    } catch {
      try {
        return JSON.parse(payload) as T;
      } catch {
        return payload as unknown as T;
      }
    }
  }
  return payload as T;
}

export function hydrateRequestDoc(doc: any) {
  if (!doc) return doc;
  return {
    ...doc,
    url:
      typeof doc.url === 'undefined'
        ? undefined
        : (decryptField<string>(doc.url) ?? doc.url ?? null),
    headers:
      typeof doc.headers === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any>>(doc.headers);
            return typeof decoded === 'undefined' ? doc.headers : decoded;
          })(),
    body:
      typeof doc.body === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.body);
            return typeof decoded === 'undefined' ? doc.body : decoded;
          })(),
    params:
      typeof doc.params === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any>>(doc.params);
            return typeof decoded === 'undefined' ? doc.params : decoded;
          })(),
    query:
      typeof doc.query === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any>>(doc.query);
            return typeof decoded === 'undefined' ? doc.query : decoded;
          })(),
    respBody:
      typeof doc.respBody === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.respBody);
            return typeof decoded === 'undefined' ? doc.respBody : decoded;
          })(),
  };
}

export function hydrateChangeDoc(doc: any) {
  if (!doc) return doc;
  return {
    ...doc,
    pk:
      typeof doc.pk === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.pk);
            return typeof decoded === 'undefined' ? doc.pk : decoded;
          })(),
    before:
      typeof doc.before === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.before);
            return typeof decoded === 'undefined' ? doc.before : decoded;
          })(),
    after:
      typeof doc.after === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.after);
            return typeof decoded === 'undefined' ? doc.after : decoded;
          })(),
    query:
      typeof doc.query === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.query);
            return typeof decoded === 'undefined' ? doc.query : decoded;
          })(),
    resultMeta:
      typeof doc.resultMeta === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.resultMeta);
            return typeof decoded === 'undefined' ? doc.resultMeta : decoded;
          })(),
    error:
      typeof doc.error === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.error);
            return typeof decoded === 'undefined' ? doc.error : decoded;
          })(),
  };
}

export function hydrateEmailDoc(doc: any) {
  if (!doc) return doc;
  return {
    ...doc,
    from:
      typeof doc.from === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any>(doc.from);
            return typeof decoded === 'undefined' ? doc.from : decoded;
          })(),
    to:
      typeof doc.to === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any[]>(doc.to);
            return typeof decoded === 'undefined' ? doc.to : decoded;
          })(),
    cc:
      typeof doc.cc === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any[]>(doc.cc);
            return typeof decoded === 'undefined' ? doc.cc : decoded;
          })(),
    bcc:
      typeof doc.bcc === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any[]>(doc.bcc);
            return typeof decoded === 'undefined' ? doc.bcc : decoded;
          })(),
    subject:
      typeof doc.subject === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<string>(doc.subject);
            return typeof decoded === 'undefined' ? doc.subject : decoded;
          })(),
    text:
      typeof doc.text === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<string | null>(doc.text);
            return typeof decoded === 'undefined' ? doc.text : decoded;
          })(),
    html:
      typeof doc.html === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<string | null>(doc.html);
            return typeof decoded === 'undefined' ? doc.html : decoded;
          })(),
    templateId:
      typeof doc.templateId === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<string | null>(doc.templateId);
            return typeof decoded === 'undefined' ? doc.templateId : decoded;
          })(),
    dynamicTemplateData:
      typeof doc.dynamicTemplateData === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any> | null>(
              doc.dynamicTemplateData,
            );
            return typeof decoded === 'undefined'
              ? doc.dynamicTemplateData
              : decoded;
          })(),
    categories:
      typeof doc.categories === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<string[]>(doc.categories);
            return typeof decoded === 'undefined' ? doc.categories : decoded;
          })(),
    customArgs:
      typeof doc.customArgs === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any> | null>(
              doc.customArgs,
            );
            return typeof decoded === 'undefined' ? doc.customArgs : decoded;
          })(),
    attachmentsMeta:
      typeof doc.attachmentsMeta === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<any[]>(doc.attachmentsMeta);
            return typeof decoded === 'undefined'
              ? doc.attachmentsMeta
              : decoded;
          })(),
    headers:
      typeof doc.headers === 'undefined'
        ? undefined
        : (() => {
            const decoded = decryptField<Record<string, any>>(doc.headers);
            return typeof decoded === 'undefined' ? doc.headers : decoded;
          })(),
  };
}
