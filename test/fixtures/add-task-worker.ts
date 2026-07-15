// Fixture invoked as a standalone child process (via tsx) by
// tasks-registry.test.ts to exercise addTask()'s lockfile-guarded
// read-modify-write under real OS scheduling instead of vitest's
// single-threaded event loop (addTask is fully synchronous, so calls made
// within a single Node process never actually interleave). Adds one task
// whose title is the id passed as argv[2] and exits.
import { addTask } from '../../src/cli/tasks-registry.js';

const id = process.argv[2];
if (!id) {
  throw new Error('usage: add-task-worker.ts <id>');
}

addTask({
  id,
  title: `task-${id}`,
  repo: '/repo/concurrency-test',
  created_at: new Date().toISOString(),
});
