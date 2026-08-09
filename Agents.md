# Agent Notes

## Communication

- Use ASD-STE100 Simplified Technical English.
- Keep responses ADHD-friendly: short sections, direct status, clear next action.

## Project Shape

- This is `icloud-cli`, a network-only iCloud CLI. Do not add Playwright or browser automation unless the user asks.
- CLI entrypoint is `src/cli.ts`; commands call `src/login.ts`, `src/import-har.ts`, and `src/whoami.ts`.
- Package is ESM (`"type": "module"`); TypeScript imports use `.js` extensions for local modules.
- Built CLI output goes to `dist/` and is ignored by git.

## Commands

- Install: `npm install`; CI uses `npm ci`.
- Run checks before pushing: `npm run typecheck`, `npm test`, `npm run build`.
- Test once: `npm test`; watch tests: `npm run test:watch`.
- TypeScript watch build: `npm run build:watch`.
- Run without linking: `npm run cli -- --help`, `npm run cli -- login`.
- Local linked command after `npm link`: `icloud-cli login`, `icloud-cli import-har <path>`, `icloud-cli whoami`.

## Auth And Sessions

- `.env` is used by `login`; required keys are `APPLE_ID_EMAIL` and `APPLE_ID_PASSWORD`.
- Saved session path defaults to macOS `~/Library/Application Support/icloud-cli/session.json`, Linux `${XDG_CONFIG_HOME:-~/.config}/icloud-cli/session.json`, and Windows `%APPDATA%\icloud-cli\session.json`.
- Tests override the session path with `ICLOUD_CLI_SESSION_PATH`; use this for any new tests that touch sessions.
- `import-har` validates with `accountLogin` before saving unless `--force` is passed.
- `whoami` is the quick post-login/import test for a saved session.

## Security

- Never commit `.env`, `*.har`, `dist/`, `node_modules/`, or the session file.
- Treat `--debug` output as sensitive even when values are redacted.
- Do not print token, cookie, `scnt`, auth attribute, 2FA code, or HAR body values in normal output.

## CI

- GitHub Actions workflow is `.github/workflows/test.yml`.
- CI runs on Node 22 and executes `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
