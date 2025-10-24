export declare class StartedMongoContainer {
  constructor(name: string, host: string, port: number, database: string);
  getHost(): string;
  getMappedPort(): number;
  getConnectionString(): string;
  stop(): Promise<void>;
}

export declare class MongoDBContainer {
  constructor(image?: string);
  withDefaultDatabase(db: string): this;
  withEnv(key: string, value: string): this;
  withExposedPorts(port: number): this;
  start(): Promise<StartedMongoContainer>;
}
