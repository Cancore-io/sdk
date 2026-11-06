import type { Options } from 'tsup';

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * Bundling hoists chunk and package imports above inlined code, so the HTTP/1.1
 * installer would run after them. Bins are built without splitting and import the
 * installer as a separate file, which keeps it the first module evaluated (CAN-3344).
 */
const keepInstallerSeparate: EsbuildPlugin = {
  name: 'keep-http1-installer-separate',
  setup(build) {
    build.onResolve({ filter: /^\.\/install-http1-dispatcher$/ }, () => ({ path: './install-http1-dispatcher.js', external: true }));
  },
};

export function daemonBinConfig(bins: Record<string, string>): Options {
  return {
    entry: { ...bins, 'install-http1-dispatcher': 'src/install-http1-dispatcher.ts' },
    format: ['esm'],
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    esbuildPlugins: [keepInstallerSeparate],
  };
}

export function cleanExceptBins(bins: Record<string, string>): string[] {
  return ['**/*', ...[...Object.keys(bins), 'install-http1-dispatcher'].map((name) => `!${name}.js*`)];
}
