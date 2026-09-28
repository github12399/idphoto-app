/* 证件照在线工具 —— 纯前端，照片不上传服务器
 * 换底色算法与桌面版证件照尺寸工具（idphoto-tool/main.py）一致：
 * 本地背景色度场（降采样扩散插值）+ 色度距离软过渡 + 边缘连通约束 + 高斯羽化。
 */
(function () {
  'use strict';

  // ---------- 与桌面版一致的常量 ----------
  var SIZES = [
    { key: 'small', name: '小一寸', mm: [22, 32], note: '驾驶证 / 社保卡 / 考试报名' },
    { key: 'one', name: '一寸', mm: [25, 35], note: '毕业证 / 护照 / 简历（最常用）' },
    { key: 'two', name: '二寸', mm: [35, 49], note: '签证 / 报名表 / 公证书' }
  ];
  var DPI_PRESETS = [96, 150, 300, 600];
  var DEFAULT_DPI = 300;
  var MIN_CROP_PX = 40;
  var DEFAULT_BG_TOL = 40;
  var BG_SEED_GATE = 6.0;
  var BG_PRESETS = [
    { key: 'orig', name: '原图', rgb: null },
    { key: 'white', name: '白底', rgb: [255, 255, 255] },
    { key: 'red', name: '红底', rgb: [255, 0, 0] },
    { key: 'blue', name: '蓝底', rgb: [67, 142, 219] }
  ];

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $('ip-file');
  var specBox = $('ip-spec');
  var bgColorBox = $('ip-bg');
  var customColor = $('ip-custom');
  var tolSlider = $('ip-tol'), tolVal = $('ip-tol-val');
  var dpiSel = $('ip-dpi');
  var fmtRadios = document.querySelectorAll('input[name=ip-fmt]');
  var qRow = $('ip-q-row'), qSlider = $('ip-q'), qVal = $('ip-q-val');
  var stage = $('ip-stage'), viewImg = $('ip-view'), overlay = $('ip-overlay');
  var previewCv = $('ip-preview');
  var emptyHint = $('ip-empty');
  var outInfo = $('ip-out-info');
  var noteEl = $('ip-spec-note');
  var sizeEl = $('ip-spec-size');
  var resetBtn = $('ip-reset');
  var zoomSlider = $('ip-zoom');
  var dlBtn = $('ip-download');

  // ---------- 状态 ----------
  var bitmap = null;          // 已按 EXIF 转正的位图
  var iw = 0, ih = 0;
  var fieldSmall = null;      // {data:Float32Array(sw*sh*3), sw, sh} 降采样色度场（原图级一次）
  var crop = null;            // {x0,y0,x1,y1} 原图坐标
  var specIdx = 1;
  var bgKey = 'blue';
  var customRGB = [67, 142, 219];
  var tol = DEFAULT_BG_TOL;
  var fmt = 'JPG';
  var jpgQ = 95;

  function targetPx(mm, dpi) {
    return [Math.max(1, Math.round(mm[0] / 25.4 * dpi)), Math.max(1, Math.round(mm[1] / 25.4 * dpi))];
  }

  function bgRGB() {
    if (bgKey === 'custom') return customRGB;
    for (var i = 0; i < BG_PRESETS.length; i++) if (BG_PRESETS[i].key === bgKey) return BG_PRESETS[i].rgb;
    return null;
  }

  // ============================================================
  // 算法部分：对应 main.py 的 build_bg_field / replace_background
  // ============================================================

  // 取 imageData 的降采样版本（浏览器双线性）
  function downscale(src, sw, sh) {
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    var tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    var tctx = tmp.getContext('2d');
    tctx.putImageData(src, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, sw, sh);
  }

  // 放大 Float32 场回全尺寸（经 canvas 双线性）
  function upscaleField(field, sw, sh, w, h) {
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    var id = ctx.createImageData(sw, sh);
    for (var i = 0, p = 0; i < sw * sh; i++) {
      id.data[p++] = Math.max(0, Math.min(255, Math.round(field[i * 3] * 255)));
      id.data[p++] = Math.max(0, Math.min(255, Math.round(field[i * 3 + 1] * 255)));
      id.data[p++] = Math.max(0, Math.min(255, Math.round(field[i * 3 + 2] * 255)));
      id.data[p++] = 255;
    }
    ctx.putImageData(id, 0, 0);
    var big = document.createElement('canvas');
    big.width = w; big.height = h;
    var bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(c, 0, 0, w, h);
    var out = bctx.getImageData(0, 0, w, h).data;
    var res = new Float32Array(w * h * 3);
    for (var j = 0, q = 0; j < w * h; j++) {
      res[q++] = out[j * 4] / 255; res[q++] = out[j * 4 + 1] / 255; res[q++] = out[j * 4 + 2] / 255;
    }
    return res;
  }

  // 3x3 中位数
  function median3(a, b, c) {
    return a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
  }

  // build_bg_field：输入原始 imageData，返回 (sw,sh,3) 色度场
  function buildBgField(src) {
    var w = src.width, h = src.height;
    var sw = Math.max(4, Math.floor(w / 8));
    var sh = Math.max(4, Math.floor(h / 8));
    var small = downscale(src, sw, sh).data;
    var n = sw * sh;
    var chroma = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var r = small[i * 4], g = small[i * 4 + 1], b = small[i * 4 + 2];
      var s = r + g + b + 1e-6;
      chroma[i * 3] = r / s; chroma[i * 3 + 1] = g / s; chroma[i * 3 + 2] = b / s;
    }
    var band = Math.max(2, Math.floor(Math.min(sh, sw) / 20));
    // 边缘带色度中位数（逐通道 6 邻值取中位，抗噪）
    function edgeMedian(idx, x, y) {
      var vals = [];
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = Math.max(0, Math.min(sw - 1, x + dx));
        var yy = Math.max(0, Math.min(sh - 1, y + dy));
        vals.push(chroma[(yy * sw + xx) * 3 + idx]);
      }
      vals.sort(function (a, b) { return a - b; });
      return vals[4];
    }
    var ref0 = [0, 0, 0];
    var cnt = 0;
    function acc(x, y) {
      ref0[0] += edgeMedian(0, x, y); ref0[1] += edgeMedian(1, x, y); ref0[2] += edgeMedian(2, x, y);
      cnt++;
    }
    var x, y;
    for (x = 0; x < sw; x++) { for (y = 0; y < band; y++) acc(x, y); for (y = sh - band; y < sh; y++) acc(x, y); }
    for (y = band; y < sh - band; y++) { for (x = 0; x < band; x++) acc(x, y); for (x = sw - band; x < sw; x++) acc(x, y); }
    ref0 = [ref0[0] / cnt, ref0[1] / cnt, ref0[2] / cnt];

    // 种子：边缘带中与主色调色度距离 < BG_SEED_GATE 的像素
    var seed = new Uint8Array(n);
    var hasSeed = false;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) {
      var onEdge = y < band || y >= sh - band || x < band || x >= sw - band;
      if (!onEdge) continue;
      var i2 = y * sw + x;
      var dr = chroma[i2 * 3] - ref0[0], dg = chroma[i2 * 3 + 1] - ref0[1], db = chroma[i2 * 3 + 2] - ref0[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) * 255 < BG_SEED_GATE) { seed[i2] = 1; hasSeed = true; }
    }

    var field = new Float32Array(n * 3);
    var known = new Uint8Array(n);
    if (!hasSeed) {
      for (i = 0; i < n; i++) { field[i * 3] = ref0[0]; field[i * 3 + 1] = ref0[1]; field[i * 3 + 2] = ref0[2]; }
    } else {
      // 波前均值扩散：每轮把有已知邻居的未知像素填为邻居均值（对应 numpy 迭代）
      var unknown = new Uint8Array(n);
      for (i = 0; i < n; i++) { unknown[i] = seed[i] ? 0 : 1; known[i] = seed[i]; if (seed[i]) { field[i * 3] = chroma[i * 3]; field[i * 3 + 1] = chroma[i * 3 + 1]; field[i * 3 + 2] = chroma[i * 3 + 2]; } }
      var rounds = sh + sw;
      for (var rd = 0; rd < rounds; rd++) {
        var any = false;
        var accF = new Float32Array(n * 3);
        var cntF = new Float32Array(n);
        for (y = 1; y < sh; y++) { var yy1 = y * sw, yy0 = (y - 1) * sw; for (x = 0; x < sw; x++) { if (known[yy0 + x]) { accF[(yy1 + x) * 3] += field[(yy0 + x) * 3]; accF[(yy1 + x) * 3 + 1] += field[(yy0 + x) * 3 + 1]; accF[(yy1 + x) * 3 + 2] += field[(yy0 + x) * 3 + 2]; cntF[yy1 + x]++; } } }
        for (y = 0; y < sh - 1; y++) { var ya = y * sw, yb = (y + 1) * sw; for (x = 0; x < sw; x++) { if (known[yb + x]) { accF[(ya + x) * 3] += field[(yb + x) * 3]; accF[(ya + x) * 3 + 1] += field[(yb + x) * 3 + 1]; accF[(ya + x) * 3 + 2] += field[(yb + x) * 3 + 2]; cntF[ya + x]++; } } }
        for (y = 0; y < sh; y++) { for (x = 1; x < sw; x++) { if (known[y * sw + x - 1]) { accF[(y * sw + x) * 3] += field[(y * sw + x - 1) * 3]; accF[(y * sw + x) * 3 + 1] += field[(y * sw + x - 1) * 3 + 1]; accF[(y * sw + x) * 3 + 2] += field[(y * sw + x - 1) * 3 + 2]; cntF[y * sw + x]++; } } }
        for (y = 0; y < sh; y++) { for (x = 0; x < sw - 1; x++) { if (known[y * sw + x + 1]) { accF[(y * sw + x) * 3] += field[(y * sw + x + 1) * 3]; accF[(y * sw + x) * 3 + 1] += field[(y * sw + x + 1) * 3 + 1]; accF[(y * sw + x) * 3 + 2] += field[(y * sw + x + 1) * 3 + 2]; cntF[y * sw + x]++; } } }
        for (i = 0; i < n; i++) {
          if (unknown[i] && cntF[i] > 0) {
            field[i * 3] = accF[i * 3] / cntF[i]; field[i * 3 + 1] = accF[i * 3 + 1] / cntF[i]; field[i * 3 + 2] = accF[i * 3 + 2] / cntF[i];
            known[i] = 1; unknown[i] = 0; any = true;
          }
        }
        if (!any) break;
      }
      for (i = 0; i < n; i++) if (unknown[i]) { field[i * 3] = ref0[0]; field[i * 3 + 1] = ref0[1]; field[i * 3 + 2] = ref0[2]; }
      // 松弛迭代（种子固定）：抹平波前台阶 → 平滑插值
      for (rd = 0; rd < 300; rd++) {
        var accR = new Float32Array(n * 3);
        var cntR = new Float32Array(n);
        for (y = 1; y < sh; y++) { var v1 = y * sw, v0 = (y - 1) * sw; for (x = 0; x < sw; x++) { if (known[v0 + x]) { accR[(v1 + x) * 3] += field[(v0 + x) * 3]; accR[(v1 + x) * 3 + 1] += field[(v0 + x) * 3 + 1]; accR[(v1 + x) * 3 + 2] += field[(v0 + x) * 3 + 2]; cntR[v1 + x]++; } } }
        for (y = 0; y < sh - 1; y++) { var ra = y * sw, rb = (y + 1) * sw; for (x = 0; x < sw; x++) { if (known[rb + x]) { accR[(ra + x) * 3] += field[(rb + x) * 3]; accR[(ra + x) * 3 + 1] += field[(rb + x) * 3 + 1]; accR[(ra + x) * 3 + 2] += field[(rb + x) * 3 + 2]; cntR[ra + x]++; } } }
        for (y = 0; y < sh; y++) { for (x = 1; x < sw; x++) { if (known[y * sw + x - 1]) { accR[(y * sw + x) * 3] += field[(y * sw + x - 1) * 3]; accR[(y * sw + x) * 3 + 1] += field[(y * sw + x - 1) * 3 + 1]; accR[(y * sw + x) * 3 + 2] += field[(y * sw + x - 1) * 3 + 2]; cntR[y * sw + x]++; } } }
        for (y = 0; y < sh; y++) { for (x = 0; x < sw - 1; x++) { if (known[y * sw + x + 1]) { accR[(y * sw + x) * 3] += field[(y * sw + x + 1) * 3]; accR[(y * sw + x) * 3 + 1] += field[(y * sw + x + 1) * 3 + 1]; accR[(y * sw + x) * 3 + 2] += field[(y * sw + x + 1) * 3 + 2]; cntR[y * sw + x]++; } } }
        for (i = 0; i < n; i++) {
          if (!seed[i] && cntR[i] > 0) {
            field[i * 3] = accR[i * 3] / cntR[i]; field[i * 3 + 1] = accR[i * 3 + 1] / cntR[i]; field[i * 3 + 2] = accR[i * 3 + 2] / cntR[i];
          }
        }
      }
    }
    return { data: field, sw: sw, sh: sh };
  }

  // 色度场子块对齐到输出尺寸（对应 main.py build_output 里的 fimg.resize）
  function fieldForOutput(box, W, H) {
    var fx0 = Math.max(0, Math.min(fieldSmall.sw - 1, Math.floor(box.x0 / iw * fieldSmall.sw)));
    var fy0 = Math.max(0, Math.min(fieldSmall.sh - 1, Math.floor(box.y0 / ih * fieldSmall.sh)));
    var fx1 = Math.max(fx0 + 1, Math.min(fieldSmall.sw, Math.ceil(box.x1 / iw * fieldSmall.sw)));
    var fy1 = Math.max(fy0 + 1, Math.min(fieldSmall.sh, Math.ceil(box.y1 / ih * fieldSmall.sh)));
    var fsw = fx1 - fx0, fsh = fy1 - fy0;
    var sub = new Float32Array(fsw * fsh * 3);
    for (var y = 0; y < fsh; y++) for (var x = 0; x < fsw; x++) {
      var si = ((fy0 + y) * fieldSmall.sw + (fx0 + x)) * 3, di = (y * fsw + x) * 3;
      sub[di] = fieldSmall.data[si]; sub[di + 1] = fieldSmall.data[si + 1]; sub[di + 2] = fieldSmall.data[si + 2];
    }
    return upscaleField(sub, fsw, fsh, W, H);
  }

  // replace_background：out 为输出 imageData（RGBA，alpha=255），返回替换后的 Uint8ClampedArray
  function replaceBackground(out, field, tolerance, targetRGB) {
    var W = out.width, H = out.height, n = W * H;
    var d = out.data;
    var dist = new Float32Array(n);
    var i, x, y;
    for (i = 0; i < n; i++) {
      var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      var s = r + g + b + 1e-6;
      var pr = r / s, pg = g / s, pb = b / s;
      var fr = field[i * 3], fg = field[i * 3 + 1], fb = field[i * 3 + 2];
      var dr = pr - fr, dg = pg - fg, db2 = pb - fb;
      dist[i] = Math.sqrt(dr * dr + dg * dg + db2 * db2) * 255;
    }
    var tLo = Math.max(0.5, tolerance * 0.1);
    var tHi = Math.max(tLo + 2.0, tolerance * 0.3);
    // 边缘连通：dist<tLo 中与四边连通的区域（栈式 flood fill）
    var cand = new Uint8Array(n), conn = new Uint8Array(n);
    for (i = 0; i < n; i++) cand[i] = dist[i] < tLo ? 1 : 0;
    var stack = [];
    for (x = 0; x < W; x++) { if (cand[x]) { conn[x] = 1; stack.push(x); } var b2 = (H - 1) * W + x; if (cand[b2]) { conn[b2] = 1; stack.push(b2); } }
    for (y = 0; y < H; y++) { var l = y * W; if (cand[l]) { conn[l] = 1; stack.push(l); } var r2 = y * W + W - 1; if (cand[r2]) { conn[r2] = 1; stack.push(r2); } }
    while (stack.length) {
      var p = stack.pop(), px = p % W, py = (p - px) / W;
      if (px > 0 && cand[p - 1] && !conn[p - 1]) { conn[p - 1] = 1; stack.push(p - 1); }
      if (px < W - 1 && cand[p + 1] && !conn[p + 1]) { conn[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && cand[p - W] && !conn[p - W]) { conn[p - W] = 1; stack.push(p - W); }
      if (py < H - 1 && cand[p + W] && !conn[p + W]) { conn[p + W] = 1; stack.push(p + W); }
    }
    var alpha = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var a = (dist[i] - tLo) / (tHi - tLo);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (!conn[i]) a = 1;
      alpha[i] = a;
    }
    // 高斯羽化（对应 PIL GaussianBlur(0.8)，用 3x3 [1,2,1] 两趟近似）
    var blurred = new Float32Array(n);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var i0 = y * W + x;
      var l = alpha[y * W + Math.max(0, x - 1)], c0 = alpha[i0], r = alpha[y * W + Math.min(W - 1, x + 1)];
      blurred[i0] = (l + 2 * c0 + r) * 0.25;
    }
    var blurred2 = new Float32Array(n);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var j0 = y * W + x;
      var u = blurred[Math.max(0, y - 1) * W + x], cc = blurred[j0], dd = blurred[Math.min(H - 1, y + 1) * W + x];
      blurred2[j0] = (u + 2 * cc + dd) * 0.25;
    }
    var tr = targetRGB[0], tg = targetRGB[1], tb = targetRGB[2];
    for (i = 0; i < n; i++) {
      var am = blurred2[i];
      d[i * 4] = d[i * 4] * am + tr * (1 - am);
      d[i * 4 + 1] = d[i * 4 + 1] * am + tg * (1 - am);
      d[i * 4 + 2] = d[i * 4 + 2] * am + tb * (1 - am);
      d[i * 4 + 3] = 255;
    }
    return d;
  }

  // ============================================================
  // 渲染管线：裁剪 → 输出尺寸 → 换底（对应 main.py build_output）
  // ============================================================

  function renderOutput() {
    if (!bitmap || !crop) return null;
    var box = {
      x0: Math.max(0, Math.min(iw, Math.round(crop.x0))),
      y0: Math.max(0, Math.min(ih, Math.round(crop.y0))),
      x1: Math.max(0, Math.min(iw, Math.round(crop.x1))),
      y1: Math.max(0, Math.min(ih, Math.round(crop.y1)))
    };
    if (box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1) return null;
    var s = SIZES[specIdx];
    var t = targetPx(s.mm, parseInt(dpiSel.value, 10) || DEFAULT_DPI);
    var W = t[0], H = t[1];
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 0, 0, W, H);
    var rgb = bgRGB();
    if (rgb && fieldSmall) {
      var id = ctx.getImageData(0, 0, W, H);
      var field = fieldForOutput(box, W, H);
      var out = replaceBackground(id, field, tol, rgb);
      ctx.putImageData(new ImageData(out, W, H), 0, 0);
    }
    return cv;
  }

  // ============================================================
  // 舞台交互：显示 + 裁剪框（拖动 / 角缩放 / 滑杆缩放，触摸友好）
  // ============================================================

  var drawRect = { x: 0, y: 0, w: 0, h: 0 };   // 图片在舞台中的显示矩形
  var dpr = Math.max(1, window.devicePixelRatio || 1);

  function layoutStage() {
    var box = stage.getBoundingClientRect();
    var scale = Math.min(box.width / iw, box.height / ih);
    var w = iw * scale, h = ih * scale;
    drawRect = { x: (box.width - w) / 2, y: (box.height - h) / 2, w: w, h: h };
    viewImg.width = Math.max(1, Math.round(w * dpr));
    viewImg.height = Math.max(1, Math.round(h * dpr));
    viewImg.style.left = drawRect.x + 'px';
    viewImg.style.top = drawRect.y + 'px';
    viewImg.style.width = w + 'px';
    viewImg.style.height = h + 'px';
    var vctx = viewImg.getContext('2d');
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, viewImg.width, viewImg.height);
    if (bitmap) vctx.drawImage(bitmap, 0, 0, viewImg.width, viewImg.height);
    overlay.width = Math.round(box.width * dpr);
    overlay.height = Math.round(box.height * dpr);
    overlay.style.width = box.width + 'px';
    overlay.style.height = box.height + 'px';
    drawOverlay();
  }

  function drawOverlay() {
    var ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = overlay.width / dpr, H = overlay.height / dpr;
    ctx.clearRect(0, 0, W, H);
    if (!crop) return;
    var sx = drawRect.w / iw, sy = drawRect.h / ih;
    var x = drawRect.x + crop.x0 * sx, y = drawRect.y + crop.y0 * sy;
    var w = (crop.x1 - crop.x0) * sx, h = (crop.y1 - crop.y0) * sy;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(drawRect.x, drawRect.y, drawRect.w, drawRect.h);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#2ea3ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    // 九宫参考线 + 角手柄
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var k = 1; k < 3; k++) {
      ctx.moveTo(x + w * k / 3, y); ctx.lineTo(x + w * k / 3, y + h);
      ctx.moveTo(x, y + h * k / 3); ctx.lineTo(x + w, y + h * k / 3);
    }
    ctx.stroke();
    var corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    ctx.fillStyle = '#2ea3ff';
    for (var i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(corners[i][0], corners[i][1], 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function toOrig(px, py) {
    return {
      x: (px - drawRect.x) / drawRect.w * iw,
      y: (py - drawRect.y) / drawRect.h * ih
    };
  }

  function fitCrop() {
    if (!bitmap) return;
    var s = SIZES[specIdx];
    var ratio = s.mm[0] / s.mm[1];
    var w = iw, h = w / ratio;
    if (h > ih) { h = ih; w = h * ratio; }
    crop = { x0: (iw - w) / 2, y0: (ih - h) * 0.38, x1: (iw + w) / 2, y1: (ih - h) * 0.38 + h };
    clampCrop();
  }

  function clampCrop() {
    var s = SIZES[specIdx];
    var ratio = s.mm[0] / s.mm[1];
    var w = crop.x1 - crop.x0, h = crop.y1 - crop.y0;
    w = Math.max(MIN_CROP_PX, Math.min(w, iw));
    h = Math.max(MIN_CROP_PX, Math.min(h, ih));
    if (Math.abs(w / h - ratio) > 0.01) {
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
    }
    if (w > iw) { w = iw; h = w / ratio; }
    if (h > ih) { h = ih; w = h * ratio; }
    var cx = (crop.x0 + crop.x1) / 2, cy = (crop.y0 + crop.y1) / 2;
    cx = Math.max(w / 2, Math.min(iw - w / 2, cx));
    cy = Math.max(h / 2, Math.min(ih - h / 2, cy));
    crop = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  }

  var drag = null; // {mode:'move'|'corner', ci, ox, oy, crop0}
  var TOUCH_R = 22, MOUSE_R = 14;

  function hitCorner(ox, oy) {
    var cs = [[crop.x0, crop.y0], [crop.x1, crop.y0], [crop.x0, crop.y1], [crop.x1, crop.y1]];
    var r = ('ontouchstart' in window) ? TOUCH_R : MOUSE_R;
    for (var i = 0; i < 4; i++) {
      if (Math.abs(ox - cs[i][0]) < r / drawRect.w * iw && Math.abs(oy - cs[i][1]) < r / drawRect.h * ih) return i;
    }
    return -1;
  }

  overlay.addEventListener('pointerdown', function (e) {
    if (!crop) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    var rect = overlay.getBoundingClientRect();
    var o = toOrig(e.clientX - rect.left, e.clientY - rect.top);
    var ci = hitCorner(o.x, o.y);
    var inside = o.x > crop.x0 && o.x < crop.x1 && o.y > crop.y0 && o.y < crop.y1;
    if (ci >= 0) drag = { mode: 'corner', ci: ci };
    else if (inside) drag = { mode: 'move', ox: o.x, oy: o.y, crop0: Object.assign({}, crop) };
    else drag = null;
  });

  overlay.addEventListener('pointermove', function (e) {
    var rect = overlay.getBoundingClientRect();
    var o = toOrig(e.clientX - rect.left, e.clientY - rect.top);
    if (!drag) {
      overlay.style.cursor = crop && hitCorner(o.x, o.y) >= 0 ? 'nwse-resize'
        : (crop && o.x > crop.x0 && o.x < crop.x1 && o.y > crop.y0 && o.y < crop.y1) ? 'move' : 'default';
      return;
    }
    e.preventDefault();
    if (drag.mode === 'move') {
      var dx = o.x - drag.ox, dy = o.y - drag.oy;
      crop = {
        x0: drag.crop0.x0 + dx, y0: drag.crop0.y0 + dy,
        x1: drag.crop0.x1 + dx, y1: drag.crop0.y1 + dy
      };
      clampCrop();
    } else {
      // 角缩放：被拖角跟手，对角固定，比例锁定
      var c0 = Object.assign({}, crop);
      var ax = drag.ci % 2 === 0 ? crop.x1 : crop.x0;   // 对角 x
      var ay = drag.ci < 2 ? crop.y1 : crop.y0;          // 对角 y
      var s = SIZES[specIdx];
      var ratio = s.mm[0] / s.mm[1];
      var w = Math.abs(o.x - ax), h = Math.abs(o.y - ay);
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
      w = Math.max(MIN_CROP_PX, Math.min(w, iw));
      h = Math.max(MIN_CROP_PX, Math.min(h, ih));
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
      var x0 = ax + (o.x < ax ? w : -w), y0 = ay + (o.y < ay ? h : -h);
      if (x0 < 0 || x0 > iw || y0 < 0 || y0 > ih) { crop = c0; }
      else crop = { x0: Math.min(ax, x0), y0: Math.min(ay, y0), x1: Math.max(ax, x0), y1: Math.max(ay, y0) };
    }
    drawOverlay();
    schedulePreview();
  });

  overlay.addEventListener('pointerup', function () { drag = null; });
  overlay.addEventListener('pointercancel', function () { drag = null; });

  zoomSlider.addEventListener('input', function () {
    if (!bitmap) return;
    var s = SIZES[specIdx];
    var ratio = s.mm[0] / s.mm[1];
    var mw = iw, mh = mw / ratio;
    if (mh > ih) { mh = ih; mw = mh * ratio; }
    var f = Math.max(0.05, Math.min(1, parseInt(zoomSlider.value, 10) / 100));
    var w = Math.max(MIN_CROP_PX, mw * f), h = Math.max(MIN_CROP_PX, mh * f);
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    crop = { x0: (iw - w) / 2, y0: (ih - h) / 2, x1: (iw + w) / 2, y1: (ih + h) / 2 };
    clampCrop();
    drawOverlay();
    schedulePreview();
  });

  // ============================================================
  // 控件与预览
  // ============================================================

  var previewTimer = null;
  function schedulePreview() {
    if (previewTimer) return;
    previewTimer = setTimeout(function () {
      previewTimer = null;
      updatePreview();
    }, 90);
  }

  function updatePreview() {
    if (!bitmap || !crop) return;
    var out = renderOutput();
    if (!out) return;
    previewCv.width = out.width;
    previewCv.height = out.height;
    previewCv.getContext('2d').drawImage(out, 0, 0);
    var s = SIZES[specIdx];
    outInfo.textContent = '输出：' + out.width + ' × ' + out.height + ' px（' + s.mm[0] + '×' + s.mm[1] + ' mm）';
  }

  function setSpec(idx) {
    specIdx = idx;
    var s = SIZES[idx];
    noteEl.textContent = s.note;
    sizeEl.textContent = s.mm[0] + '×' + s.mm[1] + ' mm';
    var btns = specBox.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', i === idx);
    if (bitmap) { fitCrop(); layoutStage(); schedulePreview(); }
  }

  function setBg(key) {
    bgKey = key;
    var chips = bgColorBox.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('on', chips[i].dataset.key === key);
    customColor.classList.toggle('on', key === 'custom');
    schedulePreview();
  }

  function hex2rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  // ---------- 事件绑定 ----------

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    loadImage(f);
  });

  // 支持粘贴截图 / 拖拽
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) {
        loadImage(items[i].getAsFile());
        e.preventDefault();
        return;
      }
    }
  });
  stage.addEventListener('dragover', function (e) { e.preventDefault(); });
  stage.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.indexOf('image') === 0) loadImage(f);
  });

  function loadImage(file) {
    var go = function (bmp) {
      bitmap = bmp;
      iw = bmp.width; ih = bmp.height;
      emptyHint.style.display = 'none';
      viewImg.style.display = 'block';
      var src = document.createElement('canvas');
      src.width = iw; src.height = ih;
      src.getContext('2d').drawImage(bmp, 0, 0);
      fieldSmall = buildBgField(src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, iw, ih));
      fitCrop();
      layoutStage();
      schedulePreview();
      stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    if (window.createImageBitmap) {
      createImageBitmap(file, { imageOrientation: 'from-image' }).then(go).catch(function () {
        fallbackLoad(file, go);
      });
    } else fallbackLoad(file, go);
  }

  function fallbackLoad(file, go) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () { go(img); URL.revokeObjectURL(url); };
    img.src = url;
  }

  specBox.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    setSpec(parseInt(btn.dataset.idx, 10));
  });

  bgColorBox.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    setBg(chip.dataset.key);
  });

  customColor.addEventListener('input', function () {
    customRGB = hex2rgb(customColor.value);
    if (bgKey !== 'custom') setBg('custom');
    else schedulePreview();
  });
  customColor.addEventListener('click', function () { setBg('custom'); });

  tolSlider.addEventListener('input', function () {
    tol = parseInt(tolSlider.value, 10);
    tolVal.textContent = tol;
    schedulePreview();
  });

  dpiSel.addEventListener('change', schedulePreview);
  for (var fi = 0; fi < fmtRadios.length; fi++) {
    fmtRadios[fi].addEventListener('change', function () {
      fmt = this.value;
      qRow.style.display = fmt === 'JPG' ? '' : 'none';
      schedulePreview();
    });
  }
  qSlider.addEventListener('input', function () {
    jpgQ = parseInt(qSlider.value, 10);
    qVal.textContent = jpgQ;
  });

  resetBtn.addEventListener('click', function () {
    if (!bitmap) return;
    fitCrop();
    layoutStage();
    schedulePreview();
  });

  dlBtn.addEventListener('click', function () {
    if (!bitmap || !crop) return;
    var out = renderOutput();
    if (!out) return;
    var s = SIZES[specIdx];
    var mime = fmt === 'JPG' ? 'image/jpeg' : 'image/png';
    var ext = fmt === 'JPG' ? 'jpg' : 'png';
    out.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '证件照_' + s.name + '_' + out.width + 'x' + out.height + '.' + ext;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    }, mime, jpgQ / 100);
  });

  window.addEventListener('resize', function () { if (bitmap) layoutStage(); });

  // ---------- 初始化 ----------
  (function init() {
    var html = '';
    for (var i = 0; i < SIZES.length; i++) {
      html += '<button type="button" data-idx="' + i + '"' + (i === specIdx ? ' class="on"' : '') + '>' + SIZES[i].name + '<small>' + SIZES[i].mm[0] + '×' + SIZES[i].mm[1] + ' mm</small></button>';
    }
    specBox.innerHTML = html;
    var chips = '';
    for (i = 0; i < BG_PRESETS.length; i++) {
      var p = BG_PRESETS[i];
      chips += '<button type="button" class="chip' + (p.key === bgKey ? ' on' : '') + '" data-key="' + p.key + '">';
      chips += p.rgb ? '<span class="dot" style="background:rgb(' + p.rgb.join(',') + ')"></span>' : '<span class="dot orig"></span>';
      chips += p.name + '</button>';
    }
    bgColorBox.innerHTML = chips;
    var ds = '';
    for (i = 0; i < DPI_PRESETS.length; i++) ds += '<option value="' + DPI_PRESETS[i] + '"' + (DPI_PRESETS[i] === DEFAULT_DPI ? ' selected' : '') + '>' + DPI_PRESETS[i] + ' DPI</option>';
    dpiSel.innerHTML = ds;
    setSpec(specIdx);
  })();
})();
