const express = require('express');
const { queryEvents } = require('../indexer/db');
const { validateQuery } = require('../middleware/validate');
const { paginationSchema } = require('../validation/schemas');

const router = express.Router();

/**
 * GET /events
 * Query params: event_type, limit (max 500), offset
 */
router.get('/', validateQuery(paginationSchema), (req, res) => {
  const { event_type, limit, offset } = req.validatedQuery;

  const events = queryEvents({ event_type, limit, offset });
  res.json({ events, count: events.length });
});

module.exports = router;