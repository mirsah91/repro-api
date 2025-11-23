import { SessionSummaryService } from './session-summary.service';

function createService() {
  const tenant = { tenantId: 'tenant-test' } as any;
  const config = { get: () => undefined } as any;
  return new SessionSummaryService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    tenant,
    config,
  );
}

describe('SessionSummaryService chat query plan normalization', () => {
  it('falls back to sensible defaults when planner output is empty', () => {
    const service = createService() as any;
    const fallback = service.buildFallbackChatQueryPlan('Why did checkout fail?');

    const plans = service.normalizeChatQueryPlans({}, fallback);

    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].target).toBeDefined();
  });

  it('ignores unknown collections from planner mongo filters', () => {
    const service = createService() as any;
    const fallback = service.buildFallbackChatQueryPlan('Explain this session');

    const parsed = {
      plans: [
        {
          target: 'not-a-collection',
          limit: 999,
          mongo: {
            collection: 'foo',
            limit: 999,
            filter: { someField: 'value' },
          },
        },
      ],
    };

    const [plan] = service.normalizeChatQueryPlans(parsed, fallback);

    expect(plan.target).toBe(fallback[0].target);
    expect(plan.mongo?.collection).toBeUndefined();
    expect(plan.limit).toBeLessThanOrEqual(8);
  });

  it('chooses changes as primary target for DB-oriented questions', () => {
    const service = createService() as any;

    const plans = service.buildFallbackChatQueryPlan(
      'Which database changes happened in this session?',
    );

    expect(plans[0].target).toBe('changes');
    expect(plans.some((p: any) => p.target === 'requests')).toBe(true);
  });
}

