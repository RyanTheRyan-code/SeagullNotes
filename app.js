var TOKEN_KEY = 'github_token';
var REPO_OWNER_KEY = 'repo_owner';
var REPO_NAME_KEY = 'repo_name';
var NOTES_DIR = 'notes';

var EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="100%" height="100%"></svg>';

var repoOwner = localStorage.getItem(REPO_OWNER_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_OWNER ? CONFIG.REPO_OWNER : 'YOUR_GITHUB_USERNAME');
var repoName = localStorage.getItem(REPO_NAME_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_NAME ? CONFIG.REPO_NAME : 'SeagullNotes');
var defaultBranch = 'main';
var fullNotesTree = []; 
var currentFolder = '';
var openFilePath = null;
var openFileSha = null;
var previewOn = false;
var fullPreview = false;
var isWhiteboardActive = false;
var isPlacingAsSticky = false;
var currentWhiteboardTool = 'pen'; 
var currentStrokeColor = '#2c3e50';
var currentDrawingElement = null; 
var isDirty = false; 
var autosaveTimer = null; 
var searchCache = {}; 
var selectedImageUrl = null;
var mainWhiteboardSvg, modalSvgBoard;

var activeStickyHtml = null;
var turndownService = (typeof TurndownService !== 'undefined') ? new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
}) : null;

if (turndownService) {
  turndownService.addRule('mermaid', {
    filter: function (node) { return node.classList && node.classList.contains('mermaid'); },
    replacement: function (content, node) {
      var source = node.getAttribute('data-source') || content;
      return '\n```mermaid\n' + source.trim() + '\n```\n';
    }
  });
  turndownService.addRule('sticky', {
    filter: function (node) { return node.classList && node.classList.contains('sticky-note'); },
    replacement: function (content, node) {
      var cleanNode = node.cloneNode(true);
      cleanNode.removeAttribute('data-initialized');
      cleanNode.removeAttribute('data-original-html');
      cleanNode.style.cursor = '';
      return '\n' + cleanNode.outerHTML + '\n';
    }
  });
  turndownService.addRule('internalLink', {
    filter: function (node) { return node.classList && node.classList.contains('internal-link'); },
    replacement: function (content, node) { return '[[' + content + ']]'; }
  });
}

// --- CORE UTILITIES ---

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(v) { if (v && v.trim()) { localStorage.setItem(TOKEN_KEY, v.trim()); document.getElementById('tokenInput').value = ''; showStatus('Token saved.', true); } }
function clearToken() { localStorage.removeItem(TOKEN_KEY); document.getElementById('tokenInput').value = ''; document.getElementById('noteText').value = ''; document.getElementById('pathInput').value = ''; openFilePath = null; openFileSha = null; showStatus('Logged out.', true); refreshNotesList(); }
function setRepo(o, n) { repoOwner = (o || '').trim(); repoName = (n || '').trim(); if (repoOwner) localStorage.setItem(REPO_OWNER_KEY, repoOwner); if (repoName) localStorage.setItem(REPO_NAME_KEY, repoName); updateRepoDisplay(); refreshNotesList(); openFilePath = null; openFileSha = null; }
function updateRepoDisplay() { var el = document.getElementById('repoDisplay'); if (el) el.textContent = 'Saving to: ' + repoOwner + '/' + repoName + (repoOwner === 'YOUR_GITHUB_USERNAME' ? ' — set above' : ''); }
function base64Utf8(t) { return btoa(unescape(encodeURIComponent(t || ''))); }
function decodeBase64Utf8(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { return atob(b); } }
function apiUrl(p) { return 'https://api.github.com/repos/' + repoOwner + '/' + repoName + (p ? '/' + p : ''); }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken(), 'Accept': 'application/vnd.github+json' }; }
function ensureNotesDir() { return fetch(apiUrl('contents/' + NOTES_DIR), { headers: authHeaders() }).then(res => res.status === 404 ? fetch(apiUrl('contents/' + NOTES_DIR + '/.gitkeep'), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Create notes directory', content: btoa('') }) }) : Promise.resolve()); }
function fetchDefaultBranch() { return fetch(apiUrl(''), { headers: authHeaders() }).then(res => res.ok ? res.json() : Promise.resolve(null)).then(data => { if (data && data.default_branch) defaultBranch = data.default_branch; }); }
function showStatus(m, ok) { var el = document.getElementById('status'); if (el) { el.textContent = m; el.style.color = ok ? 'green' : 'red'; } }
function defaultFilename() { var now = new Date(); return 'note-' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + '.md'; }
function triggerAutosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => { if (isDirty && openFilePath) { saveNote(true); isDirty = false; } }, 3000); }
function closeAllDropdowns() { var ds = document.getElementsByClassName("dropdown-content"); for (var i = 0; i < ds.length; i++) ds[i].classList.remove('show'); }
function debounce(func, delay) { let t; return function(...args) { clearTimeout(t); t = setTimeout(() => func.apply(this, args), delay); }; }

// --- EDITOR & PREVIEW LOGIC ---

function insertMarkdown(prefix, suffix) {
  var textarea = document.getElementById('noteText'), preview = document.getElementById('previewArea');
  if (fullPreview && !preview.classList.contains('hidden')) {
    if (prefix === '**') document.execCommand('bold');
    else if (prefix === '*') document.execCommand('italic');
    else if (prefix === '# ') document.execCommand('formatBlock', false, 'H1');
    else if (prefix === '## ') document.execCommand('formatBlock', false, 'H2');
    else if (prefix === '> ') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
    else if (prefix === '- ') document.execCommand('insertUnorderedList');
    else if (prefix === '1. ') document.execCommand('insertOrderedList');
    else {
      var sel = window.getSelection();
      if (sel.rangeCount > 0) {
        var range = sel.getRangeAt(0), selectedText = sel.toString();
        var content = prefix + (selectedText || 'text') + suffix;
        range.deleteContents(); range.insertNode(document.createTextNode(content));
      }
    }
    syncPreviewToText(); return;
  }
  var start = textarea.selectionStart, end = textarea.selectionEnd, text = textarea.value;
  var selected = text.substring(start, end);
  textarea.value = text.substring(0, start) + prefix + selected + suffix + text.substring(end);
  textarea.selectionStart = start + prefix.length; textarea.selectionEnd = textarea.selectionStart + selected.length;
  textarea.focus(); isDirty = true; triggerAutosave(); if (previewOn) togglePreview(true);
}

function selectionToSticky() {
  var textarea = document.getElementById('noteText'), preview = document.getElementById('previewArea'), selText = '';
  if (fullPreview && !preview.classList.contains('hidden')) {
    var sel = window.getSelection(); selText = sel.toString().trim();
    if (!selText) { showStatus('Highlight some text first!', false); return; }
    var id = 'sticky-' + Date.now();
    var html = '<div id="' + id + '" class="sticky-note" data-x="100" data-y="100" style="left: 100px; top: 100px;" contenteditable="false"><div class="sticky-content" contenteditable="true">' + selText + '</div></div>';
    document.execCommand('insertHTML', false, '<br>' + html + '<br>'); syncPreviewToText();
    setTimeout(function() {
      var s = document.getElementById(id); if (s) { var c = s.querySelector('.sticky-content'); if (c) {
        c.focus(); var r = document.createRange(), sl = window.getSelection();
        r.selectNodeContents(c); r.collapse(false); sl.removeAllRanges(); sl.addRange(r);
      } }
    }, 100);
    showStatus('Selection moved to sticky.', true); return;
  }
  var start = textarea.selectionStart, end = textarea.selectionEnd; selText = textarea.value.substring(start, end).trim();
  if (!selText) { showStatus('Highlight some text first!', false); return; }
  var html = '<div class="sticky-note" data-x="100" data-y="100" style="left: 100px; top: 100px;" contenteditable="false"><div class="sticky-content" contenteditable="true">' + selText + '</div></div>';
  textarea.value = textarea.value.substring(0, start) + '\n\n' + html + '\n\n' + textarea.value.substring(end);
  isDirty = true; triggerAutosave(); if (previewOn) togglePreview(true);
  showStatus('Selection moved to sticky.', true);
}

function parseNoteLinks(content) {
  if (!content) return '';
  return content.replace(/\[\[(.*?)\]\]/g, function(match, name) {
    var fileName = name.trim();
    if (!fileName.endsWith('.md') && !fileName.endsWith('.txt')) fileName += '.md';
    return '<a href="#" class="internal-link" onclick="openNote(\'notes/' + fileName + '\'); return false;">' + name.trim() + '</a>';
  });
}

function syncPreviewToText() { if (!turndownService || !fullPreview) return; var p = document.getElementById('previewArea'); document.getElementById('noteText').value = turndownService.turndown(p.innerHTML); isDirty = true; triggerAutosave(); initDraggableStickies(); }

function togglePreview(on) {
  if (isWhiteboardActive) return; 
  previewOn = on !== undefined ? on : !previewOn;
  var textarea = document.getElementById('noteText'), preview = document.getElementById('previewArea');
  if (previewOn) {
    if (fullPreview) {
      textarea.classList.remove('side-by-side'); preview.classList.remove('side-by-side');
      textarea.classList.add('full-view'); preview.classList.add('full-view');
    } else {
      textarea.classList.remove('full-view'); preview.classList.remove('full-view');
      textarea.classList.add('side-by-side'); preview.classList.add('side-by-side');
      preview.contentEditable = "false";
    }
    preview.classList.remove('hidden');
    if (fullPreview) preview.contentEditable = "true";
    var content = textarea.value, path = document.getElementById('pathInput').value || '', isMd = path === '' || path.endsWith('.md'); 
    if (typeof marked !== 'undefined' && isMd) {
      var parsedContent = parseNoteLinks(content || '');
      preview.innerHTML = (marked.parse || marked)(parsedContent);
      preview.querySelectorAll('pre code.language-mermaid').forEach(function(codeBlock) {
        var mermaidDiv = document.createElement('div');
        mermaidDiv.classList.add('mermaid');
        var source = codeBlock.textContent;
        mermaidDiv.textContent = source;
        mermaidDiv.setAttribute('data-source', source);
        codeBlock.parentNode.replaceChild(mermaidDiv, codeBlock);
      });
      if (typeof mermaid !== 'undefined') mermaid.run({ querySelector: '.mermaid' });
      initDraggableStickies();
      var rawBase = 'https://raw.githubusercontent.com/' + repoOwner + '/' + repoName + '/' + defaultBranch + '/';
      preview.querySelectorAll('img').forEach(function (img) {
        var src = img.getAttribute('src');
        if (!src || src.startsWith('http') || src.startsWith('data:')) return;
        var fullRaw = rawBase + (src.startsWith(NOTES_DIR) ? src : NOTES_DIR + '/' + src);
        fetch(apiUrl('contents/' + fullRaw.slice(rawBase.length)), { headers: Object.assign({}, authHeaders(), { 'Accept': 'application/vnd.github.raw' }) })
          .then(res => res.blob()).then(blob => { img.src = URL.createObjectURL(blob); }).catch(()=>{});
      });
    } else { preview.textContent = content || ''; }
  } else {
    textarea.classList.remove('side-by-side', 'full-view');
    preview.classList.remove('side-by-side', 'full-view');
    preview.classList.add('hidden');
    preview.contentEditable = "false";
  }
  var toggleBtn = document.getElementById('livePreviewToggle');
  if (toggleBtn) toggleBtn.textContent = (previewOn && !fullPreview) ? '📖 Full Edit' : '👁️ Live';
  var fullToggleBtn = document.getElementById('fullPreviewToggle');
  if (fullToggleBtn) fullToggleBtn.textContent = (previewOn && fullPreview) ? '✍️ Edit' : '🖥️ Full View';
}

// --- DRAG & STICKY LOGIC ---

window.currentDraggedSticky = null;
window.dragStartX = 0; window.dragStartY = 0;
window.dragInitialLeft = 0; window.dragInitialTop = 0;

function initDraggableStickies() {
  var p = document.getElementById('previewArea'), ss = p.querySelectorAll('.sticky-note'), tx = document.getElementById('noteText');
  if (!window.stickyEventsInitialized) {
    document.addEventListener('mousemove', e => { if (!window.currentDraggedSticky) return; var dx = e.clientX - window.dragStartX, dy = e.clientY - window.dragStartY; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { var nl = window.dragInitialLeft + dx, nt = window.dragInitialTop + dy; window.currentDraggedSticky.style.left = nl + 'px'; window.currentDraggedSticky.style.top = nt + 'px'; window.currentDraggedSticky.setAttribute('data-x', nl); window.currentDraggedSticky.setAttribute('data-y', nt); e.preventDefault(); } });
    document.addEventListener('mouseup', () => { if (window.currentDraggedSticky) { var s = window.currentDraggedSticky; window.currentDraggedSticky = null; s.style.cursor = 'grab'; if (fullPreview) syncPreviewToText(); else { var oh = s.getAttribute('data-original-html'), nh = s.outerHTML; if (oh && tx.value.includes(oh)) { tx.value = tx.value.replace(oh, nh); s.setAttribute('data-original-html', nh); isDirty = true; triggerAutosave(); } } } });
    window.stickyEventsInitialized = true;
  }
  ss.forEach(s => {
    if (s.getAttribute('data-initialized') === 'true') return;
    if (!s.querySelector('.sticky-content')) { var c = s.innerHTML; s.innerHTML = '<div class="sticky-content" contenteditable="true">' + c + '</div>'; s.contentEditable = "false"; }
    s.setAttribute('data-original-html', s.outerHTML);
    s.addEventListener('mousedown', e => { if (e.target.tagName.toLowerCase() === 'button' || e.target.classList.contains('sticky-content')) return; window.currentDraggedSticky = s; window.dragStartX = e.clientX; window.dragStartY = e.clientY; window.dragInitialLeft = parseInt(s.style.left || s.getAttribute('data-x') || 0, 10); window.dragInitialTop = parseInt(s.style.top || s.getAttribute('data-y') || 0, 10); s.style.cursor = 'grabbing'; });
    var cnt = s.querySelector('.sticky-content');
    if (cnt) {
      cnt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); document.execCommand('insertLineBreak'); return false; } }, true);
      cnt.addEventListener('blur', () => { if (fullPreview) syncPreviewToText(); else { var oh = s.getAttribute('data-original-html'), nh = s.outerHTML; if (oh && tx.value.includes(oh)) { tx.value = tx.value.replace(oh, nh); s.setAttribute('data-original-html', nh); isDirty = true; triggerAutosave(); } } });
    }
    s.setAttribute('data-initialized', 'true');
  });
}

// --- WHITEBOARD & SVG LOGIC ---

function setupSvgDrawing(svg) {
  if (!svg) return; var isDr = false;
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; if (currentWhiteboardTool === 'eraser') { isDr = true; erase(svg, e); svg.setPointerCapture(e.pointerId); return; }
    e.preventDefault(); isDr = true; var start = getMousePos(svg, e); startPos = start; currentDrawingElement = null; 
    var stroke = { 'pen': { tag: 'path', attr: { fill: 'none', 'stroke-width': '6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M ' + start.x + ' ' + start.y } }, 'rectangle': { tag: 'rect', attr: { fill: 'none', 'stroke-width': '4', x: start.x, y: start.y } }, 'circle': { tag: 'circle', attr: { fill: 'none', 'stroke-width': '4', cx: start.x, cy: start.y } } }[currentWhiteboardTool];
    if (stroke) { currentDrawingElement = document.createElementNS("http://www.w3.org/2000/svg", stroke.tag); for (var a in stroke.attr) currentDrawingElement.setAttribute(a, stroke.attr[a]); currentDrawingElement.setAttribute('stroke', currentStrokeColor); svg.appendChild(currentDrawingElement); }
    svg.setPointerCapture(e.pointerId); 
  });
  svg.addEventListener('pointermove', e => {
    if (!isDr) return; e.preventDefault(); var p = getMousePos(svg, e); if (currentWhiteboardTool === 'eraser') { erase(svg, e); return; }
    if (!currentDrawingElement) return;
    if (currentWhiteboardTool === 'pen') currentDrawingElement.setAttribute('d', currentDrawingElement.getAttribute('d') + ' L ' + p.x + ' ' + p.y);
    else if (currentWhiteboardTool === 'rectangle') { var w = p.x - startPos.x, h = p.y - startPos.y; currentDrawingElement.setAttribute('x', w > 0 ? startPos.x : p.x); currentDrawingElement.setAttribute('y', h > 0 ? startPos.y : p.y); currentDrawingElement.setAttribute('width', Math.abs(w)); currentDrawingElement.setAttribute('height', Math.abs(h)); }
    else if (currentWhiteboardTool === 'circle') currentDrawingElement.setAttribute('r', Math.sqrt(Math.pow(p.x - startPos.x, 2) + Math.pow(p.y - startPos.y, 2)));
  });
  svg.addEventListener('pointerup', (e) => { isDr = false; currentDrawingElement = null; svg.releasePointerCapture(e.pointerId); });
}

function erase(svg, e) { var t = document.elementFromPoint(e.clientX, e.clientY); while (t && t !== svg && t !== document.body) { if (['path', 'rect', 'circle'].includes(t.tagName.toLowerCase())) { t.remove(); return; } t = t.parentElement; } }

function cropSvg(s) {
  var p = new DOMParser(), d = p.parseFromString(s, "image/svg+xml"), svg = d.documentElement, box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  var els = svg.querySelectorAll('path, rect, circle'); if (els.length === 0) return s; els.forEach(el => { if (el.tagName.toLowerCase() === 'path') { el.getAttribute('d').split(/(?=[LMCHVZ])/).forEach(c => { var pts = c.slice(1).trim().split(/[\s,]+/); var x = parseFloat(pts[pts.length - 2]), y = parseFloat(pts[pts.length - 1]); if (!isNaN(x) && !isNaN(y)) { box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y); box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(bbox.maxY, y); } }); } else if (el.tagName.toLowerCase() === 'rect') { var x = parseFloat(el.getAttribute('x')), y = parseFloat(el.getAttribute('y')), w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height')); box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y); box.maxX = Math.max(box.maxX, x + w); box.maxY = Math.max(box.maxY, y + h); } else if (el.tagName.toLowerCase() === 'circle') { var cx = parseFloat(el.getAttribute('cx')), cy = parseFloat(el.getAttribute('cy')), r = parseFloat(el.getAttribute('r')); box.minX = Math.min(box.minX, cx - r); box.minY = Math.min(box.minY, cy - r); box.maxX = Math.max(box.maxX, cx + r); box.maxY = Math.max(box.maxY, cy + r); } });
  var pad = 10, x = box.minX - pad, y = box.minY - pad, w = box.maxX - box.minX + pad * 2, h = box.maxY - box.minY + pad * 2;
  svg.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h); return new XMLSerializer().serializeToString(svg);
}

// --- GITHUB API & APP LOGIC ---

function searchGithub(q) { if (!getToken()) return; showStatus('Searching GitHub...', true); var loc = fullNotesTree.filter(e => e.path.toLowerCase().includes(q.toLowerCase())); if (searchCache[q]) { combineAndRenderResults(loc, searchCache[q], q); return; } fetch('https://api.github.com/search/code?q=' + encodeURIComponent(q) + '+in:file+repo:' + repoOwner + '/' + repoName + '+path:' + NOTES_DIR + '&per_page=100', { headers: authHeaders() }).then(res => res.json()).then(data => { var rr = (data.items || []).map(i => ({ path: i.path, type: 'blob', sha: i.sha })); searchCache[q] = rr; combineAndRenderResults(loc, rr, q); }); }
function combineAndRenderResults(l, r, q) { var s = new Set(), c = []; l.concat(r).forEach(i => { if (!s.has(i.path)) { c.push(i); s.add(i.path); } }); showStatus('Found ' + c.length + ' results.', true); renderNotesList(c, true); }
function toggleWhiteboard(on) { isWhiteboardActive = on; var ids = ['previewArea', 'whiteboardArea', 'insertDropdown', 'editorToolbar', 'noteText', 'whiteboardToolbar']; ids.forEach(id => { var el = document.getElementById(id); if (el) { if (on) (id === 'whiteboardArea' || id === 'whiteboardToolbar' ? el.classList.remove('hidden') : el.classList.add('hidden')); else (id === 'whiteboardArea' || id === 'whiteboardToolbar' ? el.classList.add('hidden') : el.classList.remove('hidden')); } }); if (!on) togglePreview(previewOn); }
function newWhiteboard() { var f = 'board-' + Date.now() + '.svg'; document.getElementById('pathInput').value = currentFolder ? currentFolder + '/' + f : f; openFilePath = null; openFileSha = null; toggleWhiteboard(true); mainWhiteboardSvg.innerHTML = ''; isDirty = false; }
function refreshNotesList() { if (!getToken()) return; fetchDefaultBranch().then(() => fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() })).then(res => res.json()).then(data => { fullNotesTree = (data.tree || []).filter(e => e.path.startsWith(NOTES_DIR + '/')); renderNotesList(fullNotesTree); }); }
function renderNotesList(tree, isSearch = false) { var pre = NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/', html = ''; if (!isSearch && currentFolder) html += '<li class="folder" data-path="" data-type="dir">..</li>'; tree.forEach(e => { if (isSearch || (e.path.startsWith(pre) && !e.path.slice(pre.length).includes('/'))) { var n = e.path.slice(isSearch ? NOTES_DIR.length + 1 : pre.length); html += '<li class="' + (e.type === 'tree' ? 'folder' : 'file') + '" data-path="' + e.path.slice(NOTES_DIR.length + 1) + '" data-type="' + e.type + '">' + n + '</li>'; } }); document.getElementById('notesList').innerHTML = html || '<li>No notes</li>'; document.querySelectorAll('#notesList li').forEach(li => li.onclick = function() { var p = this.getAttribute('data-path'), t = this.getAttribute('data-type'); if (t === 'tree' || t === 'dir') { currentFolder = p === '' ? currentFolder.split('/').slice(0,-1).join('/') : p; renderNotesList(fullNotesTree); } else openNote(NOTES_DIR + '/' + p); }); }
function openNote(p) { openFilePath = p; var pi = document.getElementById('pathInput'); if (pi) pi.value = p.replace(NOTES_DIR + '/', ''); fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { var txt = decodeBase64Utf8(d.content); openFileSha = d.sha; if (p.endsWith('.svg')) { toggleWhiteboard(true); var t = document.createElement('div'); t.innerHTML = txt; mainWhiteboardSvg.innerHTML = t.querySelector('svg').innerHTML; } else { document.getElementById('noteText').value = txt; toggleWhiteboard(false); togglePreview(false); } isDirty = false; }).catch(()=>{}); }
function saveNote(isA = false) { var pi = document.getElementById('pathInput'), pr = pi.value.trim() || defaultFilename(); if (!isWhiteboardActive && !pr.includes('.')) pr += '.md'; var fp = NOTES_DIR + '/' + pr, c = isWhiteboardActive ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + mainWhiteboardSvg.innerHTML + '</svg>' : document.getElementById('noteText').value; var body = { message: (isA ? 'Autosave: ' : 'Save: ') + pr, content: base64Utf8(c), sha: openFileSha }; fetch(apiUrl('contents/' + fp), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body) }).then(res => res.json()).then(d => { if (d.content) { openFileSha = d.content.sha; openFilePath = fp; if (!isA) { showStatus('Saved.', true); refreshNotesList(); } } }); }
function deleteNote() { if (!confirm('Delete?')) return; fetch(apiUrl('contents/' + openFilePath), { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Delete', sha: openFileSha }) }).then(() => { newNote(); refreshNotesList(); }); }
function downloadNote() { var c = isWhiteboardActive ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + mainWhiteboardSvg.innerHTML + '</svg>' : document.getElementById('noteText').value; var b = new Blob([c], { type: 'text/plain' }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = document.getElementById('pathInput').value || 'note.md'; a.click(); URL.revokeObjectURL(u); }
function newFolder() { var n = prompt('Folder:'); if (!n) return; fetch(apiUrl('contents/' + NOTES_DIR + '/' + n + '/.gitkeep'), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'New folder', content: btoa('') }) }).then(() => refreshNotesList()); }
function newNote() { var pi = document.getElementById('pathInput'); if (pi) pi.value = currentFolder ? currentFolder + '/' + defaultFilename() : defaultFilename(); var nt = document.getElementById('noteText'); if (nt) nt.value = ''; openFilePath = null; openFileSha = null; toggleWhiteboard(false); togglePreview(false); isDirty = false; }

// --- TOOLBAR & TEMPLATES ---

function addMermaidTemplate(t) { var tp = { flow: '\n```mermaid\ngraph TD\n    A[Start] --> B{Is it?};\n    B -- Yes --> C[OK];\n    C --> D[End];\n    B -- No --> E[Find out];\n    E --> B;\n```\n', seq: '\n```mermaid\nsequenceDiagram\n    Alice->>John: Hello John, how are you?\n    John-->>Alice: Great!\n```\n', gantt: '\n```mermaid\ngantt\n    title Gantt\n    section S1\n    T1 :a1, 2023-01-01, 30d\n```\n', class: '\n```mermaid\nclassDiagram\n    Animal <|-- Duck\n```\n' }[t] || '\n```mermaid\ngraph TD\n    A --> B;\n```\n'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + tp + tx.value.slice(tx.selectionEnd); showStatus('Mermaid added.', true); }
function addSticky() { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note" data-x="100" data-y="100" style="left: 100px; top: 100px;" contenteditable="false"><div class="sticky-content" contenteditable="true">New sticky...</div></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }
function addDrawSticky() { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + EMPTY_SVG + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }
function addImageSticky() { uploadImage(u => { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><img src="' + u + '" alt="Image"></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }); }
function addImageLink() { uploadImage(u => { var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '![](' + u + ')' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }); }
function addImageFromUrl() { var u = prompt("URL:"); if (u) { var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '![](' + u + ')' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); } }
function uploadImage(cb) { var fi = document.getElementById('imageFileInput'); var cl = () => { var f = fi.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = () => { var b6 = rd.result.replace(/^data:image\/\w+;base64,/, ''); var name = Date.now() + '-' + f.name, p = NOTES_DIR + '/images/' + name; fetch(apiUrl('contents/' + p), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Add image', content: b6 }) }).then(res => res.json()).then(data => { cb(data.content.download_url); refreshNotesList(); }); }; rd.readAsDataURL(f); }; fi.addEventListener('change', cl, { once: true }); fi.click(); }
function showImageLibrary() { var m = document.getElementById('imageLibraryModal'), l = document.getElementById('imageLibraryList'); m.classList.remove('hidden'); l.innerHTML = '<li>Loading...</li>'; fetch(apiUrl('contents/' + NOTES_DIR + '/images'), { headers: authHeaders() }).then(res => res.json()).then(data => { l.innerHTML = ''; if (!data || data.message) return; data.forEach(file => { var img = document.createElement('img'); img.src = file.download_url; img.onclick = () => { l.querySelectorAll('img').forEach(i => i.classList.remove('selected')); img.classList.add('selected'); selectedImageUrl = file.download_url; document.getElementById('imageLibraryActions').classList.remove('hidden'); }; l.appendChild(img); }); }).catch(()=>{}); }
function showWhiteboardModal(asS) { isPlacingAsSticky = !!asS; var m = document.getElementById('whiteboardModal'), l = document.getElementById('whiteboardList'); m.classList.remove('hidden'); l.innerHTML = '<li>Loading...</li>'; fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() }).then(res => res.json()).then(data => { var fs = (data.tree||[]).filter(e => e.path.endsWith('.svg')); l.innerHTML = fs.map(f => '<li data-path="' + f.path + '">' + f.path.replace(NOTES_DIR+'/', '') + '</li>').join(''); l.querySelectorAll('li').forEach(li => li.onclick = function() { var p = this.getAttribute('data-path'); if (isPlacingAsSticky) placeWhiteboardAsSticky(p); else placeWhiteboard(p); }); }); }
function placeWhiteboardAsSticky(p) { fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { var svg = decodeBase64Utf8(d.content); var h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + svg + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; document.getElementById('noteText').value += h; if (previewOn) togglePreview(true); document.getElementById('whiteboardModal').classList.add('hidden'); }); }
function placeWhiteboard(p) { fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { var svg = decodeBase64Utf8(d.content); var u = 'data:image/svg+xml;base64,' + btoa(svg); document.getElementById('noteText').value += '![](' + u + ')'; document.getElementById('whiteboardModal').classList.add('hidden'); }); }
function placeCurrentDrawingAsSticky() { if (!isWhiteboardActive) { showStatus("No drawing.", false); return; } var inner = mainWhiteboardSvg.innerHTML; if (!inner.trim()) { showStatus("Empty.", false); return; } var full = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + inner + '</svg>'; var cr = cropSvg(full); var h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + cr + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); toggleWhiteboard(false); togglePreview(true); showStatus('Drawing pinned.', true); }

function updateToolSelection() {
  var activeIdMap = { 'pen': 'penToolBtn', 'rectangle': 'rectToolBtn', 'circle': 'circleToolBtn', 'eraser': 'eraserToolBtn' };
  var activeId = activeIdMap[currentWhiteboardTool];
  var modalIdMap = { 'pen': 'modalPenToolBtn', 'rectangle': 'modalRectToolBtn', 'circle': 'modalCircleToolBtn', 'eraser': 'modalEraserToolBtn' };
  var activeModalId = modalIdMap[currentWhiteboardTool];
  ['penToolBtn', 'rectToolBtn', 'circleToolBtn', 'eraserToolBtn', 'modalPenToolBtn', 'modalRectToolBtn', 'modalCircleToolBtn', 'modalEraserToolBtn'].forEach(id => {
    var el = document.getElementById(id); if (el) { (id === activeId || id === activeModalId) ? el.classList.add('selected-tool') : el.classList.remove('selected-tool'); }
  });
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', function() {
  var noteTextarea = document.getElementById('noteText'), whiteboardSvg = document.getElementById('mainWhiteboardSvg'), previewArea = document.getElementById('previewArea');
  if (noteTextarea) noteTextarea.addEventListener('input', () => { isDirty = true; triggerAutosave(); if (previewOn) togglePreview(true); });
  if (previewArea) previewArea.addEventListener('input', () => { if (fullPreview) syncPreviewToText(); });
  if (whiteboardSvg) { var obs = new MutationObserver(() => { isDirty = true; triggerAutosave(); }); obs.observe(whiteboardSvg, { childList: true, subtree: true, attributes: true }); }
  mainWhiteboardSvg = document.getElementById('mainWhiteboardSvg'); modalSvgBoard = document.getElementById('nativeSvgBoard');
  setupSvgDrawing(mainWhiteboardSvg); setupSvgDrawing(modalSvgBoard);
  var sIn = document.getElementById('searchInput'); if (sIn) sIn.addEventListener('input', function () { var q = this.value.trim(); if (q === '') { renderNotesList(fullNotesTree); showStatus('', true); } else { renderNotesList(fullNotesTree.filter(e => e.path.toLowerCase().includes(q.toLowerCase())), true); showStatus('Searching locally...', true); debouncedSearch(q); } });
  var rOwner = document.getElementById('repoOwnerInput'); if (rOwner) rOwner.value = repoOwner;
  var rName = document.getElementById('repoNameInput'); if (rName) rName.value = repoName;
  updateRepoDisplay();
  var uRepo = document.getElementById('useRepoBtn'); if (uRepo) uRepo.addEventListener('click', () => setRepo(document.getElementById('repoOwnerInput').value, document.getElementById('repoNameInput').value));
  var sTok = document.getElementById('saveTokenBtn'); if (sTok) sTok.addEventListener('click', () => setToken(document.getElementById('tokenInput').value));
  var lOut = document.getElementById('logoutBtn'); if (lOut) lOut.addEventListener('click', clearToken);
  var sBtn = document.getElementById('saveBtn'); if (sBtn) sBtn.addEventListener('click', () => saveNote());
  var dBtn = document.getElementById('deleteBtn'); if (dBtn) dBtn.addEventListener('click', deleteNote);
  var nFold = document.getElementById('fileDropdownNewFolderBtn'); if (nFold) nFold.addEventListener('click', newFolder);
  var nNote = document.getElementById('fileDropdownNewNoteBtn'); if (nNote) nNote.addEventListener('click', newNote);
  var nWhit = document.getElementById('fileDropdownNewWhiteboardBtn'); if (nWhit) nWhit.addEventListener('click', newWhiteboard);
  var dLoad = document.getElementById('fileDropdownDownloadBtn'); if (dLoad) dLoad.addEventListener('click', downloadNote);
  var aDiag = document.getElementById('addDiagramBtn'); if (aDiag) aDiag.addEventListener('click', () => addMermaidTemplate('flow'));
  var iLink = document.getElementById('imageDropdownAddImageLinkBtn'); if (iLink) iLink.addEventListener('click', addImageLink);
  var iUrl = document.getElementById('imageDropdownAddImageUrlBtn'); if (iUrl) iUrl.addEventListener('click', addImageFromUrl);
  var fDrop = document.getElementById('fileDropdownBtn'); if (fDrop) fDrop.addEventListener('click', (e) => { document.getElementById('fileDropdownContent').classList.toggle('show'); e.stopPropagation(); });
  var iDrop = document.getElementById('imageDropdownBtn'); if (iDrop) iDrop.addEventListener('click', (e) => { document.getElementById('imageDropdownContent').classList.toggle('show'); e.stopPropagation(); });
  var inDrop = document.getElementById('insertToggleBtn'); if (inDrop) inDrop.addEventListener('click', (e) => { document.getElementById('insertDropdownContent').classList.toggle('show'); e.stopPropagation(); });
  var lPrev = document.getElementById('livePreviewToggle'); if (lPrev) lPrev.addEventListener('click', () => { if (!previewOn || fullPreview) { previewOn = true; fullPreview = false; } else { previewOn = false; } togglePreview(previewOn); });
  var fPrev = document.getElementById('fullPreviewToggle'); if (fPrev) fPrev.addEventListener('click', () => { if (!previewOn || !fullPreview) { previewOn = true; fullPreview = true; } else { previewOn = false; fullPreview = false; } togglePreview(previewOn); });
  window.onclick = (e) => { if (!e.target.matches('.dropbtn')) closeAllDropdowns(); };
  var aStick = document.getElementById('addTextSticky'); if (aStick) aStick.addEventListener('click', (e) => { e.preventDefault(); addSticky(); });
  var aDraw = document.getElementById('addDrawingSticky'); if (aDraw) aDraw.addEventListener('click', (e) => { e.preventDefault(); addDrawSticky(); });
  var aImgS = document.getElementById('addImageSticky'); if (aImgS) aImgS.addEventListener('click', (e) => { e.preventDefault(); addImageSticky(); });
  var aWhitS = document.getElementById('addWhiteboardSticky'); if (aWhitS) aWhitS.addEventListener('click', (e) => { e.preventDefault(); showWhiteboardModal(true); });
  var iLib = document.getElementById('imageDropdownAddImageFromLibrary'); if (iLib) iLib.addEventListener('click', (e) => { e.preventDefault(); showImageLibrary(); });
  var cLib = document.getElementById('cancelImageLibraryBtn'); if (cLib) cLib.addEventListener('click', () => document.getElementById('imageLibraryModal').classList.add('hidden'));
  var iAsL = document.getElementById('insertImageAsLinkBtn'); if (iAsL) iAsL.addEventListener('click', () => { if (selectedImageUrl) { insertMarkdown('![](', selectedImageUrl + ')'); document.getElementById('imageLibraryModal').classList.add('hidden'); } });
  var iAsS = document.getElementById('insertImageAsStickyBtn'); if (iAsS) iAsS.addEventListener('click', () => { if (selectedImageUrl) { var html = '<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><img src="' + selectedImageUrl + '" alt="Image"></div>'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '\n' + html + '\n' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); document.getElementById('imageLibraryModal').classList.add('hidden'); } });
  var rList = document.getElementById('fileDropdownRefreshNotesBtn'); if (rList) rList.addEventListener('click', () => { refreshNotesList(); showStatus('List refreshed.', true); });
  var pTog = document.getElementById('previewToggle'); if (pTog) pTog.addEventListener('click', () => togglePreview());
  var pWhit = document.getElementById('placeWhiteboardBtn'); if (pWhit) pWhit.addEventListener('click', () => showWhiteboardModal(false));
  var pDraw = document.getElementById('placeDrawingAsStickyBtn'); if (pDraw) pDraw.addEventListener('click', placeCurrentDrawingAsSticky);
  var mToggle = document.getElementById('menuToggleBtn'); if (mToggle) mToggle.addEventListener('click', (e) => { document.body.classList.toggle('sidebar-open'); e.stopPropagation(); });
  var cSide = document.getElementById('closeSidebarBtn'); if (cSide) cSide.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  var cont = document.getElementById('content'); if (cont) cont.addEventListener('click', () => { if (document.body.classList.contains('sidebar-open')) document.body.classList.remove('sidebar-open'); });
  ['pen', 'rectangle', 'circle', 'eraser'].forEach(t => { 
    var id = t + 'ToolBtn', mid = 'modal' + t.charAt(0).toUpperCase() + t.slice(1) + 'ToolBtn';
    var b = document.getElementById(id); if (b) b.addEventListener('click', () => { currentWhiteboardTool = t; updateToolSelection(); showStatus('Tool: ' + t, true); });
    var mb = document.getElementById(mid); if (mb) mb.addEventListener('click', () => { currentWhiteboardTool = t; updateToolSelection(); });
  });
  var sInp = document.getElementById('strokeColorInput'); if (sInp) sInp.addEventListener('input', function() { currentStrokeColor = this.value; var m = document.getElementById('modalStrokeColorInput'); if (m) m.value = this.value; });
  var msInp = document.getElementById('modalStrokeColorInput'); if (msInp) msInp.addEventListener('input', function() { currentStrokeColor = this.value; var s = document.getElementById('strokeColorInput'); if (s) s.value = this.value; });
  document.querySelectorAll('.dropdown-content a').forEach(link => link.addEventListener('click', closeAllDropdowns));
  updateToolSelection(); refreshNotesList();
});
