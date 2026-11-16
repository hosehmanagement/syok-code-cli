// The Modal adapter against a stand-in for Modal's SDK (same method names and shapes as modal@0.11.1's types).
// The real service is exercised by test/live/modal-live.ts (run by the "modal live test" workflow when Modal tokens are set).
import { test, expect } from "bun:test";
import { modalProvider } from "../src/remote-modal.ts";

const stream = (parts: string[]) => new ReadableStream<string>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
function fakeSdk() {
  const calls: any[] = [];
  class ModalClient {
    apps = { fromName: async (name: string, p: any) => { calls.push(["apps.fromName", name, p]); return { appId: "ap-1" }; } };
    images = { fromRegistry: (tag: string) => { calls.push(["images.fromRegistry", tag]); return { tag }; } };
    sandboxes = {
      create: async (app: any, image: any, params: any) => { calls.push(["sandboxes.create", app, image, params]); return sandbox("sb-new"); },
      fromId: async (id: string) => { calls.push(["sandboxes.fromId", id]); return sandbox(id); },
    };
    close() { calls.push(["close"]); }
  }
  const sandbox = (id: string) => ({
    sandboxId: id,
    setTags: async (t: any) => { calls.push(["setTags", t]); },
    filesystem: { copyFromLocal: async (a: string, b: string) => { calls.push(["copyFromLocal", a, b]); }, copyToLocal: async (a: string, b: string) => { calls.push(["copyToLocal", a, b]); } },
    exec: async (argv: string[], params: any) => { calls.push(["exec", argv, params]); return { stdout: stream(["he", "llo\n"]), stderr: stream(["warn\n"]), wait: async () => 4 }; },
    terminate: async () => { calls.push(["terminate", id]); },
  });
  return { calls, load: async () => ({ ModalClient }) };
}

test("Modal adapter: creates a sandbox with the asked options, runs through sh -c, streams both outputs, returns the exit code", async () => {
  const sdk = fakeSdk(); const p = modalProvider(sdk.load);
  expect(p.name).toBe("Modal");
  const b = await p.create({ image: "python:3.12-slim", gpu: "T4", cpu: 2, memoryMiB: 4096, timeoutMs: 600000 });
  expect(b.id).toBe("sb-new");
  expect(sdk.calls.slice(0, 4)).toEqual([
    ["apps.fromName", "syok-code-run", { createIfMissing: true }],
    ["images.fromRegistry", "python:3.12-slim"],
    ["sandboxes.create", { appId: "ap-1" }, { tag: "python:3.12-slim" }, { timeoutMs: 600000, gpu: "T4", cpu: 2, memoryMiB: 4096 }],
    ["setTags", { made_by: "syok-code" }],
  ]);
  let out = "", err = "";
  expect(await b.exec("echo hello", { cwd: "/work", timeoutMs: 5000, onOut: (s) => (out += s), onErr: (s) => (err += s) })).toBe(4);
  expect(out).toBe("hello\n"); expect(err).toBe("warn\n");
  expect(sdk.calls[4]).toEqual(["exec", ["sh", "-c", "echo hello"], { workdir: "/work", timeoutMs: 5000 }]);
  expect(await b.exec("true", {})).toBe(4); expect(sdk.calls[5]).toEqual(["exec", ["sh", "-c", "true"], {}]);
  await b.upload("/l/a.tgz", "/tmp/a.tgz"); await b.download("/tmp/o.tgz", "/l/o.tgz"); await b.terminate();
  expect(sdk.calls.slice(6)).toEqual([["copyFromLocal", "/l/a.tgz", "/tmp/a.tgz"], ["copyToLocal", "/tmp/o.tgz", "/l/o.tgz"], ["terminate", "sb-new"]]);
});

test("Modal adapter: no GPU or sizes asked means none are sent; attach finds a sandbox by id; close closes the client once", async () => {
  const sdk = fakeSdk(); const p = modalProvider(sdk.load);
  p.close(); expect(sdk.calls).toEqual([]); // nothing was opened yet
  await p.create({ image: "node:22-slim", timeoutMs: 60000 });
  expect(sdk.calls[2][3]).toEqual({ timeoutMs: 60000 });
  const b = await p.attach("sb-old"); expect(b.id).toBe("sb-old"); expect(sdk.calls.at(-1)).toEqual(["sandboxes.fromId", "sb-old"]);
  p.close(); p.close(); expect(sdk.calls.filter((c) => c[0] === "close").length).toBe(1);
});
