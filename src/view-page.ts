/**
 * The browser client, as one HTML string.
 *
 * It renders `ScreenSnapshot` -- the grid the server is being sent, already the
 * authority -- and it does not parse anything. That is the whole reason it is
 * hand-rolled rather than built on xterm.js: xterm.js is a VT parser, it would
 * have to be fed bytes, and the one rule a viewer here has to obey is that
 * there is no second parser (`src/view.ts`). A `<pre>` of styled rows is less
 * capable than a terminal emulator and is exactly as faithful as the thing it
 * is showing.
 *
 * It is a template literal in TypeScript rather than a file on disk because
 * there is no build step and no asset pipeline to put one through; the page
 * travels with the server that serves it.
 *
 * Keys are sent **by name** (`{key: 'down'}`) and composed server-side against
 * the mode the program set, which is what makes an arrow key correct in a
 * program that has turned on application cursor keys. A paste is sent as
 * `{paste}` for the same reason: whether it is wrapped in bracketed-paste
 * guards is the program's decision, read off the screen, not the browser's.
 */
export function viewPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-term</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0b0d11; color: #c9d1d9; }
  body { display: flex; flex-direction: column; font: 13px/1.5 system-ui, sans-serif; }
  #bar {
    display: flex; gap: 12px; align-items: center; flex: 0 0 auto;
    padding: 4px 8px; border-bottom: 1px solid #1e242c; color: #6e7681; font-size: 12px;
  }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #d29922; }
  #dot.on { background: #3fb950; }
  #dot.off { background: #f85149; }
  #wrap { flex: 1 1 auto; overflow: hidden; padding: 6px 8px; }
  #screen {
    margin: 0; white-space: pre; font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 14px; line-height: 1.25; font-variant-ligatures: none;
  }
  #screen .row { height: 1.25em; }
  #screen .cur { background: #c9d1d9; color: #0b0d11; }
  #probe { position: absolute; visibility: hidden; white-space: pre; top: -9999px; left: -9999px; }
</style>
</head>
<body>
<div id="bar">
  <span id="dot"></span><span id="state">connecting</span>
  <span id="grid"></span><span id="hint">keys go to the session</span>
</div>
<div id="wrap"><pre id="screen"></pre></div>
<pre id="probe"></pre>
<script>
(function () {
  'use strict';
  var screen = document.getElementById('screen');
  var probe = document.getElementById('probe');
  var dot = document.getElementById('dot');
  var stateEl = document.getElementById('state');
  var gridEl = document.getElementById('grid');

  // ---- appearance: canonical style key -> CSS -----------------------------
  // The key is the one screen.ts builds: space-separated fg#rrggbb, fg7,
  // bg#..., bold, dim, italic, underline, blink, inverse, invisible, strike,
  // overline.

  var ANSI = ['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5',
              '#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#e5e5e5'];
  var CUBE = [0,95,135,175,215,255];

  function paletteColor(index) {
    if (index < 16) return ANSI[index];
    if (index < 232) {
      var i = index - 16;
      return 'rgb(' + CUBE[Math.floor(i / 36) % 6] + ',' + CUBE[Math.floor(i / 6) % 6] + ',' + CUBE[i % 6] + ')';
    }
    var g = 8 + (index - 232) * 10;
    return 'rgb(' + g + ',' + g + ',' + g + ')';
  }

  function cssFor(key) {
    var css = {}, fg = null, bg = null;
    var parts = key.split(' ');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.indexOf('fg#') === 0) fg = '#' + p.slice(3);
      else if (p.indexOf('bg#') === 0) bg = '#' + p.slice(3);
      else if (p.indexOf('fg') === 0) fg = paletteColor(parseInt(p.slice(2), 10));
      else if (p.indexOf('bg') === 0) bg = paletteColor(parseInt(p.slice(2), 10));
      else if (p === 'bold') css['font-weight'] = 'bold';
      else if (p === 'dim') css.opacity = '0.6';
      else if (p === 'italic') css['font-style'] = 'italic';
      else if (p === 'underline') css['text-decoration'] = (css['text-decoration'] || '') + ' underline';
      else if (p === 'strike') css['text-decoration'] = (css['text-decoration'] || '') + ' line-through';
      else if (p === 'overline') css['text-decoration'] = (css['text-decoration'] || '') + ' overline';
      else if (p === 'invisible') css.color = 'transparent';
      else if (p === 'inverse') { var t = fg; fg = bg || '#0b0d11'; bg = t || '#c9d1d9'; }
    }
    if (fg) css.color = fg;
    if (bg) css['background-color'] = bg;
    return css;
  }

  function styleAttr(css) {
    var out = '';
    for (var k in css) if (css[k]) out += k + ':' + css[k] + ';';
    return out;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- the grid ------------------------------------------------------------

  function styleAt(runs, column) {
    for (var i = 0; i < runs.length; i++) {
      if (column >= runs[i].from && column < runs[i].to) return runs[i].style;
    }
    return '';
  }

  function render(snap) {
    var rows = [];
    for (var y = 0; y < snap.rows; y++) {
      var line = snap.lines[y] || '';
      var wide = snap.wide[y] || [];
      var runs = snap.styles[y] || [];
      var cells = [], col = 0;
      for (var g = 0; g < line.length && col < snap.cols; g++) {
        var w = wide.indexOf(col) >= 0 ? 2 : 1;
        cells.push({ ch: line.charAt(g), col: col });
        col += w;
      }
      var cursorIdx = -1;
      if (y === snap.cursorY) {
        for (var k = 0; k < cells.length; k++) {
          if (cells[k].col === snap.cursorX) { cursorIdx = k; break; }
        }
        if (cursorIdx < 0) {
          for (var k2 = 0; k2 < cells.length; k2++) {
            if (cells[k2].col < snap.cursorX && snap.cursorX < cells[k2].col + 2) { cursorIdx = k2; break; }
          }
        }
      }
      var html = '', i = 0;
      while (i < cells.length) {
        if (i === cursorIdx) {
          html += '<span class="cur">' + escapeHtml(cells[i].ch) + '</span>';
          i++;
          continue;
        }
        var style = styleAt(runs, cells[i].col);
        var chunk = '';
        while (i < cells.length && i !== cursorIdx && styleAt(runs, cells[i].col) === style) {
          chunk += cells[i].ch;
          i++;
        }
        if (style === '') html += escapeHtml(chunk);
        else html += '<span style="' + styleAttr(cssFor(style)) + '">' + escapeHtml(chunk) + '</span>';
      }
      if (cursorIdx < 0 && y === snap.cursorY && snap.cursorX >= col) {
        html += '<span class="cur"> </span>';
      }
      rows.push('<div class="row">' + html + '</div>');
    }
    screen.innerHTML = rows.join('');
  }

  // ---- the wire -----------------------------------------------------------

  var ws = null;
  var follow = true;
  var dead = false;

  function say(state, on) {
    stateEl.textContent = state;
    dot.className = on === true ? 'on' : (on === false ? 'off' : '');
  }

  function gridSize() {
    // Measured, not assumed: a monospace font's advance width is whatever the
    // browser and the font say it is, and the window is the size it is.
    probe.textContent = new Array(101).join('M');
    var box = probe.getBoundingClientRect();
    var cellW = box.width / 100;
    var cellH = parseFloat(getComputedStyle(screen).lineHeight) || 17;
    var wrap = document.getElementById('wrap').getBoundingClientRect();
    return {
      cols: Math.max(20, Math.floor(wrap.width / cellW)),
      rows: Math.max(4, Math.floor(wrap.height / cellH))
    };
  }

  function sendSize() {
    if (!ws || ws.readyState !== 1 || !follow) return;
    var size = gridSize();
    ws.send(JSON.stringify({ kind: 'size', cols: size.cols, rows: size.rows }));
  }

  function connect() {
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(scheme + '//' + location.host + '/v/${token}/ws');
    ws.onopen = function () { say('connected', true); sendSize(); };
    ws.onclose = function () { say(dead ? 'session ended' : 'disconnected', false); };
    ws.onerror = function () { say('disconnected', false); };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'hello') {
        follow = msg.followResize !== false;
        render(msg.screen);
        gridEl.textContent = msg.cols + 'x' + msg.rows;
        sendSize();
      } else if (msg.type === 'screen') {
        render(msg.screen);
        gridEl.textContent = msg.screen.cols + 'x' + msg.screen.rows;
      } else if (msg.type === 'ended') {
        dead = true;
        say('session ended', false);
      } else if (msg.type === 'closed') {
        ws.close();
      } else if (msg.type === 'error') {
        say('input refused: ' + msg.message, null);
      }
    };
  }

  // ---- keys ---------------------------------------------------------------
  //
  // Named, not spelled. The browser knows a key was pressed; what bytes that
  // becomes depends on the mode the program set, which only the server can
  // read -- so the name goes over the wire and the composition happens there.

  var NAMED = {
    Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace', Delete: 'delete',
    Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
  };

  function send(steps) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: 'keys', steps: steps }));
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey) return;
    if (e.altKey && e.key.length === 1) { e.preventDefault(); send([{ key: 'alt+' + e.key }]); return; }
    if (e.ctrlKey && !e.shiftKey && /^[a-zA-Z]$/.test(e.key)) {
      // Not Ctrl-V: the browser fires a paste event for it, and sending
      // ctrl+v as well would put the text in twice.
      if (e.key.toLowerCase() === 'v') return;
      e.preventDefault();
      send([{ key: 'ctrl+' + e.key.toLowerCase() }]);
      return;
    }
    if (e.ctrlKey || e.altKey) return;
    if (e.shiftKey && e.key === 'Tab') { e.preventDefault(); send([{ key: 'shift+tab' }]); return; }
    if (NAMED[e.key]) { e.preventDefault(); send([{ key: NAMED[e.key] }]); return; }
    if (/^F([1-9]|1[0-2])$/.test(e.key)) { e.preventDefault(); send([{ key: e.key.toLowerCase() }]); return; }
    if (e.key.length === 1) { e.preventDefault(); send([{ text: e.key }]); }
  });

  document.addEventListener('paste', function (e) {
    var text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    e.preventDefault();
    send([{ paste: text }]);
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendSize, 120);
  });

  connect();
})();
</script>
</body>
</html>
`;
}
