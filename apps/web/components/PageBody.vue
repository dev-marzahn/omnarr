<!--
  The body's width box: one centred column of at most 1152 px for every
  page, so no page sets a width and switching tabs never
  changes it. The panel's body gives the padding (p-6, p-4 on a phone).
-->
<template>
  <div class="mx-auto w-full max-w-6xl flex flex-col gap-4 sm:gap-6">
    <slot />
  </div>
</template>
