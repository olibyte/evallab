import type { NextConfig } from "next";

// Repository files are canonical for the policy, datasets, benchmarks and
// replay fixtures, so they are read from disk at runtime and traced into the
// server bundle here.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/": ["./data/replays/**"],
    "/api/respond": ["./src/domain/support-policy.md"],
    "/engineering": [
      "./data/replays/**",
      "./evals/datasets/**",
      "./evals/benchmarks/**",
    ],
  },
};

export default nextConfig;
