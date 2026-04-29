/** @type {import('tailwindcss').Config} */
export default {
  content: ['./views/**/*.ejs', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'bg-subtle': 'var(--color-bg-subtle)',
        'ink-900': 'var(--color-ink-900)',
        'ink-700': 'var(--color-ink-700)',
        'ink-500': 'var(--color-ink-500)',
        'ink-300': 'var(--color-ink-300)',
        'ink-100': 'var(--color-ink-100)',
        accent: 'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        warn: 'var(--color-warn)',
        error: 'var(--color-error)',
        success: 'var(--color-success)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif']
      }
    }
  },
  plugins: []
};
