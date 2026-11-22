import type { CodeAppManifest } from '@/types.ts';

const HOST_PERMISSION_LABELS: Record<string, string> = {
  codeEditor: 'Code editor',
  settings: 'Settings',
  contacts: 'Contacts',
  sharing: 'Sharing',
  files: 'Files',
};

const DEVICE_PERMISSION_LABELS: Record<string, string> = {
  camera: 'Camera',
};

/** Human labels of the host surfaces a manifest grants, in declaration order. */
export function grantedHostPermissionLabels(manifest: CodeAppManifest): string[] {
  return Object.entries(manifest.permissions?.host ?? {})
    .filter(([, granted]) => granted)
    .map(([key]) => HOST_PERMISSION_LABELS[key] ?? key);
}

/** Human labels of device capabilities available through the host bridge. */
export function grantedDevicePermissionLabels(manifest: CodeAppManifest): string[] {
  return Object.entries(manifest.permissions?.device ?? {})
    .filter(([, granted]) => granted)
    .map(([key]) => DEVICE_PERMISSION_LABELS[key] ?? key);
}
