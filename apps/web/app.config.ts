// The Nuxt UI theme: slate as the action colour, so no state hue doubles as
// it, and violet for "Preparing".
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'slate',
      secondary: 'violet',
      success: 'green',
      info: 'blue',
      warning: 'amber',
      error: 'red',
      neutral: 'slate',
    },
    dashboardPanel: {
      slots: {
        body: 'scrollbar-gutter-stable',
      },
    },
  },
});
