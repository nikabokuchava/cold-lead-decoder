/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'jsdom',
    '@mozilla/readability',
    'html-encoding-sniffer',
    '@exodus/bytes',
    'whatwg-encoding',
    'parse5',
    'tr46',
    'webidl-conversions',
    'w3c-xmlserializer',
    'saxes',
    'symbol-tree',
    'nwsapi',
    'cheerio',
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const nodeExternals = [
        'jsdom',
        'html-encoding-sniffer',
        '@exodus/bytes',
        'whatwg-encoding',
      ];
      if (Array.isArray(config.externals)) {
        config.externals.push(...nodeExternals);
      }
    }
    return config;
  },
};

export default nextConfig;
