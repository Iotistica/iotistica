<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  data: number[]
  color?: string
  fillColor?: string
  width?: number
  height?: number
}>(), {
  color: '#1677ff',
  fillColor: 'rgba(22,119,255,0.12)',
  width: 160,
  height: 48,
})

const paths = computed(() => {
  const pts = props.data
  if (pts.length < 2) return { line: '', area: '' }

  const w = props.width
  const h = props.height
  const max = Math.max(...pts, 1)
  const coords = pts.map((v, i) => [
    (i / (pts.length - 1)) * w,
    h - (v / max) * (h - 4) - 2,   // 2px padding top/bottom
  ])

  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  return { line, area }
})
</script>

<template>
  <svg :width="width" :height="height" style="display:block; overflow:visible">
    <path :d="paths.area" :fill="fillColor" />
    <path :d="paths.line" :stroke="color" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
