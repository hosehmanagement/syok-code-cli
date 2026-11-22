// Where a SWE-bench instance runs: one container per instance, started from the instance's official image.
// The Docker backend drives the `docker` command. The Modal backend reuses Syok Code's own Modal code (src/remote-modal.ts),
// the same one `syok run --on modal` uses, so a computer without Docker can still run the benchmark in the cloud.
import { run, q, type RunResult } from "../lib/proc.ts";
import type { Box, Provider } from "../../src/remote.ts";

/** Error output joins normal output in ONE stream, in order: the eval script's start/end markers (printed by `set -x` on the
 *  error stream) must stay around the test output (printed on the normal stream). */
export const MERGE = "exec 2>&1; ";
export interface ExecOpts { cwd?: string; timeoutSec: number; env?: string[] /* names of variables to pass in (values never on a command line) */ }
export interface ExecResult { code: number | null; out: string; timedOut: boolean }
export interface Sandbox {
  id: string;
  exec(command: string, o: ExecOpts): Promise<ExecResult>;
  upload(localFile: string, remotePath: string): Promise<void>;
  stop(): Promise<void>;
}
export interface Backend {
  name: string;
  /** null when ready; otherwise a sentence that says what is missing. */
  problem(): Promise<string | null>;
  start(image: string, o: { platform?: string; timeoutSec: number }): Promise<Sandbox>;
}

// ---------- Docker ----------
export type DockerRunner = (args: string[], o: { timeoutMs: number; env?: Record<string, string | undefined> }) => Promise<RunResult>;
const realDocker: DockerRunner = (args, o) => run(["docker", ...args], { cwd: process.cwd(), timeoutMs: o.timeoutMs, env: o.env });

export function dockerBackend(docker: DockerRunner = realDocker): Backend {
  return {
    name: "docker",
    async problem() {
      const r = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30000 });
      return r.code === 0 ? null : "Docker is not running (or not installed). Start Docker Desktop / the docker service, or use --backend modal.\n(docker said: " + (r.stderr || r.stdout).trim().slice(0, 300) + ")";
    },
    async start(image, o) {
      const have = await docker(["image", "inspect", image], { timeoutMs: 60000 });
      if (have.code !== 0) {
        const p = await docker(["pull", ...(o.platform ? ["--platform", o.platform] : []), image], { timeoutMs: 3600000 });
        if (p.code !== 0) throw new Error(`docker pull ${image} failed: ${(p.stderr || p.stdout).trim().slice(-400)}`);
      }
      const name = "syok-bench-" + Math.random().toString(36).slice(2, 10);
      // The image's own start command is replaced by "sleep" so the container waits while commands are run in it.
      const r = await docker(["run", "-d", "--name", name, ...(o.platform ? ["--platform", o.platform] : []), "--entrypoint", "sleep", image, String(o.timeoutSec + 600)], { timeoutMs: 300000 });
      if (r.code !== 0) throw new Error(`docker run ${image} failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
      return {
        id: name,
        async exec(command, x) {
          // `timeout` inside the container really stops the command (killing only the docker client would leave it running there).
          const args = ["exec", ...(x.cwd ? ["-w", x.cwd] : []), ...(x.env || []).flatMap((n) => ["-e", n]), name, "timeout", "-s", "KILL", String(x.timeoutSec), "sh", "-c", MERGE + command];
          const res = await docker(args, { timeoutMs: (x.timeoutSec + 60) * 1000 });
          return { code: res.code, out: res.stdout + res.stderr, timedOut: res.timedOut || res.code === 137 };
        },
        async upload(local, remote) {
          const res = await docker(["cp", local, `${name}:${remote}`], { timeoutMs: 300000 });
          if (res.code !== 0) throw new Error(`docker cp failed: ${(res.stderr || res.stdout).trim().slice(-300)}`);
        },
        async stop() { await docker(["rm", "-f", name], { timeoutMs: 120000 }); },
      };
    },
  };
}

// ---------- Modal (through src/remote-modal.ts) ----------
export function modalBackend(provider?: Provider): Backend {
  let p = provider;
  const get = async () => (p ||= (await import("../../src/remote-modal.ts")).modalProvider());
  return {
    name: "modal",
    async problem() { return (await get()).problem(); },
    async start(image, o) {
      const box: Box = await (await get()).create({ image, timeoutMs: (o.timeoutSec + 600) * 1000 });
      return {
        id: box.id,
        async exec(command, x) {
          // A Modal sandbox command has no separate environment setting, so the values of the named variables are set at the
          // start of the command. They go only to your own Modal sandbox, but they are in that command line there.
          const env = (x.env || []).filter((n) => process.env[n] !== undefined).map((n) => `export ${n}=${q(process.env[n]!)}; `).join("");
          let out = "";
          let code: number | null = null, timedOut = false;
          try { code = await box.exec(env + `timeout -s KILL ${x.timeoutSec} sh -c ${q(MERGE + command)}`, { cwd: x.cwd, onOut: (s) => { out += s; }, onErr: (s) => { out += s; }, timeoutMs: (x.timeoutSec + 60) * 1000 }); }
          catch (e: any) { out += String(e?.message || e); timedOut = /timeout|deadline/i.test(String(e?.message || e)); }
          return { code, out, timedOut: timedOut || code === 137 };
        },
        upload: (local, remote) => box.upload(local, remote),
        async stop() { try { await box.terminate(); } finally { try { (await get()).close(); } catch {} } },
      };
    },
  };
}
