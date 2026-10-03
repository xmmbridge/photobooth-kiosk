const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kiosk', {
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    add: (name) => ipcRenderer.invoke('templates:add', { name }),
    detectForCount: (id, expectedCount) =>
      ipcRenderer.invoke('templates:detectForCount', { id, expectedCount }),
    setSlots: (id, slots, opts = {}) =>
      ipcRenderer.invoke('templates:setSlots', { id, slots, ...opts }),
    punchSlots: (id, slots) => ipcRenderer.invoke('templates:punchSlots', { id, slots }),
    setPrintSize: (id, printSize) => ipcRenderer.invoke('templates:setPrintSize', { id, printSize }),
    delete: (id) => ipcRenderer.invoke('templates:delete', { id })
  },
  gallery: {
    getFolder: () => ipcRenderer.invoke('gallery:getFolder'),
    chooseFolder: () => ipcRenderer.invoke('gallery:chooseFolder'),
    list: () => ipcRenderer.invoke('gallery:list')
  },
  phone: {
    info: () => ipcRenderer.invoke('phone:info'),
    clearInbox: () => ipcRenderer.invoke('phone:clearInbox'),
    // Fired the moment a photo arrives from the phone camera page.
    onUploaded: (cb) => ipcRenderer.on('gallery:changed', () => cb())
  },
  strips: {
    list: () => ipcRenderer.invoke('strips:list'),
    save: (record) => ipcRenderer.invoke('strips:save', record),
    delete: (id) => ipcRenderer.invoke('strips:delete', { id })
  },
  printers: {
    list: () => ipcRenderer.invoke('printers:list')
  },
  print: {
    image: (dataUrl, deviceName, silent, pageSize) =>
      ipcRenderer.invoke('print:image', { dataUrl, deviceName, silent, pageSize })
  }
});
