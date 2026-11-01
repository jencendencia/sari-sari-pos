const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window (the app draws its own title bar)
  closeWindow: () => ipcRenderer.send('window:close'),

  // Inventory
  listProducts: () => ipcRenderer.invoke('products:list'),
  saveProduct: (product) => ipcRenderer.invoke('products:save', product),
  deleteProduct: (id) => ipcRenderer.invoke('products:delete', id),
  findByBarcode: (code) => ipcRenderer.invoke('products:findByBarcode', code),
  lookupBarcode: (code) => ipcRenderer.invoke('products:lookupBarcode', code),

  // Sales
  createSale: (items) => ipcRenderer.invoke('sales:create', items),
  listSales: (limit) => ipcRenderer.invoke('sales:list', limit),
  voidSale: (id) => ipcRenderer.invoke('sales:void', id),
  salesBetween: (from, to) => ipcRenderer.invoke('sales:between', from, to),

  // Frozen sales (hold and recall)
  listHolds: () => ipcRenderer.invoke('holds:list'),
  freezeSale: (sale) => ipcRenderer.invoke('holds:create', sale),
  takeHold: (id) => ipcRenderer.invoke('holds:take', id),
  deleteHold: (id) => ipcRenderer.invoke('holds:delete', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Backup
  backupDatabase: () => ipcRenderer.invoke('db:backup'),
  openBackupFolder: () => ipcRenderer.invoke('db:openFolder'),
  restoreBackup: () => ipcRenderer.invoke('db:restore'),
  saveReportPdf: (html, name) => ipcRenderer.invoke('reports:pdf', { html, name }),

  // Updates
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  // Pictures
  choosePicture: () => ipcRenderer.invoke('images:choose'),
  downloadPicture: (url) => ipcRenderer.invoke('images:download', url),
  searchPictures: (query) => ipcRenderer.invoke('images:search', query),
  pictureUrl: (filename) =>
    filename ? 'img://files/' + encodeURIComponent(filename) : null,
});
