# Phase C — Lab workstation setup for palace EM solver

This guide covers what you (the user) need to do **on the workstation
machine** (13700K + 128 GB + RTX 4070 Ti, Windows + WSL2) to make
`POST /api/simulation-runs {module:'em_fem', runner_kind:'ssh_workstation'}`
actually run real palace instead of the synthetic Lorentzian mock.

The dev machine — where this repo lives and where uvicorn runs — only
needs to know the workstation's hostname + an SSH key path. Everything
else lives on the workstation.

---

## 0. Prerequisites checklist

- [ ] Workstation can be SSH'd into from the dev machine
- [ ] WSL2 installed on workstation (`wsl --install` if not yet)
- [ ] Docker Desktop installed on workstation **with WSL2 backend
      enabled** (Docker → Settings → General → "Use the WSL 2 based engine")
- [ ] Workstation has internet access (palace image ~1.5 GB)

If the workstation is the same physical box as the dev machine, that's
fine — `WORKSTATION_HOST=localhost` works as long as Docker Desktop is
running.

---

## 1. SSH server on the workstation

If `ssh <workstation-host>` from the dev machine doesn't work yet:

1. On the workstation (admin PowerShell):
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service -Name sshd -StartupType Automatic
   Start-Service sshd
   New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
     -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
   ```

2. From the dev machine, generate a key (if you don't already have one
   — recall the OneDrive cleanup turn confirmed `~/.ssh/` had no
   private key):
   ```powershell
   ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519
   ```

3. Copy the dev key to the workstation's
   `C:\Users\<workstation-user>\.ssh\authorized_keys` file (one key per
   line). Easiest is to paste the contents of
   `$env:USERPROFILE\.ssh\id_ed25519.pub` from the dev machine into the
   workstation's `authorized_keys`.

4. Verify from the dev machine:
   ```powershell
   ssh <workstation-host>
   ```
   Should drop you into a PowerShell prompt with no password.

If your `~/.ssh/config` already has a `Host QM` entry pointing at
`172.30.10.204` (it does — see the OneDrive cleanup turn), then
`<workstation-host>` is just `QM`.

---

## 2. palace Docker image

On the workstation, in PowerShell (or WSL — Docker Desktop exposes the
same daemon to both):

```powershell
docker pull awslabs/palace:latest
```

This pulls the official AWS Labs palace build (~1.5 GB) once. Verify:

```powershell
docker run --rm awslabs/palace:latest --help
```

You should see palace's CLI usage. If you get a "permission denied" or
"docker daemon not running" error, open Docker Desktop and let it
start its WSL2 VM.

---

## 3. Tell the backend where the workstation is

The backend reads three env vars (loaded by `pydantic-settings`):

```bash
WORKSTATION_HOST=QM
WORKSTATION_KEY_PATH=C:/Users/admin/.ssh/id_ed25519
WORKSTATION_PALACE_IMAGE=awslabs/palace:latest   # default; override only if you build your own
```

Set them in `qmem-digital-twin/.env` (copy from `.env.example` if it
doesn't have them yet). Restart the backend (`/start-project`) so it
picks them up.

---

## 4. Smoke test

In the Electronics? sorry — EM tab in the browser:

1. Click **+** to make a new EM problem.
2. Hit **Run**.

Behind the scenes the backend:

1. Sees `runner_kind='inproc'` (the SolverConsole's Run uses the
   inproc runner by default → still hits the mock palace generator).
   Synthetic Lorentzian appears in the chart.

For real palace, **dispatch with `runner_kind='ssh_workstation'`** —
either via curl:

```bash
curl -X POST http://localhost:8010/api/simulation-runs \
  -H 'Content-Type: application/json' \
  -d '{"module":"em_fem","runnerKind":"ssh_workstation","params":{"emProblemId":"<your-problem-id>"}}'
```

…or through the UI once we wire a "Run on workstation" toggle (Phase
C.4 follow-up; not in this commit).

When real palace runs, the backend:

1. Opens an asyncssh connection to `WORKSTATION_HOST`.
2. `mkdir /tmp/qmem-em-<run-id>` on the workstation.
3. SCP's the mesh + a generated `config.json` into that dir.
4. Runs `docker run --rm -v /tmp/qmem-em-<run-id>:/work
   awslabs/palace:latest /work/config.json` with a 60-min timeout
   (`settings.em_solver_timeout_sec`).
5. SCP's `postpro/port-S.csv` back to the dev machine.
6. Parses S-parameters via `app.solvers.palace_io.parse_palace_sparams`.
7. Writes them into the SimulationRun row's `result_summary` in the
   same shape Phase B.7 Touchstone parsing produces — so the existing
   Smith chart + magnitude plot just work.

---

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `SshWorkstationRunner: settings.workstation_host is unset` | `.env` not picked up; restart backend |
| `connect: connection refused` | sshd not running on workstation, or firewall blocks 22 |
| `permission denied (publickey)` | wrong key path, or the workstation's `authorized_keys` doesn't have the dev key |
| `docker: command not found` over SSH | the SSH session has its own PATH; either start Docker Desktop manually first, or invoke `& "C:\Program Files\Docker\Docker\resources\bin\docker.exe"` with the full path |
| `palace exit=1; stderr_tail=...attribute IDs...` | mesh attributes aren't tagged for ports/PEC — Phase C.6+ Gmsh CLI wrap will fix this; for now you have to hand-tag the `.msh` |
| `palace S-param CSV not found` | palace ran but didn't write `postpro/port-S.csv`. Most often the `Solver.Driven` config didn't actually emit S-params; check `palace.log` on the workstation |

---

## 6. What's NOT covered yet

- **Mesh attribute → anchorBindingId mapping**: Phase C.6+ wraps Gmsh
  CLI to auto-tag surfaces from a SceneObject's anchorBindings. Until
  then you hand-edit the `.msh` and the EmProblem's
  `boundary_conditions.pec_anchor_binding_ids` (which the config
  builder treats as raw integer attribute IDs).
- **Field pull-down**: palace's ParaView output (`.pvtu` + `.vtu`) is
  written to `postpro/paraview/` on the workstation but not yet pulled
  back to the dev machine. Phase C.8 backend will add a streaming
  endpoint and the frontend FieldViewer will fetch it. For now the
  mock field payload (a 16³ Gaussian blob) drives the viewer.
- **Multi-job queueing**: Phase C runs go through the
  ``InProcessRunner.create_task`` path which spawns a background task
  per request. If you fire 50 EM jobs at once they all queue at the
  asyncio level and at the workstation Docker level. Phase F may
  replace this with a real job queue (RQ / Celery).
