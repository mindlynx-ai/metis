/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The whole icon set: one component, inline stroke paths, no icon library.
 * Icons inherit currentColor and are decorative (aria-hidden) - the button or
 * label they sit in carries the accessible name.
 */
export const ICON_PATHS = {
  workflow: 'M3 5h5v5H3zM16 14h5v5h-5zM8 7.5h5a3 3 0 0 1 3 3V14',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  play: 'M8 5.5l11 6.5-11 6.5z',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM21 21l-5-5',
  plug: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-5 5v0a5 5 0 0 1-5-5zM12 16v5',
  pencil: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19zM13.5 6.5l3 3',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  check: 'M4 12.5l5 5L20 6.5',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  list: 'M8.5 6h12M8.5 12h12M8.5 18h12M4 6h.01M4 12h.01M4 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  alert: 'M12 9v4.5M12 17.2h.01M10.3 3.8L1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  chevron: 'M9 6l6 6-6 6',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  info: 'M12 16v-4.5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M18 6l1.5-1.5M4.5 19.5L6 18M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  logout: 'M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M9 16l-5-4 5-4M4 12h11',
  // Node-type glyphs (also used by the builder canvas nodes).
  webhook: 'M9 8a3 3 0 1 1 4 2.8l-2.3 4M15 15a3 3 0 1 1-2.5 4.6M6.5 12.5A3 3 0 1 1 9 18h5M12 10.8l-2.6 4.6M14.7 15h-4.5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14',
  branch: 'M6 3v12M6 15a3 3 0 1 0 0 .01M6 3a3 3 0 1 0 0 .01M18 9a3 3 0 1 0 0 .01M18 9c0 3-3 6-6 6H6',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  // The Sky (cloud uplift) glyph set, traced from the signed-off prototypes.
  cloud: 'M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 7 19z',
  'cloud-off':
    'M6.4 6.5A6 6 0 0 1 17.5 10a4.5 4.5 0 0 1 3.9 6.9M17.7 18.9 7 19a4 4 0 0 1-1.1-7.9M3 3l18 18',
  'cloud-check':
    'M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.6A4 4 0 0 0 7 19zM9 13.5l2.2 2L15 11',
  computer: 'M3 4h18v12H3zM8 20h8M12 16v4',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  memory:
    'M12 4a4 4 0 0 0-4 4v1a4 4 0 0 0-1 7.9V18a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-1.1A4 4 0 0 0 16 9V8a4 4 0 0 0-4-4z',
  bot: 'M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 8V4M8.5 13h.01M15.5 13h.01',
  stamp:
    'M12 3v7M8 21h8M6 17h12a1 1 0 0 0 1-1v-1a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3v1a1 1 0 0 0 1 1z',
  spark: 'M12 3l1.9 5.6L20 10l-5.6 1.9L12 18l-1.9-6.1L4 10l6.1-1.4z',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({
  name,
  size = 16,
  className,
  fill = false,
}: {
  name: IconName;
  size?: number;
  className?: string;
  /** Solid variant (the filled cloud chip): the path fills with currentColor. */
  fill?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={fill ? 1.5 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={ICON_PATHS[name]} fill={fill ? 'currentColor' : undefined} />
    </svg>
  );
}
