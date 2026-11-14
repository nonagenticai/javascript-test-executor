const path = require('path');

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/'],
  modulePaths: [path.resolve(__dirname, 'src/node_modules')],
  setupFiles: [path.resolve(__dirname, 'tests/setup.js')],
  setupFilesAfterEnv: [path.resolve(__dirname, 'tests/setup-tenant-header.cjs')],
  verbose: true,
};
