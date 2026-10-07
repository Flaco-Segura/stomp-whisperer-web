// Read-only UI: connect to the pedal over Web MIDI, read every patch slot and show
// each patch's effect chain. Nothing here writes to the pedal.
//
// Patch data may come from untrusted sources later (shared presets), so text from a
// patch is only ever put on the page with textContent, never as HTML.

import './style.css';

import { backupFileName, backupToJson, changedSlots, createBackup, parseBackup, type Backup } from './backup';
import { displayName, patchDescription, type Patch } from './patch';
import { type PatchInfo, Pedal } from './pedal';
import { type SlotEntry, effectIdHex, isFactorySlot, toSlotEntry, usedEffects } from './slots';
import { isPedalPort, openPedal, requestMidi } from './webmidi';

type Status = 'idle' | 'busy' | 'connected' | 'error';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const statusBox = $('#status');
const statusText = $('#status-text');
const connectButton = $<HTMLButtonElement>('#connect');
const refreshButton = $<HTMLButtonElement>('#refresh');
const backupButton = $<HTMLButtonElement>('#backup');
const compareButton = $<HTMLButtonElement>('#compare');
const backupFileInput = $<HTMLInputElement>('#backup-file');
const compareState = $('#compare-state');
const listState = $('#list-state');
const slotList = $('#slots');
const detail = $('#detail');

let pedal: Pedal | null = null;
let entries: SlotEntry[] = [];
// Every slot from the last complete read; null while reading or after a failed read.
let lastBackup: Backup | null = null;
// A backup file the user loaded, and the slots where it differs from the last read.
let loadedBackup: Backup | null = null;
let changed = new Set<number>();
let selected: number | null = null;
let reading = false;

/** Create an element with a class and children (strings become text nodes, never HTML). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.append(...children);
  return element;
}

function setStatus(state: Status, text: string): void {
  statusBox.dataset.state = state;
  statusText.textContent = text;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function updateButtons(): void {
  connectButton.hidden = pedal !== null;
  refreshButton.disabled = pedal === null || reading;
  backupButton.disabled = lastBackup === null || reading;
  compareButton.disabled = lastBackup === null || reading;
}

// ---------- connection ----------

async function connect(): Promise<void> {
  connectButton.disabled = true;
  setStatus('busy', 'Asking for MIDI access…');
  try {
    const access = await requestMidi();
    access.onstatechange = (event) => {
      const port = (event as MIDIConnectionEvent).port;
      if (pedal && port && isPedalPort(port) && port.state === 'disconnected') {
        disconnect('Pedal disconnected');
      }
    };
    const { name, transport } = await openPedal(access);
    pedal = new Pedal(transport);
    setStatus('connected', `Connected: ${name}`);
    updateButtons();
    await readSlots();
  } catch (error) {
    setStatus('error', messageOf(error));
  } finally {
    connectButton.disabled = false;
  }
}

function disconnect(reason: string): void {
  pedal?.close();
  pedal = null;
  setStatus('error', reason);
  updateButtons();
}

// ---------- reading ----------

async function readSlots(): Promise<void> {
  if (!pedal || reading) {
    return;
  }
  reading = true;
  updateButtons();
  entries = [];
  lastBackup = null;
  changed = new Set();
  compareState.hidden = true;
  slotList.replaceChildren();
  listState.hidden = false;
  listState.textContent = 'Reading patches…';
  try {
    // 'as': TypeScript can't see the callback assign it, and would narrow it to plain null.
    let patchInfo = null as PatchInfo | null;
    const reads = await pedal.readAllSlots((read, info) => {
      patchInfo = info;
      const entry = toSlotEntry(read);
      entries.push(entry);
      slotList.append(slotItem(entry));
      listState.textContent = `Reading patch ${read.slot} of ${info.count}…`;
    });
    if (patchInfo) {
      lastBackup = createBackup(patchInfo, reads);
    }
    // The pedal may have changed since the backup was loaded: compare again.
    compare();
    listState.hidden = true;
    if (selected !== null) {
      showDetail(selected);
    }
  } catch (error) {
    listState.textContent = `Reading stopped: ${messageOf(error)}`;
    setStatus('error', messageOf(error));
  } finally {
    reading = false;
    updateButtons();
  }
}

// ---------- backup ----------

/** Save the last complete read as a JSON file through the browser's download. */
function downloadBackup(): void {
  if (!lastBackup) {
    return;
  }
  // A web page can't write to the disk directly: it builds the file in memory (a Blob),
  // points a temporary URL at it and clicks a link that downloads that URL.
  const blob = new Blob([backupToJson(lastBackup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = backupFileName(lastBackup.createdAt);
  link.click();
  URL.revokeObjectURL(url);
}

// ---------- comparing with a backup ----------

/** Read the backup file the user picked (it comes from their disk: untrusted, so validated). */
async function loadBackupFile(file: File): Promise<void> {
  try {
    loadedBackup = parseBackup(await file.text());
  } catch (error) {
    loadedBackup = null;
    showCompareState('is-error', `${file.name} can't be used: ${messageOf(error)}`);
  }
  compare();
}

/** Compare the loaded backup with the last read and mark the slots that differ. */
function compare(): void {
  changed = new Set();
  if (loadedBackup && lastBackup) {
    try {
      changed = new Set(changedSlots(loadedBackup, lastBackup));
      const when = loadedBackup.createdAt.toLocaleString();
      if (changed.size === 0) {
        showCompareState('', `Backup from ${when} matches the pedal: all ${lastBackup.info.count} slots are identical.`);
      } else {
        const list = [...changed].join(', ');
        const slots = changed.size === 1 ? 'slot differs' : 'slots differ';
        showCompareState('has-changes', `Backup from ${when}: ${changed.size} ${slots} from the pedal (${list}).`);
      }
    } catch (error) {
      loadedBackup = null;
      showCompareState('is-error', `Can't compare: ${messageOf(error)}`);
    }
  }
  for (const button of slotList.querySelectorAll<HTMLElement>('.slot')) {
    button.classList.toggle('is-changed', changed.has(Number(button.dataset.slot)));
  }
  if (selected !== null) {
    showDetail(selected);
  }
}

function showCompareState(className: string, text: string): void {
  compareState.className = `compare-state ${className}`;
  compareState.textContent = text;
  compareState.hidden = false;
}

/** How a slot that differs looks in the backup, under the pedal's version. */
function backupVersion(slot: number): Node {
  const read = loadedBackup?.slots[slot - 1];
  const section = el('section', 'backup-version', el('h3', '', 'In the backup'));
  if (!read) {
    return section;
  }
  const entry = toSlotEntry(read);
  if (entry.patch) {
    section.append(el('h2', '', displayName(entry.patch) || '(no name)'), ...patchBody(entry.patch));
  } else {
    section.append(el('p', 'detail-empty', entry.error ?? 'Unknown error'));
  }
  return section;
}

// ---------- rendering ----------

function slotItem(entry: SlotEntry): HTMLLIElement {
  const { slot, patch } = entry;
  const count = patch ? usedEffects(patch).length : 0;
  const button = el(
    'button',
    'slot',
    el('span', 'slot-number', String(slot).padStart(3, '0')),
    el('span', 'slot-name', patch ? displayName(patch) || '(no name)' : (entry.error ?? '')),
    el('span', 'slot-meta', patch ? `${count} fx` : ''),
  );
  button.type = 'button';
  button.dataset.slot = String(slot);
  button.classList.toggle('is-user', !isFactorySlot(slot));
  button.classList.toggle('is-problem', !patch || !entry.checksumOk);
  button.classList.toggle('is-changed', changed.has(slot));
  button.setAttribute('aria-current', String(slot === selected));
  button.addEventListener('click', () => showDetail(slot));
  return el('li', '', button);
}

function showDetail(slot: number): void {
  selected = slot;
  for (const button of slotList.querySelectorAll<HTMLElement>('.slot')) {
    button.setAttribute('aria-current', String(button.dataset.slot === String(slot)));
  }
  const entry = entries.find((e) => e.slot === slot);
  if (!entry) {
    detail.replaceChildren(el('p', 'detail-empty', 'This patch has not been read yet.'));
    return;
  }

  const kind = isFactorySlot(slot) ? 'Factory patch' : 'User patch';
  const header = el(
    'header',
    'detail-head',
    el('p', 'detail-kind', `Slot ${slot} · ${kind}`),
    el('h2', '', entry.patch ? displayName(entry.patch) || '(no name)' : 'Unreadable slot'),
  );
  const parts: Node[] = [header];
  if (!entry.checksumOk) {
    parts.push(el('p', 'warning', 'The checksum of this slot did not match: the data may be corrupt.'));
  }
  if (entry.patch) {
    parts.push(...patchBody(entry.patch));
  } else {
    parts.push(el('p', 'warning', entry.error ?? 'Unknown error'));
  }
  if (changed.has(slot)) {
    parts.push(backupVersion(slot));
  }
  detail.replaceChildren(...parts);
}

function patchBody(patch: Patch): Node[] {
  const nodes: Node[] = [];
  const description = patchDescription(patch);
  if (description) {
    nodes.push(el('p', 'description', description));
  }
  const effects = usedEffects(patch);
  if (effects.length === 0) {
    nodes.push(el('p', 'detail-empty', 'This patch has no effects.'));
    return nodes;
  }
  const chain = el('ol', 'chain');
  effects.forEach((effect, position) => {
    const params = el('dl', 'params');
    effect.params.forEach((value, i) => {
      params.append(el('div', '', el('dt', '', `P${i + 1}`), el('dd', '', String(value))));
    });
    const card = el(
      'li',
      'effect',
      el('span', 'effect-position', String(position + 1)),
      el('span', 'effect-state', effect.enabled ? 'On' : 'Off'),
      // Effect names live in the pedal's effect files, not in the patch: that comes later.
      el('h3', '', `Effect ${effectIdHex(effect)}`),
      params,
    );
    card.classList.toggle('is-off', !effect.enabled);
    chain.append(card);
  });
  nodes.push(chain);
  return nodes;
}

// ---------- start ----------

connectButton.addEventListener('click', () => void connect());
refreshButton.addEventListener('click', () => void readSlots());
backupButton.addEventListener('click', downloadBackup);
// The button opens the browser's file picker of the hidden <input type="file">.
compareButton.addEventListener('click', () => backupFileInput.click());
backupFileInput.addEventListener('change', () => {
  const file = backupFileInput.files?.[0];
  backupFileInput.value = ''; // so picking the same file again fires 'change' again
  if (file) {
    void loadBackupFile(file);
  }
});
updateButtons();
