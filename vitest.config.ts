import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        // `@actions/github` builds its context from the environment once, at
        // import time. Inlining it lets `vi.resetModules()` rebuild the context
        // so each test can define its own workflow event.
        inline: ['@actions/github'],
      },
    },
  },
});
