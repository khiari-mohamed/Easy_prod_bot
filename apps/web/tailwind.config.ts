import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#f2b705', dark: '#b88a00', soft: '#fff6d6' },
        ink: '#15171c',
        graphite: '#1b1e25',
        canvas: '#f3f4f6',
        line: '#e5e7ec',
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Noto Sans Arabic',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(21,23,28,0.04), 0 4px 14px -6px rgba(21,23,28,0.10)',
        pop: '0 12px 32px -12px rgba(21,23,28,0.35)',
      },
    },
  },
  plugins: [],
};
export default config;