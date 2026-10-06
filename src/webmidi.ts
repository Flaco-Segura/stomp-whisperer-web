// The browser side of the MIDI connection: finds the pedal through the Web MIDI API and
// wraps its ports as a SysexTransport for src/pedal.ts.
//
// SysEx access needs the user's permission (the browser asks on the first call) and a
// secure context: https, or http://localhost while developing. Chrome and Edge support
// it; Firefox asks to install a small site permission add-on; Safari has no Web MIDI.

import type { SysexTransport } from './pedal';
import { PORT_NAME_HINT } from './protocol';

export class PedalNotFoundError extends Error {
  override name = 'PedalNotFoundError';
}

export const isWebMidiSupported = () =>
  typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

export const isPedalPort = (port: MIDIPort) => (port.name ?? '').includes(PORT_NAME_HINT);

/** Ask for MIDI access with SysEx; the browser shows its permission prompt the first time. */
export async function requestMidi(): Promise<MIDIAccess> {
  if (!isWebMidiSupported()) {
    throw new Error("This browser can't talk to MIDI devices. Use Chrome, Edge or Firefox.");
  }
  try {
    return await navigator.requestMIDIAccess({ sysex: true });
  } catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
      throw new Error(
        "MIDI access was blocked. Allow it for this site in the browser's settings and try again.",
      );
    }
    // Chrome's message when it can't reach the system MIDI layer (on Linux: ALSA). Seen in
    // the snap build of Chromium, whose sandbox doesn't expose ALSA.
    if (error instanceof DOMException && error.message.includes('Platform dependent initialization failed')) {
      throw new Error(
        "The browser couldn't reach the system's MIDI devices. On Linux, sandboxed browser " +
          'packages (such as the Chromium snap) may have no MIDI access: try a regular install of ' +
          'Chrome or Chromium.',
      );
    }
    throw error;
  }
}

/** Open the pedal's input and output ports. */
export async function openPedal(access: MIDIAccess): Promise<{ name: string; transport: SysexTransport }> {
  const input = [...access.inputs.values()].find(isPedalPort);
  const output = [...access.outputs.values()].find(isPedalPort);
  if (!input || !output) {
    const seen = [...access.inputs.values()].map((port) => port.name).join(', ') || 'none';
    throw new PedalNotFoundError(
      `No MIDI port matching '${PORT_NAME_HINT}' found (ports seen: ${seen}). ` +
        'Is the pedal connected and powered on?',
    );
  }
  await Promise.all([input.open(), output.open()]);

  const transport: SysexTransport = {
    send(body) {
      const message = new Uint8Array(body.length + 2);
      message[0] = 0xf0;
      message.set(body, 1);
      message[message.length - 1] = 0xf7;
      output.send(message);
    },
    listen(handler) {
      input.onmidimessage = (event) => {
        const data = event.data;
        // Only complete SysEx messages; ignore notes, program changes, clock…
        if (data && data.length >= 2 && data[0] === 0xf0 && data[data.length - 1] === 0xf7) {
          handler(data.slice(1, -1));
        }
      };
    },
    close() {
      input.onmidimessage = null;
      void input.close();
      void output.close();
    },
  };
  return { name: input.name ?? PORT_NAME_HINT, transport };
}
