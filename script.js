/* ═══════════════════════════════════════════════════════════
   denkr — script.js
   Infinite whiteboard engine — Vanilla JS, no dependencies
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────────
   APPLICATION STATE
   ────────────────────────────────────────────────────────── */
const State = {
  // Canvas transform
  panX: 0,
  panY: 0,
  zoom: 1,

  // Nodes & connections
  nodes: new Map(),       // id → node data
  connections: [],        // { id, fromId, toId, fromPort, toPort }
  nextId: 1,

  // Interaction
  selectedIds: new Set(),
  isDragging: false,
  isPanning: false,
  isSpaceDown: false,
  isDrawingConnection: false,
  connectionStart: null,  // { nodeId, port, x, y }
  isSelecting: false,
  selectionRect: null,
  isDarkMode: false,

  // History (undo/redo)
  history: [],
  historyIndex: -1,
  MAX_HISTORY: 60,

  // Settings
  settings: {
    showGrid: true,
    snapToGrid: false,
    snapSize: 24,
    animations: true,
    curvedLines: true,
    font: 'Inter',
  },

  // Clipboard
  clipboard: [],
};

/* ──────────────────────────────────────────────────────────
   DOM REFERENCES
   ────────────────────────────────────────────────────────── */
const DOM = {
  canvas: document.getElementById('canvas'),
  canvasWrapper: document.getElementById('canvasWrapper'),
  canvasGrid: document.getElementById('canvasGrid'),
  nodesLayer: document.getElementById('nodesLayer'),
  connectionsSvg: document.getElementById('connectionsSvg'),
  connectionsGroup: document.getElementById('connectionsGroup'),
  tempConnection: document.getElementById('tempConnection'),
  boardName: document.getElementById('boardName'),
  zoomLabel: document.getElementById('zoomLabel'),
  minimapCanvas: document.getElementById('minimapCanvas'),
  minimapViewport: document.getElementById('minimapViewport'),
  contextMenu: document.getElementById('contextMenu'),
  searchPanel: document.getElementById('searchPanel'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  exportMenu: document.getElementById('exportMenu'),
  toastContainer: document.getElementById('toastContainer'),
  fileInputImage: document.getElementById('fileInputImage'),
  fileInputPdf: document.getElementById('fileInputPdf'),
  fileInputOpen: document.getElementById('fileInputOpen'),
  darkModeIcon: document.getElementById('darkModeIcon'),
};

/* ──────────────────────────────────────────────────────────
   UTILITIES
   ────────────────────────────────────────────────────────── */
const uid = () => `n${State.nextId++}`;

const snap = (val, grid) =>
  State.settings.snapToGrid ? Math.round(val / grid) * grid : val;

const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

/** Convert screen coordinates to canvas coordinates */
const screenToCanvas = (sx, sy) => ({
  x: (sx - State.panX) / State.zoom,
  y: (sy - State.panY) / State.zoom,
});

/** Convert canvas coordinates to screen coordinates */
const canvasToScreen = (cx, cy) => ({
  x: cx * State.zoom + State.panX,
  y: cy * State.zoom + State.panY,
});

function showToast(msg, duration = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('exiting');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

/* ──────────────────────────────────────────────────────────
   CANVAS TRANSFORM
   ────────────────────────────────────────────────────────── */
function applyTransform() {
  DOM.canvas.style.transform = `translate(${State.panX}px, ${State.panY}px) scale(${State.zoom})`;
  DOM.zoomLabel.textContent = `${Math.round(State.zoom * 100)}%`;
  updateGrid();
  updateMinimap();
}

function updateGrid() {
  const size = 24 * State.zoom;
  const ox = State.panX % size;
  const oy = State.panY % size;
  DOM.canvasGrid.style.backgroundSize = `${size}px ${size}px`;
  DOM.canvasGrid.style.backgroundPosition = `${ox}px ${oy}px`;
}

function zoomTo(newZoom, pivotX, pivotY) {
  newZoom = clamp(newZoom, 0.08, 4);
  const px = pivotX ?? DOM.canvasWrapper.clientWidth / 2;
  const py = pivotY ?? DOM.canvasWrapper.clientHeight / 2;
  const worldX = (px - State.panX) / State.zoom;
  const worldY = (py - State.panY) / State.zoom;
  State.zoom = newZoom;
  State.panX = px - worldX * State.zoom;
  State.panY = py - worldY * State.zoom;
  applyTransform();
}

function centerView(x, y, zoom = 1) {
  const w = DOM.canvasWrapper.clientWidth;
  const h = DOM.canvasWrapper.clientHeight;
  State.zoom = zoom;
  State.panX = w / 2 - x * zoom;
  State.panY = h / 2 - y * zoom;
  applyTransform();
}

function fitAll() {
  if (State.nodes.size === 0) { centerView(0, 0, 1); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.nodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  const pw = DOM.canvasWrapper.clientWidth;
  const ph = DOM.canvasWrapper.clientHeight;
  const contentW = maxX - minX + 120;
  const contentH = maxY - minY + 120;
  const z = clamp(Math.min(pw / contentW, ph / contentH), 0.1, 1.5);
  centerView(minX + contentW / 2 - 60, minY + contentH / 2 - 60, z);
}

/* ──────────────────────────────────────────────────────────
   HISTORY (UNDO / REDO)
   ────────────────────────────────────────────────────────── */
function saveHistory() {
  const snapshot = {
    nodes: JSON.parse(JSON.stringify([...State.nodes.entries()])),
    connections: JSON.parse(JSON.stringify(State.connections)),
    nextId: State.nextId,
  };
  // Truncate forward history
  State.history = State.history.slice(0, State.historyIndex + 1);
  State.history.push(snapshot);
  if (State.history.length > State.MAX_HISTORY) State.history.shift();
  else State.historyIndex++;
}

function undo() {
  if (State.historyIndex <= 0) return;
  State.historyIndex--;
  restoreSnapshot(State.history[State.historyIndex]);
  showToast('Rückgängig');
}

function redo() {
  if (State.historyIndex >= State.history.length - 1) return;
  State.historyIndex++;
  restoreSnapshot(State.history[State.historyIndex]);
  showToast('Wiederherstellen');
}

function restoreSnapshot(snapshot) {
  State.nodes = new Map(snapshot.nodes.map(([id, n]) => [id, { ...n }]));
  State.connections = JSON.parse(JSON.stringify(snapshot.connections));
  State.nextId = snapshot.nextId;
  State.selectedIds.clear();
  rebuildDOM();
  renderConnections();
}

/* ──────────────────────────────────────────────────────────
   NODE FACTORY
   ────────────────────────────────────────────────────────── */
const NODE_DEFAULTS = {
  note:     { width: 220, height: 160, title: 'Notiz',      icon: 'fa-note-sticky' },
  richtext: { width: 300, height: 260, title: 'Dokument',   icon: 'fa-file-lines' },
  image:    { width: 240, height: 200, title: 'Bild',       icon: 'fa-image' },
  pdf:      { width: 240, height: 180, title: 'PDF',        icon: 'fa-file-pdf' },
  link:     { width: 260, height: 160, title: 'Link',       icon: 'fa-link' },
  task:     { width: 240, height: 220, title: 'Aufgaben',   icon: 'fa-list-check' },
  center:   { width: 230, height: 80,  title: 'Neues Board',icon: 'fa-compass' },
};

function createNode(type, x, y, extra = {}) {
  const def = NODE_DEFAULTS[type] || NODE_DEFAULTS.note;
  const id = uid();
  const node = {
    id,
    type,
    x: snap(x - def.width / 2, State.settings.snapSize),
    y: snap(y - def.height / 2, State.settings.snapSize),
    width: def.width,
    height: def.height,
    title: def.title,
    // Type-specific data
    content: '',
    tasks: [],
    imageData: null,
    pdfName: null,
    linkUrl: '',
    linkTitle: '',
    richtextHtml: '',
    ...extra,
  };
  State.nodes.set(id, node);
  renderNode(id);
  saveHistory();
  return id;
}

/* ──────────────────────────────────────────────────────────
   NODE RENDERING
   ────────────────────────────────────────────────────────── */
function renderNode(id) {
  const node = State.nodes.get(id);
  if (!node) return;

  // Remove existing element if present
  const existing = document.getElementById(`node-${id}`);
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = `node-${id}`;
  el.className = `node node--${node.type}`;
  el.style.cssText = `
    left:${node.x}px;
    top:${node.y}px;
    width:${node.width}px;
    height:${node.height}px;
  `;
  el.dataset.id = id;

  el.innerHTML = buildNodeHTML(node);
  DOM.nodesLayer.appendChild(el);

  // Wire up interactivity
  wireNodeEvents(el, node);
  updateSelectionVisual(id);
}

function buildNodeHTML(node) {
  const actionBtns = `
    <div class="node-actions">
      <button class="node-action-btn" data-action="duplicate" title="Duplizieren">
        <i class="fa-regular fa-copy"></i>
      </button>
      <button class="node-action-btn" data-action="connect-mode" title="Verbinden">
        <i class="fa-regular fa-link"></i>
      </button>
      <button class="node-action-btn danger" data-action="delete" title="Löschen">
        <i class="fa-regular fa-trash-can"></i>
      </button>
    </div>
  `;

  const handle = `
    <div class="node-handle">
      <i class="fa-regular ${NODE_DEFAULTS[node.type]?.icon || 'fa-circle'} node-type-icon"></i>
      <input class="node-title-input" value="${escapeAttr(node.title)}" placeholder="Titel…" spellcheck="false" />
      ${actionBtns}
    </div>
  `;

  const ports = `
    <div class="connection-port port-top" data-port="top" data-id="${node.id}"></div>
    <div class="connection-port port-bottom" data-port="bottom" data-id="${node.id}"></div>
    <div class="connection-port port-left" data-port="left" data-id="${node.id}"></div>
    <div class="connection-port port-right" data-port="right" data-id="${node.id}"></div>
    <div class="node-resize-handle" data-id="${node.id}"></div>
  `;

  let body = '';
  switch (node.type) {
    case 'note':
    case 'center':
      body = `
        <div class="node-body">
          <textarea class="note-content" placeholder="Gedanken notieren…" spellcheck="false">${escapeText(node.content)}</textarea>
        </div>`;
      break;

    case 'richtext':
      body = buildRichTextBody(node);
      break;

    case 'image':
      body = node.imageData
        ? `<div class="node-body" style="padding:0;"><img class="image-block-img" src="${node.imageData}" alt="${escapeAttr(node.title)}" /></div>`
        : `<div class="node-body"><div class="image-placeholder" data-action="upload-image"><i class="fa-regular fa-image"></i><span>Bild hochladen</span></div></div>`;
      break;

    case 'pdf':
      body = `<div class="node-body"><div class="pdf-preview">
        ${node.pdfName
          ? `<div class="pdf-info"><i class="fa-regular fa-file-pdf"></i><span>${escapeText(node.pdfName)}</span></div>`
          : `<div class="pdf-placeholder" data-action="upload-pdf"><i class="fa-regular fa-file-pdf"></i><span>PDF hochladen</span></div>`
        }
      </div></div>`;
      break;

    case 'link':
      body = `<div class="node-body">
        <div class="link-input-wrapper">
          <input class="link-url-input" type="url" value="${escapeAttr(node.linkUrl)}" placeholder="https://…" />
          <button class="link-go-btn" data-action="open-link"><i class="fa-regular fa-arrow-up-right-from-square"></i></button>
        </div>
        ${node.linkTitle ? `<div class="link-preview"><div class="link-preview-inner">
          <div class="link-preview-title">${escapeText(node.linkTitle)}</div>
          <div class="link-preview-url">${escapeText(node.linkUrl)}</div>
        </div></div>` : ''}
      </div>`;
      break;

    case 'task':
      body = buildTaskBody(node);
      break;
  }

  return handle + body + ports;
}

function buildRichTextBody(node) {
  return `
    <div class="richtext-toolbar">
      <button class="rt-btn" data-cmd="bold" title="Fett"><i class="fa-solid fa-bold"></i></button>
      <button class="rt-btn" data-cmd="italic" title="Kursiv"><i class="fa-solid fa-italic"></i></button>
      <button class="rt-btn" data-cmd="underline" title="Unterstrichen"><i class="fa-solid fa-underline"></i></button>
      <div class="rt-separator"></div>
      <button class="rt-btn" data-cmd="h1" title="Überschrift 1">H1</button>
      <button class="rt-btn" data-cmd="h2" title="Überschrift 2">H2</button>
      <button class="rt-btn" data-cmd="h3" title="Überschrift 3">H3</button>
      <div class="rt-separator"></div>
      <button class="rt-btn" data-cmd="insertUnorderedList" title="Liste"><i class="fa-solid fa-list-ul"></i></button>
      <button class="rt-btn" data-cmd="insertOrderedList" title="Nummerierung"><i class="fa-solid fa-list-ol"></i></button>
      <div class="rt-separator"></div>
      <button class="rt-btn" data-cmd="justifyLeft" title="Links"><i class="fa-solid fa-align-left"></i></button>
      <button class="rt-btn" data-cmd="justifyCenter" title="Mitte"><i class="fa-solid fa-align-center"></i></button>
      <button class="rt-btn" data-cmd="justifyRight" title="Rechts"><i class="fa-solid fa-align-right"></i></button>
      <div class="rt-separator"></div>
      <button class="rt-btn" data-cmd="blockquote" title="Zitat"><i class="fa-solid fa-quote-left"></i></button>
      <button class="rt-btn" data-cmd="code" title="Code"><i class="fa-solid fa-code"></i></button>
    </div>
    <div class="richtext-editor" contenteditable="true" spellcheck="false">${node.richtextHtml || ''}</div>
  `;
}

function buildTaskBody(node) {
  const tasks = node.tasks || [];
  const done = tasks.filter(t => t.done).length;
  const total = tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const taskItems = tasks.map(t => `
    <div class="task-item" data-task-id="${t.id}">
      <div class="task-checkbox ${t.done ? 'checked' : ''}" data-task-check="${t.id}"></div>
      <input class="task-text ${t.done ? 'done' : ''}" value="${escapeAttr(t.text)}" placeholder="Aufgabe…" data-task-text="${t.id}" />
      <button class="task-delete-btn" data-task-del="${t.id}"><i class="fa-regular fa-xmark"></i></button>
    </div>
  `).join('');

  return `<div class="node-body">
    <div class="task-list">${taskItems}</div>
    <button class="task-add-btn" data-action="add-task">
      <i class="fa-regular fa-plus"></i> Aufgabe hinzufügen
    </button>
    <div class="task-progress">
      <span>${done}/${total}</span>
      <div class="task-progress-bar">
        <div class="task-progress-fill" style="width:${pct}%"></div>
      </div>
      <span>${pct}%</span>
    </div>
  </div>`;
}

/* ──────────────────────────────────────────────────────────
   NODE EVENTS
   ────────────────────────────────────────────────────────── */
function wireNodeEvents(el, node) {
  const id = node.id;

  // ── DRAG (via handle)
  const handle = el.querySelector('.node-handle');
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    startNodeDrag(e, id);
  });

  // ── SELECT on click
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-action-btn, .connection-port, .node-resize-handle')) return;
    if (!e.shiftKey) {
      if (!State.selectedIds.has(id)) selectOnly(id);
    } else {
      toggleSelect(id);
    }
  });

  // ── ACTION BUTTONS
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    handleNodeAction(btn.dataset.action, id, btn);
  });

  // ── TITLE INPUT
  const titleInput = el.querySelector('.node-title-input');
  titleInput.addEventListener('input', () => {
    node.title = titleInput.value;
  });
  titleInput.addEventListener('blur', () => saveHistory());

  // ── CONTENT-SPECIFIC INPUTS
  wireContentEvents(el, node);

  // ── CONNECTION PORTS
  el.querySelectorAll('.connection-port').forEach(port => {
    port.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startConnectionDraw(e, id, port.dataset.port);
    });
  });

  // ── RESIZE
  const resizeHandle = el.querySelector('.node-resize-handle');
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startResize(e, id);
  });

  // ── RIGHT CLICK
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectOnly(id);
    showContextMenu(e.clientX, e.clientY, id);
  });
}

function wireContentEvents(el, node) {
  switch (node.type) {
    case 'note':
    case 'center': {
      const ta = el.querySelector('.note-content');
      if (!ta) return;
      ta.addEventListener('input', () => { node.content = ta.value; });
      ta.addEventListener('blur', () => saveHistory());
      ta.addEventListener('mousedown', e => e.stopPropagation());
      break;
    }
    case 'richtext': {
      const editor = el.querySelector('.richtext-editor');
      if (!editor) return;
      editor.addEventListener('mousedown', e => e.stopPropagation());
      editor.addEventListener('input', () => { node.richtextHtml = editor.innerHTML; });
      editor.addEventListener('blur', () => saveHistory());
      // Toolbar
      el.querySelectorAll('.rt-btn').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const cmd = btn.dataset.cmd;
          if (cmd === 'h1') document.execCommand('formatBlock', false, 'h1');
          else if (cmd === 'h2') document.execCommand('formatBlock', false, 'h2');
          else if (cmd === 'h3') document.execCommand('formatBlock', false, 'h3');
          else if (cmd === 'blockquote') document.execCommand('formatBlock', false, 'blockquote');
          else if (cmd === 'code') {
            const sel = window.getSelection();
            if (sel.rangeCount) {
              const range = sel.getRangeAt(0);
              const code = document.createElement('code');
              range.surroundContents(code);
            }
          } else {
            document.execCommand(cmd, false, null);
          }
          node.richtextHtml = editor.innerHTML;
        });
      });
      break;
    }
    case 'task': {
      wireTaskEvents(el, node);
      break;
    }
    case 'link': {
      const urlInput = el.querySelector('.link-url-input');
      if (!urlInput) return;
      urlInput.addEventListener('mousedown', e => e.stopPropagation());
      urlInput.addEventListener('input', () => { node.linkUrl = urlInput.value; });
      urlInput.addEventListener('blur', () => saveHistory());
      break;
    }
  }
}

function wireTaskEvents(el, node) {
  const list = el.querySelector('.task-list');
  if (!list) return;

  // Stop propagation inside task body
  el.querySelector('.node-body')?.addEventListener('mousedown', e => {
    if (!e.target.closest('.node-handle')) e.stopPropagation();
  });

  // Checkboxes
  list.addEventListener('click', (e) => {
    const check = e.target.closest('[data-task-check]');
    if (check) {
      const tid = check.dataset.taskCheck;
      const task = node.tasks.find(t => t.id === tid);
      if (task) {
        task.done = !task.done;
        refreshTaskNode(el, node);
        saveHistory();
      }
    }
    const del = e.target.closest('[data-task-del]');
    if (del) {
      const tid = del.dataset.taskDel;
      node.tasks = node.tasks.filter(t => t.id !== tid);
      refreshTaskNode(el, node);
      saveHistory();
    }
  });

  // Text input changes
  list.addEventListener('input', (e) => {
    const textInput = e.target.closest('[data-task-text]');
    if (textInput) {
      const tid = textInput.dataset.taskText;
      const task = node.tasks.find(t => t.id === tid);
      if (task) task.text = textInput.value;
    }
  });

  // Add task button
  const addBtn = el.querySelector('[data-action="add-task"]');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      node.tasks.push({ id: uid(), text: '', done: false });
      refreshTaskNode(el, node);
      // Focus last input
      const inputs = el.querySelectorAll('.task-text');
      if (inputs.length) inputs[inputs.length - 1].focus();
      saveHistory();
    });
  }
}

function handleNodeAction(action, id, btn) {
  switch (action) {
    case 'delete':
      deleteNode(id);
      break;
    case 'duplicate':
      duplicateNode(id);
      break;
    case 'upload-image':
      State._pendingImageNodeId = id;
      DOM.fileInputImage.click();
      break;
    case 'upload-pdf':
      State._pendingPdfNodeId = id;
      DOM.fileInputPdf.click();
      break;
    case 'open-link': {
      const node = State.nodes.get(id);
      if (node?.linkUrl) window.open(node.linkUrl, '_blank', 'noopener');
      break;
    }
    case 'connect-mode':
      showToast('Klicke auf einen Port (Kreis) zum Verbinden');
      break;
  }
}

function refreshTaskNode(el, node) {
  const body = el.querySelector('.node-body');
  if (body) body.innerHTML = buildTaskBody(node).match(/<div class="node-body">([\s\S]*)<\/div>$/)?.[1] || '';
  // Re-build properly
  const newBody = document.createElement('div');
  newBody.innerHTML = buildTaskBody(node);
  const newBodyEl = newBody.querySelector('.node-body');
  if (newBodyEl && body) {
    body.innerHTML = newBodyEl.innerHTML;
    wireTaskEvents(el, node);
  }
}

/* ──────────────────────────────────────────────────────────
   DRAG (NODE MOVEMENT)
   ────────────────────────────────────────────────────────── */
let dragState = null;

function startNodeDrag(e, id) {
  if (!State.selectedIds.has(id)) selectOnly(id);

  const startPositions = new Map();
  State.selectedIds.forEach(sid => {
    const n = State.nodes.get(sid);
    if (n) startPositions.set(sid, { x: n.x, y: n.y });
  });

  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    startPositions,
    moved: false,
  };

  State.isDragging = true;

  const onMove = (ev) => {
    const dx = (ev.clientX - dragState.startX) / State.zoom;
    const dy = (ev.clientY - dragState.startY) / State.zoom;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.moved = true;
    }
    State.selectedIds.forEach(sid => {
      const n = State.nodes.get(sid);
      const start = dragState.startPositions.get(sid);
      if (!n || !start) return;
      n.x = snap(start.x + dx, State.settings.snapSize);
      n.y = snap(start.y + dy, State.settings.snapSize);
      const el = document.getElementById(`node-${sid}`);
      if (el) {
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.classList.add('dragging');
      }
    });
    renderConnections();
    updateMinimap();
  };

  const onUp = () => {
    State.isDragging = false;
    State.selectedIds.forEach(sid => {
      const el = document.getElementById(`node-${sid}`);
      if (el) el.classList.remove('dragging');
    });
    if (dragState?.moved) saveHistory();
    dragState = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ──────────────────────────────────────────────────────────
   RESIZE
   ────────────────────────────────────────────────────────── */
function startResize(e, id) {
  const node = State.nodes.get(id);
  if (!node) return;
  const startW = node.width;
  const startH = node.height;
  const startX = e.clientX;
  const startY = e.clientY;

  const onMove = (ev) => {
    const dw = (ev.clientX - startX) / State.zoom;
    const dh = (ev.clientY - startY) / State.zoom;
    node.width = Math.max(160, startW + dw);
    node.height = Math.max(80, startH + dh);
    const el = document.getElementById(`node-${id}`);
    if (el) {
      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
    }
    renderConnections();
  };

  const onUp = () => {
    saveHistory();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ──────────────────────────────────────────────────────────
   SELECTION
   ────────────────────────────────────────────────────────── */
function selectOnly(id) {
  State.selectedIds.clear();
  if (id) State.selectedIds.add(id);
  updateAllSelectionVisuals();
}

function toggleSelect(id) {
  if (State.selectedIds.has(id)) State.selectedIds.delete(id);
  else State.selectedIds.add(id);
  updateAllSelectionVisuals();
}

function clearSelection() {
  State.selectedIds.clear();
  updateAllSelectionVisuals();
}

function updateAllSelectionVisuals() {
  State.nodes.forEach((_, id) => updateSelectionVisual(id));
}

function updateSelectionVisual(id) {
  const el = document.getElementById(`node-${id}`);
  if (!el) return;
  if (State.selectedIds.has(id)) el.classList.add('selected');
  else el.classList.remove('selected');
}

/* Rectangle selection */
let selRect = null;
let selRectEl = null;

function startRectangleSelect(e) {
  const rect = DOM.canvasWrapper.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  selRect = { sx, sy, ex: sx, ey: sy };
  selRectEl = document.createElement('div');
  selRectEl.className = 'selection-rect';
  DOM.canvasWrapper.appendChild(selRectEl);
  State.isSelecting = true;

  const onMove = (ev) => {
    selRect.ex = ev.clientX - rect.left;
    selRect.ey = ev.clientY - rect.top;
    const x = Math.min(selRect.sx, selRect.ex);
    const y = Math.min(selRect.sy, selRect.ey);
    const w = Math.abs(selRect.ex - selRect.sx);
    const h = Math.abs(selRect.ey - selRect.sy);
    selRectEl.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
    // Find intersecting nodes
    const cStart = screenToCanvas(Math.min(selRect.sx, selRect.ex) + rect.left, Math.min(selRect.sy, selRect.ey) + rect.top);
    const cEnd = screenToCanvas(Math.max(selRect.sx, selRect.ex) + rect.left, Math.max(selRect.sy, selRect.ey) + rect.top);
    State.selectedIds.clear();
    State.nodes.forEach((n, id) => {
      if (n.x < cEnd.x && n.x + n.width > cStart.x &&
          n.y < cEnd.y && n.y + n.height > cStart.y) {
        State.selectedIds.add(id);
      }
    });
    updateAllSelectionVisuals();
  };

  const onUp = () => {
    if (selRectEl) { selRectEl.remove(); selRectEl = null; }
    State.isSelecting = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ──────────────────────────────────────────────────────────
   CONNECTIONS
   ────────────────────────────────────────────────────────── */
function getPortPosition(nodeId, port) {
  const node = State.nodes.get(nodeId);
  if (!node) return { x: 0, y: 0 };
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  switch (port) {
    case 'top':    return { x: cx, y: node.y };
    case 'bottom': return { x: cx, y: node.y + node.height };
    case 'left':   return { x: node.x, y: cy };
    case 'right':  return { x: node.x + node.width, y: cy };
    default:       return { x: cx, y: cy };
  }
}

function buildConnectionPath(x1, y1, x2, y2, curved = true) {
  if (!curved) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx1 = x1 + dx * 0.5;
  const cy1 = y1;
  const cx2 = x1 + dx * 0.5;
  const cy2 = y2;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

function renderConnections() {
  const g = DOM.connectionsGroup;
  g.innerHTML = '';

  State.connections.forEach(conn => {
    const from = getPortPosition(conn.fromId, conn.fromPort);
    const to = getPortPosition(conn.toId, conn.toPort);
    const d = buildConnectionPath(from.x, from.y, to.x, to.y, State.settings.curvedLines);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'connection-path');
    path.setAttribute('marker-end', 'url(#arrowhead)');
    path.dataset.connId = conn.id;

    path.addEventListener('click', (e) => {
      e.stopPropagation();
      // Select / delete connection
      if (e.shiftKey || confirm('Verbindung löschen?')) {
        State.connections = State.connections.filter(c => c.id !== conn.id);
        renderConnections();
        saveHistory();
      }
    });

    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      State.connections = State.connections.filter(c => c.id !== conn.id);
      renderConnections();
      saveHistory();
      showToast('Verbindung entfernt');
    });

    g.appendChild(path);
  });
}

function startConnectionDraw(e, nodeId, port) {
  State.isDrawingConnection = true;
  const from = getPortPosition(nodeId, port);
  State.connectionStart = { nodeId, port, x: from.x, y: from.y };

  DOM.tempConnection.style.display = 'block';

  const onMove = (ev) => {
    const canvasRect = DOM.canvasWrapper.getBoundingClientRect();
    const mx = (ev.clientX - canvasRect.left - State.panX) / State.zoom;
    const my = (ev.clientY - canvasRect.top - State.panY) / State.zoom;
    const d = buildConnectionPath(from.x, from.y, mx, my, State.settings.curvedLines);
    DOM.tempConnection.setAttribute('d', d);
  };

  const onUp = (ev) => {
    DOM.tempConnection.style.display = 'none';
    State.isDrawingConnection = false;

    // Check if released on a port
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const port = target?.closest('.connection-port');
    if (port && port.dataset.id !== nodeId) {
      addConnection(nodeId, State.connectionStart.port, port.dataset.id, port.dataset.port);
    }

    State.connectionStart = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function addConnection(fromId, fromPort, toId, toPort) {
  // Avoid duplicates
  const exists = State.connections.some(c =>
    c.fromId === fromId && c.toId === toId && c.fromPort === fromPort && c.toPort === toPort
  );
  if (exists) return;

  State.connections.push({
    id: uid(),
    fromId, fromPort, toId, toPort,
  });
  renderConnections();
  saveHistory();
}

/* ──────────────────────────────────────────────────────────
   NODE OPERATIONS
   ────────────────────────────────────────────────────────── */
function deleteNode(id) {
  const ids = id ? [id] : [...State.selectedIds];
  ids.forEach(sid => {
    State.nodes.delete(sid);
    document.getElementById(`node-${sid}`)?.remove();
    State.connections = State.connections.filter(c => c.fromId !== sid && c.toId !== sid);
  });
  State.selectedIds.clear();
  renderConnections();
  saveHistory();
  showToast(ids.length > 1 ? `${ids.length} Elemente gelöscht` : 'Element gelöscht');
}

function duplicateNode(id) {
  const source = State.nodes.get(id);
  if (!source) return;
  const newId = createNode(source.type, source.x + source.width / 2 + 32, source.y + source.height / 2 + 32, {
    ...source,
    id: undefined,
    x: undefined,
    y: undefined,
    title: source.title + ' (Kopie)',
    tasks: source.tasks ? source.tasks.map(t => ({ ...t, id: uid() })) : [],
  });
  selectOnly(newId);
  showToast('Dupliziert');
}

function copySelected() {
  State.clipboard = [...State.selectedIds].map(id => {
    const n = State.nodes.get(id);
    return n ? JSON.parse(JSON.stringify(n)) : null;
  }).filter(Boolean);
  showToast(`${State.clipboard.length} Element(e) kopiert`);
}

function pasteClipboard() {
  if (!State.clipboard.length) return;
  clearSelection();
  State.clipboard.forEach(n => {
    const newId = createNode(n.type, n.x + n.width / 2 + 40, n.y + n.height / 2 + 40, {
      ...n,
      id: undefined,
      x: undefined,
      y: undefined,
      tasks: n.tasks ? n.tasks.map(t => ({ ...t, id: uid() })) : [],
    });
    State.selectedIds.add(newId);
  });
  updateAllSelectionVisuals();
  showToast('Eingefügt');
}

/* ──────────────────────────────────────────────────────────
   CONTEXT MENU
   ────────────────────────────────────────────────────────── */
let contextMenuTarget = null;

function showContextMenu(x, y, targetId) {
  contextMenuTarget = targetId;
  DOM.contextMenu.style.display = 'block';
  const cm = DOM.contextMenu;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  let top = y;
  if (left + 170 > vw) left = vw - 175;
  if (top + 120 > vh) top = vh - 125;
  cm.style.left = `${left}px`;
  cm.style.top = `${top}px`;
}

function hideContextMenu() {
  DOM.contextMenu.style.display = 'none';
  contextMenuTarget = null;
}

DOM.contextMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'delete') deleteNode(contextMenuTarget);
  else if (action === 'duplicate') duplicateNode(contextMenuTarget);
  else if (action === 'connect') showToast('Klicke auf einen Port (Kreis) zum Verbinden');
  hideContextMenu();
});

/* ──────────────────────────────────────────────────────────
   PANNING (CANVAS DRAG)
   ────────────────────────────────────────────────────────── */
let panState = null;

function startPan(e) {
  panState = { startX: e.clientX - State.panX, startY: e.clientY - State.panY };
  State.isPanning = true;
  DOM.canvasWrapper.classList.add('panning');

  const onMove = (ev) => {
    State.panX = ev.clientX - panState.startX;
    State.panY = ev.clientY - panState.startY;
    applyTransform();
  };

  const onUp = () => {
    State.isPanning = false;
    DOM.canvasWrapper.classList.remove('panning');
    panState = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ──────────────────────────────────────────────────────────
   CANVAS WRAPPER EVENTS
   ────────────────────────────────────────────────────────── */
DOM.canvasWrapper.addEventListener('mousedown', (e) => {
  hideContextMenu();
  closeDropdowns();

  // Middle mouse or Space+left drag = pan
  if (e.button === 1 || (e.button === 0 && State.isSpaceDown)) {
    e.preventDefault();
    startPan(e);
    return;
  }

  // Left click on empty canvas
  if (e.button === 0 && e.target === DOM.canvasWrapper || e.target === DOM.canvasGrid || e.target === DOM.nodesLayer || e.target === DOM.connectionsSvg) {
    clearSelection();
    startRectangleSelect(e);
  }
});

DOM.canvasWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.1 : 0.91;
  zoomTo(State.zoom * delta, e.clientX, e.clientY);
}, { passive: false });

DOM.canvasWrapper.addEventListener('dblclick', (e) => {
  if (e.target !== DOM.canvasWrapper && !e.target.classList.contains('canvas-grid') && e.target.id !== 'nodesLayer') return;
  const pos = screenToCanvas(e.clientX, e.clientY);
  createNode('note', pos.x, pos.y);
});

DOM.canvasWrapper.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

/* ──────────────────────────────────────────────────────────
   KEYBOARD SHORTCUTS
   ────────────────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName.toLowerCase();
  const isEditing = tag === 'input' || tag === 'textarea' || document.activeElement.isContentEditable;

  if (e.code === 'Space' && !isEditing) {
    e.preventDefault();
    State.isSpaceDown = true;
    DOM.canvasWrapper.classList.add('pan-mode');
  }

  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case 'z': e.preventDefault(); e.shiftKey ? redo() : undo(); break;
      case 'y': e.preventDefault(); redo(); break;
      case 's': e.preventDefault(); saveBoard(); break;
      case 'c': e.preventDefault(); if (!isEditing) copySelected(); break;
      case 'v': e.preventDefault(); if (!isEditing) pasteClipboard(); break;
      case 'a': e.preventDefault(); if (!isEditing) { State.nodes.forEach((_, id) => State.selectedIds.add(id)); updateAllSelectionVisuals(); } break;
      case 'f': e.preventDefault(); toggleSearch(); break;
      case '=': case '+': e.preventDefault(); zoomTo(State.zoom * 1.15); break;
      case '-': e.preventDefault(); zoomTo(State.zoom / 1.15); break;
      case '0': e.preventDefault(); centerView(0, 0, 1); break;
    }
  }

  if (!isEditing) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (State.selectedIds.size > 0) { e.preventDefault(); deleteNode(); }
    }
    if (e.key === 'Escape') {
      clearSelection();
      hideContextMenu();
      closeSearch();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    State.isSpaceDown = false;
    DOM.canvasWrapper.classList.remove('pan-mode');
  }
});

/* ──────────────────────────────────────────────────────────
   MINIMAP
   ────────────────────────────────────────────────────────── */
function updateMinimap() {
  const canvas = DOM.minimapCanvas;
  const ctx = canvas.getContext('2d');
  const mw = canvas.offsetWidth;
  const mh = canvas.offsetHeight;
  canvas.width = mw;
  canvas.height = mh;

  if (State.nodes.size === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.nodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });

  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const scaleX = mw / (maxX - minX);
  const scaleY = mh / (maxY - minY);
  const scale = Math.min(scaleX, scaleY);
  const offX = (mw - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (mh - (maxY - minY) * scale) / 2 - minY * scale;

  ctx.clearRect(0, 0, mw, mh);

  // Draw nodes
  const isDark = document.documentElement.dataset.theme === 'dark';
  ctx.fillStyle = isDark ? '#2d3343' : '#e8e8ec';

  State.nodes.forEach(n => {
    const x = n.x * scale + offX;
    const y = n.y * scale + offY;
    const w = n.width * scale;
    const h = n.height * scale;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 2);
    ctx.fill();
  });

  // Draw connections
  ctx.strokeStyle = isDark ? '#3a3f52' : '#c4c4cc';
  ctx.lineWidth = 1;
  State.connections.forEach(conn => {
    const from = getPortPosition(conn.fromId, conn.fromPort);
    const to = getPortPosition(conn.toId, conn.toPort);
    ctx.beginPath();
    ctx.moveTo(from.x * scale + offX, from.y * scale + offY);
    ctx.lineTo(to.x * scale + offX, to.y * scale + offY);
    ctx.stroke();
  });

  // Draw viewport indicator
  const vpW = DOM.canvasWrapper.clientWidth;
  const vpH = DOM.canvasWrapper.clientHeight;
  const vpLeft = (-State.panX / State.zoom) * scale + offX;
  const vpTop = (-State.panY / State.zoom) * scale + offY;
  const vpRight = ((-State.panX + vpW) / State.zoom) * scale + offX;
  const vpBottom = ((-State.panY + vpH) / State.zoom) * scale + offY;

  const vx = Math.max(0, vpLeft);
  const vy = Math.max(0, vpTop);
  const vw = Math.min(mw, vpRight) - vx;
  const vh2 = Math.min(mh, vpBottom) - vy;

  DOM.minimapViewport.style.cssText = `left:${vx}px;top:${vy}px;width:${Math.max(4,vw)}px;height:${Math.max(4,vh2)}px;`;
}

/* ──────────────────────────────────────────────────────────
   SEARCH
   ────────────────────────────────────────────────────────── */
function toggleSearch() {
  const panel = DOM.searchPanel;
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    DOM.searchInput.focus();
    DOM.searchInput.select();
  } else {
    closeSearch();
  }
}

function closeSearch() {
  DOM.searchPanel.style.display = 'none';
  DOM.searchResults.innerHTML = '';
}

DOM.searchInput.addEventListener('input', () => {
  const q = DOM.searchInput.value.trim().toLowerCase();
  if (!q) { DOM.searchResults.innerHTML = ''; return; }

  const results = [];
  State.nodes.forEach((node, id) => {
    const titleMatch = node.title.toLowerCase().includes(q);
    const contentMatch = (node.content || node.richtextHtml || '').toLowerCase().includes(q);
    const tasksMatch = (node.tasks || []).some(t => t.text.toLowerCase().includes(q));
    if (titleMatch || contentMatch || tasksMatch) {
      results.push({ id, node });
    }
  });

  if (!results.length) {
    DOM.searchResults.innerHTML = `<div class="search-empty">Keine Ergebnisse</div>`;
    return;
  }

  const icons = { note: 'fa-note-sticky', richtext: 'fa-file-lines', image: 'fa-image', pdf: 'fa-file-pdf', link: 'fa-link', task: 'fa-list-check', center: 'fa-compass' };
  DOM.searchResults.innerHTML = results.map(({ id, node }) => `
    <div class="search-result-item" data-jump="${id}">
      <i class="fa-regular ${icons[node.type] || 'fa-circle'} search-result-icon"></i>
      <div>
        <div class="search-result-text">${escapeText(node.title)}</div>
        <div class="search-result-sub">${node.type}</div>
      </div>
    </div>
  `).join('');

  DOM.searchResults.querySelectorAll('[data-jump]').forEach(item => {
    item.addEventListener('click', () => {
      const nodeId = item.dataset.jump;
      const node = State.nodes.get(nodeId);
      if (!node) return;
      centerView(node.x + node.width / 2, node.y + node.height / 2, 1);
      selectOnly(nodeId);
      closeSearch();
      showToast(`"${node.title}" gefunden`);
    });
  });
});

document.getElementById('searchClose').addEventListener('click', closeSearch);

/* ──────────────────────────────────────────────────────────
   SETTINGS MODAL
   ────────────────────────────────────────────────────────── */
function openSettings() {
  const s = State.settings;
  document.getElementById('settingGrid').checked = s.showGrid;
  document.getElementById('settingSnap').checked = s.snapToGrid;
  document.getElementById('settingDark').checked = State.isDarkMode;
  document.getElementById('settingAnimations').checked = s.animations;
  document.getElementById('settingCurved').checked = s.curvedLines;
  document.getElementById('settingFont').value = s.font;
  DOM.settingsOverlay.style.display = 'flex';
}

function closeSettings() {
  DOM.settingsOverlay.style.display = 'none';
}

// Settings live-bind
document.getElementById('settingGrid').addEventListener('change', (e) => {
  State.settings.showGrid = e.target.checked;
  DOM.canvasGrid.classList.toggle('hidden', !e.target.checked);
});

document.getElementById('settingSnap').addEventListener('change', (e) => {
  State.settings.snapToGrid = e.target.checked;
});

document.getElementById('settingDark').addEventListener('change', (e) => {
  setDarkMode(e.target.checked);
});

document.getElementById('settingAnimations').addEventListener('change', (e) => {
  State.settings.animations = e.target.checked;
  document.documentElement.style.setProperty('--transition', e.target.checked ? '140ms cubic-bezier(0.4, 0, 0.2, 1)' : '0ms');
});

document.getElementById('settingCurved').addEventListener('change', (e) => {
  State.settings.curvedLines = e.target.checked;
  renderConnections();
});

document.getElementById('settingFont').addEventListener('change', (e) => {
  State.settings.font = e.target.value;
});

DOM.settingsOverlay.addEventListener('click', (e) => {
  if (e.target === DOM.settingsOverlay) closeSettings();
});

document.getElementById('settingsClose').addEventListener('click', closeSettings);

/* ──────────────────────────────────────────────────────────
   DARK MODE
   ────────────────────────────────────────────────────────── */
function setDarkMode(dark) {
  State.isDarkMode = dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  DOM.darkModeIcon.className = dark ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
  const syncCheckbox = document.getElementById('settingDark');
  if (syncCheckbox) syncCheckbox.checked = dark;
  updateMinimap();
  localStorage.setItem('denkr-dark', dark ? '1' : '0');
}

/* ──────────────────────────────────────────────────────────
   SAVE / LOAD
   ────────────────────────────────────────────────────────── */
function getSerializableState() {
  return {
    version: '1.0',
    boardName: DOM.boardName.value,
    panX: State.panX,
    panY: State.panY,
    zoom: State.zoom,
    nextId: State.nextId,
    nodes: [...State.nodes.entries()].map(([, n]) => ({ ...n })),
    connections: [...State.connections],
    settings: { ...State.settings },
    isDarkMode: State.isDarkMode,
  };
}

function saveBoard() {
  const data = JSON.stringify(getSerializableState(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${DOM.boardName.value || 'denkr-board'}.denkr`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Board gespeichert');
}

function loadBoardFromData(data) {
  // Restore state
  DOM.boardName.value = data.boardName || 'Neues Board';
  State.panX = data.panX ?? 0;
  State.panY = data.panY ?? 0;
  State.zoom = data.zoom ?? 1;
  State.nextId = data.nextId ?? 1;
  State.connections = data.connections ?? [];
  State.settings = { ...State.settings, ...(data.settings ?? {}) };
  State.nodes = new Map((data.nodes ?? []).map(n => [n.id, n]));
  if (data.isDarkMode !== undefined) setDarkMode(data.isDarkMode);
  State.selectedIds.clear();
  rebuildDOM();
  renderConnections();
  applyTransform();
  showToast('Board geladen');
}

function rebuildDOM() {
  DOM.nodesLayer.innerHTML = '';
  State.nodes.forEach((_, id) => renderNode(id));
}

DOM.fileInputOpen.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      loadBoardFromData(data);
    } catch {
      showToast('Fehler beim Laden der Datei');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ──────────────────────────────────────────────────────────
   IMAGE UPLOAD
   ────────────────────────────────────────────────────────── */
DOM.fileInputImage.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const id = State._pendingImageNodeId;
    if (!id) return;
    const node = State.nodes.get(id);
    if (!node) return;
    node.imageData = ev.target.result;
    renderNode(id);
    saveHistory();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

/* ──────────────────────────────────────────────────────────
   PDF UPLOAD
   ────────────────────────────────────────────────────────── */
DOM.fileInputPdf.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const id = State._pendingPdfNodeId;
  if (!id) return;
  const node = State.nodes.get(id);
  if (!node) return;
  node.pdfName = file.name;
  renderNode(id);
  saveHistory();
  e.target.value = '';
  showToast(`PDF "${file.name}" hinzugefügt`);
});

/* ──────────────────────────────────────────────────────────
   EXPORT (PNG / JPG)
   ────────────────────────────────────────────────────────── */
async function exportCanvas(format) {
  if (State.nodes.size === 0) { showToast('Keine Elemente zum Exportieren'); return; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.nodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const scale = 2;
  const w = (maxX - minX) * scale;
  const h = (maxY - minY) * scale;

  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');

  const isDark = State.isDarkMode;
  ctx.fillStyle = isDark ? '#0f1117' : '#f7f7f9';
  ctx.fillRect(0, 0, w, h);

  // Draw grid dots
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
  const gridSize = 24 * scale;
  for (let gx = 0; gx < w; gx += gridSize) {
    for (let gy = 0; gy < h; gy += gridSize) {
      ctx.fillRect(gx, gy, 1, 1);
    }
  }

  // Draw node backgrounds
  State.nodes.forEach(n => {
    const x = (n.x - minX) * scale;
    const y = (n.y - minY) * scale;
    const nw = n.width * scale;
    const nh = n.height * scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = isDark ? '#171923' : '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, y, nw, nh, 14 * scale / 2);
    ctx.fill();
    ctx.restore();

    // Title bar
    ctx.fillStyle = n.type === 'center' ? '#111118' : (isDark ? '#1e2231' : '#f7f7f9');
    ctx.beginPath();
    ctx.roundRect(x, y, nw, 36 * scale / 2, [14 * scale / 2, 14 * scale / 2, 0, 0]);
    ctx.fill();

    // Title text
    ctx.fillStyle = n.type === 'center' ? '#ffffff' : (isDark ? '#f0f0f5' : '#111118');
    ctx.font = `600 ${12 * scale / 2}px Inter, sans-serif`;
    ctx.fillText(n.title, x + 10 * scale / 2, y + 24 * scale / 2, nw - 20 * scale / 2);
  });

  const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const dataUrl = offscreen.toDataURL(mimeType, 0.95);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${DOM.boardName.value || 'denkr-board'}.${ext}`;
  a.click();
  showToast(`Als ${ext.toUpperCase()} exportiert`);
}

/* ──────────────────────────────────────────────────────────
   TOOLBAR BUTTONS
   ────────────────────────────────────────────────────────── */
document.getElementById('btnSearch').addEventListener('click', toggleSearch);
document.getElementById('btnNew').addEventListener('click', () => {
  if (!State.nodes.size || confirm('Neues Board erstellen? Ungespeicherte Änderungen gehen verloren.')) {
    State.nodes.clear();
    State.connections = [];
    State.selectedIds.clear();
    State.nextId = 1;
    State.history = [];
    State.historyIndex = -1;
    DOM.nodesLayer.innerHTML = '';
    DOM.connectionsGroup.innerHTML = '';
    DOM.boardName.value = 'Neues Board';
    initCenterNode();
    showToast('Neues Board erstellt');
  }
});
document.getElementById('btnOpen').addEventListener('click', () => DOM.fileInputOpen.click());
document.getElementById('btnSave').addEventListener('click', saveBoard);
document.getElementById('btnDarkMode').addEventListener('click', () => setDarkMode(!State.isDarkMode));
document.getElementById('btnSettings').addEventListener('click', openSettings);

// Export dropdown
const btnExport = document.getElementById('btnExport');
btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = DOM.exportMenu;
  if (menu.style.display === 'none') {
    const rect = btnExport.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.display = 'block';
  } else {
    menu.style.display = 'none';
  }
});

DOM.exportMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  const fmt = btn.dataset.export;
  DOM.exportMenu.style.display = 'none';
  if (fmt === 'json') saveBoard();
  else exportCanvas(fmt);
});

/* ──────────────────────────────────────────────────────────
   SIDE PANEL — ADD NODES
   ────────────────────────────────────────────────────────── */
document.querySelectorAll('.panel-btn[data-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    if (type === 'image') {
      // Create node first, then trigger upload
      const cx = DOM.canvasWrapper.clientWidth / 2;
      const cy = DOM.canvasWrapper.clientHeight / 2;
      const pos = screenToCanvas(cx, cy);
      State._pendingImageNodeId = createNode('image', pos.x, pos.y);
      DOM.fileInputImage.click();
    } else if (type === 'pdf') {
      const cx = DOM.canvasWrapper.clientWidth / 2;
      const cy = DOM.canvasWrapper.clientHeight / 2;
      const pos = screenToCanvas(cx, cy);
      State._pendingPdfNodeId = createNode('pdf', pos.x, pos.y);
      DOM.fileInputPdf.click();
    } else {
      const cx = DOM.canvasWrapper.clientWidth / 2;
      const cy = DOM.canvasWrapper.clientHeight / 2;
      const pos = screenToCanvas(cx, cy);
      const id = createNode(type, pos.x, pos.y);
      selectOnly(id);
    }
    updateMinimap();
  });
});

document.getElementById('btnFitAll').addEventListener('click', fitAll);
document.getElementById('btnZoomReset').addEventListener('click', () => centerView(0, 0, 1));

/* ──────────────────────────────────────────────────────────
   ZOOM CONTROLS
   ────────────────────────────────────────────────────────── */
document.getElementById('btnZoomIn').addEventListener('click', () => zoomTo(State.zoom * 1.2));
document.getElementById('btnZoomOut').addEventListener('click', () => zoomTo(State.zoom / 1.2));

/* ──────────────────────────────────────────────────────────
   CLOSE MENUS ON OUTSIDE CLICK
   ────────────────────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  if (!DOM.contextMenu.contains(e.target)) hideContextMenu();
  if (!DOM.exportMenu.contains(e.target) && !document.getElementById('btnExport').contains(e.target)) {
    DOM.exportMenu.style.display = 'none';
  }
  if (!DOM.searchPanel.contains(e.target) && !document.getElementById('btnSearch').contains(e.target)) {
    closeSearch();
  }
});

function closeDropdowns() {
  DOM.exportMenu.style.display = 'none';
  DOM.settingsOverlay.style.display = 'none';
}

/* ──────────────────────────────────────────────────────────
   DRAG-AND-DROP FILES ONTO CANVAS
   ────────────────────────────────────────────────────────── */
DOM.canvasWrapper.addEventListener('dragover', (e) => { e.preventDefault(); });
DOM.canvasWrapper.addEventListener('drop', (e) => {
  e.preventDefault();
  const pos = screenToCanvas(e.clientX, e.clientY);
  [...e.dataTransfer.files].forEach(file => {
    if (file.type.startsWith('image/')) {
      const id = createNode('image', pos.x, pos.y);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const node = State.nodes.get(id);
        if (node) { node.imageData = ev.target.result; renderNode(id); saveHistory(); }
      };
      reader.readAsDataURL(file);
    } else if (file.type === 'application/pdf') {
      const id = createNode('pdf', pos.x, pos.y);
      const node = State.nodes.get(id);
      if (node) { node.pdfName = file.name; renderNode(id); saveHistory(); }
    } else if (file.name.endsWith('.denkr') || file.name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try { loadBoardFromData(JSON.parse(ev.target.result)); } catch { showToast('Ungültige Datei'); }
      };
      reader.readAsText(file);
    }
  });
});

/* ──────────────────────────────────────────────────────────
   ESCAPE HELPERS
   ────────────────────────────────────────────────────────── */
function escapeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/* ──────────────────────────────────────────────────────────
   TOUCH SUPPORT (BASIC)
   ────────────────────────────────────────────────────────── */
let lastTouchDist = null;
let lastTouchMidX = null;
let lastTouchMidY = null;

DOM.canvasWrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    lastTouchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    lastTouchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  }
}, { passive: true });

DOM.canvasWrapper.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (lastTouchDist) {
      const ratio = dist / lastTouchDist;
      zoomTo(State.zoom * ratio, midX, midY);
      const dx = midX - lastTouchMidX;
      const dy = midY - lastTouchMidY;
      State.panX += dx;
      State.panY += dy;
      applyTransform();
    }
    lastTouchDist = dist;
    lastTouchMidX = midX;
    lastTouchMidY = midY;
  }
}, { passive: false });

DOM.canvasWrapper.addEventListener('touchend', () => {
  lastTouchDist = null;
});

/* ──────────────────────────────────────────────────────────
   MINIMAP CLICK NAVIGATION
   ────────────────────────────────────────────────────────── */
DOM.minimapCanvas.addEventListener('click', (e) => {
  const rect = DOM.minimapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // Convert minimap position to canvas position
  if (State.nodes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  State.nodes.forEach(n => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
  });
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const mw = rect.width, mh = rect.height;
  const scale = Math.min(mw / (maxX - minX), mh / (maxY - minY));
  const offX = (mw - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (mh - (maxY - minY) * scale) / 2 - minY * scale;
  const cx = (mx - offX) / scale;
  const cy = (my - offY) / scale;
  centerView(cx, cy, State.zoom);
});

/* ──────────────────────────────────────────────────────────
   INITIALIZATION
   ────────────────────────────────────────────────────────── */
function initCenterNode() {
  const cx = DOM.canvasWrapper.clientWidth / 2;
  const cy = DOM.canvasWrapper.clientHeight / 2;
  const pos = screenToCanvas(cx, cy);
  const id = createNode('center', pos.x, pos.y, {
    title: 'Neues Board',
    content: 'Beginne mit deinem ersten Gedanken.',
  });
  selectOnly(id);
}

function init() {
  // Restore dark mode preference
  const savedDark = localStorage.getItem('denkr-dark');
  if (savedDark === '1') setDarkMode(true);

  // Apply initial settings
  DOM.canvasGrid.classList.toggle('hidden', !State.settings.showGrid);

  // Center canvas transform
  State.panX = 0;
  State.panY = 0;
  State.zoom = 1;
  applyTransform();

  // Create initial center node
  initCenterNode();

  // Initial minimap
  updateMinimap();

  // Save initial history snapshot
  saveHistory();

  console.log('%cdenkr', 'font-size:24px;font-weight:700;color:#111118;');
  console.log('Doppelklick auf die Arbeitsfläche, um einen neuen Block zu erstellen.');
  console.log('Strg+S zum Speichern, Strg+Z zum Rückgängigmachen.');
}

// Run after DOM is ready
document.addEventListener('DOMContentLoaded', init);
