// Runs in <head> before first paint: marks JS as available so reveal animations start hidden.
document.documentElement.classList.add('js');

// Share links made by Zvault 0.1.0 point at the site root (https://host/#id.key).
// The share page now lives at /share/, so move those links there. The key stays
// in the fragment, which browsers never send to the server.
if (/^#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(location.hash)) {
  location.replace('/share/' + location.hash);
}
