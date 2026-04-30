/** @type {import('tailwindcss').Config} */
export default {
  content: ['./views/**/*.ejs', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        obsidian: 'var(--c-obsidian)',
        carbon:   'var(--c-carbon)',
        ivory:    'var(--c-ivory)',
        pearl:    'var(--c-pearl)',
        slate:    'var(--c-slate)',
        stone:    'var(--c-stone)',
        moss:     'var(--c-moss)',
        gold:     'var(--c-gold)',
        ice:      'var(--c-ice)',
        white:    'var(--c-white)',
        error:    'var(--c-error)',
        warn:     'var(--c-warn)',
        success:  'var(--c-success)',
        'fg-on-dark':         'var(--fg-on-dark)',
        'fg-on-dark-muted':   'var(--fg-on-dark-muted)',
        'fg-on-light':        'var(--fg-on-light)',
        'fg-on-light-muted':  'var(--fg-on-light-muted)',
        'border-dark':        'var(--border-dark)',
        'border-light':       'var(--border-light)'
      },
      fontFamily: {
        display: ['Satoshi', 'system-ui', 'sans-serif'],
        body:    ['"General Sans"', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      },
      fontSize: {
        xs:    ['var(--f-xs)',  { lineHeight: 'var(--lh-body)' }],
        sm:    ['var(--f-sm)',  { lineHeight: 'var(--lh-body)' }],
        md:    ['var(--f-md)',  { lineHeight: 'var(--lh-body)' }],
        lg:    ['var(--f-lg)',  { lineHeight: 'var(--lh-lead)' }],
        xl:    ['var(--f-xl)',  { lineHeight: 'var(--lh-lead)' }],
        '2xl': ['var(--f-2xl)', { lineHeight: 'var(--lh-head)' }],
        '3xl': ['var(--f-3xl)', { lineHeight: 'var(--lh-head)' }],
        '4xl': ['var(--f-4xl)', { lineHeight: 'var(--lh-display)' }],
        '5xl': ['var(--f-5xl)', { lineHeight: 'var(--lh-display)' }]
      },
      letterSpacing: {
        display: 'var(--ls-display)',
        head:    'var(--ls-head)',
        body:    'var(--ls-body)',
        upper:   'var(--ls-upper)'
      },
      spacing: {
        1:  'var(--s-1)',
        2:  'var(--s-2)',
        3:  'var(--s-3)',
        4:  'var(--s-4)',
        6:  'var(--s-6)',
        8:  'var(--s-8)',
        12: 'var(--s-12)',
        16: 'var(--s-16)',
        24: 'var(--s-24)',
        32: 'var(--s-32)',
        40: 'var(--s-40)',
        48: 'var(--s-48)'
      },
      maxWidth: {
        container: 'var(--container)',
        content:   'var(--content)',
        prose:     'var(--prose)'
      },
      borderRadius: {
        btn:  'var(--radius-btn)',
        card: 'var(--radius-card)'
      },
      boxShadow: {
        card: 'var(--shadow-card)'
      },
      transitionDuration: {
        micro:  'var(--dur-micro)',
        reveal: 'var(--dur-reveal)'
      },
      transitionTimingFunction: {
        expo: 'var(--ease-expo)'
      }
    }
  },
  plugins: []
};
