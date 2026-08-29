<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { examples } from "./config/examples.js";

const route = useRoute();
const router = useRouter();

const groupedExamples = computed(() => {
  return examples.reduce((groups, example) => {
    const category = example.category || "Examples";
    (groups[category] ||= []).push(example);
    return groups;
  }, {});
});

function navigateTo(path) {
  if (route.path !== path) router.push(path);
}
</script>

<template>
  <div class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="sidebar-title">Cesium 示例</h1>
        <p class="sidebar-subtitle">Open Source Examples</p>
      </div>

      <nav class="sidebar-nav" aria-label="示例导航">
        <template v-for="(items, category) in groupedExamples" :key="category">
          <div class="nav-category">{{ category }}</div>
          <button
            v-for="example in items"
            :key="example.path"
            class="nav-item"
            :class="{ active: route.path === example.path }"
            type="button"
            @click="navigateTo(example.path)"
          >
            <span class="nav-icon" aria-hidden="true">{{ example.icon }}</span>
            <span class="nav-text">{{ example.title }}</span>
          </button>
        </template>
      </nav>

      <div class="sidebar-footer">
        <p class="footer-hint">Vue 3 + Vite + Cesium</p>
      </div>
    </aside>

    <main class="main-content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>
