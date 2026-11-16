import { api, download } from '../../services/apiClient.js';

// ----- import (CSV transactions) -----
export const downloadTemplate = () => download('/import/template', undefined, { fallbackName: 'fintrack-import-template.csv' });
// `src` is { csv: text } for a CSV file or { xlsx: base64 } for an Excel workbook; the server turns both into the same validated pipeline
export const previewImport = (src, fileName) => api.post('/import/transactions/preview', { ...src, fileName }).then((r) => r.data);
export const confirmImport = (src, fileName, { duplicateAction = 'skip', includeRows = [] } = {}) =>
  api.post('/import/transactions/confirm', { ...src, fileName, duplicateAction, includeRows, confirm: true }).then((r) => r.data);
export const downloadErrorReport = (src, fileName) => download('/import/transactions/error-report', undefined, { method: 'POST', body: { ...src, fileName }, fallbackName: 'fintrack-import-errors.csv' });
export const getImportHistory = () => api.get('/import/history').then((r) => r.data.imports);
export const undoImport = (id) => api.post(`/import/history/${id}/undo`).then((r) => r.data);

// ----- export -----
export const exportCsv = (kind, filters) => download(`/export/${kind}`, filters, { fallbackName: `fintrack-${kind}.csv` });
export const exportBackup = () => download('/export/backup', undefined, { fallbackName: 'fintrack-backup.json' });

// ----- restore -----
export const previewRestore = (backup, mode, fileName) => api.post('/backup/preview', { backup, mode, fileName }).then((r) => r.data);
export const restoreBackup = (backup, mode, fileName, confirmText) => api.post('/backup/restore', { backup, mode, fileName, confirm: true, ...(mode === 'replace' ? { confirmText } : {}) }).then((r) => r.data);

// File helpers: the browser reads the file; the server never receives a multipart upload.
export const LIMITS = { csvBytes: 1_000_000, xlsxBytes: 2_000_000, backupBytes: 5 * 1024 * 1024 };
export const readFileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => { const bytes = new Uint8Array(r.result); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); resolve(btoa(bin)); };
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.readAsArrayBuffer(file);
});
export const readFileText = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.readAsText(file);
});
