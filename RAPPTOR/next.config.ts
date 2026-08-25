import type { NextConfig } from "next";

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

if (process.env.NODE_ENV === 'development') {
  void initOpenNextCloudflareForDev();
}

// ---- Content Security Policy ----
const ALLOWED_SCRIPT_SRCS = [
  "'self'",
  "'unsafe-inline'",
  "'unsafe-eval'",
];

const ALLOWED_CONNECT_SRCS = [
  "'self'",
  "data:",
  "blob:",
  "https:",
];

const ALLOWED_IMG_SRCS = [
  "'self'",
  "data:",
  "blob:",
];

const CSP = [
  "default-src 'self'",
  "script-src " + ALLOWED_SCRIPT_SRCS.join(" "),
  "style-src 'self' 'unsafe-inline'",
  "img-src " + ALLOWED_IMG_SRCS.join(" "),
  "font-src 'self'",
  "connect-src " + ALLOWED_CONNECT_SRCS.join(" "),
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-XSS-Protection", value: "0" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

// Local release routes resolve `.data` at request time. Shipping those files in
// the standalone trace would duplicate the multi-gigabyte release and is not
// needed when production uses D1/Hugging Face or explicitly mounted local data.
const localReleaseTraceExcludes = [".data/**/*"];

const nextConfig: NextConfig = {
  distDir: process.env.RAPPTOR_NEXT_DIST_DIR || '.next',
  output: "standalone",
  outputFileTracingExcludes: {
    "/api/local-data/**": localReleaseTraceExcludes,
    "/api/local-region/**": localReleaseTraceExcludes,
    "/api/local-release/**": localReleaseTraceExcludes,
  },
  transpilePackages: [
    "@jbrowse/product-core",
    "@jbrowse/react-linear-genome-view",
    "@jbrowse/plugin-linear-genome-view",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
