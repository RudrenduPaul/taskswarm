// Fixture invoked as a standalone child process (via tsx) by config.test.ts to
// exercise loadOrCreateConfig()'s first-boot race window under real OS
// scheduling instead of vitest's single-threaded event loop. Prints just the
// resolved token to stdout so the parent test can compare what two racing
// processes ended up agreeing on.
import { loadOrCreateConfig } from '../../src/server/config.js';

process.stdout.write(loadOrCreateConfig().token);
