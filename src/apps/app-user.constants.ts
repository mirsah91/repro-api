export const APP_USER_CHAT_LIMIT = 10;
export const APP_MAX_COUNT = 4;

export function computeChatQuota(usageCount?: number | null) {
  const limit = APP_USER_CHAT_LIMIT;
  const normalized =
    typeof usageCount === 'number' && Number.isFinite(usageCount)
      ? Math.floor(usageCount)
      : 0;
  const used = Math.min(limit, Math.max(0, normalized));
  const remaining = Math.max(0, limit - used);
  return { limit, used, remaining };
}

export function resolveAppUserMaxCount(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return APP_MAX_COUNT;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : APP_MAX_COUNT;
}
