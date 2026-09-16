import next from "eslint-config-next";

const config = [
  {
    ignores: [
      ".agents/**",
      ".claude/**",
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...next,
];

export default config;
