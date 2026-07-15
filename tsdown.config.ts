import { defineConfig } from 'tsdown';

export default defineConfig({
  // One entry per public subpath. Each dialect is its own entry so importing `.../sqlite` pulls in
  // only its driver — the whole point of the package.
  entry: [
    './src/index.ts',
    './src/sqlite/index.ts',
    './src/postgres/index.ts',
    './src/mysql/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  outDir: 'dist',
});
