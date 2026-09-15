<script setup lang="ts">
// Phase 5 placeholder —— 零文案、零邏輯
</script>

<template>
  <div class="scanner-overlay">
    <slot />
  </div>
</template>

<style scoped>
.scanner-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
