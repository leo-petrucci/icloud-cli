# icloud-cli

Network-only iCloud CLI experiments.

This project tries to use the same web APIs that iCloud.com uses. It does not use Playwright or browser automation.

## Status

This is early research code.

Working now:

- Apple ID password auth with SRP/S2K
- SMS 2FA flow
- Trusted session save
- Session import from a browser HAR file

Not done yet:

- Reusing the saved session for iCloud service commands
- Commands for Reminders, Notes, Drive, Photos, and other services
- Full cookie/session validation

## Install

Install dependencies:

```sh
npm install
```

Build:

```sh
npm run build
```

Link the CLI locally:

```sh
npm link
```

Then run:

```sh
icloud-cli --help
```

## Login With Apple ID

Create a `.env` file:

```env
APPLE_ID_EMAIL=you@example.com
APPLE_ID_PASSWORD=your-password
```

Run:

```sh
icloud-cli login
```

The CLI will:

- Start Apple ID auth
- Prove the password with SRP/S2K
- Request an SMS 2FA code if needed
- Ask you to enter the code
- Trust the session
- Save auth data for later use

Test the saved session:

```sh
icloud-cli whoami
```

Expected output:

```text
Logged in as Your Name <you@example.com>
```

For debug output:

```sh
icloud-cli login --debug
```

Debug output is redacted, but still treat it as sensitive.

## Import Login From HAR

You can also import an existing browser login from a HAR file.

Log in to iCloud.com in your browser. Export a HAR after login completes. Then run:

```sh
icloud-cli import-har apple-login.har
```

For a field summary:

```sh
icloud-cli import-har apple-login.har --debug
```

This imports Apple session headers and cookies when they are present in the HAR.

Test the imported session:

```sh
icloud-cli whoami
```

## Session File

The CLI saves session data here:

```text
~/Library/Application Support/icloud-cli/session.json
```

This file is a secret. Do not commit it. Do not share it.

## Security Notes

Treat these files as secrets:

- `.env`
- `*.har`
- `~/Library/Application Support/icloud-cli/session.json`

The `.gitignore` excludes `.env` and `*.har`.

## Development

Run typecheck:

```sh
npm run typecheck
```

Run tests:

```sh
npm test
```

Watch tests:

```sh
npm run test:watch
```

Watch TypeScript builds:

```sh
npm run build:watch
```

Run the CLI without linking:

```sh
npm run cli -- --help
npm run cli -- login
```
