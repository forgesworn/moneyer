// Inline stroke icons, one visual family, sized by the CSS that places
// them. Icon-first UI: every action reads at a glance before any label.

const svg = (body: string, viewBox = '0 0 24 24'): string =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  logo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.6v8.8"/><path d="M15.4 9.4c-.7-1.1-1.9-1.8-3.4-1.8-2 0-3.6 1.1-3.6 2.7 0 3.4 7.2 1.8 7.2 5 0 1.6-1.6 2.7-3.6 2.7-1.5 0-2.7-.7-3.4-1.8"/></svg>`,
  bolt: svg('<path d="M13 2 4.5 13.5H11L9.5 22 18 10.5h-6.5L13 2z"/>'),
  mint: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8.2v7.6"/><path d="M15 9.8c-.6-1-1.7-1.6-3-1.6-1.8 0-3.2 1-3.2 2.4 0 3 6.4 1.6 6.4 4.4 0 1.4-1.4 2.4-3.2 2.4-1.3 0-2.4-.6-3-1.6"/>'),
  check: svg('<path d="m4.5 12.5 5 5 10-11"/>'),
  shield: svg('<path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8 7.5 10 4.3-2 7.5-5.4 7.5-10v-6L12 2.5z"/><path d="m8.8 12 2.2 2.2 4.2-4.6"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>'),
  qr: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M13.5 13.5h3v3h-3z"/><path d="M20.5 13.5v3"/><path d="M13.5 20.5h3"/><path d="M20.5 20.5v.01"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>'),
  paste: svg('<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 12h6"/><path d="M9 16h4"/>'),
  back: svg('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  note: svg('<rect x="2.5" y="6" width="19" height="12" rx="3"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01"/><path d="M18 14.5v.01"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  x: svg('<path d="m6 6 12 12"/><path d="m18 6-12 12"/>'),
  hourglass: svg('<path d="M7 3h10"/><path d="M7 21h10"/><path d="M8 3c0 4 3 5 3 7s-3 3-3 7"/><path d="M16 3c0 4-3 5-3 7s3 3 3 7"/>'),
  refresh: svg('<path d="M20 11.5A8 8 0 1 0 18.4 17"/><path d="M20 5v6.5h-6.5"/>'),
  wallet: svg('<rect x="2.5" y="6" width="19" height="13" rx="3.5"/><path d="M2.5 10h12"/><rect x="15" y="11.5" width="4.5" height="3.5" rx="1.75" fill="currentColor" stroke="none"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5"/>'),
  scale: svg('<path d="M12 4v16"/><path d="M7 20h10"/><path d="M4 7l16 0"/><path d="m6.5 7-2.5 5.5a2.6 2.6 0 0 0 5 0L6.5 7z"/><path d="m17.5 7-2.5 5.5a2.6 2.6 0 0 0 5 0L17.5 7z"/>')
} as const

export type IconName = keyof typeof icons
