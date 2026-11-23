import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@libsql/client",
    "libsql",
    "@libsql/hrana-client",
    "@libsql/core",
    "@libsql/isomorphic-ws",
    "@libsql/isomorphic-fetch",
  ],
};

export default nextConfig;
