// Node-only Web Worker transport for software-codec correctness. Never load in a browser.
import { Worker as NodeWorker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { resolveObjectURL } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

export class CodecNodeWorker {
  #worker; #terminated = false;
  constructor(specifier, { type = 'classic', name = '' } = {}) {
    const url = new URL(specifier);
    if (!['file:', 'blob:'].includes(url.protocol)) throw Error('Node correctness worker allows only local assets');
    this.#worker = new NodeWorker(new URL(import.meta.url), { name, workerData: { url: url.href, type, name } });
    this.#worker.on('message', data => this.onmessage?.({ data }));
    this.#worker.on('messageerror', error => this.onmessageerror?.(error));
    this.#worker.on('error', error => this.onerror?.(error));
    this.#worker.on('exit', code => { if (!this.#terminated) this.onerror?.(Error(`Node correctness worker exited (${code})`)); });
    const source = url.protocol === 'blob:' ? resolveObjectURL(url.href).text() : Promise.resolve(null);
    this.ready = source.then(text => { if (!this.#terminated) this.#worker.postMessage({ ubveStart: true, text }); });
  }
  postMessage(value, transfers = []) { void this.ready.then(() => { if (!this.#terminated) this.#worker.postMessage(value, Array.isArray(transfers) ? transfers : transfers.transfer ?? []); }); }
  terminate() { if (!this.#terminated) { this.#terminated = true; void this.#worker.terminate(); } }
}

if (!isMainThread) {
  const entry = new URL(workerData.url), listeners = new Set(), messages = [];
  let loaded = false;
  const dispatch = data => { const event = { data }; globalThis.onmessage?.(event); for (const listener of listeners) listener(event); };
  const runClassic = (source, filename) => runInThisContext(source, { filename });
  Object.assign(globalThis, {
    self: globalThis, Worker: CodecNodeWorker, WorkerGlobalScope: class {}, name: workerData.name,
    crossOriginIsolated: true, location: entry, process: undefined,
    postMessage: (data, transfers = []) => parentPort.postMessage(data, Array.isArray(transfers) ? transfers : transfers.transfer ?? []),
    addEventListener: (type, handler) => { if (type === 'message') listeners.add(handler); },
    removeEventListener: (type, handler) => { if (type === 'message') listeners.delete(handler); },
    importScripts: (...urls) => { for (const url of urls) runClassic(readFileSync(new URL(url, entry), 'utf8'), url); },
    fetch: async url => new Response(readFileSync(new URL(url, entry))),
    close: () => parentPort.close(),
  });
  // The upstream heap selects its browser branches from UA and primitive probes.
  // This is intentionally not a Chromium identity or a browser-capability test.
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 Chrome/156.0.0.0' });
  parentPort.on('message', async data => {
    if (data?.ubveStart) {
      if (entry.protocol === 'blob:') runClassic(data.text, entry.href);
      else if (workerData.type === 'classic') globalThis.importScripts(entry.href);
      else await import(entry.href);
      loaded = true;
      for (const message of messages.splice(0)) dispatch(message);
    } else if (loaded) dispatch(data); else messages.push(data);
  });
}
