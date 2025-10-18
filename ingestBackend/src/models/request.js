const { Schema, model, models } = require('mongoose');

const RequestSchema = new Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      index: true,
    },
    durMs: {
      type: Number,
      default: null,
    },
    status: {
      type: Number,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    collection: 'requests',
    timestamps: true,
  }
);

RequestSchema.index({ sessionId: 1, key: 1 });

module.exports = models.Request || model('Request', RequestSchema);
