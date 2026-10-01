// Atelier Assist panel layout, before first paint (classic script in <head>). The Android app's WebView injects
// window.AtelierAssist for this origin's top frame only; ?panel=assist alone (any link can carry it) counts only together
// with the app's user-agent token, and only ever changes the look. public/assist.js holds the bridge itself.
(function () {
  var d = document.documentElement, b = window.AtelierAssist;
  var bridge = !!(b && typeof b.postMessage === 'function');
  var hinted = /[?&]panel=assist(?:&|$)/.test(location.search) && / AtelierAssist\/\d/.test(navigator.userAgent);
  if (bridge || hinted) d.classList.add('assist');
})();
