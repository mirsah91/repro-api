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

describe('SessionSummaryService scopeTimelineCollections', () => {
  it('prioritizes traces when the prompt references a file and line', () => {
    const service = createService();
    const requests = [
      { rid: 'REQ-TAIL', url: '/api/irrelevant' },
      { rid: 'REQ-CHECKOUT', url: '/api/checkout' },
    ];
    const traces = [
      {
        id: 'trace-tail',
        requestRid: 'REQ-TAIL',
        data: [{ fn: 'otherCall', file: 'app/other.ts', line: 12 }],
      },
      {
        id: 'trace-checkout',
        requestRid: 'REQ-CHECKOUT',
        data: [
          { fn: 'handleCheckout', file: 'src/cart.service.ts', line: 88 },
          { fn: 'processPayment', file: 'src/payments.ts', line: 140 },
        ],
      },
    ];
    const hintMessages = [
      {
        role: 'user',
        content: 'Why does checkout fail in cart.service.ts line 88?',
      },
    ];

    const scoped = (service as any).scopeTimelineCollections(
      [],
      requests,
      traces,
      hintMessages,
    );

    expect(scoped.requests[0].rid).toBe('REQ-CHECKOUT');
    expect(scoped.requests.some((req: any) => req.rid === 'REQ-CHECKOUT')).toBe(
      true,
    );
    expect(scoped.traces[0].requestRid).toBe('REQ-CHECKOUT');
    expect(
      scoped.traces.some((trace: any) => trace.requestRid === 'REQ-CHECKOUT'),
    ).toBe(true);
  });

  it('matches traces without request IDs when a function name is referenced', () => {
    const service = createService();
    const requests = [{ rid: 'REQ-ONLY', url: '/api/default' }];
    const traces = [
      {
        id: 'trace-without-request',
        requestRid: null,
        data: [{ fn: 'renderEmail', file: 'src/mailer.tsx', line: 33 }],
      },
    ];
    const hintMessages = [
      {
        role: 'user',
        content: 'Where does renderEmail run?',
      },
    ];

    const scoped = (service as any).scopeTimelineCollections(
      [],
      requests,
      traces,
      hintMessages,
    );

    expect(scoped.traces).toHaveLength(1);
    expect(scoped.traces[0].id).toBe('trace-without-request');
    // requests fall back to defaults because no rid could be matched
    expect(scoped.requests.length).toBeGreaterThan(0);
  });

  it('falls back to evenly sampled requests when no hint tokens exist', () => {
    const service = createService();
    const requests = Array.from({ length: 10 }, (_, idx) => ({
      rid: `REQ-${idx + 1}`,
      url: `/api/${idx + 1}`,
    }));
    const traces: any[] = [];
    const hintMessages = [
      {
        role: 'user',
        content: 'Give me the full run down of this session.',
      },
    ];

    const scoped = (service as any).scopeTimelineCollections(
      [],
      requests,
      traces,
      hintMessages,
    );

    expect(scoped.requests.some((req: any) => req.rid === 'REQ-1')).toBe(true);
    expect(scoped.requests.some((req: any) => req.rid === 'REQ-10')).toBe(true);
    expect(scoped.requests.length).toBeGreaterThan(1);
  });
});
