// Each test file starts in the shared scratch instance (see vitest.base.config.ts),
// whatever an earlier file in the same worker left in BARRY_HOME.
if (process.env.BARRY_TEST_INSTANCE_HOME) process.env.BARRY_HOME = process.env.BARRY_TEST_INSTANCE_HOME;
