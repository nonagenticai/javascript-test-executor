# Phantom base run 32220263722 — do not try to clear it

`gh run list` on this repo shows a **Base image** run that has been `queued`
since 2026-08-19T05:39:47Z and will never finish. It is a GitHub-side
orphan. This file exists so the next person does not spend an hour on it
twice — one session already mis-triaged it as CI pool contention.

## What it is

The push that merged #22 (commit `50b269ca`, which touched
`.github/workflows/base-image.yml` and nothing else) created run
`32220263722` on `main`. GitHub created the run and then never processed it:

| probe | result |
|---|---|
| `status` | `queued`, indefinitely |
| `/runs/<id>/jobs` | `{"jobs": []}` — zero jobs ever created |
| check suite `87342771984` | `latest_check_runs_count: 0` |
| `updated_at` | identical to `created_at` — never touched after creation |
| `/runs/<id>/pending_deployments` | `[]` — so it is **not** an environment approval gate |

## Why every fix fails

There is no job to act on, so nothing that acts on jobs can work. Measured
2026-08-20:

| attempt | result |
|---|---|
| `gh run cancel` | HTTP 500 |
| `POST /runs/<id>/force-cancel` | HTTP 500 |
| `DELETE /runs/<id>` | HTTP 403 — GitHub will not delete a non-completed run |
| `gh run rerun` | `cannot be rerun; This workflow is already running` |
| workflow `disable` + `enable` | no effect |

Clearing it needs GitHub Support, quoting run `32220263722` and check suite
`87342771984`.

## Why it is harmless — measured, not assumed

The thing worth checking was never the phantom itself. It was whether the
phantom **holds `image-only.yml`'s concurrency group**:

```yaml
group: image-only-${{ github.repository }}-${{ inputs.image_name }}
cancel-in-progress: false
```

That group is workflow-level and **not ref-scoped**, so a run that held it
would wedge every future base build in this repo — from `main` included.

Probed 2026-08-20 by PR #24: a `pull_request` run of `base-image.yml` (run
`32429519928` — same repo, same `image_name`, therefore the **same group**)
went `in_progress` and was allocated three real jobs:

```
base / Secret scan (gitleaks)             success   arc-amd64-fqgw2-runner-rv5zz
base / Lint — no docker.io / LAN-IP refs  success   arc-amd64-fqgw2-runner-mkgt8
base / Build, push, smoke                 started   arc-amd64-fqgw2-runner-lqq8b
```

The group is free. The probe was cancelled the moment it answered — the
question was whether it *starts*, and a PR run tags `pr-<sha>` and never
promotes, so there was no reason to spend the ~220 MiB push.

## Nothing was left unbuilt

The commit the phantom belongs to changed only `base-image.yml`, **not**
`Dockerfile.base`. So it would have rebuilt a byte-identical image. The
`FROM ...-base@sha256:` pin in `Dockerfile` still matches this base's
`:latest` (verified `7c465a01` on both sides, HEAD 200, 2026-08-20).

## Why this note is not in base-image.yml

`base-image.yml` is in its own `paths:` filter. Editing it to add a comment
would trigger a real base rebuild on merge, push a new digest, promote it to
`:latest`, and leave the `Dockerfile` pin stale — a repin PR for a comment.
This file is outside that filter, so it costs nothing.
