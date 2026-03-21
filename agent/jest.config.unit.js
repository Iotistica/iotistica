/**
 * Jest configuration for UNIT tests only
 * Tests that mock all external dependencies
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  testMatch: [
    '**/*.unit.spec.ts',
    '!**/sensors/**/*.unit.spec.ts',     // Skip deprecated sensor tests
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!uuid)'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/migrations/**',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage/unit',
  verbose: true,
  forceExit: true,
  displayName: 'Unit Tests',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/test/tsconfig.json'
    }]
  }
};
