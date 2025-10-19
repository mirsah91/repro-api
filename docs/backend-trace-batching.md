# Backend trace batching

Backend instrumentation can stream large traces in deterministic batches
instead of buffering the entire payload in memory. The ingestion endpoint
accepts one batch per POST request as long as each payload includes a request
identifier and monotonically increasing `traceBatchIndex` values.

## Streaming from `reproMiddleware`

The snippet below shows one way to adapt the existing Express middleware so it
flushes batches independently. Each flush sends only the accumulated trace
events plus metadata for the matching request.

```ts
const MAX_EVENTS_PER_BATCH = 150;

function reproMiddleware(cfg: { appId: string; appSecret: string; apiBase: string }) {
    return function handler(req: Request, res: Response, next: NextFunction) {
        // ... existing header parsing omitted for brevity ...

        type TraceEventPayload = {
            t: number;
            type: 'enter' | 'exit';
            functionType?: string | null;
            fn?: string;
            file?: string;
            line?: number | null;
            depth?: number;
            args?: any;
            returnValue?: any;
            threw?: boolean;
            error?: any;
        };

        const normalizeEvent = (ev: any): TraceEventPayload | null => {
            // reuse the existing filtering + sanitizing logic from the current middleware
            // and return `null` for dropped events.
            return ev as TraceEventPayload;
        };

        const events: TraceEventPayload[] = [];

        let batchIndex = 0;

        const flush = () => {
            if (!events.length) return;
            post(cfg.apiBase, cfg.appId, cfg.appSecret, sid, {
                entries: [{
                    actionId: aid,
                    request: {
                        rid,
                        method: req.method,
                        url,
                        status: res.statusCode,
                        durMs: Date.now() - t0,
                        key,
                        trace: JSON.stringify(events),
                        traceBatchIndex: batchIndex++,
                    },
                    t: Date.now(),
                }],
            });
            events.length = 0;
        };

        const maybeFlush = () => {
            if (events.length >= MAX_EVENTS_PER_BATCH) {
                flush();
            }
        };

        unsubscribe = __TRACER__.tracer.on((ev: any) => {
            const evt = normalizeEvent(ev);
            if (!evt) {
                return;
            }
            events.push(evt);
            maybeFlush();
        });

        res.on('finish', () => {
            flush();
            // ... existing payload handling ...
        });

        next();
    };
}
```

The service now treats each batch independently, upserting request metadata
without overriding previously stored fields when a subsequent batch omits them.

## Payload expectations

- Every batch must include a `request.rid` value so it can be attached to the
  right request document.
- Provide a numeric `traceBatchIndex` (starting at zero) to preserve ordering.
- Additional request properties (such as status or duration) are optional after
  the initial batch. Missing fields no longer clear previous values on the
  server.

