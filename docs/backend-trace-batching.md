# Backend trace batching

Backend instrumentation can stream large traces in deterministic batches
instead of buffering the entire payload in memory. The ingestion endpoint
accepts one batch per POST request as long as each payload includes a request
identifier and a batch index. Trace batches can arrive alongside the matching
request metadata **or** independently as "trace-only" entries when the request
data has already been ingested.

## Streaming from `reproMiddleware`

The snippet below shows one way to adapt the existing Express middleware so it
flushes batches independently. Each flush sends only the accumulated trace
events plus metadata for the matching request.

```ts
const MAX_EVENTS_PER_BATCH = 150;

function reproMiddleware(cfg: { appId: string; appSecret: string; apiBase: string }) {
    return function handler(req: Request, res: Response, next: NextFunction) {
        // ... existing header parsing omitted for brevity ...

        const events: any[] = [];
        let batchIndex = 0;

        const flush = () => {
            if (!events.length) return;
            post(cfg.apiBase, cfg.appId, cfg.appSecret, sid, {
                entries: [{
                    actionId: aid,
                    trace: JSON.stringify(events),
                    traceBatch: {
                        rid,
                        index: batchIndex++,
                        total: undefined,
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
            events.push(ev);
            maybeFlush();
        });

        res.on('finish', () => {
            flush();
            // ... existing request payload handling can post separately ...
        });

        next();
    };
}
```

The service now treats each batch independently, upserting request metadata
without overriding previously stored fields when a subsequent batch omits them.

## Trace-only batches

If your instrumentation emits request metadata separately from the trace
payloads, post the trace batches on their own. Provide the request identifier in
`traceBatch.rid` and omit the `request` object entirely:

```json
{
  "entries": [
    {
      "actionId": "A1",
      "request": {
        "rid": "R12",
        "method": "POST",
        "url": "/api/apply",
        "status": 200,
        "durMs": 140
      },
      "t": 1710000000200
    }
  ]
}
```

Later, send each trace batch as its own entry:

```json
{
  "entries": [
    {
      "actionId": "A1",
      "trace": "[{\"t\":0,\"type\":\"enter\"}]",
      "traceBatch": {
        "rid": "R12",
        "index": 1,
        "total": 4
      },
      "t": 1710000000205
    }
  ]
}
```

Each trace-only entry sends the serialized trace plus metadata describing the
batch. The server associates the batch with the existing request document using
`traceBatch.rid` (or the legacy `requestRid` fallback).

## Payload expectations

- Every request payload must include a `request.rid` value so it can be attached
  to the right request document.
- Provide a numeric `traceBatch.index` (starting at zero) to preserve ordering.
- Additional request properties (such as status or duration) are optional after
  the initial batch.
- Trace batches can be uploaded without a `request` payload by including
  `traceBatch.rid` (or `requestRid`) at the entry level.

