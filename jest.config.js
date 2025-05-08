module.exports = {
  testEnvironment: 'node',
  setupFiles: ["<rootDir>/test/testEnvVar.js"],
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
