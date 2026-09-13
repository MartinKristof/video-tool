import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Remotion's renderer/bundler are Node-native (spawn ffmpeg, load esbuild +
  // platform-specific binaries). They must NOT be bundled by Turbopack/Webpack —
  // externalize them so the /api/render route compiles and export works.
  serverExternalPackages: ["@remotion/cli", "@remotion/renderer", "@remotion/bundler", "esbuild"],
};

export default nextConfig;
