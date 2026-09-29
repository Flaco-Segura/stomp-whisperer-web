# StompWhisperer Web

A browser version of [StompWhisperer](https://github.com/Flaco-Segura/stomp-whisperer): browse,
edit and share patches of a Zoom MS-50G+ pedal straight from the browser over Web MIDI, with no
local server.

Planned:

- Patch reading, editing and writing ported to TypeScript and running in the browser (Web MIDI
  with SysEx; Chrome, Edge, Opera and recent Firefox on desktop).
- Static site hosted on GitHub Pages.
- Sharing presets with other users through Supabase (accounts and database).

## Status

Just started. The port is checked against golden files exported from the Python version
(`stomp-whisperer golden`): every parse, encoding and SysEx message must match byte for byte.
Golden files built from personal dumps hold user patches, so `golden/` is git-ignored.
