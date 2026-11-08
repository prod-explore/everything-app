'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: pickFolder } = window.__TAURI__.dialog;

const $ = (sel) => document.querySelector(sel);
const fields = [...document.querySelectorAll('[data-path]')];

let config = null;
let status = null;

// --- helpers ---------------------------------------------------------------------------------

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}
function say(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}
const errText = (e) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e));

// --- tabs ------------------------------------------------------------------------------------

function showTab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const s of document.querySelectorAll('[role=tabpanel]')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'json') loadJson();
  if (name === 'status') refreshStatus();
}
for (const b of document.querySelectorAll('nav [role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

// --- settings form ---------------------------------------------------------------------------

function fillForm(cfg) {
  config = cfg;
  for (const el of fields) {
    const v = getPath(cfg, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  renderRoots();
}

function readForm() {
  const cfg = structuredClone(config ?? {});
  for (const el of fields) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.hasAttribute('data-nullable') && String(v).trim() === '') v = null;
    setPath(cfg, el.dataset.path, v);
  }
  return cfg;
}

function renderRoots() {
  const ul = $('#roots');
  ul.replaceChildren();
  const roots = config?.files?.roots ?? [];
  if (roots.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No folders. The agent can read nothing until you add one.';
    ul.append(li);
    return;
  }
  roots.forEach((root, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = root;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${root}`);
    rm.addEventListener('click', () => {
      config = readForm();
      config.files.roots.splice(i, 1);
      renderRoots();
    });
    li.append(span, rm);
    ul.append(li);
  });
}

$('#add-root').addEventListener('click', async () => {
  try {
    const dir = await pickFolder({ directory: true, multiple: false, title: 'Folder the agent may access' });
    if (typeof dir !== 'string') return;
    config = readForm();
    config.files.roots = [...new Set([...(config.files.roots ?? []), dir])];
    renderRoots();
  } catch (e) {
    say($('#form-msg'), errText(e), true);
  }
});

async function save(cfg, msgEl) {
  try {
    const saved = await invoke('save_config', { config: cfg });
    fillForm(saved);
    say(msgEl, 'Saved.');
    return true;
  } catch (e) {
    say(msgEl, errText(e), true);
    return false;
  }
}

$('#form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  save(readForm(), $('#form-msg'));
});

// --- JSON tab --------------------------------------------------------------------------------

const jsonBox = $('#json');
function checkJson() {
  try {
    JSON.parse(jsonBox.value);
    jsonBox.classList.remove('invalid');
    say($('#json-msg'), '');
    return true;
  } catch (e) {
    jsonBox.classList.add('invalid');
    say($('#json-msg'), `Invalid JSON: ${e.message}`, true);
    return false;
  }
}
jsonBox.addEventListener('input', checkJson);

async function loadJson() {
  try {
    jsonBox.value = await invoke('get_config_json');
    checkJson();
  } catch (e) {
    say($('#json-msg'), errText(e), true);
  }
}
$('#reload-json').addEventListener('click', loadJson);
$('#save-json').addEventListener('click', async () => {
  if (!checkJson()) return;
  if (await save(JSON.parse(jsonBox.value), $('#json-msg'))) loadJson().then(() => say($('#json-msg'), 'Saved.'));
});

// --- status tab ------------------------------------------------------------------------------

function renderStatus(s) {
  status = s;
  const rows = [
    ['State', s.label],
    ['Detail', s.detail],
    ['Pairing code', s.userCode],
    ['Last activity', s.activity],
    ['Start at login', s.autostart ? 'on' : 'off'],
    ['Version', s.version],
    ['Config file', s.configPath],
    ['Log folder', s.logDir],
  ].filter(([, v]) => v);
  const dl = $('#status');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $('#btn-pair').disabled = !s.canPair;
  const pairedStates = ['connecting', 'online', 'offline', 'paused'];
  $('#btn-pause').disabled = !pairedStates.includes(s.state);
  $('#btn-pause').textContent = s.paused ? 'Resume' : 'Pause';
  $('#btn-unpair').disabled = !s.serverSet || s.state === 'unpaired';
}

async function refreshStatus() {
  try {
    renderStatus(await invoke('get_status'));
  } catch (e) {
    say($('#status-msg'), errText(e), true);
  }
}

async function act(cmd) {
  try {
    await invoke(cmd);
    say($('#status-msg'), '');
  } catch (e) {
    say($('#status-msg'), errText(e), true);
  }
}
$('#btn-pair').addEventListener('click', async () => {
  // Pair with what is on screen: save the form first when it is open with changes.
  if (await save(readForm(), $('#status-msg'))) act('pair');
});
$('#btn-pause').addEventListener('click', () => act(status?.paused ? 'resume' : 'pause'));
$('#btn-unpair').addEventListener('click', () => act('unpair'));

// --- start -----------------------------------------------------------------------------------

listen('status-changed', (ev) => renderStatus(ev.payload));
listen('config-changed', (ev) => {
  // The tray toggled a capability: show it unless the form has been edited since.
  if (document.activeElement?.closest('#form') == null) fillForm(ev.payload);
});

(async () => {
  try {
    fillForm(await invoke('get_config'));
  } catch (e) {
    say($('#form-msg'), `${errText(e)} Fix it in the JSON tab.`, true);
  }
  refreshStatus();
})();
