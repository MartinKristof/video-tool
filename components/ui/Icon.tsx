"use client";

import React from "react";

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronLeft: <path d="M10 4l-4 4 4 4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  arrowLeft: <path d="M13 8H3M7 4L3 8l4 4" />,
  play: <path d="M5 3v10l8-5z" fill="currentColor" stroke="none" />,
  pause: <g><rect x="4" y="3" width="3" height="10" fill="currentColor" stroke="none" /><rect x="9" y="3" width="3" height="10" fill="currentColor" stroke="none" /></g>,
  stop: <rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" />,
  skipBack: <g><path d="M12 3l-6 5 6 5V3z" fill="currentColor" stroke="none" /><rect x="3" y="3" width="1.5" height="10" fill="currentColor" stroke="none" /></g>,
  skipForward: <g><path d="M4 3l6 5-6 5V3z" fill="currentColor" stroke="none" /><rect x="11.5" y="3" width="1.5" height="10" fill="currentColor" stroke="none" /></g>,
  loop: <path d="M3 8a5 5 0 0 1 10 0 5 5 0 0 1-10 0M11 3l2 2-2 2" />,
  search: <g><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></g>,
  dots: <g><circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" /></g>,
  copy: <g><rect x="3" y="3" width="8" height="8" rx="1" /><path d="M5 13h6a2 2 0 0 0 2-2V5" /></g>,
  trash: <g><path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9" /></g>,
  duplicate: <g><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="6" y="6" width="7" height="7" rx="1" /></g>,
  download: <g><path d="M8 2v8M4 7l4 4 4-4M2 13h12" /></g>,
  upload: <g><path d="M8 11V3M4 6l4-4 4 4M2 13h12" /></g>,
  folder: <path d="M2 4h4l1 1h7v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" />,
  image: <g><rect x="2" y="3" width="12" height="10" rx="1" /><circle cx="6" cy="7" r="1.2" /><path d="M3 12l3-3 3 3 2-2 2 2" /></g>,
  film: <g><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M5 3v10M11 3v10M2 6h3M11 6h3M2 10h3M11 10h3" /></g>,
  sparkle: <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" fill="currentColor" stroke="none" />,
  send: <path d="M2 8l12-5-5 12-2-5z" />,
  attach: <path d="M11 7l-5 5a2.5 2.5 0 0 1-3.5-3.5l6-6a2 2 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5l5-5" />,
  code: <path d="M5 4L2 8l3 4M11 4l3 4-3 4M9 3l-2 10" />,
  chat: <path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 2v-2H3a1 1 0 0 1-1-1V4z" />,
  monitor: <g><rect x="2" y="3" width="12" height="9" rx="1" /><path d="M5 14h6M8 12v2" /></g>,
  grid: <g><rect x="3" y="3" width="4" height="4" /><rect x="9" y="3" width="4" height="4" /><rect x="3" y="9" width="4" height="4" /><rect x="9" y="9" width="4" height="4" /></g>,
  list: <g><path d="M3 4h10M3 8h10M3 12h10" /></g>,
  settings: <g><circle cx="8" cy="8" r="2" /><path d="M8 1v2M8 13v2M15 8h-2M3 8H1M13 3l-1.5 1.5M4.5 11.5L3 13M13 13l-1.5-1.5M4.5 4.5L3 3" /></g>,
  check: <path d="M3 8l3 3 7-7" />,
  warn: <g><path d="M8 2l7 12H1z" /><path d="M8 6v4M8 12v.5" /></g>,
  info: <g><circle cx="8" cy="8" r="6" /><path d="M8 5v.5M8 8v4" /></g>,
  help: <g><circle cx="8" cy="8" r="6" /><path d="M6.3 6.3a1.75 1.75 0 1 1 1.7 2.1v.8M8 11.4v.4" /></g>,
  layers: <g><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></g>,
  aspect: <g><rect x="2" y="4" width="12" height="8" rx="1" /><path d="M6 4v8M10 4v8" /></g>,
  maximize: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  minimize: <path d="M6 3v3H3M10 3v3h3M10 13v-3h3M6 13v-3H3" />,
  movie: <g><rect x="2" y="5" width="12" height="8" rx="1" /><path d="M4 5l1-2h2l-1 2M8 5l1-2h2l-1 2M12 5l1-2" /></g>,
  bolt: <path d="M9 2L3 9h4l-1 5 6-7H8z" fill="currentColor" stroke="none" />,
  checkerboard: <g><rect x="2" y="2" width="12" height="12" rx="1" /><rect x="2" y="2" width="6" height="6" fill="currentColor" stroke="none" /><rect x="8" y="8" width="6" height="6" fill="currentColor" stroke="none" /></g>,
  scissors: <g><circle cx="4" cy="4" r="2" /><circle cx="4" cy="12" r="2" /><path d="M5.8 5.4L14 12M5.8 10.6L14 4" /></g>,
  // Track controls read as what they do: a speaker for sound, an eye for
  // visibility, each with a slash through it when off.
  speaker: <g><path d="M8 3L5 6H2.5v4H5l3 3V3z" /><path d="M10.5 6a3 3 0 0 1 0 4" /></g>,
  speakerOff: <g><path d="M8 3L5 6H2.5v4H5l3 3V3z" /><path d="M11 6l3 4M14 6l-3 4" /></g>,
  eye: <g><path d="M1.5 8S4 4 8 4s6.5 4 6.5 4S12 12 8 12 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></g>,
  eyeOff: <g><path d="M6 4.4A6.3 6.3 0 0 1 8 4c4 0 6.5 4 6.5 4a12 12 0 0 1-2 2.3M9.8 11.7A6.6 6.6 0 0 1 8 12c-4 0-6.5-4-6.5-4a12 12 0 0 1 2.8-2.9" /><path d="M2.5 2.5l11 11" /></g>,
  // Tool-rail glyphs.
  type: <g><path d="M3 4h10M8 4v9M6 13h4" /></g>,
  square: <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />,
  rows: <g><rect x="2" y="3" width="12" height="4" rx="1" /><rect x="2" y="9" width="12" height="4" rx="1" /></g>,
  zoomIn: <g><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M7 5v4M5 7h4" /></g>,
  zoomOut: <g><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14M5 7h4" /></g>,
};

interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: string;
  size?: number;
}

export default function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
