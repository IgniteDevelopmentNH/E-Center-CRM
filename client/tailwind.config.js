/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // UNH shield navy, and the teal used for growth/innovation accents.
        // Defined in index.css so the admin CRM can swap the whole family for granite.
        navy: {
          DEFAULT: 'rgb(var(--navy-700) / <alpha-value>)',
          50: 'rgb(var(--navy-50) / <alpha-value>)',
          100: 'rgb(var(--navy-100) / <alpha-value>)',
          200: 'rgb(var(--navy-200) / <alpha-value>)',
          600: 'rgb(var(--navy-600) / <alpha-value>)',
          700: 'rgb(var(--navy-700) / <alpha-value>)',
          800: 'rgb(var(--navy-800) / <alpha-value>)',
          900: 'rgb(var(--navy-900) / <alpha-value>)',
        },
        teal: {
          DEFAULT: '#008080',
          50: '#e6f4f4',
          100: '#c7e8e8',
          200: '#8fd2d2',
          600: '#008080',
          700: '#00696a',
          800: '#005253',
        },
        gold: { DEFAULT: '#FFD700', 100: '#fff8d1', 600: '#c9a900' },
        success: '#28a745',
        pending: '#ffc107',
        urgent: '#dc3545',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0, 28, 57, 0.06), 0 1px 3px rgba(0, 28, 57, 0.10)',
        raised: '0 4px 12px rgba(0, 28, 57, 0.10)',
        panel: '-8px 0 32px rgba(0, 28, 57, 0.16)',
      },
      keyframes: {
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'slide-in': 'slide-in 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        'fade-in': 'fade-in 150ms ease-out',
        'toast-in': 'toast-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};
