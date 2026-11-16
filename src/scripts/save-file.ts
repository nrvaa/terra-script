/**
 * Save a file the user asked for (export, .terra backup, CSV).
 *  - Desktop app (Tauri): the Windows "Save as" dialog, then the file is
 *    written where the user chose.
 *  - Browser: a normal download.
 * Resolves to false when the user cancels the Save dialog.
 */

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const FILTER_NAMES: Record<string, string> = {
  terra: 'Terra Script project',
  pdf: 'PDF document',
  fountain: 'Fountain screenplay',
  txt: 'Plain text',
  csv: 'CSV spreadsheet',
};

export async function saveFile(name: string, data: Blob | string, type = 'application/octet-stream'): Promise<boolean> {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  if (isDesktop()) {
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const path = await save({
      defaultPath: name,
      filters: ext ? [{ name: FILTER_NAMES[ext] ?? ext.toUpperCase(), extensions: [ext] }] : undefined,
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}
