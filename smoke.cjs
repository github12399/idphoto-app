const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { sandbox: true } })
  await win.loadFile('app/index.html')
  const checks = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    specBtns: document.querySelectorAll('#ip-spec button').length,
    chips: document.querySelectorAll('#ip-bg .chip').length,
    dpiOpts: document.querySelectorAll('#ip-dpi option').length,
    fmtRadios: document.querySelectorAll('input[name=ip-fmt]').length,
    downloadBtn: !!document.getElementById('ip-download')
  }))()`)
  await new Promise(r => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  require('fs').writeFileSync('smoke-window.png', img.toPNG())
  console.log(JSON.stringify(checks))
  app.exit(0)
}).catch(e => { console.error('SMOKE FAIL', e); app.exit(1) })
