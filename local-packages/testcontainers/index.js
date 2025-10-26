const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const crypto = require('crypto');

const execAsync = promisify(exec);

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(err => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForPort(host, port, timeoutMs = 30000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      socket.setTimeout(2000);
      socket.on('connect', () => {
        settled = true;
        socket.destroy();
        resolve();
      });
      const onError = () => {
        if (settled) return;
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${host}:${port} did not open in time`));
        } else {
          setTimeout(check, 500);
        }
      };
      socket.on('timeout', onError);
      socket.on('error', onError);
    };
    check();
  });
}

class StartedMongoContainer {
  constructor(name, host, port, database) {
    this.name = name;
    this.host = host;
    this.port = port;
    this.database = database;
  }

  getHost() {
    return this.host;
  }

  getMappedPort() {
    return this.port;
  }

  getConnectionString() {
    return `mongodb://${this.host}:${this.port}/${this.database}`;
  }

  async stop() {
    try {
      await execAsync(`docker rm -f ${this.name}`);
    } catch (err) {
      if (err && err.code !== 1) {
        throw err;
      }
    }
  }
}

class MongoDBContainer {
  constructor(image = 'mongo:7') {
    this.image = image;
    this.database = 'test';
    this.host = '127.0.0.1';
    this.port = undefined;
    this.name = `tc-mongo-${crypto.randomUUID()}`;
    this.env = {};
  }

  withDefaultDatabase(db) {
    this.database = db;
    return this;
  }

  withEnv(key, value) {
    this.env[key] = value;
    return this;
  }

  withExposedPorts(port) {
    this.port = port;
    return this;
  }

  async start() {
    const port = this.port ?? (await getFreePort());
    const envArgs = Object.entries(this.env)
      .map(([key, value]) => `-e ${key}=${value}`)
      .join(' ');

    await execAsync(`docker run -d --rm -p ${port}:27017 ${envArgs} --name ${this.name} ${this.image}`);
    await waitForPort(this.host, port, 45000);
    return new StartedMongoContainer(this.name, this.host, port, this.database);
  }
}

module.exports = {
  MongoDBContainer,
  StartedMongoContainer,
};
