import {
  decryptJson,
  encryptJson,
} from '../../common/security/encryption.util';

export function encryptField(value: any): string | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  return encryptJson(value ?? null);
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
        : (decryptField<Record<string, any>>(doc.headers) ??
          doc.headers ??
          {}),
    respBody:
      typeof doc.respBody === 'undefined'
        ? undefined
        : decryptField<any>(doc.respBody),
  };
}

export function hydrateChangeDoc(doc: any) {
  if (!doc) return doc;
  return {
    ...doc,
    pk:
      typeof doc.pk === 'undefined'
        ? undefined
        : decryptField<any>(doc.pk) ?? doc.pk,
    before:
      typeof doc.before === 'undefined'
        ? undefined
        : decryptField<any>(doc.before) ?? doc.before,
    after:
      typeof doc.after === 'undefined'
        ? undefined
        : decryptField<any>(doc.after) ?? doc.after,
    query:
      typeof doc.query === 'undefined'
        ? undefined
        : decryptField<any>(doc.query) ?? doc.query,
    resultMeta:
      typeof doc.resultMeta === 'undefined'
        ? undefined
        : decryptField<any>(doc.resultMeta) ?? doc.resultMeta,
    error:
      typeof doc.error === 'undefined'
        ? undefined
        : decryptField<any>(doc.error) ?? doc.error,
  };
}

export function hydrateEmailDoc(doc: any) {
  if (!doc) return doc;
  return {
    ...doc,
    from:
      typeof doc.from === 'undefined'
        ? undefined
        : decryptField<any>(doc.from) ?? doc.from ?? null,
    to:
      typeof doc.to === 'undefined'
        ? undefined
        : (decryptField<any[]>(doc.to) ?? doc.to ?? []),
    cc:
      typeof doc.cc === 'undefined'
        ? undefined
        : (decryptField<any[]>(doc.cc) ?? doc.cc ?? []),
    bcc:
      typeof doc.bcc === 'undefined'
        ? undefined
        : (decryptField<any[]>(doc.bcc) ?? doc.bcc ?? []),
    subject:
      typeof doc.subject === 'undefined'
        ? undefined
        : (decryptField<string>(doc.subject) ?? doc.subject ?? ''),
    text:
      typeof doc.text === 'undefined'
        ? undefined
        : decryptField<string | null>(doc.text),
    html:
      typeof doc.html === 'undefined'
        ? undefined
        : decryptField<string | null>(doc.html),
    templateId:
      typeof doc.templateId === 'undefined'
        ? undefined
        : decryptField<string | null>(doc.templateId),
    dynamicTemplateData:
      typeof doc.dynamicTemplateData === 'undefined'
        ? undefined
        : decryptField<Record<string, any> | null>(
            doc.dynamicTemplateData,
          ) ?? doc.dynamicTemplateData,
    categories:
      typeof doc.categories === 'undefined'
        ? undefined
        : (decryptField<string[]>(doc.categories) ?? doc.categories ?? []),
    customArgs:
      typeof doc.customArgs === 'undefined'
        ? undefined
        : decryptField<Record<string, any> | null>(doc.customArgs) ??
          doc.customArgs,
    attachmentsMeta:
      typeof doc.attachmentsMeta === 'undefined'
        ? undefined
        : decryptField<any[]>(doc.attachmentsMeta) ?? doc.attachmentsMeta ?? [],
    headers:
      typeof doc.headers === 'undefined'
        ? undefined
        : decryptField<Record<string, any>>(doc.headers) ?? doc.headers ?? {},
  };
}
