// The Modal adapter against a stand-in for Modal's SDK (same method names and shapes as modal@0.11.1's types).
// The real service is exercised by test/live/modal-live.ts (run by the "modal live test" workflow when Modal tokens are set).
import { test, expect } from "bun:test";
import { modalProvider, tokenShape, friendly } from "../src/remote-modal.ts";

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

test("a refused token is explained by its shape, never by its value; pasted spaces are trimmed", async () => {
  expect(tokenShape({ MODAL_TOKEN_ID: "ak-abc123", MODAL_TOKEN_SECRET: "as-xyz" })).toBe("MODAL_TOKEN_ID starts with ak-, 9 characters; MODAL_TOKEN_SECRET starts with as-, 6 characters");
  expect(tokenShape({ MODAL_TOKEN_ID: " as-swapped\n", MODAL_TOKEN_SECRET: "" })).toBe("MODAL_TOKEN_ID does NOT start with ak- (it should), 10 characters, had spaces or a line break around it; MODAL_TOKEN_SECRET is empty");
  const old = { id: process.env.MODAL_TOKEN_ID, s: process.env.MODAL_TOKEN_SECRET };
  process.env.MODAL_TOKEN_ID = "  ak-SECRETVALUE1\n"; process.env.MODAL_TOKEN_SECRET = "as-SECRETVALUE2 ";
  try {
    const msg = friendly(new Error("UNAUTHENTICATED: Token not found")).message;
    expect(msg).toContain("starts with ak-, 15 characters, had spaces"); expect(msg).not.toContain("SECRETVALUE");
    let got: any = null; class ModalClient { constructor(p: any) { got = p; } apps = { fromName: async () => ({}) }; images = { fromRegistry: () => ({}) }; sandboxes = { create: async () => ({ sandboxId: "x", setTags: async () => {} }) }; close() {} }
    await modalProvider(async () => ({ ModalClient })).create({ image: "a", timeoutMs: 1 });
    expect(got).toEqual({ tokenId: "ak-SECRETVALUE1", tokenSecret: "as-SECRETVALUE2" });
  } finally { if (old.id === undefined) delete process.env.MODAL_TOKEN_ID; else process.env.MODAL_TOKEN_ID = old.id; if (old.s === undefined) delete process.env.MODAL_TOKEN_SECRET; else process.env.MODAL_TOKEN_SECRET = old.s; }
});

test("a secret saved without its as- start: refused once, then retried with as- added, and the user is told; a truly wrong token still fails", async () => {
  const old = { id: process.env.MODAL_TOKEN_ID, s: process.env.MODAL_TOKEN_SECRET };
  const seen: any[] = []; const notes: string[] = [];
  const sdk = (good: string) => async () => ({ ModalClient: class { p: any; constructor(p: any) { this.p = p; seen.push(p.tokenSecret); }
    apps = { fromName: async () => { if (this.p.tokenSecret !== good) throw new Error("/modal.client.ModalClient/AuthTokenGet UNAUTHENTICATED: Token not found"); return {}; } };
    images = { fromRegistry: () => ({}) }; sandboxes = { create: async () => ({ sandboxId: "sb-ok", setTags: async () => {} }), fromId: async (id: string) => { if (this.p.tokenSecret !== good) throw new Error("UNAUTHENTICATED: Token not found"); return { sandboxId: id }; } }; close() {} } });
  try {
    process.env.MODAL_TOKEN_ID = "ak-id"; process.env.MODAL_TOKEN_SECRET = "REALSECRET";
    const p = modalProvider(sdk("as-REALSECRET"), (s) => notes.push(s));
    expect((await p.create({ image: "a", timeoutMs: 1 })).id).toBe("sb-ok");
    expect(seen).toEqual(["REALSECRET", "as-REALSECRET"]); expect(notes.length).toBe(1); expect(notes[0]).toMatch(/saved without "as-"/); expect(notes[0]).not.toContain("REALSECRET");
    expect((await p.attach("sb-9")).id).toBe("sb-9"); expect(seen.length).toBe(2); // the working form is kept, no second retry
    // A secret that is wrong either way: one retry, then the plain refusal (with the shape, never the value).
    seen.length = 0; notes.length = 0;
    const bad = modalProvider(sdk("as-SOMETHINGELSE"), (s) => notes.push(s));
    const err = await bad.create({ image: "a", timeoutMs: 1 }).catch((e) => e);
    expect(err.message).toMatch(/Modal did not accept your token/); expect(err.message).not.toContain("REALSECRET"); expect(seen).toEqual(["REALSECRET", "as-REALSECRET"]); expect(notes).toEqual([]);
    // A secret that already has as- is never changed.
    seen.length = 0; process.env.MODAL_TOKEN_SECRET = "as-WRONG";
    await modalProvider(sdk("as-RIGHT"), () => {}).create({ image: "a", timeoutMs: 1 }).catch(() => {});
    expect(seen).toEqual(["as-WRONG"]);
  } finally { if (old.id === undefined) delete process.env.MODAL_TOKEN_ID; else process.env.MODAL_TOKEN_ID = old.id; if (old.s === undefined) delete process.env.MODAL_TOKEN_SECRET; else process.env.MODAL_TOKEN_SECRET = old.s; }
});
