/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@meeting-prd/core'],
  // The pipeline touches node:crypto and node:fs — keep it off the edge runtime.
  serverExternalPackages: [],
};

export default nextConfig;
