// Set environment variables before any test files load the module
process.env.TEST_WORKSPACE = '/tmp/test_workspace_jest';
process.env.PORT = '0'; // Use random port for testing
