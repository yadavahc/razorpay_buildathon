import type { Config } from 'tailwindcss';

/**
 * RECLAIM's visual system.
 *
 * A financial control room, not a SaaS dashboard: near-black ground, a narrow silver
 * type scale, and exactly one accent — a cold mint that is reserved for recovered money
 * and nothing else. Colour carries meaning here rather than decoration, so a merchant can
 * read state from a glance across the room.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Layered near-blacks. The steps are deliberately small: depth comes from
        // hairline borders and glow, not from high-contrast panels.
        ink: {
          950: '#050507',
          900: '#08080b',
          850: '#0b0b0f',
          800: '#101015',
          750: '#15151b',
          700: '#1b1b22',
          600: '#25252e',
          500: '#33333e',
        },
        silver: {
          50: '#fafafa',
          100: '#f2f2f4',
          200: '#e4e4e8',
          300: '#c9c9d1',
          400: '#a1a1ad',
          500: '#7c7c8a',
          600: '#5c5c68',
          700: '#42424c',
        },
        // The single accent. Recovered revenue, and nothing else.
        mint: {
          400: '#5eead4',
          500: '#2dd4bf',
          600: '#14b8a6',
          700: '#0d9488',
        },
        // Semantic states. Muted so they read as instrumentation, not alarm.
        risk: {
          400: '#fbbf6e',
          500: '#f59e0b',
          600: '#d97706',
        },
        loss: {
          400: '#f87f7f',
          500: '#ef4444',
          600: '#dc2626',
        },
        info: {
          400: '#93b4f8',
          500: '#6187e8',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
      },
      letterSpacing: {
        widest: '0.18em',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        // Glass surfaces: a hairline top highlight plus depth beneath.
        glass:
          'inset 0 1px 0 0 rgb(255 255 255 / 0.04), 0 1px 2px 0 rgb(0 0 0 / 0.4), 0 8px 24px -8px rgb(0 0 0 / 0.6)',
        'glass-lg':
          'inset 0 1px 0 0 rgb(255 255 255 / 0.05), 0 2px 4px 0 rgb(0 0 0 / 0.5), 0 24px 48px -16px rgb(0 0 0 / 0.7)',
        glow: '0 0 24px -4px rgb(45 212 191 / 0.35)',
        'glow-strong': '0 0 48px -8px rgb(45 212 191 / 0.5)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(to bottom, rgb(255 255 255 / 0.03) 1px, transparent 1px), linear-gradient(to right, rgb(255 255 255 / 0.03) 1px, transparent 1px)',
        'radial-fade':
          'radial-gradient(ellipse 80% 50% at 50% -20%, rgb(45 212 191 / 0.12), transparent)',
      },
      backgroundSize: {
        grid: '48px 48px',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        'ticker-up': {
          from: { transform: 'translateY(100%)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.4s ease-out both',
        shimmer: 'shimmer 2.4s linear infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ticker-up': 'ticker-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
