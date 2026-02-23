var TOKEN_KEY = 'github_token';
var REPO_OWNER_KEY = 'repo_owner';
var REPO_NAME_KEY = 'repo_name';
var NOTES_DIR = 'notes';

var EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="100%" height="100%"></svg>';

var repoOwner = localStorage.getItem(REPO_OWNER_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_OWNER ? CONFIG.REPO_OWNER : 'YOUR_GITHUB_USERNAME');
var repoName = localStorage.getItem(REPO_NAME_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_NAME ? CONFIG.REPO_NAME : 'SeagullNotes');
var defaultBranch = 'main';
var currentTree = [];
var currentFolder = '';
var openFilePath = null;
var openFileSha = null;
var previewOn = false;
var isWhiteboardActive = false;

var activeStickyHtml = null;

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(value) {
  if (value && value.trim()) {
    localStorage.setItem(TOKEN_KEY, value.trim());
    document.getElementById('tokenInput').value = '';
    showStatus('Token saved.', true);
  }
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  document.getElementById('tokenInput').value = '';
  document.getElementById('noteText').value = '';
  document.getElementById('pathInput').value = '';
  openFilePath = null;
  openFileSha = null;
  showStatus('Logged out.', true);
  refreshNotesList();
}

function getRepo() { return { owner: repoOwner, name: repoName }; }
function setRepo(owner, name) {
  repoOwner = (owner || '').trim();
  repoName = (name || '').trim();
  if (repoOwner) localStorage.setItem(REPO_OWNER_KEY, repoOwner);
  if (repoName) localStorage.setItem(REPO_NAME_KEY, repoName);
  updateRepoDisplay();
  refreshNotesList();
  openFilePath = null;
  openFileSha = null;
}
function updateRepoDisplay() {
  var el = document.getElementById('repoDisplay');
  el.textContent = 'Saving to: ' + repoOwner + '/' + repoName +
    (repoOwner === 'YOUR_GITHUB_USERNAME' ? ' — set above and click Use repo' : '');
}

function base64Utf8(text) { return btoa(unescape(encodeURIComponent(text || ''))); }
function decodeBase64Utf8(b64) {
  try { return decodeURIComponent(escape(atob(b64))); } 
  catch (e) { return atob(b64); }
}

function apiUrl(path) { return 'https://api.github.com/repos/' + repoOwner + '/' + repoName + (path ? '/' + path : ''); }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken(), 'Accept': 'application/vnd.github+json' }; }

function ensureNotesDir() {
  return fetch(apiUrl('contents/' + NOTES_DIR), { headers: authHeaders() })
    .then(function (res) {
      if (res.status === 404) {
        return fetch(apiUrl('contents/' + NOTES_DIR + '/.gitkeep'), {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ message: 'Create notes directory', content: btoa('') })
        }).then(function (r) { return r.ok ? Promise.resolve() : r.json().then(function (d) { throw new Error(d.message || 'Failed to create notes/'); }); });
      }
      return Promise.resolve();
    });
}

function fetchDefaultBranch() {
  return fetch(apiUrl(''), { headers: authHeaders() })
    .then(function (res) { return res.ok ? res.json() : Promise.resolve(null); })
    .then(function (data) { if (data && data.default_branch) defaultBranch = data.default_branch; });
}

function showStatus(msg, isOk) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = isOk ? 'green' : 'red';
}

function defaultFilename() {
  var now = new Date();
  var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  var h = String(now.getHours()).padStart(2, '0'), min = String(now.getMinutes()).padStart(2, '0');
  return 'note-' + y + '-' + m + '-' + d + '-' + h + min + '.md';
}

// --- NATIVE SVG DRAWING LOGIC ---
function setupSvgDrawing(svgElement) {
  var isDrawing = false;
  var currentPath = null;
  var dString = "";

  function getMousePos(evt) {
    var CTM = svgElement.getScreenCTM();
    return {
      x: (evt.clientX - CTM.e) / CTM.a,
      y: (evt.clientY - CTM.f) / CTM.d
    };
  }

  svgElement.addEventListener('pointerdown', function(e) {
    isDrawing = true;
    var pos = getMousePos(e);
    
    currentPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    currentPath.setAttribute("fill", "none");
    currentPath.setAttribute("stroke", "#2c3e50"); 
    currentPath.setAttribute("stroke-width", "6");
    currentPath.setAttribute("stroke-linecap", "round");
    currentPath.setAttribute("stroke-linejoin", "round");
    
    dString = "M " + pos.x + " " + pos.y;
    currentPath.setAttribute("d", dString);
    svgElement.appendChild(currentPath);
    svgElement.setPointerCapture(e.pointerId); 
  });

  svgElement.addEventListener('pointermove', function(e) {
    if (!isDrawing) return;
    var pos = getMousePos(e);
    dString += " L " + pos.x + " " + pos.y;
    currentPath.setAttribute("d", dString);
  });

  svgElement.addEventListener('pointerup', function(e) {
    isDrawing = false;
    svgElement.releasePointerCapture(e.pointerId);
  });
}

// Initialize native drawing for both the main whiteboard and the sticky modal
var mainWhiteboardSvg = document.getElementById('mainWhiteboardSvg');
var modalSvgBoard = document.getElementById('nativeSvgBoard');
setupSvgDrawing(mainWhiteboardSvg);
setupSvgDrawing(modalSvgBoard);

function toggleWhiteboard(on) {
  isWhiteboardActive = on;
  var textarea = document.getElementById('noteText');
  var preview = document.getElementById('previewArea');
  var whiteboard = document.getElementById('whiteboardArea');
  var previewBtn = document.getElementById('previewToggle');
  var stickyBtn = document.getElementById('addStickyBtn');
  var imageBtn = document.getElementById('addImageBtn');
  var drawStickyBtn = document.getElementById('addDrawStickyBtn');

  if (on) {
    textarea.classList.add('hidden');
    preview.classList.add('hidden');
    whiteboard.classList.remove('hidden');
    previewBtn.classList.add('hidden'); 
    stickyBtn.classList.add('hidden'); 
    imageBtn.classList.add('hidden');
    drawStickyBtn.classList.add('hidden');
  } else {
    whiteboard.classList.add('hidden');
    previewBtn.classList.remove('hidden');
    stickyBtn.classList.remove('hidden');
    imageBtn.classList.remove('hidden');
    drawStickyBtn.classList.remove('hidden');
    togglePreview(previewOn); 
  }
}

function newWhiteboard() {
  var filename = 'board-' + Date.now() + '.svg';
  document.getElementById('pathInput').value = currentFolder ? currentFolder + '/' + filename : filename;
  openFilePath = null;
  openFileSha = null;
  toggleWhiteboard(true);
  mainWhiteboardSvg.innerHTML = '';
}

function refreshNotesList() {
  var token = getToken();
  if (!token) {
    document.getElementById('notesList').innerHTML = '<li>Set token to list notes</li>';
    document.getElementById('breadcrumb').textContent = '';
    return;
  }
  fetchDefaultBranch().then(function () {
    return fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() });
  }).then(function (res) {
    if (!res.ok) { document.getElementById('notesList').innerHTML = '<li>Could not load tree</li>'; return; }
    return res.json().then(function (data) {
      var tree = (data.tree || []).filter(function (e) {
        return e.path === NOTES_DIR || (e.path.indexOf(NOTES_DIR + '/') === 0 && e.path !== NOTES_DIR + '/.gitkeep');
      });
      currentTree = tree;
      renderNotesList(tree);
    });
  }).catch(function () { document.getElementById('notesList').innerHTML = '<li>Error loading notes</li>'; });
}

function renderNotesList(tree) {
  var prefix = NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/';
  var dirs = [], files = [];
  tree.forEach(function (e) {
    if (e.path === NOTES_DIR + '/.gitkeep' || !e.path.startsWith(prefix)) return;
    var name = e.path.slice(prefix.length);
    if (name.indexOf('/') >= 0) return;
    if (e.type === 'tree') dirs.push(name); else files.push(name);
  });
  dirs.sort(); files.sort();
  var html = currentFolder ? '<li class="folder" data-path="" data-type="dir">..</li>' : '';
  dirs.forEach(function (d) { html += '<li class="folder" data-path="' + (currentFolder ? currentFolder + '/' : '') + d + '" data-type="dir">' + d + '/</li>'; });
  files.forEach(function (f) { html += '<li class="file" data-path="' + (currentFolder ? currentFolder + '/' : '') + f + '" data-type="file">' + f + '</li>'; });
  if (html === '') html = '<li>No notes yet</li>';
  document.getElementById('notesList').innerHTML = html;
  document.getElementById('breadcrumb').textContent = NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/';

  document.querySelectorAll('#notesList li[data-path]').forEach(function (li) {
    li.addEventListener('click', function () {
      var path = this.getAttribute('data-path'), type = this.getAttribute('data-type');
      if (type === 'dir') {
        currentFolder = path === '' ? currentFolder.split('/').slice(0, -1).join('/') : path;
        renderNotesList(currentTree);
      } else {
        openNote(NOTES_DIR + '/' + path);
      }
    });
  });
}

function openNote(fullPath) {
  var token = getToken();
  if (!token) { showStatus('Set token first.', false); return; }
  openFilePath = fullPath;
  openFileSha = null;
  document.getElementById('pathInput').value = fullPath.replace(NOTES_DIR + '/', '');
  fetch(apiUrl('contents/' + fullPath), { headers: authHeaders() })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || 'Failed to load'); });
      return res.json();
    })
    .then(function (d) {
      var text = (d.content != null && d.encoding === 'base64') ? decodeBase64Utf8(d.content) : (d.content || '');
      openFileSha = d.sha || null;

      if (fullPath.endsWith('.svg')) {
        toggleWhiteboard(true);
        var tempDiv = document.createElement('div');
        tempDiv.innerHTML = text;
        var loadedSvg = tempDiv.querySelector('svg');
        mainWhiteboardSvg.innerHTML = loadedSvg ? loadedSvg.innerHTML : '';
      } else {
        document.getElementById('noteText').value = text;
        toggleWhiteboard(false);
        togglePreview(false);
      }
    }).catch(function (err) { showStatus('Error: ' + err.message, false); });
}

function saveNote() {
  var token = getToken();
  if (!token) {
    var fromPrompt = prompt('Paste your GitHub token (stored in browser only):');
    if (fromPrompt && fromPrompt.trim()) { setToken(fromPrompt); token = getToken(); }
    if (!token) { showStatus('Need a token to save.', false); return; }
  }
  var pathRel = document.getElementById('pathInput').value.trim();
  if (!pathRel) { pathRel = defaultFilename(); document.getElementById('pathInput').value = pathRel; }
  if (!isWhiteboardActive && !pathRel.endsWith('.md') && !pathRel.endsWith('.txt') && !pathRel.endsWith('.svg')) pathRel += '.md';
  
  var fullPath = NOTES_DIR + '/' + pathRel;
  var noteContent = '';

  if (isWhiteboardActive) {
    // Generate valid full SVG string from the main whiteboard
    noteContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + mainWhiteboardSvg.innerHTML + '</svg>';
  } else {
    noteContent = document.getElementById('noteText').value;
  }
  
  var url = apiUrl('contents/' + fullPath);
  var body = { message: 'Add note: ' + pathRel, content: base64Utf8(noteContent) };

  ensureNotesDir()
    .then(function () { return fetch(url, { headers: authHeaders() }); })
    .then(function (getRes) { if (getRes.ok) return getRes.json().then(function (data) { body.sha = data.sha; }); })
    .then(function () {
      return fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body) });
    })
    .then(function (res) {
      if (res.ok) {
        showStatus('Saved.', true);
        openFilePath = fullPath;
        return res.json().then(function (d) { openFileSha = (d && d.content && d.content.sha) ? d.content.sha : null; });
      }
      return res.json().then(function (data) {
        var msg = data.message || 'Save failed.';
        if (res.status === 404 || res.status === 403) msg += ' Check token has access to ' + repoOwner + '/' + repoName + '.';
        showStatus(msg, false);
      });
    })
    .then(function () { refreshNotesList(); })
    .catch(function (err) { showStatus('Error: ' + err.message, false); });
}

function deleteNote() {
  if (!openFilePath || !openFileSha) { showStatus('Open a note first.', false); return; }
  if (!confirm('Delete this note?')) return;
  var token = getToken();
  if (!token) { showStatus('Need a token.', false); return; }
  fetch(apiUrl('contents/' + openFilePath), {
    method: 'DELETE',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ message: 'Delete note: ' + openFilePath, sha: openFileSha })
  }).then(function (res) {
      if (res.ok) {
        showStatus('Deleted.', true);
        document.getElementById('pathInput').value = '';
        document.getElementById('noteText').value = '';
        mainWhiteboardSvg.innerHTML = '';
        openFilePath = null;
        openFileSha = null;
        refreshNotesList();
      } else return res.json().then(function (d) { showStatus(d.message || 'Delete failed.', false); });
    }).catch(function (err) { showStatus('Error: ' + err.message, false); });
}

function newFolder() {
  var name = prompt('Folder name (e.g. work):');
  if (!name || !name.trim()) return;
  name = name.trim().replace(/\/+$/, '');
  var token = getToken();
  if (!token) { showStatus('Set token first.', false); return; }
  var path = NOTES_DIR + '/' + name + '/.gitkeep';
  ensureNotesDir()
    .then(function () {
      return fetch(apiUrl('contents/' + path), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ message: 'New folder: ' + name, content: btoa('') })
      });
    }).then(function (res) {
      if (res.ok) { showStatus('Folder created.', true); refreshNotesList(); }
      else return res.json().then(function (d) { showStatus(d.message || 'Failed.', false); });
    }).catch(function (err) { showStatus('Error: ' + err.message, false); });
}

function newNote() {
  document.getElementById('pathInput').value = currentFolder ? currentFolder + '/' + defaultFilename() : defaultFilename();
  document.getElementById('noteText').value = '';
  openFilePath = null;
  openFileSha = null;
  toggleWhiteboard(false);
  togglePreview(false);
}

function initDraggableStickies() {
  var preview = document.getElementById('previewArea');
  var stickies = preview.querySelectorAll('.sticky-note');
  var textarea = document.getElementById('noteText');

  stickies.forEach(function(sticky) {
    var isDragging = false, startX, startY, initialLeft, initialTop;
    var originalHtml = sticky.outerHTML;

    sticky.addEventListener('mousedown', function(e) {
      if (e.target.tagName.toLowerCase() === 'button') return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      initialLeft = parseInt(sticky.style.left || sticky.getAttribute('data-x') || 0, 10);
      initialTop = parseInt(sticky.style.top || sticky.getAttribute('data-y') || 0, 10);
      sticky.style.cursor = 'grabbing';
      e.preventDefault(); 
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var newLeft = initialLeft + (e.clientX - startX);
      var newTop = initialTop + (e.clientY - startY);
      sticky.style.left = newLeft + 'px';
      sticky.style.top = newTop + 'px';
      sticky.setAttribute('data-x', newLeft);
      sticky.setAttribute('data-y', newTop);
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        sticky.style.cursor = 'grab';
        var newHtml = sticky.outerHTML;
        textarea.value = textarea.value.replace(originalHtml, newHtml);
        originalHtml = newHtml;
      }
    });
  });
}

// --- FULL VIEWPORT DISPLAY LOGIC ---
document.getElementById('clearDrawBtn').addEventListener('click', function() {
  modalSvgBoard.innerHTML = '';
});

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
  activeStickyHtml = stickyEl.outerHTML;
};

function closeDrawScreen() {
  document.getElementById('drawScreen').classList.add('hidden');
  document.getElementById('top').classList.remove('hidden');
  document.getElementById('mainLayout').classList.remove('hidden');
  activeStickyHtml = null;
}

document.getElementById('saveDrawScreenBtn').addEventListener('click', function() {
  if (activeStickyHtml) {
    var finalSvgString = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="100%" height="100%">' + modalSvgBoard.innerHTML + '</svg>';
    
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = activeStickyHtml;
    var stickyEl = tempDiv.firstElementChild;
    stickyEl.querySelector('.draw-preview').innerHTML = finalSvgString;
    
    var newHtml = stickyEl.outerHTML;
    var textarea = document.getElementById('noteText');

    if (textarea.value.indexOf(activeStickyHtml) === -1) {
        console.error("Sync Error: activeStickyHtml not found in raw text. String replacement failed.");
    }
    textarea.value = textarea.value.replace(activeStickyHtml, newHtml);
    
    closeDrawScreen();
    togglePreview(true);
  }
});

document.getElementById('cancelDrawScreenBtn').addEventListener('click', closeDrawScreen);

function addDrawSticky() {
  if (isWhiteboardActive) { showStatus("Cannot add sticky notes to a whiteboard.", false); return; }
  
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = '<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + EMPTY_SVG + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>';
  var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
  
  var textarea = document.getElementById('noteText');
  var start = textarea.selectionStart, end = textarea.selectionEnd;
  var text = textarea.value;
  textarea.value = text.slice(0, start) + stickyHtml + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;
  if (previewOn) togglePreview(true);
  showStatus('Draw sticky added.', true);
}

function togglePreview(on) {
  if (isWhiteboardActive) return; 
  previewOn = on !== undefined ? on : !previewOn;
  var textarea = document.getElementById('noteText');
  var preview = document.getElementById('previewArea');
  
  if (previewOn) {
    textarea.classList.add('hidden');
    preview.classList.remove('hidden');
    var content = textarea.value;
    var path = document.getElementById('pathInput').value || '';
    var isMd = path === '' || path.endsWith('.md'); 
    
    if (typeof marked !== 'undefined' && isMd) {
      preview.innerHTML = (marked.parse || marked)(content || '');
      initDraggableStickies();
      var rawBase = 'https://raw.githubusercontent.com/' + repoOwner + '/' + repoName + '/' + defaultBranch + '/';
      preview.querySelectorAll('img').forEach(function (img) {
        var src = img.getAttribute('src');
        if (!src) return;
        var fullRaw = (src.indexOf('http') !== 0) ? (rawBase + (src.indexOf(NOTES_DIR) === 0 ? src : NOTES_DIR + '/' + src)) : src;
        if (fullRaw.indexOf(rawBase) !== 0) { img.setAttribute('src', fullRaw); return; }
        fetch(apiUrl('contents/' + fullRaw.slice(rawBase.length)), { headers: Object.assign({}, authHeaders(), { 'Accept': 'application/vnd.github.raw' }) })
          .then(function (res) { return res.ok ? res.blob() : Promise.reject(new Error('Failed to load image')); })
          .then(function (blob) { img.src = URL.createObjectURL(blob); }).catch(function () {});
      });
    } else {
      preview.textContent = content || '';
    }
  } else {
    textarea.classList.remove('hidden');
    preview.classList.add('hidden');
  }
  document.getElementById('previewToggle').textContent = previewOn ? 'Edit' : 'Preview';
}

function addSticky() {
  if (isWhiteboardActive) { showStatus("Cannot add sticky notes to a whiteboard.", false); return; }
  
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = '<div class="sticky-note" data-x="20" data-y="20" style="left: 20px; top: 20px;" contenteditable="true">New sticky note...</div>';
  var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
  
  var textarea = document.getElementById('noteText');
  var start = textarea.selectionStart, end = textarea.selectionEnd;
  var text = textarea.value;
  textarea.value = text.slice(0, start) + stickyHtml + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;
  if (previewOn) togglePreview(true);
  showStatus('Sticky note added.', true);
}

function addImage() { document.getElementById('imageFileInput').click(); }
document.getElementById('imageFileInput').addEventListener('change', function () {
  var file = this.files[0];
  if (!file) return;
  var token = getToken();
  if (!token) { showStatus('Set token first.', false); this.value = ''; return; }
  var base = NOTES_DIR + '/images', name = Date.now() + '-' + (file.name || 'image.png'), path = base + '/' + name;
  var reader = new FileReader();
  reader.onload = function () {
    var base64 = reader.result.replace(/^data:image\/\w+;base64,/, '');
    ensureNotesDir().then(function () { return fetch(apiUrl('contents/' + base + '/.gitkeep'), { headers: authHeaders() }); })
      .then(function (res) { return res.status === 404 ? fetch(apiUrl('contents/' + base + '/.gitkeep'), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Create images dir', content: btoa('') }) }) : Promise.resolve(); })
      .then(function () { return fetch(apiUrl('contents/' + path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ message: 'Add image: ' + name, content: base64 }) }); })
      .then(function (res) {
        this.value = '';
        if (res.ok) {
          var rawUrl = 'https://raw.githubusercontent.com/' + repoOwner + '/' + repoName + '/' + defaultBranch + '/' + path;
          var textarea = document.getElementById('noteText');
          var insert = '![' + name + '](' + rawUrl + ')', start = textarea.selectionStart, end = textarea.selectionEnd, text = textarea.value;
          textarea.value = text.slice(0, start) + insert + text.slice(end);
          textarea.selectionStart = textarea.selectionEnd = start + insert.length;
          showStatus('Image added.', true);
          refreshNotesList();
        } else return res.json().then(function (d) { showStatus(d.message || 'Upload failed.', false); });
      }.bind(this)).catch(function (err) { showStatus('Error: ' + err.message, false); this.value = ''; }.bind(this));
  };
  reader.readAsDataURL(file);
});

document.getElementById('repoOwnerInput').value = repoOwner;
document.getElementById('repoNameInput').value = repoName;
updateRepoDisplay();

document.getElementById('useRepoBtn').addEventListener('click', function () { setRepo(document.getElementById('repoOwnerInput').value, document.getElementById('repoNameInput').value); showStatus('Repo updated.', true); });
document.getElementById('saveTokenBtn').addEventListener('click', function () { setToken(document.getElementById('tokenInput').value); });
document.getElementById('logoutBtn').addEventListener('click', clearToken);
document.getElementById('saveBtn').addEventListener('click', saveNote);
document.getElementById('deleteBtn').addEventListener('click', deleteNote);
document.getElementById('newFolderBtn').addEventListener('click', newFolder);
document.getElementById('newNoteBtn').addEventListener('click', newNote);
document.getElementById('newWhiteboardBtn').addEventListener('click', newWhiteboard);
document.getElementById('addStickyBtn').addEventListener('click', addSticky);
document.getElementById('addDrawStickyBtn').addEventListener('click', addDrawSticky);
document.getElementById('refreshNotesBtn').addEventListener('click', function () { refreshNotesList(); showStatus('List refreshed.', true); });
document.getElementById('previewToggle').addEventListener('click', function () { togglePreview(); });
document.getElementById('addImageBtn').addEventListener('click', addImage);

refreshNotesList();