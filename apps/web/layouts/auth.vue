<!--
  Pages before sign-in: no sidebar, one 380 px column, centred on a desktop
  and top-aligned on a phone so the keyboard doesn't cover the button.
-->
<template>
  <div class="min-h-svh flex justify-center items-start sm:items-center px-4 py-10 sm:py-16">
    <div class="w-full max-w-[380px]">
      <slot />
    </div>
  </div>
</template>
