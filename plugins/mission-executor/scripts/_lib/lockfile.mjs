// Advisory file-lock for read-modify-write of registry.json and state.json.
//
// Mechanism: O_EXCL | O_CREAT | O_WRONLY lockfile; on contention, exponential
// backoff with jitter. Stale-lock recovery if lockfile age > 30s AND pid not
// alive. No external deps.
//
// Contract:
//   import { withLock } from "./lockfile.mjs";
//   const result = await withLock(lockPath, () => { ...critical section... });
//
// Exits the critical section via try/finally even on throw. The callback may
// be sync or async; the wrapper awaits it.

import { openSync, closeSync, writeFileSync, unlinkSync, statSync, readFileSync } from "node:fs";

const INITIAL_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 500;
const DEFAULT_DEADLINE_MS = 3000;
const STALE_LOCK_AGE_MS = 30_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";  // process exists but owned by another user
  }
}

function tryStaleRecovery(lockPath) {
  try {
    const st = statSync(lockPath);
    const age = Date.now() - st.mtimeMs;
    if (age < STALE_LOCK_AGE_MS) return false;
    let owner = {};
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch {}
    if (pidAlive(owner.pid)) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(lockPath, { deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const started = Date.now();
  let backoff = INITIAL_BACKOFF_MS;
  let staleRetried = false;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      closeSync(fd);
      return { release: () => { try { unlinkSync(lockPath); } catch {} } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!staleRetried && tryStaleRecovery(lockPath)) {
        staleRetried = true;
        continue;
      }
      if (Date.now() - started >= deadlineMs) {
        const err = new Error(`lock-timeout: ${lockPath} held for >${deadlineMs}ms`);
        err.code = "LOCK_TIMEOUT";
        throw err;
      }
      const jitter = Math.floor(Math.random() * backoff);
      await sleep(backoff + jitter);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

export async function withLock(lockPath, fn, opts = {}) {
  const { release } = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
