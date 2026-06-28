<script setup lang="ts">
import { computed } from 'vue'
import type { TopicNode } from '@/api/mqtt'

const props = defineProps<{
  nodes: Record<string, TopicNode>
  selectedTopic: string | null
  depth?: number
}>()

const emit = defineEmits<{
  (e: 'select', node: TopicNode): void
}>()

const sorted = computed(() =>
  Object.values(props.nodes).sort((a, b) => {
    // Folders (children) before leaves, then alphabetical
    const aHasChildren = Object.keys(a.children).length > 0
    const bHasChildren = Object.keys(b.children).length > 0
    if (aHasChildren !== bHasChildren) return aHasChildren ? -1 : 1
    return a.name.localeCompare(b.name)
  }),
)

function hasChildren(node: TopicNode) {
  return Object.keys(node.children).length > 0
}

function typeColor(t: string) {
  if (t === 'json') return '#52c41a'
  if (t === 'binary') return '#722ed1'
  return '#1677ff'
}

function fmtCount(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
</script>

<template>
  <div class="topic-tree">
    <div
      v-for="node in sorted"
      :key="node.fullTopic"
      class="topic-node"
    >
      <!-- Leaf topic (has messages) -->
      <div
        v-if="node.count > 0 || !hasChildren(node)"
        class="topic-row"
        :class="{ selected: selectedTopic === node.fullTopic }"
        @click="emit('select', node)"
      >
        <span class="topic-indent" :style="{ width: `${(depth ?? 0) * 14}px` }" />
        <span class="topic-icon">
          <span v-if="hasChildren(node)" class="folder-icon">▾</span>
          <span v-else class="leaf-icon" :style="{ background: typeColor(node.messageType) }" />
        </span>
        <span class="topic-name">{{ node.name }}</span>
        <span v-if="node.count > 0" class="topic-count">{{ fmtCount(node.count) }}</span>
        <span v-if="node.retain" class="topic-retain" title="Retained">R</span>
      </div>

      <!-- Folder label (no own messages, only has children) -->
      <div
        v-else
        class="topic-row topic-folder"
      >
        <span class="topic-indent" :style="{ width: `${(depth ?? 0) * 14}px` }" />
        <span class="topic-icon"><span class="folder-icon">▾</span></span>
        <span class="topic-name topic-name--dim">{{ node.name }}</span>
      </div>

      <!-- Recurse -->
      <TopicTree
        v-if="hasChildren(node)"
        :nodes="node.children"
        :selected-topic="selectedTopic"
        :depth="(depth ?? 0) + 1"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.topic-tree {
  font-size: 12px;
  font-family: 'SFMono-Regular', 'Consolas', monospace;
}

.topic-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 6px;
  cursor: pointer;
  border-radius: 4px;
  user-select: none;
  transition: background 0.1s;
}

.topic-row:hover {
  background: rgba(22, 119, 255, 0.08);
}

.topic-row.selected {
  background: rgba(22, 119, 255, 0.14);
  color: #1677ff;
}

.topic-folder {
  cursor: default;
  opacity: 0.7;
}

.topic-indent {
  display: inline-block;
  flex-shrink: 0;
}

.topic-icon {
  width: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.folder-icon {
  font-size: 11px;
  color: #999;
}

.leaf-icon {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}

.topic-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topic-name--dim {
  color: #aaa;
}

.topic-count {
  font-size: 10px;
  color: #999;
  background: rgba(0,0,0,0.06);
  border-radius: 8px;
  padding: 0 5px;
  flex-shrink: 0;
}

.topic-retain {
  font-size: 9px;
  color: #fa8c16;
  font-weight: 700;
  flex-shrink: 0;
}
</style>
