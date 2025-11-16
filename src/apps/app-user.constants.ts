export const APP_USER_CHAT_LIMIT = 10;

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
