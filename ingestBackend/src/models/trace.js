const { Schema, model, models } = require('mongoose');

const TraceSpanSchema = new Schema(
  {
    spanId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    startTime: {
      type: Date,
      required: true,
    },
    durationMs: {
      type: Number,
      required: true,
    },
    attributes: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

const TraceSchema = new Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    requestId: {
      type: Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
      index: true,
    },
    traceId: {
      type: String,
      required: true,
      index: true,
    },
    spans: {
      type: [TraceSpanSchema],
      default: [],
    },
  },
  {
    collection: 'traces',
    timestamps: true,
  }
);

TraceSchema.index({ sessionId: 1, requestId: 1 });
TraceSchema.index({ traceId: 1 }, { unique: true });

module.exports = models.Trace || model('Trace', TraceSchema);
