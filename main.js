'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');

const {
  findActiveConversation,
  readTrajectory,
  learnFloor,
  brainAttachments,
  trajectoryPath,
} = require('./src/reader');
const { buildBreakdown } = require('./src/analyzer');

const POLL_MS = 2500;
const DEFAULT_BOUNDS = { width: 380, height: 372 };

let win = null;
let tray = null;
let timer = null;
let lastSignature = '';
let floorHint = null;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// Keeps the window fully inside the work area, so a saved position from a wider
// display (or a since-changed resolution) cannot push it off-screen.
function clampToWorkArea(bounds) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x ?? area.x + area.width - width - 24, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y ?? area.y + 64, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function loadBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = {
    width: DEFAULT_BOUNDS.width,
    height: DEFAULT_BOUNDS.height,
    x: area.x + area.width - DEFAULT_BOUNDS.width - 24,
    y: area.y + 64,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (saved && typeof saved.width === 'number') return clampToWorkArea(saved);
  } catch {
    /* no saved state yet */
  }
  return clampToWorkArea(fallback);
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    /* best effort */
  }
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 190,
    frame: false,
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    refresh(true);
  });

  for (const event of ['resize', 'move']) win.on(event, saveBounds);
  win.on('close', saveBounds);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('Antigravity Context Monitor');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: toggleWindow },
      { label: '立即刷新', click: () => refresh(true) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleWindow);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.show();
    refresh(true);
  }
}

function emptyState(reason, detail) {
  return { status: reason, detail: detail || '', updatedAt: Date.now() };
}

// Re-parsing the trajectory is the only expensive step, so it is gated on the
// file's mtime/size. `force` bypasses the gate for manual refreshes.
function collect(force) {
  const conv = findActiveConversation();
  if (!conv) return emptyState('idle', '未找到 Antigravity 会话');

  const file = trajectoryPath(conv.conversation_id);
  let signature;
  try {
    const stat = fs.statSync(file);
    signature = `${conv.conversation_id}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return emptyState('idle', '会话文件不可读');
  }

  if (!force && signature === lastSignature) return null;
  lastSignature = signature;

  const traj = readTrajectory(conv.conversation_id);
  if (!traj || traj.samples.length === 0) return emptyState('idle', '该会话暂无生成记录');

  const breakdown = buildBreakdown(traj, brainAttachments(traj.id), { floorHint });
  if (breakdown.empty) return emptyState('idle', '无法解析上下文');

  // A conversation that has compacted reveals the fixed floor; remember it so
  // conversations that never compacted can still be split correctly.
  const observed = Math.min(...traj.samples.map((s) => s.contextTotal));
  if (traj.samples.length >= 2 && observed < breakdown.total && (floorHint == null || observed < floorHint)) {
    floorHint = observed;
  }

  return {
    status: 'ok',
    title: conv.title || '',
    model: breakdown.model,
    limit: breakdown.limit,
    total: breakdown.total,
    freeSpace: breakdown.freeSpace,
    overBy: breakdown.overBy,
    percent: breakdown.percent,
    categories: breakdown.categories,
    series: breakdown.series,
    compactionCount: breakdown.compactionCount,
    updatedAt: Date.now(),
  };
}

function refresh(force) {
  if (!win || win.isDestroyed()) return;
  const payload = collect(force === true);
  if (payload) win.webContents.send('context:update', payload);
}

app.whenReady().then(() => {
  try {
    floorHint = learnFloor();
  } catch {
    floorHint = null;
  }
  createWindow();
  createTray();
  timer = setInterval(refresh, POLL_MS);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (timer) clearInterval(timer);
});

ipcMain.on('window:hide', () => win && win.hide());
ipcMain.on('window:quit', () => app.quit());
ipcMain.on('window:refresh', () => refresh(true));
