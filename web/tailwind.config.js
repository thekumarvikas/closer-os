/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        brand: {
          50: '#EEF8F6', 100: '#D3EEE9', 200: '#A6DCD3', 300: '#6FC2B6', 400: '#3FA396',
          500: '#21867A', 600: '#156D63', 700: '#0E5E57', 800: '#0D4A45', 900: '#0B3B37',
        },
        gold: { 400: '#F5B942', 500: '#E9A21B' },
      },
    },
  },
  plugins: [],
}
