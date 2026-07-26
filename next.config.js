// Static-demo build for GitHub Pages (scripts/deployDemo.sh): export the
// spell crafter as plain files served under /<repo>.
const isSpellDemo = process.env.NEXT_PUBLIC_SPELL_DEMO === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isSpellDemo
    ? {
        output: "export",
        basePath: "/conjurer",
        assetPrefix: "/conjurer",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  experimental: {
    optimizePackageImports: [
      "recharts",
      "@aws-sdk/client-s3",
      "@aws-sdk/credential-providers",
    ],
  },
  webpack: (config, options) => {
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      use: ["raw-loader", "glslify-loader"],
    });
    return config;
  },
  eslint: {
    dirs: ["modules", "pages"],
    ignoreDuringBuilds: true,
  },
};

const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true",
});
module.exports = withBundleAnalyzer(nextConfig);

// module.exports = nextConfig;
