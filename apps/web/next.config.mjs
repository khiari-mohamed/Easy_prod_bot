/** The dashboard proxies /api and /media to the API so the session cookie stays same-origin. */
const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'ngrok-skip-browser-warning', value: '1' }],
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API}/:path*` },
      { source: '/media/:path*', destination: `${API}/media/:path*` },
    ];
  },
};

export default nextConfig;
