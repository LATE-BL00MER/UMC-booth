# UMC Photo Booth event operations runbook

## Install and start

Use the event MacBook with Node.js 22 or later. Install the project dependencies and the tunnel client before the event:

```bash
node --version
npm ci
brew install cloudflared
```

The booth uses the committed UMC application form at `https://forms.gle/nMDuKHj6rGt8stiH8` as its join destination:

```bash
npm run booth
```

Keep this terminal open. Confirm the operator page is available only on the Mac and that the public listener `/health` returns `{"ok":true}` through the tunnel.

## Before doors open

Confirm all of the following:

- Mac power is connected; sleep is disabled; Do Not Disturb is enabled.
- The camera framing fits a 1–4-person team, with consistent lighting and a clear standing position.
- The six on-screen pose prompts are correct and staff have practiced them.
- The selected frame pack is the approved event frame pack.
- Local storage has enough free capacity for the operating system, build output, and temporary encrypted session data.
- The front sign reads `친구와 무료 네컷 촬영 · 휴대폰으로 바로 저장`.
- The front-sign subcopy reads `앱 설치 없음 · 사진은 10분 후 삭제`.

### Vercel-hosted event budget

When the production Vercel deployment is used instead of the local tunnel, keep exactly one authenticated operator tab open. Close rehearsal tabs when they are no longer in use; multiple operator tabs perform independent readiness polling.

The production cleanup policy performs one Blob listing at startup and then at most one listing every five minutes. A normal completed team uses two additional Blob advanced operations: one upload and one activation copy. For the September 1–2 schedule (six hours per day), reserve at least 550 Blob advanced operations. This covers twelve hours at the physical maximum of fifteen teams per hour plus periodic cleanup, with a small operational buffer.

Before each event day, check **Vercel → Usage → Blob Advanced Operations**. Do not start the hosted booth if fewer than 550 operations remain for both days combined; use the documented local-tunnel fallback or increase the Vercel allowance first.

## Staff script and normal team flow

Invite teams of 1–4 people: “친구와 무료 네컷 촬영 · 휴대폰으로 바로 저장.” Ask everyone to confirm consent on the operator screen. Guide them through six poses, then let them select four photos in their preferred order and choose a frame.

When the QR is issued, tell every team member to scan the same QR with their own phone. They can independently open and save the same completed photo during the ten-minute timer. The link becomes inaccessible when the timer ends; the encrypted server copy is removed by the next cleanup sweep. Never display a participant’s live camera view or completed photo anywhere other than the operator screen.

The recipient must choose **사진 저장하기** before the application CTA appears. Do not promise that a QR remains valid beyond its displayed timer.

## Network and device rehearsal

Before the event, test an issued QR from both iPhone Safari and Android Chrome using cellular data, not the Mac Wi-Fi. Confirm the photo preview loads, photo saving starts, and the application CTA appears only after the save action.

Run 10 consecutive team rehearsals. Record capture-to-QR duration, download success, memory behavior, and any previous-photo leakage. Mark a rehearsal failed if any of these occur:

- Capture-to-QR exceeds four minutes.
- Recipient preview takes more than five seconds on working cellular data.
- A plaintext photo appears on disk.
- Reset takes more than three seconds.
- A previous team’s photo appears in the next session.

The following real-hardware checks are **unperformed until completed on the actual event MacBook**: the iPhone Safari cellular rehearsal, Android Chrome cellular rehearsal, ten consecutive team rehearsal, tunnel-loss recovery rehearsal, and final physical shutdown rehearsal. Record the device model, browser version, mobile carrier, date, operator, result, and any corrective action in the event log.

## Tunnel-down recovery

If the tunnel health check fails, stop new captures immediately. Wait for the runtime to obtain its automatic replacement public URL, then reissue the current team’s QR from the operator screen. From a cellular-connected phone, verify `<public-url>/health` before allowing the next team to start. Do not promise an old QR will work after the replacement URL is issued.

## Reset and privacy checks

Use the upper-right `처음으로` control only after confirming the current team is finished or has asked to start over. A reset clears the current unissued work but does not invalidate an already-issued QR; the issued team can still download until its timer expires.

During rehearsals and hourly during the event, inspect the configured session directory. It must contain only ciphertext and metadata—never JPEG/plaintext image files. Do not copy or export session files, QR URLs, or photos for debugging.

## Shutdown

Before doors open, record the local aggregate baseline from the loopback-only private listener (the configured default private port is `4173`):

```bash
curl --fail --silent --show-error http://127.0.0.1:4173/api/metrics
```

At closing, block new teams and wait for the final displayed QR's full 10-minute timer to finish. Record the final aggregate snapshot **before** shutdown, because shutdown closes the private listener:

```bash
curl --fail --silent --show-error http://127.0.0.1:4173/api/metrics
```

Then request deletion:

```bash
curl --fail --silent --show-error -X POST http://127.0.0.1:4173/api/shutdown \
  -H 'content-type: application/json' \
  --data '{"confirm":"DELETE_ALL"}'
```

Wait for the process to complete its deletion, then verify the configured default session directory (`runtime-data/sessions`) is empty:

```bash
test -d runtime-data/sessions
test -z "$(find runtime-data/sessions -mindepth 1 -maxdepth 1 -print -quit)"
```

Only after both commands succeed should staff stop the booth process and power/network equipment.

## After the event

Record aggregate counts only: team starts, completed QRs, successful decryptions, save intents, join clicks, and UTM visits. Compare the relevant rates against the 90% team-start-to-completed-QR target, the 95% successful-decryption target, and the 30% join-click target. Do not export photos, session identifiers, or any recipient-level records.

The baseline and final `/api/metrics` snapshots contain counters only, never session IDs, QR URLs, tokens, keys, or participant data.
