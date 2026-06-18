import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
// Integration specs connect to this DB; override via env to point elsewhere.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sync:sync@localhost:5432/syncdb';
