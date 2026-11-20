const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ["@zavi/shared"],
  async redirects() {
    return [
      { source: "/tasks", destination: "/approvals", permanent: false },
      { source: "/onboarding", destination: "/start", permanent: true },
      { source: "/upcar", destination: "/live/upcar", permanent: false },
      { source: "/auth/reset", destination: "/auth/callback", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/live/:slug/review/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      {
        source: "/extension/connect",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      {
        source: "/pages/:id",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'; frame-src 'none'" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/r-Hg5x3K/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/r-Hg5x3K/decide",
        destination: "https://us.i.posthog.com/decide",
      },
      {
        source: "/r-Hg5x3K/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
};

export default nextConfig;
