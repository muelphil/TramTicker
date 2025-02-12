<template>
  <div>
    Departure Times for {{stationId}}
  </div>
</template>

<script setup lang="ts">
defineProps<{
  stationId: number
}>()
</script>

<style scoped>
</style>
