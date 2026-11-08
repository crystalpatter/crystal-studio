// Getting photos and videos ready for Instagram, in the browser:
// - photos are converted to JPEG (iPhone HEIC photos included), resized to
//   1440px wide, and cropped into Instagram's allowed shape (4:5 tall to 1.91:1 wide);
// - in a carousel every photo is cropped to the first photo's shape, as Instagram does;
// - videos are uploaded as they are; we grab one frame for the AI and the calendar.

const MIN_RATIO = 0.8; // 4:5 portrait
const MAX_RATIO = 1.91; // landscape

export function kindOf(file) {
  if (file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name)) return 'video';
  return 'image';
}

export function videoType(file) {
  if (file.type === 'video/mp4' || file.type === 'video/quicktime') return file.type;
  return /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This photo couldn't be opened. Try exporting it as a JPEG."));
    img.src = src;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export function clampRatio(r) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

async function drawCropped(source, sw, sh, ratio, maxW, quality) {
  // Centre-crop to `ratio` (width / height), then scale down to maxW.
  let cw = sw;
  let ch = sh;
  if (sw / sh > ratio) cw = Math.round(sh * ratio);
  else ch = Math.round(sw / ratio);
  const sx = Math.round((sw - cw) / 2);
  const sy = Math.round((sh - ch) / 2);
  const scale = Math.min(1, maxW / cw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
  const blob = await toBlob(canvas, quality);
  return { blob, width: canvas.width, height: canvas.height };
}

export async function imageInfo(item) {
  const img = await loadImage(item.previewUrl);
  return { width: img.naturalWidth, height: img.naturalHeight, img };
}

// Final JPEG for Instagram.
export async function prepareImage(item, ratio) {
  const { img, width, height } = await imageInfo(item);
  return drawCropped(img, width, height, ratio ?? clampRatio(width / height), 1440, 0.9);
}

// Small JPEG (data URL) so Claude can see the photo.
export async function aiPreview(source, w, h) {
  const { blob } = await drawCropped(source, w, h, w / h, 768, 0.72);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

// One frame from a video, plus its length and size.
export function videoFrame(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    const fail = () => reject(new Error("This video couldn't be opened here. Try an MP4 or MOV from your camera roll."));
    v.onerror = fail;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 3);
    };
    v.onseeked = async () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        const { blob } = await drawCropped(c, c.width, c.height, c.width / c.height, 720, 0.8);
        resolve({ canvas: c, thumbBlob: blob, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      } catch (e) {
        reject(e);
      }
    };
    setTimeout(fail, 15000);
  });
}
