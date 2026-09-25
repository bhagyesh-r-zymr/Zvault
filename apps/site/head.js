// Runs in <head> before first paint: marks JS as available so reveal animations start hidden.
document.documentElement.classList.add('js');

// Share links made by Zvault 0.1.0 point at the site root (https://host/#id.key).
// The share page now lives at /share/, so move those links there. The key stays
// in the fragment, which browsers never send to the server.
if (/^#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(location.hash)) {
  location.replace('/share/' + location.hash);
}

// The 3D hero (archive.js) takes over the first screen only with WebGL and full
// motion. Deciding here, before first paint, keeps the layout from jumping.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      document.documentElement.classList.add('archive-on');
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch {
    // No WebGL: the static hero stays.
  }
}
