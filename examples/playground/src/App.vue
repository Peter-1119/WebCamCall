<script setup>
import { ref } from 'vue'
import CoreDemo from './CoreDemo.vue'
import VueDemo from './VueDemo.vue'
import ComponentDemo from './ComponentDemo.vue'
import BenchDemo from './BenchDemo.vue'

const tab = ref(localStorage.getItem('demo') ?? 'ui')
const pick = (t) => { tab.value = t; localStorage.setItem('demo', t) }
</script>

<template>
  <nav class="tabs">
    <button :class="{ on: tab === 'ui' }" @click="pick('ui')">&lt;BarcodeScanner&gt;</button>
    <button :class="{ on: tab === 'vue' }" @click="pick('vue')">useBarcodeScanner()</button>
    <button :class="{ on: tab === 'core' }" @click="pick('core')">@cclemon/scanner-core</button>
    <button :class="{ on: tab === 'bench' }" @click="pick('bench')">bench</button>
  </nav>
  <!-- key 讓切換時整個 demo 重建，相機一定會被 stop -->
  <ComponentDemo v-if="tab === 'ui'" key="ui" />
  <VueDemo v-else-if="tab === 'vue'" key="vue" />
  <BenchDemo v-else-if="tab === 'bench'" key="bench" />
  <CoreDemo v-else key="core" />
</template>

<style>
.tabs { display: flex; gap: 4px; padding: 8px 8px 0; max-width: 480px; margin: 0 auto; }
.tabs button { flex: 1; padding: 8px; background: #222; color: #aaa; border: 1px solid #444; }
.tabs button.on { background: #333; color: #fff; border-color: #9f9; }
</style>
