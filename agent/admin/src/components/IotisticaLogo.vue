<script setup lang="ts">
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    :width="size ?? 28"
    :height="size ?? 28"
    style="display: block; flex-shrink: 0"
  >
    <rect width="32" height="32" rx="7" fill="#1677ff"/>
    <polygon
      points="16,5 25.53,10.5 25.53,21.5 16,27 6.47,21.5 6.47,10.5"
      fill="none"
      stroke="white"
      stroke-width="1.6"
      stroke-linejoin="round"
      opacity="0.45"
    />
    <line x1="16" y1="16" x2="16"    y2="5"    stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="16" y1="16" x2="25.53" y2="21.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="16" y1="16" x2="6.47"  y2="21.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="16"    cy="16"   r="3"   fill="white"/>
    <circle cx="16"    cy="5"    r="2.2" fill="white"/>
    <circle cx="25.53" cy="21.5" r="2.2" fill="white"/>
    <circle cx="6.47"  cy="21.5" r="2.2" fill="white"/>
  </svg>
</template>
