# Cross-device software playback lab

The Windows master hosts an operator dashboard and a separate device runner. A phone, tablet or another computer needs only a browser. Pair it once and keep the tab in the foreground. Queued jobs start and complete without taps on the device. The dashboard queues and cancels jobs and shows the raw receipt. The lab is separate from the static player and its release verdict.

## Start on Windows

Use Node 24.22.3 and npm 11.19.1. Pick the master's private LAN IPv4 address, not a VPN or virtual adapter address. With mkcert installed on the master, run from the repository root.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run lab:build
$labIp = '192.168.1.20'  # Replace with the actual LAN IPv4 address
$env:CAROOT = Join-Path (Get-Location) '.local/device-lab-ca'
New-Item -ItemType Directory -Force -Path $env:CAROOT | Out-Null
mkcert -install
mkcert -cert-file .local/device-lab.pem -key-file .local/device-lab-key.pem $labIp 127.0.0.1
npm.cmd run lab:serve -- --lan-ip $labIp --cert .local/device-lab.pem --key .local/device-lab-key.pem
```

Open the controller link the server prints at `https://127.0.0.1:4175`. Generate one pairing link per device. Install only the public CA certificate `.local/device-lab-ca/rootCA.pem` on test devices as needed. On iOS/iPadOS, enable full trust under Certificate Trust Settings after installing the profile. If the Windows firewall blocks access, allow inbound TCP 4174 on the private network. The command does not add a firewall rule or bind the controller to the LAN. [mkcert mobile setup](https://github.com/FiloSottile/mkcert#mobile-devices) · [Apple certificate trust](https://support.apple.com/en-us/102390)

On browsers that block Web Audio until a gesture, the **Pair device** submission admits the lab’s exact-rate audio contexts. Each audio job leases one of those contexts, creates a fresh PCM worklet and retires it at the end. Refreshing or replacing the tab may require enabling audio once for the new document. If the browser blocks audio, the lab records a refusal and does not wait for a per-job tap. Video-only jobs do not require audio permission. Fixture packs can declare `audioSampleRate` for rates not already specified by their independent audio reference. [Web Audio start policy](https://webaudio.github.io/web-audio-api/#allowed-to-start)

The server defaults to loopback if `--lan-ip` is omitted. This lets the master run both sides without exposing anything to the LAN. The worker listener on `4174` can serve an isolated document at `/isolated/` or a standard document at `/`. To pair the standard document, keep the pairing fragment and change the path to `/` before opening it. The portable decoder also works on an isolated page when forced by the job.

## Run a playlist automatically

On the master, supply the controller origin and the admin code from the printed link. Give Node the public CA. The CLI waits for the foreground runner, queues each test in order, and prints a terminal receipt summary for every attempt. Repeat `--fixture` for a playlist, use `--all` for the active manifest, or use the device ID when several devices share a name.

```powershell
$env:NODE_EXTRA_CA_CERTS = Join-Path $env:CAROOT 'rootCA.pem'
$env:UBVE_LAB_CONTROLLER = 'https://127.0.0.1:4175'
$env:UBVE_LAB_ADMIN_CODE = Read-Host 'Admin code from the controller link'
npm.cmd run lab:run -- --device 'iPad' --fixture av1-truehd-ass-720p60 --fold-down
```

## Workloads and evidence

- The default fixture is the committed AV1 HDR10/TrueHD/ASS 720p60 clip. For the complete authored software corpus, add `--manifest test/fixtures/modern/manifest.json --media-root test/fixtures/modern` to the server command.
- A **File** job verifies the whole preloaded fixture before opening the SDK and is capped at 64 MiB. A **Range** job uses the real strict HTTP source. The master verifies source SHA-256 before serving it and refuses if its file identity changes. Each job uses one frozen build. To compare two builds, set `UBVE_LAB_BUILD_DIR` during each build, then restart the server with the corresponding `--build` directory.
- **Playback and seek** checks Ready without autoplay, software EOS, declared picture and PCM counts, paused seek, resume, close, and fresh reopen. **Exclusive timing** runs only one case across the lab and records foreground/cadence and separate bounded stage histograms. Its opt-in one-frame Canvas worker is a comparison candidate, not a player default. Decode-output wait, input-consumed latency, draw submission, and physical presentation are different measurements. A visual or audible result is not inferred from a worklet or Canvas counter.
- A 15-second device lease separates a disconnected attempt from a successful one. Cancel waits for the runner to tear down or for that lease to end. Restart keeps prior receipts under `.local/device-lab` and marks any in-progress attempt interrupted. A retry is a new attempt. Check each actual Windows, macOS, iOS, iPadOS, and Android browser separately.

On a reserved device, queue at least three counterbalanced baseline/candidate pairs with the same fixture, transport, decoder and output settings. Give the two attempts in each pair the same comparison label and keep device name/model consistent through restarts. The comparison command reports every attempt, rejects unmatched or contaminated pairs, and never issues a v8 verdict.

```sh
npm run bench:paired -- --baseline BASELINE_BUILD_ID --candidate CANDIDATE_BUILD_ID
```

For inline versus worker conversion on one frozen build, give both flags the same build ID and add `--prefetch-ab`. Leave the worker unchecked in one attempt and check it in the other.

For a local browser smoke, set `UBVE_LAB_CERT` and `UBVE_LAB_KEY` to the trusted PEM paths and run `npm run test:lab:browser` after `npm run lab:build`. It drives both pages, pairs the runner once, and completes two primary lifecycle jobs and the exact Opus/MP3 end-trim checks over HTTPS ranges without device clicks or disabled certificate validation.
