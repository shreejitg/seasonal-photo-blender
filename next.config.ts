import type { NextConfig } from "next";
import path from "node:path";

/**
 * @xenova/transformers' env.js does `import fs from "fs"; Object.keys(fs)`.
 * Client bundles that resolve `fs` to `undefined` throw. Stub as `{}` for browser.
 */
const nodeStub = path.join(process.cwd(), "src", "shims", "node-stub.mjs");
const nodeStubTurbopack = `./src/shims/node-stub.mjs` as const;

const nextConfig: NextConfig = {
  serverExternalPackages: ["googleapis"],
  turbopack: {
    resolveAlias: {
      // Next 16: point browser to an empty ESM so isEmpty({}) is true, not isEmpty(undefined)
      fs: { browser: nodeStubTurbopack },
      path: { browser: nodeStubTurbopack },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      const cur = (config.resolve.alias as Record<string, string> | undefined) ?? {};
      config.resolve.alias = {
        ...cur,
        fs: nodeStub,
        path: nodeStub,
      };
    }
    return config;
  },
};

export default nextConfig;
