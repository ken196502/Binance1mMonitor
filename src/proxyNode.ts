// Talks to the in-container mihomo control API so the app can rotate away from
// proxy nodes that Binance rejects (HTTP 451) or that are simply dead.
//
// Why this is needed (verified against Mihomo Meta v1.19.32):
// mihomo's built-in health check only measures latency/reachability — it does NOT
// enforce the HTTP status code of the probe. A node that answers every request
// with 451 is still reported as "alive", and the auto-selecting PROXY group will
// happily park on it, which breaks every Binance call and the whole dashboard.
//
// So the proxy-selection decision that actually matters is made here: whenever a
// request fails in a way that points at the node, we mark that node bad and move
// the ACTIVE group to a different candidate.
//
// Everything degrades gracefully: if mihomo isn't running (or the API/group isn't
// there, e.g. non-Docker deployments), these helpers report failure and the
// caller falls back to its normal retry/backoff behaviour.

function apiBase(): string {
  // Read lazily so tests (and any runtime reconfiguration) can repoint this.
  return (process.env.MIHOMO_API_URL ?? "http://127.0.0.1:9090").replace(/\/+$/, "");
}
const GROUP = process.env.MIHOMO_PROXY_GROUP ?? "ACTIVE";

// Groups and pseudo-targets: never useful as a rotation target, and `PROXY` in
// particular must not be recorded as "bad" — it is the auto-fallback group whose
// current underlying node is what actually failed.
const RESERVED = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"]);
const GROUPS = new Set(["PROXY", "MANUAL", "ACTIVE"]);

// Subscription "info" placeholders (剩余流量 / 到期 / 官网 …) are shaped like nodes
// but point at 127.0.0.1, so they can never carry traffic.
const FAKE_NODE = /^(说明|剩余|到期|过期|官网|订阅|流量|套餐|时效|天数|群组|客服|邮箱|公告|重置|续费|防失联|请勿|转发卡)/;

const badNodes = new Set<string>();

// Nodes that have actually served Binance. Re-tried first on the next rotation:
// finding a working node can take a while, so we hang on to the good ones instead
// of rediscovering them.
const goodNodes: string[] = [];

let cached: { at: number; names: string[] } | null = null;
const CANDIDATE_TTL_MS = 60_000;

async function api(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null; // mihomo absent or unreachable — caller degrades gracefully
  }
}

/** Candidate node names, health-checked nodes first, with bad/placeholder nodes dropped. */
async function candidates(): Promise<string[]> {
  const now = Date.now();
  const fresh = cached && now - cached.at < CANDIDATE_TTL_MS;
  let pool: string[] | undefined = fresh ? cached!.names : undefined;

  if (!pool) {
    const r = await api("/providers/proxies");
    if (!r?.ok) return [];

    let parsed: any;
    try {
      parsed = await r.json();
    } catch {
      return [];
    }

    const alive: string[] = [];
    const rest: string[] = [];
    for (const prov of Object.values<any>(parsed?.providers ?? {})) {
      for (const p of prov?.proxies ?? []) {
        const name: string = p?.name ?? "";
        if (!name || RESERVED.has(name) || GROUPS.has(name) || FAKE_NODE.test(name)) continue;
        (p?.alive ? alive : rest).push(name);
      }
    }
    pool = [...alive, ...rest];
    // Subscriptions are usually ordered by the provider's own speed score, which
    // correlates strongly with region (the fastest free nodes are frequently US
    // hosted, i.e. exactly the ones Binance 451s). Always testing the head of the
    // list therefore burns through dozens of blocked nodes before finding a good
    // one, so shuffle to explore the whole pool instead.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    cached = { at: now, names: pool };
  }

  // Always re-filter against the current blacklist: the cache holds the raw pool,
  // and bad nodes must never be handed back out just because the entry is cached.
  // Previously-verified good nodes float to the front.
  const usable = pool.filter((n) => !badNodes.has(n));
  const preferred = goodNodes.filter((n) => usable.includes(n));
  const rest = usable.filter((n) => !goodNodes.includes(n));
  return [...preferred, ...rest];
}

/** True when the control API answers and the group we manage actually exists. */
export async function proxyRotationAvailable(): Promise<boolean> {
  const r = await api("/proxies/" + encodeURIComponent(GROUP));
  return !!r?.ok;
}

/** Node the managed group is currently using (may be a group name like PROXY). */
export async function currentProxyNode(): Promise<string | null> {
  const r = await api("/proxies/" + encodeURIComponent(GROUP));
  if (!r?.ok) return null;
  try {
    return (await r.json())?.now ?? null;
  } catch {
    return null;
  }
}

/** Point the managed group at a specific candidate. Returns true on success. */
export async function selectProxyNode(name: string): Promise<boolean> {
  const res = await api("/proxies/" + encodeURIComponent(GROUP), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return !!res?.ok;
}

/**
 * Hand out candidate nodes to try, most-likely-good first, skipping every node
 * already known to be bad. The caller is expected to *verify* a candidate before
 * trusting it (see `findWorkingNode`) and report the outcome via `markProxyNodeBad`.
 */
export async function nextProxyCandidates(limit = 8): Promise<string[]> {
  return (await candidates()).slice(0, limit);
}

/**
 * Move the managed proxy group off its current node onto a different candidate.
 * Returns the newly selected node, or null when rotation isn't possible.
 */
export async function rotateProxyNode(): Promise<string | null> {
  const cur = await api("/proxies/" + encodeURIComponent(GROUP));
  if (!cur?.ok) return null;

  let current: string | null = null;
  try {
    current = (await cur.json())?.now ?? null;
  } catch {
    return null;
  }

  // Never come back to a node that just failed us. Group names are not nodes,
  // so skip them (otherwise `PROXY` itself would get blacklisted).
  if (current && !RESERVED.has(current) && !GROUPS.has(current)) badNodes.add(current);

  const pool = await candidates();
  const pick = pool.find((n) => n !== current);
  if (!pick) return null;

  const res = await api("/proxies/" + encodeURIComponent(GROUP), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: pick }),
  });
  if (!res?.ok) return null;

  console.warn(
    `[proxy-node] 切换代理节点: ${current ?? "(无)"} → ${pick} (累计已排除 ${badNodes.size} 个异常节点)`,
  );
  return pick;
}

export function markProxyNodeBad(name: string | null | undefined): void {
  if (name && !RESERVED.has(name) && !GROUPS.has(name)) badNodes.add(name);
}

/**
 * Probe a Binance endpoint through the proxy from the given base URL and report
 * whether the node really works. Used to validate candidates before committing to
 * them, since mihomo's own health check cannot see HTTP 451.
 */
export async function probeNodeWorks(
  probeUrl: string,
  dispatcher: unknown,
): Promise<boolean> {
  try {
    // undici's fetch (not the global one) is what accepts a `dispatcher`, i.e. the
    // proxy agent that actually routes the probe through mihomo.
    const { fetch: undiciFetch } = await import("undici");
    const r = await undiciFetch(probeUrl, {
      dispatcher: dispatcher as any,
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8_000),
    });
    await r.arrayBuffer().catch(() => undefined);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Walk candidates until one actually serves Binance, selecting it on success.
 *
 * Each candidate is validated with a real request first, so a run of dead or
 * region-blocked nodes costs a probe each instead of stalling the caller with a
 * failing request. Returns the working node, or null if none of them work.
 */
export async function findWorkingNode(
  probeUrl: string,
  dispatcher: unknown,
  maxTries = Number(process.env.PROXY_ROBE_TRIES ?? 6),
): Promise<string | null> {
  const candidates = await nextProxyCandidates(maxTries);
  for (const name of candidates) {
    if (!(await selectProxyNode(name))) continue;
    if (await probeNodeWorks(probeUrl, dispatcher)) {
      if (!goodNodes.includes(name)) goodNodes.unshift(name);
      console.warn(`[proxy-node] 已切换到可用代理节点: ${name}`);
      return name;
    }
    markProxyNodeBad(name);
    console.warn(`[proxy-node] 候选节点不可用，已排除: ${name}`);
  }
  return null;
}

export function badProxyNodeCount(): number {
  return badNodes.size;
}

export function resetProxyNodesForTest(): void {
  badNodes.clear();
  goodNodes.length = 0;
  cached = null;
}