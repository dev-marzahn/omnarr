<!--
  An Issue's fixes: the first fix as the button, the others in "More fixes"
  with "Open timeline" and Dismiss last. The backend runs them through
  issues.act; "Search and pick", "Set up Jellyfin again" and "Enter a
  metadata key" are the web app's own. A fix with a confirm (`fixConfirm`)
  opens it first; a refused fix shows its reason.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { FixAction, IssueAction, IssueRow } from '@omnarr/contracts';

import { actErrorMessage, FIX_ICONS, FIX_LABELS, fixConfirm, fixToast, type IssueButton, issueActions, issueItemLink } from '~/lib/issues';
import { mediaUrl } from '~/lib/media';

const props = withDefaults(defineProps<{ issue: IssueRow; onItem?: boolean; size?: 'xs' | 'sm' }>(), { onItem: false, size: 'xs' });

const act = useMutation(api.api.issues.act);
const searchAndPick = useSearchAndPick();
const toast = useToast();
const { convex } = useUrls();

const buttons = computed(() => issueActions(props.issue, { onItem: props.onItem }));
const running = ref<FixAction>();
const confirming = ref<FixAction>();
const confirm = computed(() => (confirming.value ? fixConfirm(confirming.value, props.issue) : undefined));
const confirmOpen = computed({
  get: () => confirming.value !== undefined,
  set: (value) => {
    if (!value) confirming.value = undefined;
  },
});
const rerunOpen = ref(false);

async function run(action: FixAction) {
  confirming.value = undefined;
  const unit = props.issue.unit;
  if (action === 'searchAndPick') {
    if (unit) await searchAndPick(unit);
    return;
  }
  if (action === 'rerunJellyfinSetup') return (rerunOpen.value = true);
  if (action === 'enterMetadataKey') return navigateTo('/settings/metadata');
  running.value = action;
  try {
    const result = await act({ issueId: props.issue.issueId, action: action as IssueAction });
    if (result.outcome === 'url') window.open(mediaUrl(result.url, convex), '_blank', 'noopener');
    else toast.add({ title: fixToast(action), color: 'success', icon: FIX_ICONS[action] });
  } catch (error) {
    toast.add({ title: `${FIX_LABELS[action]} didn't run`, description: actErrorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    running.value = undefined;
  }
}

function press(button: IssueButton) {
  if (button === 'openTimeline') {
    const link = issueItemLink(props.issue);
    return link ? navigateTo(link) : undefined;
  }
  if (fixConfirm(button, props.issue)) return (confirming.value = button);
  return run(button);
}

const more = computed(() => [
  buttons.value.more.map((button) => ({
    label: button === 'openTimeline' ? 'Open timeline' : FIX_LABELS[button],
    icon: FIX_ICONS[button],
    onSelect: () => press(button),
  })),
]);
</script>

<template>
  <div class="flex items-center gap-1.5">
    <UButton
      v-if="buttons.primary"
      :size="size"
      color="neutral"
      variant="outline"
      :icon="FIX_ICONS[buttons.primary]"
      :label="FIX_LABELS[buttons.primary]"
      :loading="running === buttons.primary"
      @click="press(buttons.primary)"
    />
    <UDropdownMenu v-if="buttons.more.length" :items="more" :content="{ align: 'end' }">
      <UButton
        :size="size"
        color="neutral"
        variant="ghost"
        trailing-icon="i-lucide-chevron-down"
        label="More fixes"
        :loading="running !== undefined && running !== buttons.primary"
      />
    </UDropdownMenu>

    <UModal v-if="confirm" v-model:open="confirmOpen" :title="confirm.title">
      <template #body>
        <div class="space-y-2 text-sm">
          <p class="whitespace-pre-line">{{ confirm.description }}</p>
          <p v-if="confirm.note" class="text-muted">{{ confirm.note }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="confirming = undefined" />
          <UButton :color="confirm.destructive ? 'error' : 'primary'" :label="confirm.confirm" @click="run(confirming!)" />
        </div>
      </template>
    </UModal>
    <JellyfinRerunDialog v-model:open="rerunOpen" />
  </div>
</template>
