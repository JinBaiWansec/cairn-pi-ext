# cairn-pi-ext

Cairn_Y FGS (Fact–Goal–Step) pentest engine as a Pi extension. Runs a headless
serial scheduler: `execute → decide → conclude` loops against a target, with a
live web UI (graph + facts + findings + log) on port 8377.

## Install

```bash
pi install git:github.com/JinBaiWansec/cairn-pi-ext   # git source
pi install /path/to/cairn-pi-ext                      # local directory
```

Then `/reload` in a pi session.

## Usage

```
/cairn run <origin> <goal>   # start engine in background + UI server
/cairn status                # inspect state
/cairn abort                 # stop
```

Example:

```
/cairn run http://192.168.229.132 "find auth bypass on /api/users"
```

Open the UI at `http://<host>:8377` — you can **inject hints** (consumed by the
engine on its next decide) and **abort** directly from the page.

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `CAIRN_UI_PORT` | `8377` | UI server port |
| `CAIRN_EXECUTE_MODEL` | none (rule-based) | model for execute steps |
| `CAIRN_DECIDE_MODEL` | none | model for decide steps |
| `CAIRN_MAX_EXECUTES` | see `DEFAULTS` | step budget |
| `CAIRN_DORMANCY_MS` | see `DEFAULTS` | dormancy window for decide gating |
| `CAIRN_*_TIMEOUT_MS` | see `DEFAULTS` | per-phase timeouts |

## Credits

Based on [oritera/Cairn](https://github.com/oritera/Cairn) — thanks to
oritera for the original FGS engine. This project is a Pi-extension port of
its dispatcher (execute → decide → conclude), keeping the protocol, prompts
and output-parser behavior in sync with the Python original.

感谢 oritera/Cairn 项目。

## Development

```bash
npm install
node test/run.mjs          # no-model suite (fixes/graph/prompts/protocol)
node test/serve.mjs        # standalone UI server on a temp workspace
test/smoke-curl.sh         # 15-assertion endpoint smoke against it
```
