import { defineComponent } from 'convex/server';

// The locally installed Better Auth component: its schema is generated from
// our options (../authOptions.ts), so it has the admin plugin's fields.
const component = defineComponent('betterAuth');

export default component;
