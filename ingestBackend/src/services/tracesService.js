const { findTracesGroupedByRequestKey } = require('../repositories/tracesRepository');

async function getTracesForSession(sessionId) {
  if (!sessionId) {
    throw new Error('A session id is required to query traces.');
  }

  const results = await findTracesGroupedByRequestKey(sessionId);

  return {
    sessionId,
    groups: results,
  };
}

module.exports = {
  getTracesForSession,
};
