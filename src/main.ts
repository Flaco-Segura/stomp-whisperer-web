// The UI: connect to the pedal over Web MIDI, read every patch slot and show each patch's
// effect chain. The only write is restoring user slots from a backup, after the user
// downloaded a backup of the pedal and confirmed it (see restoreSlots).
//
// Patch data may come from untrusted sources later (shared presets), so text from a
// patch is only ever put on the page with textContent, never as HTML.

import './style.css';

import { backupFileName, backupToJson, changedSlots, createBackup, parseBackup, type Backup } from './backup';
import { type Change, patchChanges } from './diff';
import { displayName, patchBytes, patchDescription, type Patch } from './patch';
import { type PatchInfo, Pedal, type SlotRead } from './pedal';
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
const restoreManyButton = $<HTMLButtonElement>('#restore-many');
const listState = $('#list-state');
const slotList = $('#slots');
const detail = $('#detail');

let pedal: Pedal | null = null;
let entries: SlotEntry[] = [];
// Every slot from the last complete read; null while reading or after a failed read.
let lastBackup: Backup | null = null;
// A backup file the user loaded, and the slots where it differs from the last read, each
// with what changed (null if either side can't be parsed).
let loadedBackup: Backup | null = null;
let changed = new Map<number, Change[] | null>();
let selected: number | null = null;
// Whether the detail panel shows the restore-several-slots panel instead of a slot.
let restorePanelOpen = false;
let reading = false;
let writing = false;
// Whether the user downloaded a backup since the last read: no write is allowed before.
let backupDownloaded = false;

const busy = () => reading || writing;

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
  refreshButton.disabled = pedal === null || busy();
  backupButton.disabled = lastBackup === null || busy();
  compareButton.disabled = lastBackup === null || busy();
  restoreManyButton.disabled = busy();
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
  if (!pedal || busy()) {
    return;
  }
  reading = true;
  // The pedal may have changed since the last backup (it saves edits by itself).
  backupDownloaded = false;
  updateButtons();
  entries = [];
  lastBackup = null;
  changed = new Map();
  compareState.hidden = true;
  restoreManyButton.hidden = true;
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
  backupDownloaded = true;
  redrawDetail(); // the restore buttons may be enabled now
}

// ---------- restoring slots from a backup ----------

/** Why `slot` itself can't be restored from the loaded backup, or null if it can. */
function slotBlocker(slot: number): string | null {
  const read = loadedBackup?.slots[slot - 1];
  if (isFactorySlot(slot)) {
    return 'Factory slots (1–85) are never written from this page.';
  }
  if (!read) {
    return 'Load a backup to restore this slot.';
  }
  if (!read.checksumOk || !toSlotEntry(read).patch) {
    return "The backup's copy of this slot is damaged or empty: it can't be restored.";
  }
  return null;
}

/** Why nothing can be written to the pedal right now, or null if it can. */
function writeBlocker(): string | null {
  if (!pedal || !lastBackup) {
    return 'Connect the pedal and read it to restore slots.';
  }
  if (!backupDownloaded) {
    return 'Download a backup of the pedal first: it keeps what the slots hold now.';
  }
  return null;
}

const restoreBlocker = (slot: number) => slotBlocker(slot) ?? writeBlocker();

/** User slots that differ from the loaded backup, in order. */
const changedUserSlots = () => [...changed.keys()].filter((slot) => !isFactorySlot(slot)).sort((a, b) => a - b);

const backupName = (slot: number) => displayName(toSlotEntry(loadedBackup!.slots[slot - 1]!).patch!) || '(no name)';

function restoreControl(slot: number): Node {
  const blocker = restoreBlocker(slot);
  const button = el('button', 'restore', `Restore slot ${slot} from the backup`);
  button.type = 'button';
  button.disabled = blocker !== null || busy();
  button.addEventListener('click', () => void restoreSlots([slot]));
  const note = blocker ?? 'Writes the backup\'s version to the pedal and reads the slot back to check it.';
  return el('div', 'restore-box', button, el('p', 'restore-note', note));
}

/** The panel to pick several user slots to restore; sound changes come checked. */
function showRestorePanel(): void {
  selected = null;
  restorePanelOpen = true;
  for (const button of slotList.querySelectorAll<HTMLElement>('.slot')) {
    button.setAttribute('aria-current', 'false');
  }
  const slots = changedUserSlots();
  const when = loadedBackup?.createdAt.toLocaleString() ?? '';
  const panel = el(
    'section',
    'restore-panel',
    el('p', 'detail-kind', 'User slots 86–100'),
    el('h2', '', 'Restore from the backup'),
    el('p', 'description', `User slots that differ from the backup from ${when}. Each one is written with the backup's version and read back to check it.`),
  );
  if (slots.length === 0) {
    panel.append(el('p', 'detail-empty', 'No user slot differs from the backup.'));
    detail.replaceChildren(panel);
    return;
  }
  const choices = el('ul', 'restore-choices');
  for (const slot of slots) {
    const blocker = slotBlocker(slot);
    const box = el('input');
    box.type = 'checkbox';
    box.value = String(slot);
    box.checked = blocker === null && !isStateOnly(slot);
    box.disabled = blocker !== null || busy();
    const current = entries.find((entry) => entry.slot === slot)?.patch;
    const now = current ? displayName(current) || '(no name)' : 'unreadable';
    const label = el(
      'label',
      `restore-choice${blocker ? ' is-blocked' : ''}`,
      box,
      el('span', 'slot-number', String(slot).padStart(3, '0')),
      el('span', '', blocker ? '' : backupName(slot)),
      el('span', 'restore-tag', blocker ?? `now: ${now}${isStateOnly(slot) ? ' · pedal state only' : ''}`),
    );
    choices.append(el('li', '', label));
  }
  const blocker = writeBlocker();
  const button = el('button', 'restore', 'Restore the checked slots');
  button.type = 'button';
  button.disabled = blocker !== null || busy();
  button.addEventListener('click', () => {
    const checked = [...choices.querySelectorAll<HTMLInputElement>('input:checked')].map((box) => Number(box.value));
    void restoreSlots(checked);
  });
  const note = blocker ?? 'Slots that differ only in pedal state (like the effect selected on screen) sound the same: they start unchecked.';
  panel.append(choices, el('div', 'restore-box', button, el('p', 'restore-note', note)));
  detail.replaceChildren(panel);
}

/** Take a slot as read back after writing it as the pedal's current version. */
function storeWritten(stored: SlotRead): void {
  const entry = toSlotEntry(stored);
  entries = entries.map((e) => (e.slot === stored.slot ? entry : e));
  lastBackup = { ...lastBackup!, slots: lastBackup!.slots.map((r) => (r.slot === stored.slot ? stored : r)) };
  slotList.querySelector(`.slot[data-slot="${stored.slot}"]`)?.parentElement?.replaceWith(slotItem(entry));
}

/** Write the backup's version of some user slots to the pedal, after the user confirms. */
async function restoreSlots(slots: number[]): Promise<void> {
  if (slots.length === 0 || slots.some((slot) => restoreBlocker(slot) !== null) || busy() || !pedal || !loadedBackup) {
    return;
  }
  const when = loadedBackup.createdAt.toLocaleString();
  const question =
    slots.length === 1
      ? `Write slot ${slots[0]} on the pedal?\n\n` +
        `It will hold "${backupName(slots[0]!)}" again, as in the backup from ${when}.\n` +
        'What the slot holds now is only kept in the backup you downloaded.'
      : `Write ${slots.length} slots on the pedal?\n\n` +
        slots.map((slot) => `  ${slot}: "${backupName(slot)}"`).join('\n') +
        `\n\nThey will hold these patches again, as in the backup from ${when}.\n` +
        'What the slots hold now is only kept in the backup you downloaded.';
  if (!window.confirm(question)) {
    return;
  }
  const backup = loadedBackup;
  // Only the patch's own bytes: the leftovers after it are not part of it.
  const writes = slots.map((slot) => ({ slot, patch: patchBytes(backup.slots[slot - 1]!.data) }));
  const done: number[] = [];
  writing = true;
  updateButtons();
  redrawDetail();
  setStatus('busy', `Writing slot ${slots[0]}…`);
  try {
    await pedal.writeSlots(writes, (stored) => {
      storeWritten(stored);
      done.push(stored.slot);
      const next = slots[done.length];
      if (next !== undefined) {
        setStatus('busy', `Slot ${stored.slot} checked. Writing slot ${next} (${done.length + 1} of ${slots.length})…`);
      }
    });
    const what = slots.length === 1 ? `Slot ${slots[0]} restored and checked` : `Slots ${slots.join(', ')} restored and checked`;
    setStatus('connected', `${what}: the backup's version is on the pedal.`);
  } catch (error) {
    const written = done.length ? ` Restored and checked before it: ${done.join(', ')}.` : '';
    const failed = slots[done.length];
    const rest = slots.slice(done.length + 1);
    const notSent = rest.length ? ` Not written: ${rest.join(', ')}.` : '';
    setStatus('error', `Slot ${failed} was not restored: ${messageOf(error)}.${written}${notSent} Read the pedal again to see its state.`);
  } finally {
    writing = false;
    updateButtons();
    compare(); // redraws the detail too
  }
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
  changed = new Map();
  if (loadedBackup && lastBackup) {
    try {
      for (const slot of changedSlots(loadedBackup, lastBackup)) {
        changed.set(slot, slotChanges(loadedBackup, lastBackup, slot));
      }
      const when = loadedBackup.createdAt.toLocaleString();
      if (changed.size === 0) {
        showCompareState('', `Backup from ${when} matches the pedal: all ${lastBackup.info.count} slots are identical.`);
      } else {
        const stateOnly = [...changed.keys()].filter(isStateOnly);
        const sound = [...changed.keys()].filter((slot) => !isStateOnly(slot));
        const slots = changed.size === 1 ? 'slot differs' : 'slots differ';
        const parts = [
          sound.length ? `sound or unknown: ${sound.join(', ')}` : '',
          stateOnly.length ? `pedal state only: ${stateOnly.join(', ')}` : '',
        ].filter(Boolean);
        showCompareState('has-changes', `Backup from ${when}: ${changed.size} ${slots} from the pedal (${parts.join('; ')}).`);
      }
    } catch (error) {
      loadedBackup = null;
      showCompareState('is-error', `Can't compare: ${messageOf(error)}`);
    }
  }
  for (const button of slotList.querySelectorAll<HTMLElement>('.slot')) {
    markChanged(button, Number(button.dataset.slot));
  }
  restoreManyButton.hidden = changedUserSlots().length === 0;
  redrawDetail();
}

/** Draw the detail panel again with what it shows now (a slot or the restore panel). */
function redrawDetail(): void {
  if (selected !== null) {
    showDetail(selected);
  } else if (restorePanelOpen) {
    showRestorePanel();
  }
}

function showCompareState(className: string, text: string): void {
  compareState.className = `compare-state ${className}`;
  compareState.textContent = text;
  compareState.hidden = false;
}

/** What changed in a slot, from the backup to the pedal; null if a side can't be parsed. */
function slotChanges(backup: Backup, current: Backup, slot: number): Change[] | null {
  const [before, after] = [toSlotEntry(backup.slots[slot - 1]!), toSlotEntry(current.slots[slot - 1]!)];
  return before.patch && after.patch ? patchChanges(before.patch, after.patch) : null;
}

/** True if a slot differs only in pedal state (PRM2): it most likely sounds the same. */
function isStateOnly(slot: number): boolean {
  const changes = changed.get(slot);
  return !!changes?.length && changes.every((change) => change.kind === 'state');
}

function markChanged(button: HTMLElement, slot: number): void {
  button.classList.toggle('is-changed', changed.has(slot));
  button.classList.toggle('is-state-only', isStateOnly(slot));
}

/** The list of changes of a slot that differs, split into sound and pedal state. */
function changeList(slot: number): Node {
  const section = el('section', 'changes', el('h3', '', 'What changed since the backup'));
  const changes = changed.get(slot);
  if (!changes) {
    section.append(el('p', 'detail-empty', 'One of the two versions can\'t be read as a patch: compare them below.'));
    return section;
  }
  if (changes.length === 0) {
    section.append(el('p', 'detail-empty', 'The bytes differ, but in no field this app understands yet.'));
    return section;
  }
  const groups: [Change['kind'], string][] = [['sound', 'Sound'], ['state', 'Pedal state (PRM2)']];
  for (const [kind, title] of groups) {
    const texts = changes.filter((change) => change.kind === kind).map((change) => el('li', '', change.text));
    if (texts.length) {
      section.append(el('h4', '', title), el('ul', `change-list is-${kind}`, ...texts));
    }
  }
  return section;
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
  markChanged(button, slot);
  button.setAttribute('aria-current', String(slot === selected));
  button.addEventListener('click', () => showDetail(slot));
  return el('li', '', button);
}

function showDetail(slot: number): void {
  selected = slot;
  restorePanelOpen = false;
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
    parts.push(changeList(slot), restoreControl(slot), backupVersion(slot));
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
restoreManyButton.addEventListener('click', showRestorePanel);
backupFileInput.addEventListener('change', () => {
  const file = backupFileInput.files?.[0];
  backupFileInput.value = ''; // so picking the same file again fires 'change' again
  if (file) {
    void loadBackupFile(file);
  }
});
updateButtons();
