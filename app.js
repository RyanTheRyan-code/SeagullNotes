var TOKEN_KEY = 'github_token';
var REPO_OWNER_KEY = 'repo_owner';
var REPO_NAME_KEY = 'repo_name';
var NOTES_DIR = 'notes';

var EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="100%" height="100%"></svg>';

var repoOwner = localStorage.getItem(REPO_OWNER_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_OWNER ? CONFIG.REPO_OWNER : 'YOUR_GITHUB_USERNAME');
var repoName = localStorage.getItem(REPO_NAME_KEY) || (typeof CONFIG !== 'undefined' && CONFIG.REPO_NAME ? CONFIG.REPO_NAME : 'SeagullNotes');
var defaultBranch = 'main';
var fullNotesTree = []; // Stores the full tree for reference
var currentFolder = '';
var openFilePath = null;
var openFileSha = null;
var previewOn = false;
var fullPreview = false;
var isWhiteboardActive = false;
var isPlacingAsSticky = false;
var currentWhiteboardTool = 'pen'; // 'pen', 'rectangle', 'circle', 'eraser'
var currentStrokeColor = '#2c3e50';
var currentDrawingElement = null; // Used for shapes
var isDirty = false; // Tracks unsaved changes for autosave
var autosaveTimer = null; // Timer for debouncing autosave
var searchCache = {}; // Cache for search results
var selectedImageUrl = null;
var mainWhiteboardSvg, modalSvgBoard;

var activeStickyHtml = null;
var turndownService = (typeof TurndownService !== 'undefined') ? new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
}) : null;

// Configure turndown to keep our custom sticky notes as raw HTML
if (turndownService) {
  turndownService.keep(['div', 'img', 'button']);
}

function insertMarkdown(prefix, suffix) {
  var textarea = document.getElementById('noteText');
  var preview = document.getElementById('previewArea');
  
  if (fullPreview && !preview.classList.contains('hidden')) {
    // Unified WYSIWYG Formatting for Full View
    if (prefix === '**') {
      document.execCommand('bold');
    } else if (prefix === '*') {
      document.execCommand('italic');
    } else if (prefix === '# ') {
      document.execCommand('formatBlock', false, 'H1');
    } else if (prefix === '## ') {
      document.execCommand('formatBlock', false, 'H2');
    } else if (prefix === '> ') {
      document.execCommand('formatBlock', false, 'BLOCKQUOTE');
    } else if (prefix === '- ') {
      document.execCommand('insertUnorderedList');
    } else if (prefix === '1. ') {
      document.execCommand('insertOrderedList');
    } else {
      // Custom pattern insertion (Links, Code blocks)
      var selection = window.getSelection();
      if (selection.rangeCount > 0) {
        var range = selection.getRangeAt(0);
        var selectedText = selection.toString();
        var content = prefix + (selectedText || 'text') + suffix;
        
        // Remove selection and insert new pattern
        range.deleteContents();
        range.insertNode(document.createTextNode(content));
      }
    }
    syncPreviewToText();
    return;
  }

  // Standard Textarea Selection Wrapping
  var start = textarea.selectionStart;
  var end = textarea.selectionEnd;
  var text = textarea.value;
  var selected = text.substring(start, end);
  var before = text.substring(0, start);
  var after = text.substring(end);
  
  textarea.value = before + prefix + selected + suffix + after;
  textarea.selectionStart = start + prefix.length;
  textarea.selectionEnd = textarea.selectionStart + selected.length;
  textarea.focus();
  
  // Trigger update for live preview if active
  isDirty = true;
  triggerAutosave();
  if (previewOn) togglePreview(true);
}

// Function to debounce calls
function debounce(func, delay) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), delay);
  };
}


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
  var tokenInput = document.getElementById('tokenInput');
  if (tokenInput) tokenInput.value = '';
  var textarea = document.getElementById('noteText');
  if (textarea) textarea.value = '';
  var pathInput = document.getElementById('pathInput');
  if (pathInput) pathInput.value = '';
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
  if (el) {
    el.textContent = msg;
    el.style.color = isOk ? 'green' : 'red';
  }
}

function defaultFilename() {
  var now = new Date();
  var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  var h = String(now.getHours()).padStart(2, '0'), min = String(now.getMinutes()).padStart(2, '0');
  return 'note-' + y + '-' + m + '-' + d + '-' + h + min + '.md';
}

function triggerAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(function() {
    if (isDirty && openFilePath) {
      saveNote(true);
      isDirty = false;
    }
  }, 3000);
}

function syncPreviewToText() {
  if (!turndownService) return;
  var preview = document.getElementById('previewArea');
  var textarea = document.getElementById('noteText');
  
  // Clone to avoid messing with the visible UI
  var clone = preview.cloneNode(true);
  
  // Remove UI-only elements from the clone so they don't end up in the Markdown
  clone.querySelectorAll('.edit-draw-btn, .mermaid, .vditor-copy').forEach(el => el.remove());
  
  var markdown = turndownService.turndown(clone.innerHTML);
  textarea.value = markdown;
  isDirty = true;
  triggerAutosave();
}

function updateToolSelection() {
  var mainTools = ['penToolBtn', 'rectToolBtn', 'circleToolBtn', 'eraserToolBtn'];
  var modalTools = ['modalPenToolBtn', 'modalRectToolBtn', 'modalCircleToolBtn', 'modalEraserToolBtn'];
  
  var toolToId = {
    'pen': 0,
    'rectangle': 1,
    'circle': 2,
    'eraser': 3
  };
  
  var activeIndex = toolToId[currentWhiteboardTool];
  
  mainTools.forEach(function(id, idx) {
    var el = document.getElementById(id);
    if (el) {
      if (idx === activeIndex) el.classList.add('selected-tool');
      else el.classList.remove('selected-tool');
    }
  });
  
  modalTools.forEach(function(id, idx) {
    var el = document.getElementById(id);
    if (el) {
      if (idx === activeIndex) el.classList.add('selected-tool');
      else el.classList.remove('selected-tool');
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  var noteTextarea = document.getElementById('noteText');
  var whiteboardSvg = document.getElementById('mainWhiteboardSvg');

  if (noteTextarea) {
    noteTextarea.addEventListener('input', function() {
      isDirty = true;
      triggerAutosave();
      if (previewOn) togglePreview(true);
    });
  }

  var previewArea = document.getElementById('previewArea');
  if (previewArea) {
    previewArea.addEventListener('input', function() {
      if (fullPreview) {
        syncPreviewToText();
      }
    });
  }

    if (whiteboardSvg) {
      var observer = new MutationObserver(function() {
        isDirty = true;
        triggerAutosave();
      });
      observer.observe(whiteboardSvg, { childList: true, subtree: true, attributes: true });
    }
  
    mainWhiteboardSvg = document.getElementById('mainWhiteboardSvg');
    modalSvgBoard = document.getElementById('nativeSvgBoard');
    setupSvgDrawing(mainWhiteboardSvg);
      setupSvgDrawing(modalSvgBoard);
    
      var searchInput = document.getElementById('searchInput');
    
        if (searchInput) {
          searchInput.addEventListener('input', function () {
            var query = this.value.trim();
            if (query === '') {
              renderNotesList(fullNotesTree);
              showStatus('', true);
            } else {
              // Immediate local filtering for fast feedback
              var localResults = fullNotesTree.filter(function(e) {
                return e.type === 'blob' && e.path.toLowerCase().indexOf(query.toLowerCase()) >= 0;
              });
              renderNotesList(localResults, true);
              showStatus('Searching locally...', true);
              
              debouncedSearch(query);
            }
          });
        }
      
        document.getElementById('repoOwnerInput').value = repoOwner;
        document.getElementById('repoNameInput').value = repoName;
        updateRepoDisplay();
      
        document.getElementById('useRepoBtn').addEventListener('click', function () { setRepo(document.getElementById('repoOwnerInput').value, document.getElementById('repoNameInput').value); showStatus('Repo updated.', true); });
        document.getElementById('saveTokenBtn').addEventListener('click', function () { setToken(document.getElementById('tokenInput').value); });
          document.getElementById('logoutBtn').addEventListener('click', clearToken);
        
          document.getElementById('saveBtn').addEventListener('click', function() { saveNote(); });
          document.getElementById('deleteBtn').addEventListener('click', deleteNote);
          document.getElementById('fileDropdownNewFolderBtn').addEventListener('click', newFolder);
          document.getElementById('fileDropdownNewNoteBtn').addEventListener('click', newNote);
          document.getElementById('fileDropdownNewWhiteboardBtn').addEventListener('click', newWhiteboard);
          var addDiagramBtn = document.getElementById('addDiagramBtn');
          if (addDiagramBtn) addDiagramBtn.addEventListener('click', addMermaidTemplate);
          document.getElementById('imageDropdownAddImageLinkBtn').addEventListener('click', addImageLink);
            document.getElementById('imageDropdownAddImageUrlBtn').addEventListener('click', addImageFromUrl);
          
              document.getElementById('fileDropdownBtn').addEventListener('click', function(event) {
                document.getElementById('fileDropdownContent').classList.toggle('show');
                event.stopPropagation();
              });
            
              document.getElementById('imageDropdownBtn').addEventListener('click', function(event) {
                document.getElementById('imageDropdownContent').classList.toggle('show');
                event.stopPropagation();
              });
            
                              document.getElementById('insertToggleBtn').addEventListener('click', function(event) {
                              document.getElementById('insertDropdownContent').classList.toggle('show');
                              event.stopPropagation();
                            });          
              
                            var liveToggle = document.getElementById('livePreviewToggle');
                            if (liveToggle) {
                              liveToggle.addEventListener('click', function() {
                                if (!previewOn || fullPreview) {
                                  previewOn = true;
                                  fullPreview = false;
                                } else {
                                  previewOn = false;
                                }
                                togglePreview(previewOn);
                              });
                            }
              
                            var fullToggle = document.getElementById('fullPreviewToggle');
                            if (fullToggle) {
                              fullToggle.addEventListener('click', function() {
                                if (!previewOn || !fullPreview) {
                                  previewOn = true;
                                  fullPreview = true;
                                } else {
                                  previewOn = false;
                                  fullPreview = false;
                                }
                                togglePreview(previewOn);
                              });
                            }
              
                            // Close the dropdown if the user clicks outside of it
                            window.onclick = function(event) {
                if (!event.target.matches('.dropbtn')) {
                  var dropdowns = document.getElementsByClassName("dropdown-content");
                  for (var i = 0; i < dropdowns.length; i++) {
                    var openDropdown = dropdowns[i];
                    if (openDropdown.classList.contains('show')) {
                      openDropdown.classList.remove('show');
                    }
                  }
                }
              }
            
              document.getElementById('addTextSticky').addEventListener('click', function(e) { e.preventDefault(); addSticky(); });
              document.getElementById('addDrawingSticky').addEventListener('click', function(e) { e.preventDefault(); addDrawSticky(); });
              document.getElementById('addImageSticky').addEventListener('click', function(e) { e.preventDefault(); addImageSticky(); });
              document.getElementById('addWhiteboardSticky').addEventListener('click', function(e) { e.preventDefault(); showWhiteboardModal(true); });
              document.getElementById('imageDropdownAddImageFromLibrary').addEventListener('click', function(e) { e.preventDefault(); showImageLibrary(); });
            
              document.getElementById('cancelImageLibraryBtn').addEventListener('click', function() {
                document.getElementById('imageLibraryModal').classList.add('hidden');
              });
            
              document.getElementById('insertImageAsLinkBtn').addEventListener('click', function() {
                if (selectedImageUrl) {
                  var insert = '![](' + selectedImageUrl + ')';
                  var textarea = document.getElementById('noteText');
                  var start = textarea.selectionStart;
                  var end = textarea.selectionEnd;
                  textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(end);
                  textarea.selectionStart = textarea.selectionEnd = start + insert.length;
                  showStatus('Image link added.', true);
                  document.getElementById('imageLibraryModal').classList.add('hidden');
                  if (previewOn) togglePreview(true);
                }
              });
            
                document.getElementById('insertImageAsStickyBtn').addEventListener('click', function() {
                  if (selectedImageUrl) {
                    var tempDiv = document.createElement('div');
                    tempDiv.innerHTML = '<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><img src="' + selectedImageUrl + '" alt="Image Sticky"></div>';
                    var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
                    
                    var textarea = document.getElementById('noteText');
                    var start = textarea.selectionStart;
                    var end = textarea.selectionEnd;
                    textarea.value = textarea.value.slice(0, start) + stickyHtml + textarea.value.slice(end);
                    textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;
                    
                    if (previewOn) togglePreview(true);
                    showStatus('Image sticky added.', true);
                    document.getElementById('imageLibraryModal').classList.add('hidden');
                  }
                });
              
                document.getElementById('fileDropdownRefreshNotesBtn').addEventListener('click', function () { refreshNotesList(); showStatus('List refreshed.', true); });
                document.getElementById('previewToggle').addEventListener('click', function () { togglePreview(); });
                var placeBtn = document.getElementById('placeWhiteboardBtn');
                if (placeBtn) placeBtn.addEventListener('click', function () { showWhiteboardModal(false); });
                
                var cancelWBtn = document.getElementById('cancelWhiteboardSelectionBtn');
                if (cancelWBtn) cancelWBtn.addEventListener('click', function() {
                  document.getElementById('whiteboardModal').classList.add('hidden');
                });
                
                var placeStickyBtn = document.getElementById('placeDrawingAsStickyBtn');
                if (placeStickyBtn) placeStickyBtn.addEventListener('click', placeCurrentDrawingAsSticky);
                
                // Event listener for mobile menu toggle
                var menuToggleBtn = document.getElementById('menuToggleBtn');
                if (menuToggleBtn) {
                  menuToggleBtn.addEventListener('click', function() {
                    document.body.classList.toggle('sidebar-open');
                  });
                }
              
                // Event listeners for whiteboard tools
                var penBtn = document.getElementById('penToolBtn');
                if (penBtn) penBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'pen';
                  updateToolSelection();
                  showStatus('Tool: Pen', true);
                });
                
                var rectBtn = document.getElementById('rectToolBtn');
                if (rectBtn) rectBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'rectangle';
                  updateToolSelection();
                  showStatus('Tool: Rectangle', true);
                });
                
                var circleBtn = document.getElementById('circleToolBtn');
                if (circleBtn) circleBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'circle';
                  updateToolSelection();
                  showStatus('Tool: Circle', true);
                });
                
                var eraserBtn = document.getElementById('eraserToolBtn');
                if (eraserBtn) eraserBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'eraser';
                  updateToolSelection();
                  showStatus('Tool: Eraser', true);
                });
                
                var strokeIn = document.getElementById('strokeColorInput');
                if (strokeIn) strokeIn.addEventListener('input', function() {
                  currentStrokeColor = this.value;
                  var modalStroke = document.getElementById('modalStrokeColorInput');
                  if (modalStroke) modalStroke.value = currentStrokeColor;
                  showStatus('Color: ' + currentStrokeColor, true);
                });

                // Modal toolbar listeners
                var mPenBtn = document.getElementById('modalPenToolBtn');
                if (mPenBtn) mPenBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'pen';
                  updateToolSelection();
                });
                
                var mRectBtn = document.getElementById('modalRectToolBtn');
                if (mRectBtn) mRectBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'rectangle';
                  updateToolSelection();
                });
                
                var mCircleBtn = document.getElementById('modalCircleToolBtn');
                if (mCircleBtn) mCircleBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'circle';
                  updateToolSelection();
                });
                
                var mEraserBtn = document.getElementById('modalEraserToolBtn');
                if (mEraserBtn) mEraserBtn.addEventListener('click', function() {
                  currentWhiteboardTool = 'eraser';
                  updateToolSelection();
                });
                
                var mStrokeIn = document.getElementById('modalStrokeColorInput');
                if (mStrokeIn) mStrokeIn.addEventListener('input', function() {
                  currentStrokeColor = this.value;
                  var mainStroke = document.getElementById('strokeColorInput');
                  if (mainStroke) mainStroke.value = currentStrokeColor;
                });
              
                updateToolSelection();
                refreshNotesList();
              }
            );

function getMousePos(svgElement, evt) {
  var CTM = svgElement.getScreenCTM();
  if (!CTM) return { x: 0, y: 0 }; // Handle cases where CTM might be null
  return {
    x: (evt.clientX - CTM.e) / CTM.a,
    y: (evt.clientY - CTM.f) / CTM.d
  };
}

var isDrawing = false;
var startPos = { x: 0, y: 0 };

function erase(svgElement, e) {
  var target = document.elementFromPoint(e.clientX, e.clientY);
  // If we are clicking on a child of a group or just a direct shape
  while (target && target !== svgElement && target !== document.body) {
    if (target.tagName && ['path', 'rect', 'circle'].includes(target.tagName.toLowerCase())) {
      target.remove();
      return;
    }
    target = target.parentElement;
  }
}

function setupSvgDrawing(svgElement) {
  if (!svgElement) return;

  svgElement.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    
    // For eraser, we might want to erase on down too
    if (currentWhiteboardTool === 'eraser') {
      isDrawing = true;
      erase(svgElement, e);
      svgElement.setPointerCapture(e.pointerId);
      return;
    }

    e.preventDefault(); 
    isDrawing = true;
    startPos = getMousePos(svgElement, e);
    currentDrawingElement = null; 
    
    switch (currentWhiteboardTool) {
      case 'pen':
        currentDrawingElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
        currentDrawingElement.setAttribute("fill", "none");
        currentDrawingElement.setAttribute("stroke", currentStrokeColor); 
        currentDrawingElement.setAttribute("stroke-width", "6");
        currentDrawingElement.setAttribute("stroke-linecap", "round");
        currentDrawingElement.setAttribute("stroke-linejoin", "round");
        currentDrawingElement.setAttribute("d", "M " + startPos.x + " " + startPos.y);
        break;
      case 'rectangle':
        currentDrawingElement = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        currentDrawingElement.setAttribute("stroke", currentStrokeColor);
        currentDrawingElement.setAttribute("stroke-width", "4");
        currentDrawingElement.setAttribute("fill", "none");
        currentDrawingElement.setAttribute("x", startPos.x);
        currentDrawingElement.setAttribute("y", startPos.y);
        currentDrawingElement.setAttribute("width", "0");
        currentDrawingElement.setAttribute("height", "0");
        break;
      case 'circle':
        currentDrawingElement = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        currentDrawingElement.setAttribute("stroke", currentStrokeColor);
        currentDrawingElement.setAttribute("stroke-width", "4");
        currentDrawingElement.setAttribute("fill", "none");
        currentDrawingElement.setAttribute("cx", startPos.x);
        currentDrawingElement.setAttribute("cy", startPos.y);
        currentDrawingElement.setAttribute("r", "0");
        break;
    }

    if (currentDrawingElement) {
      svgElement.appendChild(currentDrawingElement);
    }
    
    svgElement.setPointerCapture(e.pointerId); 
  });

  svgElement.addEventListener('pointermove', function(e) {
    if (!isDrawing) return;
    e.preventDefault();
    var pos = getMousePos(svgElement, e);
    
    if (currentWhiteboardTool === 'eraser') {
      erase(svgElement, e);
      return;
    }

    switch (currentWhiteboardTool) {
      case 'pen':
        if (currentDrawingElement && currentDrawingElement.tagName === 'path') {
          currentDrawingElement.setAttribute("d", currentDrawingElement.getAttribute("d") + " L " + pos.x + " " + pos.y);
        }
        break;
      case 'rectangle':
        if (currentDrawingElement && currentDrawingElement.tagName === 'rect') {
          var width = pos.x - startPos.x;
          var height = pos.y - startPos.y;
          currentDrawingElement.setAttribute("x", width > 0 ? startPos.x : pos.x);
          currentDrawingElement.setAttribute("y", height > 0 ? startPos.y : pos.y);
          currentDrawingElement.setAttribute("width", Math.abs(width));
          currentDrawingElement.setAttribute("height", Math.abs(height));
        }
        break;
      case 'circle':
        if (currentDrawingElement && currentDrawingElement.tagName === 'circle') {
          var dx = pos.x - startPos.x;
          var dy = pos.y - startPos.y;
          var r = Math.sqrt(dx*dx + dy*dy);
          currentDrawingElement.setAttribute("r", r);
        }
        break;
    }
  });

  svgElement.addEventListener('pointerup', function(e) {
    isDrawing = false;
    currentDrawingElement = null;
    svgElement.releasePointerCapture(e.pointerId);
  });
}



function searchGithub(query) {
  var token = getToken();
  if (!token) { showStatus('Set token to search.', false); return; }
  if (!query) {
    renderNotesList(fullNotesTree);
    return;
  }

  // 1. Local Search (Instant) - Filename match
  var localResults = fullNotesTree.filter(function(e) {
    return e.type === 'blob' && e.path.toLowerCase().indexOf(query.toLowerCase()) >= 0;
  });

  // Check cache for remote results
  if (searchCache[query]) {
    combineAndRenderResults(localResults, searchCache[query], query);
    return;
  }

  showStatus('Searching content on GitHub...', true);

  var searchUrl = 'https://api.github.com/search/code?q=' + encodeURIComponent(query) +
                  '+in:file+repo:' + repoOwner + '/' + repoName +
                  '+path:' + NOTES_DIR + '&per_page=100';

  fetch(searchUrl, { headers: authHeaders() })
    .then(function (res) {
      if (res.status === 403) {
        throw new Error('Search API rate limit reached. Please wait a minute.');
      }
      if (!res.ok) return res.json().then(function (d) { throw new Error(d.message || 'Search failed.'); });
      return res.json();
    })
    .then(function (data) {
      var remoteResults = data.items.map(function (item) {
        return {
          path: item.path,
          type: 'blob',
          sha: item.sha
        };
      });
      
      searchCache[query] = remoteResults;
      combineAndRenderResults(localResults, remoteResults, query);
    })
    .catch(function (err) {
      showStatus('Search error: ' + err.message, false);
      // Fallback to local results only if remote fails
      renderNotesList(localResults, true);
    });
}

function combineAndRenderResults(local, remote, query) {
  // Merge and remove duplicates based on path
  var seenPaths = new Set();
  var combined = [];
  
  local.forEach(function(item) {
    if (!seenPaths.has(item.path)) {
      combined.push(item);
      seenPaths.add(item.path);
    }
  });
  
  remote.forEach(function(item) {
    if (!seenPaths.has(item.path)) {
      combined.push(item);
      seenPaths.add(item.path);
    }
  });

  if (combined.length === 0) {
    showStatus('No results found for "' + query + '".', true);
  } else {
    showStatus('Search complete. Found ' + combined.length + ' results.', true);
  }
  renderNotesList(combined, true);
}

var debouncedSearch = debounce(searchGithub, 800);

function toggleWhiteboard(on) {
  isWhiteboardActive = on;
  var preview = document.getElementById('previewArea');
  var whiteboard = document.getElementById('whiteboardArea');
  var insertDropdown = document.getElementById('insertDropdown');
  var placeDrawingAsStickyBtn = document.getElementById('placeDrawingAsStickyBtn');
  var whiteboardToolbar = document.getElementById('whiteboardToolbar');
  var editorToolbar = document.getElementById('editorToolbar');
  var noteText = document.getElementById('noteText');

  if (on) {
    if (editorToolbar) editorToolbar.classList.add('hidden');
    if (noteText) noteText.classList.add('hidden');
    if (preview) preview.classList.add('hidden');
    if (whiteboard) whiteboard.classList.remove('hidden');
    if (insertDropdown) insertDropdown.classList.add('hidden');
    if (placeDrawingAsStickyBtn) placeDrawingAsStickyBtn.classList.remove('hidden');
    if (whiteboardToolbar) whiteboardToolbar.classList.remove('hidden');
  } else {
    if (whiteboard) whiteboard.classList.add('hidden');
    if (editorToolbar) editorToolbar.classList.remove('hidden');
    if (noteText) noteText.classList.remove('hidden');
    if (insertDropdown) insertDropdown.classList.remove('hidden');
    if (placeDrawingAsStickyBtn) placeDrawingAsStickyBtn.classList.add('hidden');
    if (whiteboardToolbar) whiteboardToolbar.classList.add('hidden');
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
  isDirty = false;
}

function refreshNotesList() {
  var token = getToken();
  if (!token) {
    document.getElementById('notesList').innerHTML = '<li>Set token to list notes</li>';
    document.getElementById('breadcrumb').textContent = '';
    fullNotesTree = [];
    return;
  }
  fetchDefaultBranch().then(function () {
    return fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() });
  }).then(function (res) {
    if (!res.ok) { document.getElementById('notesList').innerHTML = '<li>Could not load tree</li>'; return; }
    return res.json().then(function (data) {
      fullNotesTree = (data.tree || []).filter(function (e) {
        return e.path === NOTES_DIR || (e.path.indexOf(NOTES_DIR + '/') === 0 && e.path !== NOTES_DIR + '/.gitkeep');
      });
      renderNotesList(fullNotesTree);
    });
  }).catch(function () { document.getElementById('notesList').innerHTML = '<li>Error loading notes</li>'; });
}

function renderNotesList(treeToRender, isSearchResult = false) {
  var prefix = NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/';
  var dirs = [], files = [];

  if (isSearchResult) {
    files = treeToRender.map(function (e) {
        return e.path.slice(NOTES_DIR.length + 1);
    }).sort();
  } else {
    treeToRender.forEach(function (e) {
      if (e.path === NOTES_DIR + '/.gitkeep' || !e.path.startsWith(prefix)) return;
      var name = e.path.slice(prefix.length);
      if (name.indexOf('/') >= 0) return;
      if (e.type === 'tree') dirs.push(name); else files.push(name);
    });
    dirs.sort(); files.sort();
  }

  var html = '';
  if (!isSearchResult) {
    html += currentFolder ? '<li class="folder" data-path="" data-type="dir">..</li>' : '';
    dirs.forEach(function (d) { html += '<li class="folder" data-path="' + (currentFolder ? currentFolder + '/' : '') + d + '" data-type="dir">' + d + '/</li>'; });
  }
  
  files.forEach(function (f) {
    var displayName = f;
    var searchInput = document.getElementById('searchInput');
    var query = searchInput ? searchInput.value.trim() : '';
    if (isSearchResult && query) {
      var regex = new RegExp('(' + query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + ')', 'gi');
      displayName = f.replace(regex, '<mark>$1</mark>');
    }
    html += '<li class="file" data-path="' + (isSearchResult ? f : (currentFolder ? currentFolder + '/' : '') + f) + '" data-type="file">' + displayName + '</li>';
  });
  if (html === '') html = '<li>No notes yet</li>';
  document.getElementById('notesList').innerHTML = html;
  document.getElementById('breadcrumb').textContent = isSearchResult ? 'Search Results' : NOTES_DIR + (currentFolder ? '/' + currentFolder : '') + '/';

  document.querySelectorAll('#notesList li[data-path]').forEach(function (li) {
    li.addEventListener('click', function () {
      var path = this.getAttribute('data-path'), type = this.getAttribute('data-type');
      if (type === 'dir') {
        currentFolder = path === '' ? currentFolder.split('/').slice(0, -1).join('/') : path;
        renderNotesList(fullNotesTree);
        if (searchInput) searchInput.value = '';
      } else {
        openNote(NOTES_DIR + '/' + path);
      }
    });
  });
}

function openNote(fullPath) {
  var token = getToken();
  if (!token) { showStatus('Set token first.', false); return; }
  
  if (document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
  }

  openFilePath = fullPath;
  openFileSha = null;
  var pathInput = document.getElementById('pathInput');
  if (pathInput) pathInput.value = fullPath.replace(NOTES_DIR + '/', '');
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
        var noteTextEl = document.getElementById('noteText');
        if (noteTextEl) noteTextEl.value = text;
        toggleWhiteboard(false);
        togglePreview(false);
      }
      isDirty = false;
    }).catch(function (err) { showStatus('Error: ' + err.message, false); });
}

function saveNote(isAutosave = false) {
  var token = getToken();
  if (!token) {
    if (!isAutosave) {
      var fromPrompt = prompt('Paste your GitHub token (stored in browser only):');
      if (fromPrompt && fromPrompt.trim()) { setToken(fromPrompt); token = getToken(); }
      if (!token) { showStatus('Need a token to save.', false); return; }
    } else {
      return;
    }
  }
  var pathInput = document.getElementById('pathInput');
  var pathRel = pathInput ? pathInput.value.trim() : '';
      if (!pathRel) { pathRel = defaultFilename(); if (pathInput) pathInput.value = pathRel; }  if (!isWhiteboardActive && !pathRel.endsWith('.md') && !pathRel.endsWith('.txt') && !pathRel.endsWith('.svg')) pathRel += '.md';
  
  var fullPath = NOTES_DIR + '/' + pathRel;
  var noteContent = '';

  if (isWhiteboardActive) {
    noteContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + mainWhiteboardSvg.innerHTML + '</svg>';
  } else {
    var noteTextEl = document.getElementById('noteText');
    noteContent = noteTextEl ? noteTextEl.value : '';
  }
  
  var url = apiUrl('contents/' + fullPath);
  var body = { message: (isAutosave ? 'Autosave: ' : 'Add note: ') + pathRel, content: base64Utf8(noteContent) };

  ensureNotesDir()
    .then(function () { return fetch(url, { headers: authHeaders() }); })
    .then(function (getRes) { if (getRes.ok) return getRes.json().then(function (data) { body.sha = data.sha; }); })
    .then(function () {
      return fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body) });
    })
    .then(function (res) {
      if (res.ok) {
        if (!isAutosave) {
          showStatus('Saved.', true);
        }
        openFilePath = fullPath;
        isDirty = false;
        return res.json().then(function (d) { openFileSha = (d && d.content && d.content.sha) ? d.content.sha : null; });
      }
      if (!isAutosave) {
        return res.json().then(function (data) {
          var msg = data.message || 'Save failed.';
          if (res.status === 404 || res.status === 403) msg += ' Check token has access to ' + repoOwner + '/' + repoName + '.';
          showStatus(msg, false);
        });
      }
    })
    .then(function () { if (!isAutosave) refreshNotesList(); })
    .catch(function (err) { if (!isAutosave) showStatus('Error: ' + err.message, false); });
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
        var pathInput = document.getElementById('pathInput');
        if (pathInput) pathInput.value = '';
        var noteText = document.getElementById('noteText');
        if (noteText) noteText.value = '';
        mainWhiteboardSvg.innerHTML = '';
        openFilePath = null;
        openFileSha = null;
        isDirty = false;
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
  var pathInput = document.getElementById('pathInput');
  if (pathInput) pathInput.value = currentFolder ? currentFolder + '/' + defaultFilename() : defaultFilename();
  var noteText = document.getElementById('noteText');
  if (noteText) noteText.value = '';
  openFilePath = null;
  openFileSha = null;
  toggleWhiteboard(false);
  togglePreview(false);
  isDirty = false;
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
        isDirty = true;
        triggerAutosave();
      }
    });

    // Handle text changes in contenteditable stickies
    sticky.addEventListener('blur', function() {
      var newHtml = sticky.outerHTML;
      if (newHtml !== originalHtml) {
        textarea.value = textarea.value.replace(originalHtml, newHtml);
        originalHtml = newHtml;
        isDirty = true;
        triggerAutosave();
      }
    });
  });
}

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

  // Sync modal controls with current state
  var modalStroke = document.getElementById('modalStrokeColorInput');
  if (modalStroke) modalStroke.value = currentStrokeColor;
  updateToolSelection();
};

function closeDrawScreen() {
  document.getElementById('drawScreen').classList.add('hidden');
  document.getElementById('top').classList.remove('hidden');
  document.getElementById('mainLayout').classList.remove('hidden');
  activeStickyHtml = null;
}

document.getElementById('saveDrawScreenBtn').addEventListener('click', function() {
  if (activeStickyHtml && modalSvgBoard) {
    var finalSvgString = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="100%" height="100%">' + modalSvgBoard.innerHTML + '</svg>';
    var croppedSvg = cropSvg(finalSvgString);
    
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = activeStickyHtml;
    var stickyEl = tempDiv.firstElementChild;
    var drawPreview = stickyEl ? stickyEl.querySelector('.draw-preview') : null;
    if (drawPreview) drawPreview.innerHTML = croppedSvg;
    
    var newHtml = stickyEl ? stickyEl.outerHTML : '';
    var textarea = document.getElementById('noteText');

    if (textarea && newHtml) {
      if (textarea.value.indexOf(activeStickyHtml) === -1) {
          console.error("Sync Error: activeStickyHtml not found in raw text. String replacement failed.");
          showStatus("Error saving drawing sticky: text changed.", false);
      } else {
          textarea.value = textarea.value.replace(activeStickyHtml, newHtml);
      }
    }
    
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

function addMermaidTemplate() {
  var template = '\n```mermaid\ngraph TD\n    A[Start] --> B{Is it?};\n    B -- Yes --> C[OK];\n    C --> D[End];\n    B -- No --> E[Find out];\n    E --> B;\n```\n';
  var textarea = document.getElementById('noteText');
  var start = textarea.selectionStart;
  textarea.value = textarea.value.slice(0, start) + template + textarea.value.slice(start);
  textarea.selectionStart = textarea.selectionEnd = start + template.length;
  showStatus('Mermaid diagram template added.', true);
}

function togglePreview(on) {
  if (isWhiteboardActive) return; 
  previewOn = on !== undefined ? on : !previewOn;
  var textarea = document.getElementById('noteText');
  var preview = document.getElementById('previewArea');
  
  if (previewOn) {
    if (fullPreview) {
      textarea.classList.remove('side-by-side');
      preview.classList.remove('side-by-side');
      textarea.classList.add('full-view');
      preview.classList.add('full-view');
    } else {
      textarea.classList.remove('full-view');
      preview.classList.remove('full-view');
      textarea.classList.add('side-by-side');
      preview.classList.add('side-by-side');
      preview.contentEditable = "false";
    }
    preview.classList.remove('hidden');
    if (fullPreview) preview.contentEditable = "true";
    var content = textarea.value;
    var path = document.getElementById('pathInput').value || '';
    var isMd = path === '' || path.endsWith('.md'); 
    
    if (typeof marked !== 'undefined' && isMd) {
      preview.innerHTML = (marked.parse || marked)(content || '');
      // Render Mermaid diagrams
      preview.querySelectorAll('pre code.language-mermaid').forEach(function(codeBlock) {
        var mermaidDiv = document.createElement('div');
        mermaidDiv.classList.add('mermaid');
        mermaidDiv.textContent = codeBlock.textContent;
        codeBlock.parentNode.replaceChild(mermaidDiv, codeBlock);
      });
      if (typeof mermaid !== 'undefined') {
        mermaid.run({
          querySelector: '.mermaid'
        });
      }
      initDraggableStickies();
      var rawBase = 'https://raw.githubusercontent.com/' + repoOwner + '/' + repoName + '/' + defaultBranch + '/';
      preview.querySelectorAll('img').forEach(function (img) {
        var src = img.getAttribute('src');
        if (!src) return;
        if (src.startsWith('http') || src.startsWith('data:')) {
          return;
        }
        var fullRaw = rawBase + (src.startsWith(NOTES_DIR) ? src : NOTES_DIR + '/' + src);
        fetch(apiUrl('contents/' + fullRaw.slice(rawBase.length)), { headers: Object.assign({}, authHeaders(), { 'Accept': 'application/vnd.github.raw' }) })
          .then(function (res) { return res.ok ? res.blob() : Promise.reject(new Error('Failed to load image')); })
          .then(function (blob) { img.src = URL.createObjectURL(blob); }).catch(function () {});
      });
    } else {
      preview.textContent = content || '';
    }
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

function uploadImage(callback) {
  var fileInput = document.getElementById('imageFileInput');
  
  var changeListener = function() {
    var file = this.files[0];
    if (!file) return;
    var token = getToken();
    if (!token) { showStatus('Set token first.', false); this.value = ''; return; }
    
    var base = NOTES_DIR + '/images', name = Date.now() + '-' + (file.name || 'image.png'), path = base + '/' + name;
    var url = apiUrl('contents/' + path);
    
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = reader.result.replace(/^data:image\/\w+;base64,/, '');
      var body = { message: 'Add image: ' + name, content: base64 };

      fetch(url, { headers: authHeaders() })
        .then(function(getRes) {
          if (getRes.ok) {
            return getRes.json().then(function(data) {
              body.sha = data.sha;
            });
          }
          return Promise.resolve();
        })
        .then(function() {
          return fetch(url, {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify(body)
          });
        })
        .then(function (res) {
          if (res.ok) {
            return res.json().then(function(data) {
              var rawUrl = (data && data.content && data.content.download_url) ? data.content.download_url : 'https://raw.githubusercontent.com/' + repoOwner + '/' + repoName + '/' + defaultBranch + '/' + path;
              callback(rawUrl);
              refreshNotesList();
            });
          } else {
            return res.json().then(function (d) { showStatus(d.message || 'Upload failed.', false); });
          }
        }).catch(function (err) { showStatus('Error: ' + err.message, false); });
    };
    reader.readAsDataURL(file);
    this.value = '';
  };
  
  fileInput.addEventListener('change', changeListener, { once: true });
  fileInput.click();
}

function addImageSticky() {
  uploadImage(function(url) {
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = '<div class="sticky-note sticky-image" data-x="20" data-y="20" style="left: 20px; top: 20px;"><img src="' + url + '" alt="Image Sticky"></div>';
    var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
    
    var textarea = document.getElementById('noteText');
    var start = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, start) + stickyHtml + textarea.value.slice(start);
    textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;
    if (previewOn) togglePreview(true);
    showStatus('Image sticky added.', true);
  });
}

function addImageLink() {
  uploadImage(function(url) {
    var textarea = document.getElementById('noteText');
    var insert = '![](' + url + ')';
    var start = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(start);
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    if (previewOn) togglePreview(true);
    showStatus('Image link added.', true);
  });
}

function addImageFromUrl() {
  var url = prompt("Please enter the image URL:", "https://");
  if (url) {
    var textarea = document.getElementById('noteText');
    var insert = '![](' + url + ')';
    var start = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, start) + insert + textarea.value.slice(start);
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    if (previewOn) togglePreview(true);
    showStatus('Image link added.', true);
  }
}

var selectedImageUrl = null;

function showImageLibrary() {
  var modal = document.getElementById('imageLibraryModal');
  var list = document.getElementById('imageLibraryList');
  var actions = document.getElementById('imageLibraryActions');
  modal.classList.remove('hidden');
  list.innerHTML = '<li>Loading images...</li>';
  actions.classList.add('hidden');
  selectedImageUrl = null;

  fetch(apiUrl('contents/' + NOTES_DIR + '/images'), { headers: authHeaders() })
    .then(function(res) {
      if (!res.ok) {
        list.innerHTML = '<li>Could not load images. Ensure the `notes/images` directory exists.</li>';
        return;
      }
      return res.json();
    })
    .then(function(data) {
      if (!data || data.length === 0) {
        list.innerHTML = '<li>No images found in the library.</li>';
        return;
      }
      list.innerHTML = '';
      data.forEach(function(file) {
        if (file.type === 'file' && file.download_url) {
          var img = document.createElement('img');
          img.src = file.download_url;
          img.dataset.url = file.download_url;
          img.addEventListener('click', function() {
            list.querySelectorAll('img').forEach(function(i) { i.classList.remove('selected'); });
            this.classList.add('selected');
            selectedImageUrl = this.dataset.url;
            actions.classList.remove('hidden');
          });
          list.appendChild(img);
        }
      });
    });
}

function showWhiteboardModal(asSticky) {
  isPlacingAsSticky = !!asSticky;
  var token = getToken();
  if (!token) {
    showStatus('Set token to list whiteboards.', false);
    return;
  }
  var modal = document.getElementById('whiteboardModal');
  modal.classList.remove('hidden');

  var list = document.getElementById('whiteboardList');
  list.innerHTML = '<li>Loading...</li>';

  fetch(apiUrl('git/trees/' + defaultBranch + '?recursive=1'), { headers: authHeaders() })
    .then(function (res) {
      if (!res.ok) {
        list.innerHTML = '<li>Could not load tree</li>';
        return;
      }
      return res.json().then(function (data) {
        var svgFiles = (data.tree || []).filter(function (e) {
          return e.path.startsWith(NOTES_DIR + '/') && e.path.endsWith('.svg');
        });

        if (svgFiles.length === 0) {
          list.innerHTML = '<li>No whiteboards found.</li>';
          return;
        }

        var html = '';
        svgFiles.forEach(function (file) {
          html += '<li data-path="' + file.path + '">' + file.path.replace(NOTES_DIR + '/', '') + '</li>';
        });
        list.innerHTML = html;

        document.querySelectorAll('#whiteboardList li[data-path]').forEach(function (li) {
          li.addEventListener('click', function () {
            var path = this.getAttribute('data-path');
            if (isPlacingAsSticky) {
              placeWhiteboardAsSticky(path);
            } else {
              placeWhiteboard(path);
            }
          });
        });
      });
    })
    .catch(function () {
      list.innerHTML = '<li>Error loading whiteboards</li>';
    });
}

function placeCurrentDrawingAsSticky() {
  if (!isWhiteboardActive) {
    showStatus("No active drawing to place.", false);
    return;
  }

  var svgInnerContent = mainWhiteboardSvg.innerHTML;
  if (!svgInnerContent.trim()) {
    showStatus("Drawing is empty.", false);
    return;
  }

  var fullSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + svgInnerContent + '</svg>';
  var croppedSvg = cropSvg(fullSvg);

  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = '<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + croppedSvg + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>';
  var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
  
  var textarea = document.getElementById('noteText');
  var start = textarea.selectionStart, end = textarea.selectionEnd;
  var text = textarea.value;
  textarea.value = text.slice(0, start) + stickyHtml + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;

  toggleWhiteboard(false);
  togglePreview(true);
  showStatus('Drawing placed as sticky.', true);
}

function placeWhiteboardAsSticky(filePath) {
  var token = getToken();
  if (!token) {
    showStatus('Set token first.', false);
    return;
  }

  fetch(apiUrl('contents/' + filePath), { headers: authHeaders() })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || 'Failed to load'); });
      return res.json();
    })
    .then(function (d) {
      var svgContent = (d.content != null && d.encoding === 'base64') ? decodeBase64Utf8(d.content) : (d.content || '');
      var croppedSvg = cropSvg(svgContent);
      
      var tempDiv = document.createElement('div');
      tempDiv.innerHTML = '<div class="sticky-note sticky-draw" data-x="20" data-y="20" style="left: 20px; top: 20px;"><div class="draw-preview">' + croppedSvg + '</div><button class="edit-draw-btn" onclick="window.openDrawScreen(this.parentElement)">✏️ Edit</button></div>';
      var stickyHtml = '\n' + tempDiv.firstElementChild.outerHTML + '\n';
      
      var textarea = document.getElementById('noteText');
      var start = textarea.selectionStart, end = textarea.selectionEnd;
      var text = textarea.value;
      textarea.value = text.slice(0, start) + stickyHtml + text.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + stickyHtml.length;
      
      if (previewOn) togglePreview(true);
      showStatus('Whiteboard placed as sticky.', true);
      document.getElementById('whiteboardModal').classList.add('hidden');
    })
    .catch(function (err) {
      showStatus('Error: ' + err.message, false);
    });
}

function placeWhiteboard(filePath) {
  var token = getToken();
  if (!token) {
    showStatus('Set token first.', false);
    return;
  }

  fetch(apiUrl('contents/' + filePath), { headers: authHeaders() })
    .then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || 'Failed to load'); });
      return res.json();
    })
    .then(function (d) {
      var svgContent = (d.content != null && d.encoding === 'base64') ? decodeBase64Utf8(d.content) : (d.content || '');
      var croppedSvg = cropSvg(svgContent);
      var dataUri = 'data:image/svg+xml;base64,' + btoa(croppedSvg);
      var textarea = document.getElementById('noteText');
      var insert = '![whiteboard](' + dataUri + ')';
      var start = textarea.selectionStart, end = textarea.selectionEnd, text = textarea.value;
      textarea.value = text.slice(0, start) + insert + text.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
      showStatus('Whiteboard placed.', true);
      document.getElementById('whiteboardModal').classList.add('hidden');
    })
    .catch(function (err) {
      showStatus('Error: ' + err.message, false);
    });
}

function cropSvg(svgContent) {
  var parser = new DOMParser();
  var svgDoc = parser.parseFromString(svgContent, "image/svg+xml");
  var svg = svgDoc.documentElement;
  var bbox = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  var elements = svg.querySelectorAll('path, rect, circle');
  if (elements.length === 0) {
    return svgContent;
  }

  elements.forEach(function(el) {
    if (el.tagName.toLowerCase() === 'path') {
      var d = el.getAttribute('d');
      var commands = d.split(/(?=[LMCHVZ])/);
      commands.forEach(function(command) {
        var points = command.slice(1).trim().split(/[\s,]+/);
        var x = parseFloat(points[points.length - 2]);
        var y = parseFloat(points[points.length - 1]);

        if (!isNaN(x) && !isNaN(y)) {
          bbox.minX = Math.min(bbox.minX, x);
          bbox.minY = Math.min(bbox.minY, y);
          bbox.maxX = Math.max(bbox.maxX, x);
          bbox.maxY = Math.max(bbox.maxY, y);
        }
      });
    } else if (el.tagName.toLowerCase() === 'rect') {
      var x = parseFloat(el.getAttribute('x'));
      var y = parseFloat(el.getAttribute('y'));
      var w = parseFloat(el.getAttribute('width'));
      var h = parseFloat(el.getAttribute('height'));
      bbox.minX = Math.min(bbox.minX, x);
      bbox.minY = Math.min(bbox.minY, y);
      bbox.maxX = Math.max(bbox.maxX, x + w);
      bbox.maxY = Math.max(bbox.maxY, y + h);
    } else if (el.tagName.toLowerCase() === 'circle') {
      var cx = parseFloat(el.getAttribute('cx'));
      var cy = parseFloat(el.getAttribute('cy'));
      var r = parseFloat(el.getAttribute('r'));
      bbox.minX = Math.min(bbox.minX, cx - r);
      bbox.minY = Math.min(bbox.minY, cy - r);
      bbox.maxX = Math.max(bbox.maxX, cx + r);
      bbox.maxY = Math.max(bbox.maxY, cy + r);
    }
  });

  var padding = 10;
  var x = bbox.minX - padding;
  var y = bbox.minY - padding;
  var width = bbox.maxX - bbox.minX + padding * 2;
  var height = bbox.maxY - bbox.minY + padding * 2;

  svg.setAttribute('viewBox', x + ' ' + y + ' ' + width + ' ' + height);

  var serializer = new XMLSerializer();
  return serializer.serializeToString(svg);
}
