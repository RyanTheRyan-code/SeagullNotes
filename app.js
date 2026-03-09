var TOKEN_KEY = 'github_token';
var REPO_OWNER_KEY = 'repo_owner';
var REPO_NAME_KEY = 'repo_name';
var NOTES_DIR = 'notes';
var RECENT_NOTES_KEY = 'recent_notes';
var VAULT_INDEX_KEY = 'vault_index';

function getVaultIndex() { return JSON.parse(localStorage.getItem(VAULT_INDEX_KEY) || '{}'); }
function saveVaultIndex(idx) { localStorage.setItem(VAULT_INDEX_KEY, JSON.stringify(idx)); }

function indexNote(path, content) {
  var idx = getVaultIndex();
  // Don't index tags in SVGs to avoid hex colors
  var tags = [];
  if (!path.endsWith('.svg')) {
    // Only match tags that start with a letter and are preceded by whitespace or start of line
    // This naturally excludes hex codes in attributes like stroke="#2c3e50"
    var matches = content.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]*)/g);
    tags = [...new Set([...matches].map(m => '#' + m[1]))];
  }
  var links = [...new Set((content.match(/\[\[(.*?)\]\]/g) || []).map(m => {
    var link = m.slice(2, -2).trim();
    return link.endsWith('.md') || link.endsWith('.txt') ? link.split('.')[0] : link;
  }))];
  idx[path] = { tags: tags, links: links };
  saveVaultIndex(idx);
  updateTagsSidebar();
}

function updateRecentNotes(p) {
  var recents = JSON.parse(localStorage.getItem(RECENT_NOTES_KEY) || '[]');
  recents = recents.filter(r => r !== p);
  recents.unshift(p);
  recents = recents.slice(0, 5);
  localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(recents));
  updateRecentNotesUI();
}

function updateRecentNotesUI() {
  var recents = JSON.parse(localStorage.getItem(RECENT_NOTES_KEY) || '[]');
  var list = document.getElementById('recentNotesList');
  if (recents.length === 0) { document.getElementById('recentNotesSection').classList.add('hidden'); return; }
  document.getElementById('recentNotesSection').classList.remove('hidden');
  list.innerHTML = recents.map(r => `<li onclick="openNote('${r}')">${r.replace(NOTES_DIR + '/', '')}</li>`).join('');
}

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
var isSaving = false;
var autosaveTimer = null; 
var startPos = { x: 0, y: 0 };

var canvasPanX = 0, canvasPanY = 0, canvasZoom = 1;
var draggedElement = null, dragOffset = { x: 0, y: 0 };

function updateCanvasTransform(svg) {
  if (!svg) return;
  svg.setAttribute('viewBox', `${-canvasPanX} ${-canvasPanY} ${1000/canvasZoom} ${1000/canvasZoom}`);
}

// --- EDITOR & PREVIEW LOGIC ---
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
                var cleanHtml = cleanHtmlForMarkdown(node);
                return '\n\n' + cleanHtml + '\n\n';
              }
            });    turndownService.addRule('internalLink', {
      filter: function (node) { return node.classList && node.classList.contains('internal-link'); },
      replacement: function (content, node) { return '[[' + content + ']]'; }
    });
    turndownService.addRule('images', {
      filter: 'img',
      replacement: function (content, node) {
        var src = node.getAttribute('data-canonical-src') || node.getAttribute('src');
        var alt = node.getAttribute('alt') || '';
        return '![' + alt + '](' + src + ')';
      }
    });
  }

function cleanHtmlForMarkdown(el) {
  var clone = el.cloneNode(true);
  clone.querySelectorAll('img').forEach(img => {
    var canonical = img.getAttribute('data-canonical-src');
    if (canonical) {
      img.setAttribute('src', canonical);
      img.removeAttribute('data-canonical-src');
    }
  });
  // Also remove runtime operational attributes
  clone.removeAttribute('data-initialized');
  clone.removeAttribute('data-original-html');
  clone.style.cursor = '';
  return clone.outerHTML;
}

// --- CORE UTILITIES ---

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(v) { if (v && v.trim()) { localStorage.setItem(TOKEN_KEY, v.trim()); document.getElementById('tokenInput').value = ''; showStatus('Token saved.', true); } }
function clearToken() { localStorage.removeItem(TOKEN_KEY); document.getElementById('tokenInput').value = ''; document.getElementById('noteText').value = ''; document.getElementById('pathInput').value = ''; openFilePath = null; openFileSha = null; showStatus('Logged out.', true); refreshNotesList(); }
function getRepo() { return { owner: repoOwner, name: repoName }; }
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
function triggerAutosave() { 
  clearTimeout(autosaveTimer); 
  autosaveTimer = setTimeout(() => { 
    if (isDirty && openFilePath && !isSaving) { 
      saveNote(true); 
    } 
  }, 3000); 
}
function closeAllDropdowns() { var ds = document.getElementsByClassName("dropdown-content"); for (var i = 0; i < ds.length; i++) ds[i].classList.remove('show'); }
function debounce(func, delay) { let t; return function(...args) { clearTimeout(t); t = setTimeout(() => func.apply(this, args), delay); }; }
var debouncedSearch = debounce(searchGithub, 1000);

// --- EDITOR & PREVIEW LOGIC ---

function insertMarkdown(prefix, suffix) {
  var textarea = document.getElementById('noteText'), preview = document.getElementById('previewArea');
  if (fullPreview && !preview.classList.contains('hidden')) {
    preview.focus(); 
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
  // Handle Obsidian-style image links ![[image.png]]
  content = content.replace(/!\[\[(.*?)\]\]/g, function(match, name) {
    var src = name.trim();
    return '<img src="' + src + '" alt="' + src + '">';
  });
  // Handle Obsidian-style internal links [[Note]]
  return content.replace(/\[\[(.*?)\]\]/g, function(match, name) {
    var fileName = name.trim();
    if (!fileName.endsWith('.md') && !fileName.endsWith('.txt')) fileName += '.md';
    return '<a href="#" class="internal-link" onclick="openNote(\'notes/' + fileName + '\'); return false;">' + name.trim() + '</a>';
  });
}

var debouncedTogglePreview = debounce((on) => togglePreview(on), 500);

function syncPreviewToText() { if (!turndownService || !fullPreview) return; var p = document.getElementById('previewArea'); document.getElementById('noteText').value = turndownService.turndown(p.innerHTML); isDirty = true; triggerAutosave(); initDraggableStickies(); }

function togglePreview(on) {
  if (isWhiteboardActive) return; 
  previewOn = on !== undefined ? on : !previewOn;
  var textarea = document.getElementById('noteText'), preview = document.getElementById('previewArea');
  if (previewOn) {
    if (fullPreview) {
      textarea.classList.remove('side-by-side'); preview.classList.remove('side-by-side');
      textarea.classList.add('full-view'); preview.classList.add('full-view');
      preview.contentEditable = "true";
    } else {
      textarea.classList.remove('full-view'); preview.classList.remove('full-view');
      textarea.classList.add('side-by-side'); preview.classList.add('side-by-side');
      preview.contentEditable = "false";
    }
    preview.classList.remove('hidden');
    var content = textarea.value, path = document.getElementById('pathInput').value || '', isMd = path === '' || path.endsWith('.md'); 
    
    // Strip Frontmatter for preview
    if (isMd) content = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

    if (typeof marked !== 'undefined' && isMd) {
      var parsedContent = parseNoteLinks(content || '');
      var html = (marked.parse || marked)(parsedContent);
      
      // Prevent immediate loading of relative paths by renaming src to data-src
      // This regex is more robust to handle various attribute orders and quotes
      html = html.replace(/<img([^>]+?)src=(["']?)([^"'\s>]+?)\2([^>]*?)>/gi, function(m, p1, q, p2, p3) {
        if (p2.startsWith('http') || p2.startsWith('data:') || p2.startsWith('blob:')) return m;
        return '<img' + p1 + 'data-src=' + q + p2 + q + ' src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"' + p3 + '>';
      });
      preview.innerHTML = html;
      
      // Callout Transformation
      preview.querySelectorAll('blockquote').forEach(function(bq) {
        var firstP = bq.querySelector('p');
        if (firstP) {
          var match = firstP.innerHTML.trim().match(/^\[!(\w+)\]/);
          if (match) {
            var type = match[1].toLowerCase();
            var div = document.createElement('div');
            div.className = 'callout callout-' + (['info', 'warning', 'danger', 'success', 'note'].includes(type) ? type : 'info');
            
            var title = document.createElement('div');
            title.className = 'callout-title';
            title.innerHTML = type;
            div.appendChild(title);
            
            firstP.innerHTML = firstP.innerHTML.replace(/^\[!(\w+)\]/, '').trim();
            div.innerHTML += bq.innerHTML;
            bq.parentNode.replaceChild(div, bq);
          }
        }
      });

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
      
      preview.querySelectorAll('img').forEach(function (img) {
        var src = img.getAttribute('data-src') || img.getAttribute('src');
        if (!src) return;
        
        // Backward compatibility: Convert full GitHub URLs to relative paths
        var rawPattern = new RegExp('https://raw\\.githubusercontent\\.com/' + repoOwner + '/' + repoName + '/[^/]+/(.*)');
        var match = src.match(rawPattern);
        if (match) {
          src = match[1];
          if (src.startsWith(NOTES_DIR + '/')) src = src.slice(NOTES_DIR.length + 1);
        }

        if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('blob:')) return;
        
        // Strip query tokens (e.g. ?token=...)
        var cleanPath = src.split('?')[0];
        
        // Canonical relative path (e.g. images/pic.png)
        img.setAttribute('data-canonical-src', cleanPath);
        var fullPath = cleanPath.startsWith(NOTES_DIR) ? cleanPath : NOTES_DIR + '/' + cleanPath;

        fetch(apiUrl('contents/' + fullPath), { headers: Object.assign({}, authHeaders(), { 'Accept': 'application/vnd.github.raw' }) })
          .then(res => res.blob())
          .then(blob => { 
            var reader = new FileReader();
            reader.onloadend = function() { img.src = reader.result; };
            reader.readAsDataURL(blob);
          }).catch(()=>{});
      });
    } else { preview.textContent = content || ''; }
    if (fullPreview) { preview.style.minHeight = "100%"; preview.focus(); }
  } else {
    if (fullPreview) syncPreviewToText();
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
    document.addEventListener('mouseup', () => { 
      if (window.currentDraggedSticky) { 
        var s = window.currentDraggedSticky; 
        window.currentDraggedSticky = null; 
        s.style.cursor = 'grab'; 
        if (fullPreview) syncPreviewToText(); 
        else { 
          var oh = s.getAttribute('data-original-html');
          var nh = cleanHtmlForMarkdown(s); 
          if (oh && tx.value.includes(oh)) { 
            tx.value = tx.value.replace(oh, nh); 
            s.setAttribute('data-original-html', nh); 
            isDirty = true; triggerAutosave(); 
          } 
        } 
      } 
    });
    window.stickyEventsInitialized = true;
  }
  ss.forEach(s => {
    if (s.getAttribute('data-initialized') === 'true') return;
    
    // Capture original HTML BEFORE any runtime modifications
    s.setAttribute('data-original-html', s.outerHTML);
    
    // specialized stickies don't need the default text wrapper
    if (!s.querySelector('.sticky-content') && !s.classList.contains('sticky-image') && !s.classList.contains('sticky-draw')) { 
      var c = s.innerHTML; s.innerHTML = '<div class="sticky-content" contenteditable="true">' + c + '</div>'; s.contentEditable = "false"; 
    }
    
    s.addEventListener('mousedown', e => { 
      if (e.target.tagName.toLowerCase() === 'button') return; 
      if (e.target.classList.contains('sticky-content') && !s.classList.contains('sticky-image') && !s.classList.contains('sticky-draw')) return;
      window.currentDraggedSticky = s; window.dragStartX = e.clientX; window.dragStartY = e.clientY; 
      window.dragInitialLeft = parseInt(s.style.left || s.getAttribute('data-x') || 0, 10); 
      window.dragInitialTop = parseInt(s.style.top || s.getAttribute('data-y') || 0, 10); 
      s.style.cursor = 'grabbing'; 
    });
    
    var cnt = s.querySelector('.sticky-content');
    if (cnt) {
      cnt.addEventListener('keydown', e => { 
        if (e.key === 'Enter') { 
          e.preventDefault(); e.stopPropagation(); 
          document.execCommand('insertLineBreak'); 
          cnt.dispatchEvent(new Event('input', { bubbles: true }));
          return false; 
        } 
      }, true);
      cnt.addEventListener('blur', () => { if (fullPreview) syncPreviewToText(); else { var oh = s.getAttribute('data-original-html'), nh = s.outerHTML; if (oh && tx.value.includes(oh)) { tx.value = tx.value.replace(oh, nh); s.setAttribute('data-original-html', nh); isDirty = true; triggerAutosave(); } } });
    }
    s.setAttribute('data-initialized', 'true');
  });
}

// --- WHITEBOARD & SVG LOGIC ---

function getMousePos(svg, e) {
  var pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  var ctm = svg.getScreenCTM();
  return pt.matrixTransform(ctm.inverse());
}

function toggleWhiteboard(on) { 
  isWhiteboardActive = on; 
  if (on) { currentWhiteboardTool = 'pen'; updateToolSelection(); }
  
  var ids = ['previewArea', 'whiteboardArea', 'insertDropdown', 'editorToolbar', 'noteText', 'whiteboardToolbar', 'editorContainer']; 
  ids.forEach(id => { 
    var el = document.getElementById(id); 
    if (el) {
      if (on) {
        // Show whiteboard things, hide editor things
        if (id === 'whiteboardArea' || id === 'whiteboardToolbar') el.classList.remove('hidden');
        else el.classList.add('hidden');
      } else {
        // Hide whiteboard things, show editor things
        if (id === 'whiteboardArea' || id === 'whiteboardToolbar') el.classList.add('hidden');
        else {
          if (id === 'previewArea' && !previewOn) return; // Don't show preview if it wasn't on
          el.classList.remove('hidden');
        }
      }
    }
  }); 
  if (!on) togglePreview(previewOn); 
}

function setupSvgDrawing(svg) {
  if (!svg) return; 
  var isDr = false, isPanning = false, panStart = { x: 0, y: 0 };
  
  svg.addEventListener('pointerdown', e => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) { // Middle click or Alt+Drag to pan
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    var p = getMousePos(svg, e);
    
    if (currentWhiteboardTool === 'eraser') { isDr = true; erase(svg, e); svg.setPointerCapture(e.pointerId); return; }
    if (currentWhiteboardTool === 'select') {
      var target = e.target;
      while (target && target !== svg && !['path', 'rect', 'circle', 'foreignObject'].includes(target.tagName.toLowerCase())) {
        target = target.parentElement;
      }
      if (target && target !== svg) {
        draggedElement = target;
        var ex = parseFloat(target.getAttribute('x') || 0);
        var ey = parseFloat(target.getAttribute('y') || 0);
        if (target.tagName.toLowerCase() === 'path') {
          dragOffset = { x: p.x, y: p.y };
        } else {
          dragOffset = { x: p.x - ex, y: p.y - ey };
        }
        svg.setPointerCapture(e.pointerId);
      }
      return;
    }

    e.preventDefault(); isDr = true; startPos = p; currentDrawingElement = null; 
    var stroke = { 'pen': { tag: 'path', attr: { fill: 'none', 'stroke-width': '6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M ' + p.x + ' ' + p.y } }, 'rectangle': { tag: 'rect', attr: { fill: 'none', 'stroke-width': '4', x: p.x, y: p.y } }, 'circle': { tag: 'circle', attr: { fill: 'none', 'stroke-width': '4', cx: p.x, cy: p.y } } }[currentWhiteboardTool];
    if (stroke) { currentDrawingElement = document.createElementNS("http://www.w3.org/2000/svg", stroke.tag); for (var a in stroke.attr) currentDrawingElement.setAttribute(a, stroke.attr[a]); currentDrawingElement.setAttribute('stroke', currentStrokeColor); svg.appendChild(currentDrawingElement); }
    svg.setPointerCapture(e.pointerId); 
  });

  svg.addEventListener('pointermove', e => {
    if (isPanning) {
      var dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
      canvasPanX += dx / canvasZoom;
      canvasPanY += dy / canvasZoom;
      panStart = { x: e.clientX, y: e.clientY };
      updateCanvasTransform(svg);
      return;
    }
    var p = getMousePos(svg, e);
    if (draggedElement) {
      if (draggedElement.tagName.toLowerCase() === 'path') {
        var dx = p.x - dragOffset.x, dy = p.y - dragOffset.y;
        var d = draggedElement.getAttribute('d');
        draggedElement.setAttribute('d', d.replace(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/g, (m, x, y) => {
          return (parseFloat(x) + dx) + ' ' + (parseFloat(y) + dy);
        }));
        dragOffset = { x: p.x, y: p.y };
      } else {
        draggedElement.setAttribute('x', p.x - dragOffset.x);
        draggedElement.setAttribute('y', p.y - dragOffset.y);
        if (draggedElement.tagName.toLowerCase() === 'circle') {
          draggedElement.setAttribute('cx', p.x - dragOffset.x);
          draggedElement.setAttribute('cy', p.y - dragOffset.y);
        }
      }
      isDirty = true;
      return;
    }
    if (!isDr) return; e.preventDefault(); if (currentWhiteboardTool === 'eraser') { erase(svg, e); return; }
    if (!currentDrawingElement) return;
    if (currentWhiteboardTool === 'pen') currentDrawingElement.setAttribute('d', currentDrawingElement.getAttribute('d') + ' L ' + p.x + ' ' + p.y);
    else if (currentWhiteboardTool === 'rectangle') { var w = p.x - startPos.x, h = p.y - startPos.y; currentDrawingElement.setAttribute('x', w > 0 ? startPos.x : p.x); currentDrawingElement.setAttribute('y', h > 0 ? startPos.y : p.y); currentDrawingElement.setAttribute('width', Math.abs(w)); currentDrawingElement.setAttribute('height', Math.abs(h)); }
    else if (currentWhiteboardTool === 'circle') currentDrawingElement.setAttribute('r', Math.sqrt(Math.pow(p.x - startPos.x, 2) + Math.pow(p.y - startPos.y, 2)));
  });

  svg.addEventListener('pointerup', (e) => { isDr = false; isPanning = false; draggedElement = null; currentDrawingElement = null; svg.releasePointerCapture(e.pointerId); });
  
  svg.addEventListener('wheel', e => {
    if (e.ctrlKey) {
      e.preventDefault();
      var delta = e.deltaY > 0 ? 0.9 : 1.1;
      canvasZoom *= delta;
      updateCanvasTransform(svg);
    }
  }, { passive: false });
}

function erase(svg, e) { var t = document.elementFromPoint(e.clientX, e.clientY); while (t && t !== svg && t !== document.body) { if (['path', 'rect', 'circle'].includes(t.tagName.toLowerCase())) { t.remove(); return; } t = t.parentElement; } }

function cropSvg(s) {
  var p = new DOMParser(), d = p.parseFromString(s, "image/svg+xml"), svg = d.documentElement, box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  var els = svg.querySelectorAll('path, rect, circle'); if (els.length === 0) return s; els.forEach(el => { if (el.tagName.toLowerCase() === 'path') { el.getAttribute('d').split(/(?=[LMCHVZ])/).forEach(c => { var pts = c.slice(1).trim().split(/[\s,]+/); var x = parseFloat(pts[pts.length - 2]), y = parseFloat(pts[pts.length - 1]); if (!isNaN(x) && !isNaN(y)) { box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y); box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(box.maxY, y); } }); } else if (el.tagName.toLowerCase() === 'rect') { var x = parseFloat(el.getAttribute('x')), y = parseFloat(el.getAttribute('y')), w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height')); box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y); box.maxX = Math.max(box.maxX, x + w); box.maxY = Math.max(box.maxY, y + h); } else if (el.tagName.toLowerCase() === 'circle') { var cx = parseFloat(el.getAttribute('cx')), cy = parseFloat(el.getAttribute('cy')), r = parseFloat(el.getAttribute('r')); box.minX = Math.min(box.minX, cx - r); box.minY = Math.min(box.minY, cy - r); box.maxX = Math.max(box.maxX, cx + r); box.maxY = Math.max(box.maxY, cy + r); } });
  var pad = 10, x = box.minX - pad, y = box.minY - pad, w = box.maxX - box.minX + pad * 2, h = box.maxY - box.minY + pad * 2;
  svg.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h); return new XMLSerializer().serializeToString(svg);
}

// --- GITHUB API & APP LOGIC ---

function searchGithub(q) { if (!getToken()) return; showStatus('Searching GitHub...', true); var loc = fullNotesTree.filter(e => e.path.toLowerCase().includes(q.toLowerCase())); if (searchCache[q]) { combineAndRenderResults(loc, searchCache[q], q); return; } fetch('https://api.github.com/search/code?q=' + encodeURIComponent(q) + '+in:file+repo:' + repoOwner + '/' + repoName + '+path:' + NOTES_DIR + '&per_page=100', { headers: authHeaders() }).then(res => res.json()).then(data => { var rr = (data.items || []).map(i => ({ path: i.path, type: 'blob', sha: i.sha })); searchCache[q] = rr; combineAndRenderResults(loc, rr, q); }); }
function combineAndRenderResults(l, r, q) { var s = new Set(), c = []; l.concat(r).forEach(i => { if (!s.has(i.path)) { c.push(i); s.add(i.path); } }); showStatus('Found ' + c.length + ' results.', true); renderNotesList(c, true); }

// --- QUICK SWITCHER ---
function toggleQuickSwitcher(show) {
  var modal = document.getElementById('quickSwitcherModal'), input = document.getElementById('quickSwitcherInput');
  if (show === undefined) show = modal.classList.contains('hidden');
  if (show) {
    modal.classList.remove('hidden');
    input.value = '';
    input.focus();
    renderQuickSwitcherResults('');
  } else {
    modal.classList.add('hidden');
  }
}

function renderQuickSwitcherResults(q) {
  var list = document.getElementById('quickSwitcherResults'), results = [];
  if (!q) {
    results = fullNotesTree.filter(e => e.type === 'blob').slice(0, 10);
  } else {
    results = fullNotesTree.filter(e => e.type === 'blob' && e.path.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  }
  list.innerHTML = results.map((r, i) => `<li data-path="${r.path}" class="${i === 0 ? 'selected' : ''}">${r.path.replace(NOTES_DIR + '/', '')}</li>`).join('');
  list.querySelectorAll('li').forEach(li => li.onclick = function() { openNote(this.getAttribute('data-path')); toggleQuickSwitcher(false); });
}

function searchQuickSwitcher(e) {
  var list = document.getElementById('quickSwitcherResults'), items = list.querySelectorAll('li'), selected = list.querySelector('.selected'), idx = Array.from(items).indexOf(selected);
  if (e.key === 'ArrowDown') {
    e.preventDefault(); if (selected) selected.classList.remove('selected');
    var next = items[(idx + 1) % items.length]; if (next) next.classList.add('selected');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); if (selected) selected.classList.remove('selected');
    var prev = items[(idx - 1 + items.length) % items.length]; if (prev) prev.classList.add('selected');
  } else if (e.key === 'Enter') {
    e.preventDefault(); if (selected) { openNote(selected.getAttribute('data-path')); toggleQuickSwitcher(false); }
  } else if (e.key === 'Escape') {
    toggleQuickSwitcher(false);
  } else {
    renderQuickSwitcherResults(e.target.value);
  }
}

// --- AUTO-COMPLETE ---
function handleAutoComplete(e) {
  var textarea = e.target, val = textarea.value, pos = textarea.selectionStart;
  var before = val.substring(0, pos), lastBracket = before.lastIndexOf('[[');
  if (lastBracket !== -1 && !before.substring(lastBracket).includes(']]')) {
    var q = before.substring(lastBracket + 2);
    renderAutoCompleteResults(q, lastBracket);
  } else {
    document.getElementById('autoCompleteDropdown').classList.add('hidden');
  }
}

function renderAutoCompleteResults(q, startIdx) {
  var dropdown = document.getElementById('autoCompleteDropdown'), list = document.getElementById('autoCompleteList');
  var results = fullNotesTree.filter(e => e.type === 'blob' && e.path.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
  if (results.length === 0) { dropdown.classList.add('hidden'); return; }
  dropdown.classList.remove('hidden');
  list.innerHTML = results.map((r, i) => `<li data-path="${r.path}" class="${i === 0 ? 'selected' : ''}">${r.path.replace(NOTES_DIR + '/', '').replace('.md','')}</li>`).join('');
  list.querySelectorAll('li').forEach(li => li.onclick = function() {
    var textarea = document.getElementById('noteText'), val = textarea.value, pos = textarea.selectionStart;
    var name = this.innerText;
    var before = val.substring(0, startIdx) + '[[' + name + ']]';
    var after = val.substring(pos);
    textarea.value = before + after;
    textarea.selectionStart = textarea.selectionEnd = before.length;
    textarea.focus();
    dropdown.classList.add('hidden');
    isDirty = true; triggerAutosave(); if (previewOn) togglePreview(true);
  });
}

function toggleWhiteboard(on) { isWhiteboardActive = on; var ids = ['previewArea', 'whiteboardArea', 'insertDropdown', 'editorToolbar', 'noteText', 'whiteboardToolbar']; ids.forEach(id => { var el = document.getElementById(id); if (el) { if (on) (id === 'whiteboardArea' || id === 'whiteboardToolbar' ? el.classList.remove('hidden') : el.classList.add('hidden')); else (id === 'whiteboardArea' || id === 'whiteboardToolbar' ? el.classList.add('hidden') : el.classList.remove('hidden')); } }); if (!on) togglePreview(previewOn); }

function resetCanvasView() {
  canvasPanX = 0; canvasPanY = 0; canvasZoom = 1;
  if (mainWhiteboardSvg) mainWhiteboardSvg.setAttribute('viewBox', '0 0 1000 1000');
}

function newWhiteboard() { 
  var f = 'board-' + Date.now() + '.svg'; 
  document.getElementById('pathInput').value = currentFolder ? currentFolder + '/' + f : f; 
  openFilePath = null; 
  openFileSha = null; 
  toggleWhiteboard(true); 
  mainWhiteboardSvg.innerHTML = ''; 
  resetCanvasView();
  isDirty = false; 
}
function refreshNotesList() { if (!getToken()) return; fetchDefaultBranch().then(() => fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() })).then(res => res.json()).then(data => { fullNotesTree = (data.tree || []).filter(e => e.path.startsWith(NOTES_DIR + '/')); renderNotesList(fullNotesTree); }); }
function renderNotesList(tree, isSearch = false) { var pre = NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/', html = ''; if (!isSearch && currentFolder) html += '<li class="folder" data-path="" data-type="dir">..</li>'; tree.forEach(e => { if (isSearch || (e.path.startsWith(pre) && !e.path.slice(pre.length).includes('/'))) { var n = e.path.slice(isSearch ? NOTES_DIR.length + 1 : pre.length); html += '<li class="' + (e.type === 'tree' ? 'folder' : 'file') + '" data-path="' + e.path.slice(NOTES_DIR.length + 1) + '" data-type="' + e.type + '">' + n + '</li>'; } }); document.getElementById('notesList').innerHTML = html || '<li>No notes</li>'; document.querySelectorAll('#notesList li').forEach(li => li.onclick = function() { var p = this.getAttribute('data-path'), t = this.getAttribute('data-type'); if (t === 'tree' || t === 'dir') { currentFolder = p === '' ? currentFolder.split('/').slice(0,-1).join('/') : p; renderNotesList(fullNotesTree); } else openNote(NOTES_DIR + '/' + p); }); }
function openNote(p) { 
  openFilePath = p; 
  var pi = document.getElementById('pathInput'); 
  if (pi) pi.value = p.replace(NOTES_DIR + '/', ''); 
  fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { 
    var txt = decodeBase64Utf8(d.content); 
    openFileSha = d.sha; 
    if (p.endsWith('.svg')) { 
      toggleWhiteboard(true); 
      var t = document.createElement('div'); 
      t.innerHTML = txt; 
      var loadedSvg = t.querySelector('svg');
      if (loadedSvg) {
        mainWhiteboardSvg.innerHTML = loadedSvg.innerHTML;
        var vb = loadedSvg.getAttribute('viewBox');
        if (vb) {
          mainWhiteboardSvg.setAttribute('viewBox', vb);
          var parts = vb.split(' ').map(parseFloat);
          canvasPanX = -parts[0]; canvasPanY = -parts[1];
          canvasZoom = 1000 / parts[2];
        } else {
          resetCanvasView();
        }
      }
    } else { 
      document.getElementById('noteText').value = txt; 
      toggleWhiteboard(false); 
      togglePreview(false); 
    } 
    isDirty = false; 
    updateBacklinks(p);
    updateRecentNotes(p);
    updateOutline();
    updateProperties();
  }).catch(()=>{}); 
}

function updateBacklinks(p) {
  var name = p.replace(NOTES_DIR + '/', '').replace('.md', '').replace('.txt', '');
  var idx = getVaultIndex(), backlinks = [], list = document.getElementById('backlinksList'), pane = document.getElementById('backlinksPane');
  for (var path in idx) { if (path !== p && (idx[path].links || []).includes(name)) backlinks.push(path); }
  if (backlinks.length === 0) { pane.classList.add('hidden'); return; }
  pane.classList.remove('hidden');
  list.innerHTML = backlinks.map(path => `<li onclick="openNote('${path}')">${path.replace(NOTES_DIR + '/', '')}</li>`).join('');
}

function updateTagsSidebar() {
  var idx = getVaultIndex(), allTags = new Set();
  for (var path in idx) { (idx[path].tags || []).forEach(t => allTags.add(t)); }
  var list = document.getElementById('tagsList');
  list.innerHTML = Array.from(allTags).map(t => `<span class="tag" onclick="searchByTag('${t}')">${t}</span>`).join(' ');
}

function updateOutline() {
  var content = document.getElementById('noteText').value;
  var list = document.getElementById('outlineList');
  var headers = [...content.matchAll(/^(#{1,6})\s+(.*)$/gm)];
  if (headers.length === 0) {
    list.innerHTML = '<li style="color:#888; font-size:0.8em; padding:10px;">No headings found</li>';
    return;
  }
  list.innerHTML = headers.map((h, i) => {
    var level = h[1].length;
    var text = h[2].trim();
    return `<li class="outline-item outline-h${level}" onclick="jumpToHeader(${i})">${text}</li>`;
  }).join('');
}

function updateProperties() {
  var content = document.getElementById('noteText').value;
  var pane = document.getElementById('propertiesPane');
  var list = document.getElementById('propertiesList');
  var match = content.match(/^---\n([\s\S]*?)\n---/);
  
  if (!match) {
    pane.classList.add('hidden');
    return;
  }
  
  pane.classList.remove('hidden');
  var yaml = match[1];
  var lines = yaml.split('\n');
  var html = '';
  lines.forEach(line => {
    var parts = line.split(':');
    if (parts.length >= 2) {
      var key = parts[0].trim();
      var value = parts.slice(1).join(':').trim();
      html += `<div class="property-item"><div class="property-key">${key}</div><div class="property-value">${value}</div></div>`;
    }
  });
  list.innerHTML = html || '<div style="color:#888">Empty properties</div>';
}

window.jumpToHeader = function(index) {
  var content = document.getElementById('noteText').value;
  var headers = [...content.matchAll(/^(#{1,6})\s+(.*)$/gm)];
  if (headers[index]) {
    var pos = headers[index].index;
    var textarea = document.getElementById('noteText');
    textarea.focus();
    textarea.setSelectionRange(pos, pos + headers[index][0].length);
    // Scroll textarea to the position
    var lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight);
    var linesBefore = content.substring(0, pos).split('\n').length;
    textarea.scrollTop = (linesBefore - 1) * lineHeight;
    
    // If preview is on, try to scroll it too
    if (previewOn) {
      var preview = document.getElementById('previewArea');
      var escapedText = headers[index][2].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var elements = [...preview.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      var target = elements.find(el => el.innerText.trim() === headers[index][2].trim());
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
};

function switchSidebarTab(tab) {
  var notesBtn = document.getElementById('notesTabBtn');
  var outlineBtn = document.getElementById('outlineTabBtn');
  var notesContent = document.getElementById('sidebarNotesContent');
  var outlineContent = document.getElementById('sidebarOutlineContent');
  
  if (tab === 'notes') {
    notesBtn.classList.add('active');
    outlineBtn.classList.remove('active');
    notesContent.classList.remove('hidden');
    outlineContent.classList.add('hidden');
  } else {
    notesBtn.classList.remove('active');
    outlineBtn.classList.add('active');
    notesContent.classList.add('hidden');
    outlineContent.classList.remove('hidden');
    updateOutline();
  }
}

// --- GRAPH VIEW ---
var nodes = [], links = [], graphAnimId = null;
function openGraphView() {
  var modal = document.getElementById('graphModal');
  modal.classList.remove('hidden');
  var canvas = document.getElementById('graphCanvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 50;
  
  // Build data from vault index
  var idx = getVaultIndex();
  nodes = []; links = [];
  var nodeMap = {};
  
  // Add all files as nodes (ONLY Markdown files)
  fullNotesTree.forEach(f => {
    if (f.type === 'blob' && f.path.endsWith('.md')) {
      var name = f.path.replace(NOTES_DIR + '/', '').replace('.md', '');
      var node = { id: f.path, name: name, x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: 0, vy: 0 };
      nodes.push(node);
      nodeMap[name] = node;
    }
  });
  
  // Add links from vault index
  for (var path in idx) {
    var sourceNode = nodes.find(n => n.id === path);
    if (sourceNode) {
      (idx[path].links || []).forEach(linkName => {
        var targetNode = nodeMap[linkName];
        if (targetNode) links.push({ source: sourceNode, target: targetNode });
      });
    }
  }
  
  startGraphSimulation();
}

function startGraphSimulation() {
  var canvas = document.getElementById('graphCanvas'), ctx = canvas.getContext('2d');
  var draggedNode = null, startDragPos = { x: 0, y: 0 }, hasMoved = false;
  
  canvas.onmousedown = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    draggedNode = nodes.find(n => Math.sqrt(Math.pow(n.x - mx, 2) + Math.pow(n.y - my, 2)) < 20);
    if (draggedNode) {
      canvas.style.cursor = 'grabbing';
      startDragPos = { x: mx, y: my };
      hasMoved = false;
    }
  };

  canvas.onmousemove = function(e) {
    if (!draggedNode) return;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    
    // Check if we've moved enough to call it a drag
    if (Math.abs(mx - startDragPos.x) > 5 || Math.abs(my - startDragPos.y) > 5) {
      hasMoved = true;
    }
    
    draggedNode.x = mx;
    draggedNode.y = my;
    draggedNode.vx = 0; draggedNode.vy = 0;
  };

  canvas.onmouseup = function(e) {
    if (draggedNode && !hasMoved) {
      // It was a click, not a drag
      openNote(draggedNode.id);
      closeGraphView();
    }
    draggedNode = null;
    canvas.style.cursor = 'grab';
  };

  function step() {
    // Advanced physics
    nodes.forEach(n1 => {
      // Attraction to center (gravity)
      n1.vx += (canvas.width/2 - n1.x) * 0.0003;
      n1.vy += (canvas.height/2 - n1.y) * 0.0003;
      
      nodes.forEach(n2 => {
        if (n1 === n2) return;
        var dx = n2.x - n1.x, dy = n2.y - n1.y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
        
        // Inverse-Square Repulsion (Force = Charge / Dist^2)
        // This ensures nodes really push away when they get too close
        if (dist < 250) {
          var force = 100 / (dist * dist);
          n1.vx -= dx * force;
          n1.vy -= dy * force;
        }
      });
    });
    
    links.forEach(l => {
      var dx = l.target.x - l.source.x, dy = l.target.y - l.source.y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
      // Spring attraction (hooke's law simplified)
      // Ideal distance around 100px
      var strength = 0.005;
      l.source.vx += dx * strength;
      l.source.vy += dy * strength;
      l.target.vx -= dx * strength;
      l.target.vy -= dy * strength;
    });
    
    nodes.forEach(n => {
      if (n === draggedNode) return;
      n.x += n.vx; n.y += n.vy;
      n.vx *= 0.8; n.vy *= 0.8; // Higher friction for stability
      
      // Boundary collision
      if (n.x < 50) n.vx += 1; if (n.x > canvas.width - 50) n.vx -= 1;
      if (n.y < 50) n.vy += 1; if (n.y > canvas.height - 50) n.vy -= 1;
    });
    
    // Draw
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Links
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1;
    links.forEach(l => {
      ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
    });
    
    // Nodes & Labels
    nodes.forEach(n => {
      var isCurrent = n.id === openFilePath;
      ctx.fillStyle = isCurrent ? '#007bff' : '#999';
      ctx.beginPath(); ctx.arc(n.x, n.y, isCurrent ? 6 : 4, 0, Math.PI*2); ctx.fill();
      
      // Label
      ctx.fillStyle = isCurrent ? '#000' : '#555';
      ctx.font = (isCurrent ? 'bold ' : '') + '11px sans-serif';
      // Text halo for readability
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(n.name, n.x + 10, n.y + 4);
      ctx.fillText(n.name, n.x + 10, n.y + 4);
    });
    
    graphAnimId = requestAnimationFrame(step);
  }
  step();
}

function closeGraphView() {
  document.getElementById('graphModal').classList.add('hidden');
  cancelAnimationFrame(graphAnimId);
}

function searchByTag(tag) {
  var input = document.getElementById('searchInput');
  if (input) { input.value = tag; input.dispatchEvent(new Event('input')); }
}

function reindexVault() {
  showStatus('Re-indexing vault (this may take a moment)...', true);
  var mdFiles = fullNotesTree.filter(e => e.type === 'blob' && (e.path.endsWith('.md') || e.path.endsWith('.txt')));
  var count = 0;
  Promise.all(mdFiles.map(file => 
    fetch(apiUrl('contents/' + file.path), { headers: authHeaders() })
      .then(res => res.json()).then(d => {
        var txt = decodeBase64Utf8(d.content);
        indexNote(file.path, txt);
        count++;
      }).catch(()=>{})
  )).then(() => {
    showStatus('Indexed ' + count + ' notes.', true);
    updateTagsSidebar();
  });
}

function placeDrawingAsSticky() {
  // Existing function
}

function showNoteSelectionForWhiteboard() {
  var m = document.getElementById('whiteboardModal'), l = document.getElementById('whiteboardList'), h = m.querySelector('h3');
  h.textContent = 'Select a Note to Add';
  m.classList.remove('hidden');
  l.innerHTML = '<li>Loading...</li>';
  var notes = fullNotesTree.filter(e => e.type === 'blob' && (e.path.endsWith('.md') || e.path.endsWith('.txt')));
  l.innerHTML = notes.map(f => `<li data-path="${f.path}">${f.path.replace(NOTES_DIR+'/', '')}</li>`).join('');
  l.querySelectorAll('li').forEach(li => li.onclick = function() {
    var p = this.getAttribute('data-path');
    addNoteCardToWhiteboard(p);
    document.getElementById('whiteboardModal').classList.add('hidden');
  });
}

function addNoteCardToWhiteboard(path) {
  fetch(apiUrl('contents/' + path), { headers: authHeaders() }).then(res => res.json()).then(d => {
    var txt = decodeBase64Utf8(d.content);
    var name = path.replace(NOTES_DIR + '/', '');
    var fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute('x', '100'); fo.setAttribute('y', '100');
    fo.setAttribute('width', '200'); fo.setAttribute('height', '150');
    fo.setAttribute('class', 'note-card');
    
    var div = document.createElement('div');
    div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    div.style.cssText = 'background:#fff; border:1px solid #ccc; padding:10px; font-family:sans-serif; font-size:10px; height:100%; overflow:hidden; box-shadow:2px 2px 5px rgba(0,0,0,0.1);';
    div.innerHTML = `<strong>${name}</strong><hr/><div style="white-space:pre-wrap;">${txt.substring(0, 200)}...</div>`;
    
    fo.appendChild(div);
    mainWhiteboardSvg.appendChild(fo);
    isDirty = true;
  });
}

function saveNote(isA = false) { 
  if (isSaving) return;
  var pi = document.getElementById('pathInput'), pr = pi.value.trim() || defaultFilename(); 
  if (!isWhiteboardActive && !pr.includes('.')) pr += '.md'; 
  var fp = NOTES_DIR + '/' + pr;
  var vb = mainWhiteboardSvg.getAttribute('viewBox') || '0 0 1000 1000';
  var c = isWhiteboardActive ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${mainWhiteboardSvg.innerHTML}</svg>` : document.getElementById('noteText').value; 
  var body = { message: (isA ? 'Autosave: ' : 'Save: ') + pr, content: base64Utf8(c), sha: openFileSha }; 
  
  isSaving = true;
  if (isA) showStatus('Autosaving...', true);
  else showStatus('Saving...', true);

  fetch(apiUrl('contents/' + fp), { 
    method: 'PUT', 
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), 
    body: JSON.stringify(body) 
  })
  .then(res => {
    if (res.status === 409) throw new Error('Save conflict. Please refresh or try again.');
    return res.json();
  })
  .then(d => { 
    isSaving = false;
    if (d.content) { 
      openFileSha = d.content.sha; 
      openFilePath = fp; 
      isDirty = false;
      indexNote(fp, c); 
      if (!isA) { showStatus('Saved.', true); refreshNotesList(); } 
      else { showStatus('Autosaved.', true); }
    } else if (d.message) {
      showStatus('Error: ' + d.message, false);
    }
  })
  .catch(err => {
    isSaving = false;
    showStatus(err.message, false);
  }); 
}
function deleteNote() { if (!confirm('Delete?')) return; fetch(apiUrl('contents/' + openFilePath), { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Delete', sha: openFileSha }) }).then(() => { newNote(); refreshNotesList(); }); }
function downloadNote() { var c = isWhiteboardActive ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + mainWhiteboardSvg.innerHTML + '</svg>' : document.getElementById('noteText').value; var b = new Blob([c], { type: 'text/plain' }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = document.getElementById('pathInput').value || 'note.md'; a.click(); URL.revokeObjectURL(u); }
function newFolder() { var n = prompt('Folder:'); if (!n) return; fetch(apiUrl('contents/' + NOTES_DIR + '/' + n + '/.gitkeep'), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'New folder', content: btoa('') }) }).then(() => refreshNotesList()); }
function newNote() { var pi = document.getElementById('pathInput'); if (pi) pi.value = currentFolder ? currentFolder + '/' + defaultFilename() : defaultFilename(); var nt = document.getElementById('noteText'); if (nt) nt.value = ''; openFilePath = null; openFileSha = null; toggleWhiteboard(false); togglePreview(false); isDirty = false; }

function openDailyNote() {
  var now = new Date();
  var fileName = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '.md';
  var path = NOTES_DIR + '/' + fileName;
  
  // Check if it already exists in our tree
  var existing = fullNotesTree.find(e => e.path === path);
  if (existing) {
    openNote(path);
  } else {
    // Doesn't exist, create it locally first and set up for save
    document.getElementById('pathInput').value = fileName;
    document.getElementById('noteText').value = '---\ntags: \n---\n# Daily Note: ' + now.toLocaleDateString() + '\n\n';
    openFilePath = null;
    openFileSha = null;
    isDirty = true;
    toggleWhiteboard(false);
    togglePreview(false);
    saveNote(); // Save immediately to create the file
  }
}

// --- TOOLBAR & TEMPLATES ---

function addMermaidTemplate(t) { var tp = { flow: '\n```mermaid\ngraph TD\n    A[Start] --> B{Is it?};\n    B -- Yes --> C[OK];\n    C --> D[End];\n    B -- No --> E[Find out];\n    E --> B;\n```\n', seq: '\n```mermaid\nsequenceDiagram\n    Alice->>John: Hello John, how are you?\n    John-->>Alice: Great!\n```\n', gantt: '\n```mermaid\ngantt\n    title Gantt\n    section S1\n    T1 :a1, 2023-01-01, 30d\n```\n', class: '\n```mermaid\nclassDiagram\n    Animal <|-- Duck\n```\n' }[t] || '\n```mermaid\ngraph TD\n    A --> B;\n```\n'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + tp + tx.value.slice(tx.selectionEnd); showStatus('Mermaid added.', true); }
function addSticky() { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note" data-x="100" data-y="100" style="left: 100px; top: 100px;" contenteditable="false"><div class="sticky-content" contenteditable="true">New sticky...</div></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }
function addDrawSticky() { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + EMPTY_SVG + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }
function addImageSticky() { uploadImage(u => { var tx = document.getElementById('noteText'), h = '\n\n<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="sticky-content"><img src="' + u + '" alt="Image" style="pointer-events:none; width:100%; display:block;"></div></div>\n\n'; tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }); }
function addImageLink() { uploadImage(u => { var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '![](' + u + ')' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); }); }
function addImageFromUrl() { var u = prompt("URL:"); if (u) { var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '![](' + u + ')' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); } }
function uploadImage(cb) { var fi = document.getElementById('imageFileInput'); var cl = () => { var f = fi.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = () => { var b6 = rd.result.replace(/^data:image\/\w+;base64,/, ''); var name = Date.now() + '-' + f.name, p = NOTES_DIR + '/images/' + name; fetch(apiUrl('contents/' + p), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Add image', content: b6 }) }).then(res => res.json()).then(data => { cb(data.content.path.replace(NOTES_DIR + '/', '')); refreshNotesList(); }); }; rd.readAsDataURL(f); }; fi.addEventListener('change', cl, { once: true }); fi.click(); }
function showImageLibrary() { var m = document.getElementById('imageLibraryModal'), l = document.getElementById('imageLibraryList'); m.classList.remove('hidden'); l.innerHTML = '<li>Loading...</li>'; fetch(apiUrl('contents/' + NOTES_DIR + '/images'), { headers: authHeaders() }).then(res => res.json()).then(data => { l.innerHTML = ''; if (!data || data.message) return; data.forEach(file => { var img = document.createElement('img'); img.src = file.download_url; img.onclick = () => { l.querySelectorAll('img').forEach(i => i.classList.remove('selected')); img.classList.add('selected'); selectedImageUrl = file.path.replace(NOTES_DIR + '/', ''); document.getElementById('imageLibraryActions').classList.remove('hidden'); }; l.appendChild(img); }); }).catch(()=>{}); }
function showWhiteboardModal(asS) { isPlacingAsSticky = !!asS; var m = document.getElementById('whiteboardModal'), l = document.getElementById('whiteboardList'); m.classList.remove('hidden'); l.innerHTML = '<li>Loading...</li>'; fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() }).then(res => res.json()).then(data => { var fs = (data.tree||[]).filter(e => e.path.endsWith('.svg')); l.innerHTML = fs.map(f => '<li data-path="' + f.path + '">' + f.path.replace(NOTES_DIR+'/', '') + '</li>').join(''); l.querySelectorAll('li').forEach(li => li.onclick = function() { var p = this.getAttribute('data-path'); if (isPlacingAsSticky) placeWhiteboardAsSticky(p); else placeWhiteboard(p); }); }); }
function placeWhiteboardAsSticky(p) { fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { var svg = decodeBase64Utf8(d.content); var h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + svg + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; document.getElementById('noteText').value += h; if (previewOn) togglePreview(true); document.getElementById('whiteboardModal').classList.add('hidden'); }); }
function placeWhiteboard(p) { fetch(apiUrl('contents/' + p), { headers: authHeaders() }).then(res => res.json()).then(d => { var svg = decodeBase64Utf8(d.content); var u = 'data:image/svg+xml;base64,' + btoa(svg); document.getElementById('noteText').value += '![](' + u + ')'; document.getElementById('whiteboardModal').classList.add('hidden'); }); }
function placeCurrentDrawingAsSticky() { if (!isWhiteboardActive) { showStatus("No drawing.", false); return; } var inner = mainWhiteboardSvg.innerHTML; if (!inner.trim()) { showStatus("Empty.", false); return; } var full = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + inner + '</svg>'; var cr = cropSvg(full); var h = '\n\n<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + cr + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>\n\n'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + h + tx.value.slice(tx.selectionEnd); toggleWhiteboard(false); togglePreview(true); showStatus('Drawing pinned.', true); }

window.openDrawScreen = function(stickyEl) {
  document.getElementById('top').classList.add('hidden');
  document.getElementById('mainLayout').classList.add('hidden');
  document.getElementById('drawScreen').classList.remove('hidden');
  var preview = stickyEl.querySelector('.draw-preview');
  var svgContent = preview && preview.innerHTML.trim() !== '' ? preview.innerHTML : EMPTY_SVG;
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = svgContent;
  var loadedSvg = tempDiv.querySelector('svg');
  modalSvgBoard.innerHTML = loadedSvg ? loadedSvg.innerHTML : '';
  
  // Load viewBox or reset
  var vb = loadedSvg ? loadedSvg.getAttribute('viewBox') : null;
  if (vb) {
    modalSvgBoard.setAttribute('viewBox', vb);
    var parts = vb.split(' ').map(parseFloat);
    canvasPanX = -parts[0]; canvasPanY = -parts[1];
    canvasZoom = 1000 / parts[2];
  } else {
    canvasPanX = 0; canvasPanY = 0; canvasZoom = 1;
    modalSvgBoard.setAttribute('viewBox', '0 0 1000 1000');
  }

  // Use data-original-html as the reliable search key for the Markdown replace
  activeStickyHtml = stickyEl.getAttribute('data-original-html') || stickyEl.outerHTML;
  var modalStroke = document.getElementById('modalStrokeColorInput');
  if (modalStroke) modalStroke.value = currentStrokeColor;
  updateToolSelection();
};

function closeDrawScreen() {
  document.getElementById('drawScreen').classList.add('hidden');
  document.getElementById('top').classList.remove('hidden');
  document.getElementById('mainLayout').classList.remove('hidden');
  activeStickyHtml = null;
  // Reset pan/zoom for main whiteboard just in case
  resetCanvasView();
}

function updateToolSelection() {
  var activeIdMap = { 'select': 'selectToolBtn', 'pen': 'penToolBtn', 'rectangle': 'rectToolBtn', 'circle': 'circleToolBtn', 'eraser': 'eraserToolBtn' };
  var activeId = activeIdMap[currentWhiteboardTool];
  var modalIdMap = { 'select': 'modalSelectToolBtn', 'pen': 'modalPenToolBtn', 'rectangle': 'modalRectToolBtn', 'circle': 'modalCircleToolBtn', 'eraser': 'modalEraserToolBtn' };
  var activeModalId = modalIdMap[currentWhiteboardTool];
  ['selectToolBtn', 'penToolBtn', 'rectToolBtn', 'circleToolBtn', 'eraserToolBtn', 'modalSelectToolBtn', 'modalPenToolBtn', 'modalRectToolBtn', 'modalCircleToolBtn', 'modalEraserToolBtn'].forEach(id => {
    var el = document.getElementById(id); if (el) { (id === activeId || id === activeModalId) ? el.classList.add('selected-tool') : el.classList.remove('selected-tool'); }
  });
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', function() {
  var noteTextarea = document.getElementById('noteText'), whiteboardSvg = document.getElementById('mainWhiteboardSvg'), previewArea = document.getElementById('previewArea');
  if (noteTextarea) {
    noteTextarea.addEventListener('input', (e) => { 
      isDirty = true; triggerAutosave(); 
      if (previewOn) debouncedTogglePreview(true);
      handleAutoComplete(e);
      updateTagsSidebar();
      updateOutline();
      updateProperties();
    });
    noteTextarea.addEventListener('keydown', (e) => {
      var dropdown = document.getElementById('autoCompleteDropdown');
      if (!dropdown.classList.contains('hidden')) {
        var list = document.getElementById('autoCompleteList'), selected = list.querySelector('.selected'), items = list.querySelectorAll('li'), idx = Array.from(items).indexOf(selected);
        if (e.key === 'ArrowDown') { e.preventDefault(); if (selected) selected.classList.remove('selected'); (items[(idx + 1) % items.length]).classList.add('selected'); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (selected) selected.classList.remove('selected'); (items[(idx - 1 + items.length) % items.length]).classList.add('selected'); }
        else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (selected) selected.click(); }
        else if (e.key === 'Escape') { dropdown.classList.add('hidden'); }
      }
    });
  }
  if (previewArea) previewArea.addEventListener('input', () => { if (fullPreview) syncPreviewToText(); });
  if (whiteboardSvg) { var obs = new MutationObserver(() => { isDirty = true; triggerAutosave(); }); obs.observe(whiteboardSvg, { childList: true, subtree: true, attributes: true }); }
  mainWhiteboardSvg = document.getElementById('mainWhiteboardSvg'); modalSvgBoard = document.getElementById('nativeSvgBoard');
  setupSvgDrawing(mainWhiteboardSvg); setupSvgDrawing(modalSvgBoard);
  var sIn = document.getElementById('searchInput'); 
  if (sIn) sIn.addEventListener('input', function () { 
    var q = this.value.trim().toLowerCase(); 
    if (q === '') { 
      renderNotesList(fullNotesTree); showStatus('', true); 
    } else { 
      var fileMatches = fullNotesTree.filter(e => e.path.toLowerCase().includes(q));
      var idx = getVaultIndex(), indexedMatches = [];
      for (var path in idx) {
        if ((idx[path].tags || []).some(t => t.toLowerCase().includes(q)) || 
            (idx[path].links || []).some(l => l.toLowerCase().includes(q))) {
          var entry = fullNotesTree.find(e => e.path === path);
          if (entry && !fileMatches.includes(entry)) indexedMatches.push(entry);
        }
      }
      var combined = fileMatches.concat(indexedMatches);
      renderNotesList(combined, true); 
      showStatus('Searching local index...', true); 
      if (q.length > 2 && !q.startsWith('#') && !q.startsWith('[[')) debouncedSearch(q); 
    } 
  });
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
  var dNoteBtn = document.getElementById('dailyNoteBtn'); if (dNoteBtn) dNoteBtn.addEventListener('click', openDailyNote);
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
  var cWhitS = document.getElementById('cancelWhiteboardSelectionBtn'); if (cWhitS) cWhitS.addEventListener('click', () => document.getElementById('whiteboardModal').classList.add('hidden'));
  var iAsL = document.getElementById('insertImageAsLinkBtn'); if (iAsL) iAsL.addEventListener('click', () => { if (selectedImageUrl) { insertMarkdown('![](', selectedImageUrl + ')'); document.getElementById('imageLibraryModal').classList.add('hidden'); } });
  var iAsS = document.getElementById('insertImageAsStickyBtn'); if (iAsS) iAsS.addEventListener('click', () => { if (selectedImageUrl) { var html = '<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="sticky-content"><img src="' + selectedImageUrl + '" alt="Image" style="pointer-events:none; width:100%; display:block;"></div></div>'; var tx = document.getElementById('noteText'); tx.value = tx.value.slice(0, tx.selectionStart) + '\n' + html + '\n' + tx.value.slice(tx.selectionEnd); if (previewOn) togglePreview(true); document.getElementById('imageLibraryModal').classList.add('hidden'); } });
  var rList = document.getElementById('fileDropdownRefreshNotesBtn'); if (rList) rList.addEventListener('click', () => { refreshNotesList(); showStatus('List refreshed.', true); });
  var pTog = document.getElementById('previewToggle'); if (pTog) pTog.addEventListener('click', () => togglePreview());
  var pWhit = document.getElementById('placeWhiteboardBtn'); if (pWhit) pWhit.addEventListener('click', () => showWhiteboardModal(false));
  var rCBtn = document.getElementById('resetCanvasBtn'); if (rCBtn) rCBtn.addEventListener('click', resetCanvasView);
  var mrCBtn = document.getElementById('modalResetCanvasBtn'); if (mrCBtn) mrCBtn.addEventListener('click', () => {
    canvasPanX = 0; canvasPanY = 0; canvasZoom = 1;
    updateCanvasTransform(modalSvgBoard);
  });
  var aNoteCard = document.getElementById('addNoteCardBtn'); if (aNoteCard) aNoteCard.addEventListener('click', showNoteSelectionForWhiteboard);
  var pDraw = document.getElementById('placeDrawingAsStickyBtn'); if (pDraw) pDraw.addEventListener('click', placeCurrentDrawingAsSticky);
  var rIdxBtn = document.getElementById('reindexBtn'); if (rIdxBtn) rIdxBtn.addEventListener('click', reindexVault);
  
  var nTabBtn = document.getElementById('notesTabBtn'); if (nTabBtn) nTabBtn.addEventListener('click', () => switchSidebarTab('notes'));
  var oTabBtn = document.getElementById('outlineTabBtn'); if (oTabBtn) oTabBtn.addEventListener('click', () => switchSidebarTab('outline'));
  
  var gBtn = document.getElementById('graphViewBtn'); if (gBtn) gBtn.addEventListener('click', openGraphView);
  var cGBtn = document.getElementById('closeGraphBtn'); if (cGBtn) cGBtn.addEventListener('click', closeGraphView);

  var mToggle = document.getElementById('menuToggleBtn'); if (mToggle) mToggle.addEventListener('click', (e) => { document.body.classList.toggle('sidebar-open'); e.stopPropagation(); });
  var cSide = document.getElementById('closeSidebarBtn'); if (cSide) cSide.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  var cont = document.getElementById('content'); if (cont) cont.addEventListener('click', () => { if (document.body.classList.contains('sidebar-open')) document.body.classList.remove('sidebar-open'); });
  ['select', 'pen', 'rectangle', 'circle', 'eraser'].forEach(t => { 
    var id = t + 'ToolBtn', mid = 'modal' + t.charAt(0).toUpperCase() + t.slice(1) + 'ToolBtn';
    var b = document.getElementById(id); if (b) b.addEventListener('click', () => { currentWhiteboardTool = t; updateToolSelection(); showStatus('Tool: ' + t, true); });
    var mb = document.getElementById(mid); if (mb) mb.addEventListener('click', () => { currentWhiteboardTool = t; updateToolSelection(); });
  });
  var sInp = document.getElementById('strokeColorInput'); if (sInp) sInp.addEventListener('input', function() { currentStrokeColor = this.value; var m = document.getElementById('modalStrokeColorInput'); if (m) m.value = this.value; });
  var msInp = document.getElementById('modalStrokeColorInput'); if (msInp) msInp.addEventListener('input', function() { currentStrokeColor = this.value; var s = document.getElementById('strokeColorInput'); if (s) s.value = this.value; });
  
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); toggleQuickSwitcher(); }
    if (e.key === 'Escape') toggleQuickSwitcher(false);
  });
  var qsInp = document.getElementById('quickSwitcherInput'); if (qsInp) qsInp.addEventListener('keyup', searchQuickSwitcher);

  document.querySelectorAll('.dropdown-content a').forEach(link => link.addEventListener('click', closeAllDropdowns));
  
  var clearD = document.getElementById('clearDrawBtn'); if (clearD) clearD.addEventListener('click', () => modalSvgBoard.innerHTML = '');
  var cancelD = document.getElementById('cancelDrawScreenBtn'); if (cancelD) cancelD.addEventListener('click', closeDrawScreen);
  var saveD = document.getElementById('saveDrawScreenBtn');
  if (saveD) saveD.addEventListener('click', function() {
    if (activeStickyHtml && modalSvgBoard) {
      var vb = modalSvgBoard.getAttribute('viewBox') || '0 0 1000 1000';
      var finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" height="100%">` + modalSvgBoard.innerHTML + '</svg>';
      var cropped = cropSvg(finalSvg);
      var temp = document.createElement('div'); temp.innerHTML = activeStickyHtml;
      var stick = temp.firstElementChild;
      var dp = stick ? stick.querySelector('.draw-preview') : null;
      if (dp) dp.innerHTML = cropped;
      
      var newH = cleanHtmlForMarkdown(stick);
      var tx = document.getElementById('noteText');
      if (tx && newH && tx.value.includes(activeStickyHtml)) { 
        tx.value = tx.value.replace(activeStickyHtml, newH); 
        isDirty = true;
        triggerAutosave();
      }
      closeDrawScreen(); togglePreview(true);
    }
  });

  updateRecentNotesUI();
  updateTagsSidebar();
  updateToolSelection(); refreshNotesList();
});
