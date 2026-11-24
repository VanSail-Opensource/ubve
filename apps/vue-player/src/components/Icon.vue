<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  play: 'M8 5v14l11-7z', pause: 'M8 5v14M16 5v14',
  folder: 'M3 7h7l2 2h9v11H3zM3 7V4h6l3 3',
  link: 'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
  volume: 'M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
  muted: 'M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6',
  fullscreen: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
  pip: 'M3 4h18v16H3zM11 11h8v7h-8z',
  subtitles: 'M3 5h18v14H3zM6 11h4M14 11h4M6 15h2M11 15h7',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  close: 'M6 6l12 12M6 18 18 6', chevron: 'm9 5 7 7-7 7',
  film: 'M5 3h14v18H5zM5 7h14M5 17h14M8 3v4M16 3v4M8 17v4M16 17v4',
  plus: 'M12 5v14M5 12h14', check: 'm5 12 4 4L19 6',
  shield: 'm12 3 8 4v5c0 4-4 7-8 9-4-2-8-5-8-9V7zM8 12l3 3 5-6',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  info: 'M12 8v.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  back: 'm11 7-6 5 6 5M19 5v14',
  next: 'm13 7 6 5-6 5M5 5v14',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
};
</script>
<template>
  <svg :width="size ?? 20" :height="size ?? 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.info" /></svg>
</template>
