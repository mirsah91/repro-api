const Trace = require('../models/trace');

async function findTracesGroupedByRequestKey(sessionId) {
  const pipeline = [
    { $match: { sessionId } },
    {
      $lookup: {
        from: 'requests',
        localField: 'requestId',
        foreignField: '_id',
        as: 'request',
      },
    },
    { $unwind: '$request' },
    {
      $group: {
        _id: '$request.key',
        request: {
          $first: {
            key: '$request.key',
            durMs: '$request.durMs',
            status: '$request.status',
          },
        },
        traces: {
          $push: {
            id: '$_id',
            traceId: '$traceId',
            spans: '$spans',
            createdAt: '$createdAt',
            updatedAt: '$updatedAt',
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        key: '$_id',
        request: 1,
        traces: 1,
      },
    },
    { $sort: { key: 1 } },
  ];

  return Trace.aggregate(pipeline);
}

module.exports = {
  findTracesGroupedByRequestKey,
};
