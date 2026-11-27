const express = require('express');
const { queryEvents } = require('../indexer/db');
const { validateQuery } = require('../middleware/validate');
const { paginationSchema } = require('../validation/schemas');

const router = express.Router();

// Documented maximums for the public events endpoint.
// - limit: maximum number of records returned in a single response (default 100).
// - offset: maximum offset allowed to prevent unbounded deep pagination.
// - batch: maximum number of event_type filters accepted in a single request.
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_OFFSET = 100000;
const MAX_BATCH = 50;

/**
 * @swagger
 * /events:
 *   get:
 *     summary: Query indexed on-chain events
 *     tags:
 *       - Events
 *     parameters:
 *       - in: query
 *         name: event_type
 *         schema: { type: string }
 *         description: Filter by event type
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 500 }
 *         description: Max results (default 100)
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *         description: Offset for pagination
 *     responses:
 *       200:
 *         description: Events retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                 count:
 *                   type: integer
 */

/**
 * GET /events
 * Query params:
 *   - event_type: single event type or comma-separated list (max 50 entries)
 *   - limit: max records to return (default 100, max 500)
 *   - offset: pagination offset (max 100000)
 *
 * Semantics:
 *   - limit above MAX_LIMIT is truncated to MAX_LIMIT and reported via `truncated`.
 *   - offset above MAX_OFFSET returns 400 with a predictable error.
 *   - batch of event_type filters above MAX_BATCH returns 400.
 */
router.get('/', (req, res) => {
  // Parse and validate limit.
  const rawLimit = req.query.limit;
  let limit = DEFAULT_LIMIT;
  let limitTruncated = false;
  if (rawLimit !== undefined) {
    const parsedLimit = parseInt(rawLimit, 10);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
      return res.status(400).json({
        error: 'invalid_limit',
        message: `limit must be a positive integer (max ${MAX_LIMIT})`,
        max_limit: MAX_LIMIT,
      });
    }
    if (parsedLimit > MAX_LIMIT) {
      limit = MAX_LIMIT;
      limitTruncated = true;
    } else {
      limit = parsedLimit;
    }
  }

  // Parse and validate offset.
  const rawOffset = req.query.offset;
  let offset = 0;
  if (rawOffset !== undefined) {
    const parsedOffset = parseInt(rawOffset, 10);
    if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({
        error: 'invalid_offset',
        message: `offset must be a non-negative integer (max ${MAX_OFFSET})`,
        max_offset: MAX_OFFSET,
      });
    }
    if (parsedOffset > MAX_OFFSET) {
      return res.status(400).json({
        error: 'offset_too_large',
        message: `offset exceeds maximum of ${MAX_OFFSET}`,
        max_offset: MAX_OFFSET,
      });
    }
    offset = parsedOffset;
  }

  // Parse and validate event_type (supports comma-separated batch).
  let eventType = req.query.event_type;
  if (typeof eventType === 'string' && eventType.includes(',')) {
    const parts = eventType
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > MAX_BATCH) {
      return res.status(400).json({
        error: 'batch_too_large',
        message: `event_type batch exceeds maximum of ${MAX_BATCH}`,
        max_batch: MAX_BATCH,
      });
    }
    eventType = parts;
  }

  const events = queryEvents({ event_type: eventType, limit, offset });

  // Truncate defensively in case the underlying query returns more than requested.
  const truncatedByLimit = events.length > limit;
  const returned = truncatedByLimit ? events.slice(0, limit) : events;

  res.json({
    events: returned,
    count: returned.length,
    limit,
    offset,
    truncated: limitTruncated || truncatedByLimit,
    max_limit: MAX_LIMIT,
    max_offset: MAX_OFFSET,
    max_batch: MAX_BATCH,
  });
});

module.exports = router;
module.exports.MAX_LIMIT = MAX_LIMIT;
module.exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
module.exports.MAX_OFFSET = MAX_OFFSET;
module.exports.MAX_BATCH = MAX_BATCH;
