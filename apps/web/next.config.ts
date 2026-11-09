import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // trace dependencies from the monorepo root so the standalone bundle is complete
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
