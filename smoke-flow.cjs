const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 780, webPreferences: { sandbox: true } })
  await win.loadFile('app/index.html')
  const b64 = fs.readFileSync('D:/xm/zcode/test/blog/test/test_photo.jpg').toString('base64')
  const script = `(async () => {
    const b64 = ${JSON.stringify(b64)};
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('ip-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1800));
    document.querySelector('.chip[data-key="red"]').click();
    await new Promise(r => setTimeout(r, 800));
    const cv = document.getElementById('ip-preview');
    const ctx = cv.getContext('2d');
    const grab = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.95));
    return {
      out: document.getElementById('ip-out-info').textContent,
      redCorners: [grab(3, 3), grab(cv.width - 4, cv.height - 4)],
      hair: grab(Math.round(cv.width / 2), Math.round(cv.height * 0.30)),
      exportBytes: blob.size
    };
  })()`
  const result = await win.webContents.executeJavaScript(script)
  console.log('RESULT ' + JSON.stringify(result))
  app.exit(0)
}).catch(e => { console.error('SMOKE FAIL', e); app.exit(1) })
