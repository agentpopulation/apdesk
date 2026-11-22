// The installer page. Every action goes to the installer on this PC (server.mjs), which does the work with the
// same checks as the console installer, and every answer is shown at once.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { copy: 'Copying the program', packages: 'Getting the packages', shortcuts: 'Making the shortcuts', done: 'Finishing' };
  var ORDER = ['copy', 'packages', 'shortcuts', 'done'];
  var lastFolder = '';
  var polling = null;

  function call(name, body) {
    var o = body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch('api/' + name, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; });
    });
  }
  function note(el, text, kind) { el.textContent = text || ''; el.className = 'note' + (kind ? ' ' + kind : ''); }
  function show(id) { ['setup', 'progress', 'ready', 'failed'].forEach(function (s) { $(s).hidden = s !== id; }); }
  function lost(el) { note(el, 'The installer is not answering. If its window was closed, run install.bat again.', 'bad'); }
  // after the install the installer ends on its own once no page asks; these say so plainly instead of "not answering"
  function finished(el) { note(el, 'The installer has finished and closed. AP Desk is installed: start it from the Start menu, AP Desk.', 'ok'); $('open').disabled = true; }
  function closedAfterFailure(el) {
    note(el, 'The installer has closed. To try once more, run install.bat.', 'bad'); $('again').disabled = true; $('close').disabled = true;
    $('failed-todo').textContent = $('failed-todo').textContent.replace(', then press Try again.', '.');   // the button is gone now: one next step only
  }

  // while an end screen is open, ask the installer now and then so it waits for this page's buttons
  var alive = null;
  function keepAlive() {
    if (alive) return;
    alive = setInterval(function () {
      call('progress').catch(function () {
        clearInterval(alive); alive = null;
        if (!$('ready').hidden) finished($('ready-note')); else if (!$('failed').hidden) closedAfterFailure($('failed-note'));
      });
    }, 20000);
  }
  function stopKeepAlive() { if (alive) { clearInterval(alive); alive = null; } }

  function choices() {
    return { folder: $('folder').value, desktop: $('desktop').checked, apps: $('apps').checked, autostart: $('autostart').checked, start: $('start').checked };
  }

  call('state').then(function (s) {
    $('version').textContent = 'Agent Population Desk' + (s.version ? ', version ' + s.version : '');
    $('folder').value = s.defaultFolder || '';
    lastFolder = $('folder').value;
    if (s.phase === 'running') { show('progress'); poll(); }
    else if (s.phase === 'done' || s.phase === 'failed') paint(s);
  }).catch(function () { lost($('folder-note')); });

  $('folder').addEventListener('input', function () { $('warn').hidden = true; note($('folder-note'), ''); });

  $('browse').addEventListener('click', function () {
    var b = $('browse'); b.disabled = true;
    note($('folder-note'), 'Opening the folder picker. It may open behind this window.');
    call('browse', {}).then(function (r) {
      b.disabled = false;
      if (r.folder) { $('folder').value = r.folder; lastFolder = r.folder; $('warn').hidden = true; note($('folder-note'), 'Picked: ' + r.folder, 'ok'); }
      else note($('folder-note'), r.problem || 'No folder was picked. The folder above is kept.');
    }).catch(function () { b.disabled = false; lost($('folder-note')); });
  });

  function start(anyway) {
    var b = $('install'); var body = choices(); body.anyway = !!anyway;
    b.disabled = true; b.textContent = 'Checking the folder …';
    note($('folder-note'), '');
    call('install', body).then(function (r) {
      b.disabled = false; b.textContent = 'Install';
      if (r.status === 202) { show('progress'); paint({ phase: 'running', step: null, done: [], line: r.kept || 'Getting ready …' }); poll(); return; }
      if (r.warn) { $('warn-text').textContent = r.warn; $('warn').hidden = false; $('anyway').focus(); return; }
      note($('folder-note'), r.problem || 'The installer could not use that folder.', 'bad'); $('folder').focus();
    }).catch(function () { b.disabled = false; b.textContent = 'Install'; lost($('folder-note')); });
  }
  $('form').addEventListener('submit', function (e) { e.preventDefault(); start(false); });
  $('anyway').addEventListener('click', function () { start(true); });
  $('other').addEventListener('click', function () { $('warn').hidden = true; $('folder').focus(); $('folder').select(); });

  function poll() {
    if (polling) return;
    polling = setInterval(function () {
      call('progress').then(function (s) { paint(s); if (s.phase !== 'running') { clearInterval(polling); polling = null; } })
        .catch(function () { clearInterval(polling); polling = null; $('line').textContent = 'The installer is not answering. If its window was closed, run install.bat again.'; });
    }, 600);
  }

  function paint(s) {
    var done = s.done || [];
    ORDER.forEach(function (id) {
      var li = document.querySelector('[data-step="' + id + '"]');
      li.className = done.indexOf(id) >= 0 || s.phase === 'done' ? 'done' : s.step === id ? (s.phase === 'failed' ? 'failed' : 'doing') : '';
    });
    if (s.phase === 'running') { show('progress'); $('line').textContent = s.line || 'Working …'; return; }
    if (s.phase === 'done') {
      show('ready'); keepAlive();
      $('ready-where').textContent = 'It is installed in ' + s.dir + '.';
      $('ready-problems').hidden = !s.problems;
      $('ready-kept').textContent = s.kept || ''; $('ready-kept').hidden = !s.kept;
      if (s.started) note($('ready-note'), 'AP Desk is starting. It opens in its own window in a moment.', 'ok');
      return;
    }
    if (s.phase === 'failed') {
      show('failed'); keepAlive();
      $('failed-what').textContent = (NAMES[s.step] || 'Getting ready') + ' did not work.';
      $('failed-todo').textContent = s.message || 'Try again. If it keeps happening, run install.bat /console to see each step.';
      $('failed-log').hidden = !s.log;
      $('failed-log').textContent = s.log ? 'What happened, line by line, is in the install log: ' + s.log : '';
    }
  }

  $('open').addEventListener('click', function () {
    var b = $('open'); b.disabled = true;
    note($('ready-note'), 'Starting AP Desk …');
    stopKeepAlive();
    call('open', {}).then(function (r) {
      note($('ready-note'), (r.note || 'AP Desk is starting.') + ' You can close this page.', 'ok');
    }).catch(function () { finished($('ready-note')); });
  });
  $('again').addEventListener('click', function () { stopKeepAlive(); show('setup'); $('folder').value = lastFolder || $('folder').value; note($('folder-note'), ''); $('install').focus(); });
  $('close').addEventListener('click', function () {
    stopKeepAlive();
    call('close', {}).then(function () { closedAfterFailure($('failed-note')); $('failed-note').className = 'note ok'; })
      .catch(function () { closedAfterFailure($('failed-note')); });
  });
})();
