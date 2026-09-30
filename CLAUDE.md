# StompWhisperer Web: context for Claude

Browser port of the Python app at `~/Repos/stomp-whisperer` (the reference implementation).
Background and decisions: `~/Repos/stomp-whisperer/CLOUD_IDEAS.md` (written for AWS; we chose
the free tiers of **GitHub Pages** for the static site and **Supabase** for accounts, database
and server-side preset validation instead).

## Decisions so far (2026-09-29)

- Separate public repo (GitHub Pages is free only for public repos).
- Port the logic to **TypeScript**, not Pyodide: the same parser can then validate uploaded
  presets in Supabase Edge Functions (Deno/TS).
- Planned stack: Vite + TypeScript + Vitest, Node 22 LTS (`.nvmrc`; the system Node is 18,
  install via nvm).
- Order: 1) port patch/protocol code + tests against golden files, 2) UI with Web MIDI,
   read-only, 3) writing to the pedal with the current safeguards, 4) Supabase last.

## Golden files

Generate them from the Python repo (needs its venv and `dumps/`, no pedal):

    cd ~/Repos/stomp-whisperer && .venv/bin/stomp-whisperer golden --out ~/Repos/stomp-whisperer-web/golden

Format documented in `~/Repos/stomp-whisperer/src/stomp_whisperer/golden.py`. `golden/` is
git-ignored: it holds the user's own patches (slots 86–100) and this repo is public. Not covered
yet: ZD2 effect parsing (no ZD2 fixtures are stored); the effect library cache is at
`~/.cache/stomp-whisperer/effects.json`.

## Rules carried over from the Python project

- All user-facing text (UI, messages, errors) in English; chat with the user can be Spanish.
- Pedal writes are delicate (the user fears bricking the MS-50G+): only ever write patch slots
  (SysEx command 0x45), never files/effects; back up all slots first; ask before every new kind
  of write; read the slot back to verify.
- Factory patches = slots 1–85, user patches = 86–100; never overwrite factory slots.
- Presets from other users are untrusted: validate before offering to write them to a pedal.

## Next step

Once `node --version` shows v22: scaffold Vite + TypeScript + Vitest, then start porting
`patch.py` and `protocol.py` test-first against the golden files.
