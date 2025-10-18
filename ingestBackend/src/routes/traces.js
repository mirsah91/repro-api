const express = require('express');
const { getTracesForSession } = require('../services/tracesService');

const router = express.Router();

router.get('/sessions/:sessionId/traces', async (req, res, next) => {
  try {
    const payload = await getTracesForSession(req.params.sessionId);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
