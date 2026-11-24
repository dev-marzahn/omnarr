export function useUsenetToasts() {
  const toast = useToast();
  const applied = (title: string) =>
    toast.add({ title, description: 'The worker applies it within 30 seconds.', icon: 'i-lucide-circle-check', color: 'success' });
  return {
    providerSaved: () => applied('Saved the Usenet provider'),
    backupSaved: () => applied('Saved the backup server'),
    backupRemoved: () => applied('Removed the backup server'),
  };
}
