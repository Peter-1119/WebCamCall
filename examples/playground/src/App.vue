<script setup>
import { VERSION } from '@scanner/core'
import { CORE_VERSION } from '@scanner/vue'
import { ScannerOverlay } from '@scanner/ui'

// Phase 0：只驗證三個 package 都能被 playground 引用，以及裝置能力
const secure = window.isSecureContext
const hasGum = !!navigator.mediaDevices?.getUserMedia
const hasBarcodeDetector = 'BarcodeDetector' in window
</script>

<template>
  <main style="font-family: system-ui; padding: 1rem">
    <h1>@scanner playground</h1>
    <ul>
      <li>core VERSION: {{ VERSION }}</li>
      <li>vue → core: {{ CORE_VERSION }}</li>
      <li>isSecureContext: {{ secure }}</li>
      <li>getUserMedia: {{ hasGum }}</li>
      <li>BarcodeDetector: {{ hasBarcodeDetector }}</li>
    </ul>
    <div style="position: relative; height: 120px; border: 1px dashed #999">
      <ScannerOverlay>overlay slot ok</ScannerOverlay>
    </div>
  </main>
</template>
