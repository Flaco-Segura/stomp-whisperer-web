// Read-only UI: connect to the pedal over Web MIDI, read every patch slot and show
// each patch's effect chain. Nothing here writes to the pedal.
//
// Patch data may come from untrusted sources later (shared presets), so text from a
// patch is only ever put on the page with textContent, never as HTML.

import './style.css';

import { displayName, patchDescription, type Patch } from './patch';
import { Pedal } from './pedal';
import { type SlotEntry, effectIdHex, isFactorySlot, toSlotEntry, usedEffects } from './slots';
import { isPedalPort, openPedal, requestMidi } from './webmidi';

type Status = 'idle' | 'busy' | 'connected' | 'error';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const statusBox = $('#status');
const statusText = $('#status-text');
const connectButton = $<HTMLButtonElement>('#connect');
const refreshButton = $<HTMLButtonElement>('#refresh');
const listState = $('#list-state');
const slotList = $('#slots');
const detail = $('#detail');

let pedal: Pedal | null = null;
let entries: SlotEntry[] = [];
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
  slotList.replaceChildren();
  listState.hidden = false;
  listState.textContent = 'Reading patches…';
  try {
    await pedal.readAllSlots((read, info) => {
      const entry = toSlotEntry(read);
      entries.push(entry);
      slotList.append(slotItem(entry));
      listState.textContent = `Reading patch ${read.slot} of ${info.count}…`;
    });
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
updateButtons();
