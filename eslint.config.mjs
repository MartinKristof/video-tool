import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Runtime project data, not source.
    "data/**",
    // Emitted by scripts/build-chat-gifs.cjs and scripts/build-aichat-snippet.cjs.
    "remotion/scenes/gen/**",
    "**/*.built.tsx",
    // Source for those generators, not a standalone component.
    "**/*.template.tsx",
  ]),
  {
    // Node scripts run outside the bundler, where require() is the point.
    files: ["scripts/**/*.{js,cjs}"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Remotion paints into a video through headless Chrome, so next/image and
    // its LCP heuristics do not apply.
    files: ["remotion/**", "scripts/**"],
    rules: { "@next/next/no-img-element": "off" },
  },
]);

export default eslintConfig;
