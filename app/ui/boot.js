// Applies the saved theme before first paint. The server setting is the truth; this copy only avoids a flash.
try { var t = localStorage.getItem('apd-theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; else document.documentElement.dataset.theme = 'light'; } catch (e) { document.documentElement.dataset.theme = 'light'; }
