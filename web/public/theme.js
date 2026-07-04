// Apply the saved theme before first paint to avoid a light->dark flash.
// Loaded as a blocking external script (not inline) so the CSP can stay
// `script-src 'self'` without a hash that breaks on any edit.
try {
  var t = localStorage.getItem("birds.theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
