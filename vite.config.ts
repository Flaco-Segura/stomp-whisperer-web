import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/, not at the domain root.
  base: '/stomp-whisperer-web/',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
