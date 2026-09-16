import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The support policy is read from disk at runtime so the markdown file
  // stays the single authoritative source.
  outputFileTracingIncludes: {
    "/api/respond": ["./src/domain/support-policy.md"],
  },
};

export default nextConfig;
