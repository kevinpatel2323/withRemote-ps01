/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  // Integration specs share one Postgres and truncate tables between tests, so files
  // must not run concurrently. Serialize the suite (small enough that this is cheap).
  maxWorkers: 1,
  // Integration specs spin up DB connections; give them room.
  testTimeout: 30000,
};
