# Ingest Backend

This service provides APIs for working with ingested request data. It now stores
traces in a dedicated MongoDB collection that references the `requests`
collection, enabling more targeted queries and aggregations.

## Collections

- **requests** – stores metadata about each request including the session it
  belongs to, its key, duration (in milliseconds) and status.
- **traces** – stores trace payloads for each request. Each trace document
  references the request it belongs to through the `requestId` field and keeps
  all spans for that trace.

## API

### `GET /sessions/:sessionId/traces`

Returns traces for the supplied session grouped by the request key. For each
request key the response includes the associated request metadata (`key`,
`durMs` and `status`) along with every trace recorded for that request.

```json
{
  "sessionId": "session-123",
  "groups": [
    {
      "key": "request.key",
      "request": {
        "key": "request.key",
        "durMs": 120,
        "status": 200
      },
      "traces": [
        {
          "id": "66a...",
          "traceId": "trace-1",
          "spans": [
            {
              "spanId": "span-1",
              "name": "root",
              "startTime": "2024-01-01T00:00:00.000Z",
              "durationMs": 12,
              "attributes": {}
            }
          ],
          "createdAt": "2024-01-01T00:00:00.000Z",
          "updatedAt": "2024-01-01T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

## Running the service

Set the `MONGO_URI` environment variable so the service can connect to MongoDB
and then start the server:

```bash
cd ingestBackend
npm install
npm start
```

By default the server listens on port `3000`. Use the `PORT` environment
variable to choose a different port.
