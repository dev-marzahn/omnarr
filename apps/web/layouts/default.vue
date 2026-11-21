<!--
  The app shell: the sidebar and the page's UDashboardPanel, which brings
  its own PageHeader (with the worker banner above it) and PageBody. The
  collapsed state is kept in UDashboardGroup's cookie.
-->
<template>
  <UDashboardGroup unit="rem" storage-key="omnarr">
    <AppSidebar />
    <slot />
  </UDashboardGroup>
</template>
