const express = require('express');
const { connect } = require('./db/connection');
const traceRoutes = require('./routes/traces');

const app = express();
app.use(express.json());
app.use(traceRoutes);

// eslint-disable-next-line no-console
function logError(error) {
  // Centralise logging without adding an entire logging framework.
  console.error('[ingest-backend] error', error); // eslint-disable-line no-console
}

// Simple error handler to make debugging easier for the API consumer.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  logError(error);
  res.status(500).json({
    error: 'Internal Server Error',
    message: error.message,
  });
});

async function start(port = process.env.PORT || 3000) {
  await connect();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Ingest backend listening on port ${port}`);
      resolve(server);
    });
  });
}

module.exports = {
  app,
  start,
};

if (require.main === module) {
  start().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start ingest backend', error);
    process.exit(1);
  });
}
