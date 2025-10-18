const mongoose = require('mongoose');

let connectionPromise;

async function connect(connectionString = process.env.MONGO_URI) {
  if (!connectionString) {
    throw new Error('Missing MongoDB connection string. Set the MONGO_URI environment variable.');
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000,
    });
  }

  return connectionPromise;
}

module.exports = {
  connect,
  mongoose,
};
