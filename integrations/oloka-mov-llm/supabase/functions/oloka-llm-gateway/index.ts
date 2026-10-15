import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
const cors = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: cors });
const fail = (message: string, status = 400) => json({ error: message }, status);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modelPattern = /^[a-zA-Z0-9._:/-]{1,128}$/;
const slugPattern = /^[a-z][a-z0-9_-]{1,63}$/;
const protocols = ["openai_compatible", "anthropic_messages", "gemini_generate"];
const allowedHostsSuffixes = [".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".onion"];
type Dict = Record<string, unknown>;
type Connection = { id: string; name: string; provider_slug: string; protocol: string; base_url: string; models_path: string; chat_path: string; enabled: boolean; vault_secret_id?: string | null; last_test_status?: string | null };
function validateBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 1000) throw new Error("Base URL must be a public HTTPS URL");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (url.port && url.port !== "443") || !host.includes(".") || /^\d[\d.]*$/.test(host) || host.includes(":") || host === "localhost" || allowedHostsSuffixes.some((x) => host.endsWith(x))) {
    throw new Error("Only public HTTPS hostnames are permitted (no IP, local, private or nonstandard ports)");
  }
  return url.toString().replace(/\/+$/, "");
}
function validPath(path: unknown, fallback: string): string {
  const p = path === undefined || path === "" ? fallback : path;
  if (typeof p !== "string" || p.length > 200 || !/^\/(?!\/)[a-zA-Z0-9._~!$&'()*+,;=:@/%{}?-]*$/.test(p) || p.includes("..") || p.includes("#")) throw new Error("Invalid API path");
  return p;
}
function payload(input: Dict, previous?: Connection): Dict {
  const protocol = String(input.protocol ?? previous?.protocol ?? "openai_compatible");
  if (!protocols.includes(protocol)) throw new Error("Unsupported protocol");
  const name = String(input.name ?? previous?.name ?? "").trim();
  const slug = String(input.provider_slug ?? previous?.provider_slug ?? "custom").trim().toLowerCase();
  if (name.length < 1 || name.length > 100 || !slugPattern.test(slug)) throw new Error("Invalid connection name or provider slug");
  const base_url = validateBaseUrl(input.base_url ?? previous?.base_url);
  const models_path = validPath(input.models_path ?? previous?.models_path, "/models");
  const defaultChatPath = protocol === "anthropic_messages" ? "/messages" : protocol === "gemini_generate" ? "/models/{model}:generateContent" : "/chat/completions";
  const chat_path = validPath(input.chat_path ?? (protocol === previous?.protocol ? previous?.chat_path : undefined), defaultChatPath);
  return { name, provider_slug: slug, protocol, base_url, models_path, chat_path };
}
async function body(req: Request): Promise<Dict> {
  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > 32000) throw new Error("Request is too large");
  const val = await req.json();
  if (!val || Array.isArray(val) || typeof val !== "object") throw new Error("JSON object expected");
  return val as Dict;
}
async function adminUser(req: Request): Promise<string | null> {
  const match = /^Bearer (.+)$/i.exec(req.headers.get("authorization") || "");
  if (!match) return null;
  const client = createClient(SB_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await client.auth.getUser(match[1]);
  if (error || !user) return null;
  const { data, error: authzError } = await db.from("mov_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (authzError || !data) return null;
  return user.id;
}
async function getConnection(id: string): Promise<Connection> {
  if (!idPattern.test(id)) throw new Error("Invalid connection ID");
  const { data, error } = await db.from("mov_llm_connections").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("Database connection lookup failed");
  if (!data) throw new Error("Connection not found");
  return data as Connection;
}
function safeConnection(row: Connection) {
  const { vault_secret_id, ...rest } = row;
  return { ...rest, has_api_key: Boolean(vault_secret_id) };
}
async function apiKey(row: Connection): Promise<string | null> {
  if (!row.vault_secret_id) return null;
  const { data, error } = await db.rpc("mov_connection_key_get", { p_id: row.id });
  if (error) throw new Error("Vault key lookup failed");
  return typeof data === "string" ? data : null;
}
function remoteUrl(conn: Connection, path: string): string {
  return validateBaseUrl(conn.base_url) + path;
}
async function remoteRequest(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(12000) });
}
function providerHeaders(conn: Connection, key: string | null): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (key) {
    if (conn.protocol === "anthropic_messages") { h["x-api-key"] = key; h["anthropic-version"] = "2023-06-01"; }
    else if (conn.protocol === "gemini_generate") h["x-goog-api-key"] = key;
    else h.Authorization = "Bearer " + key;
  }
  return h;
}
async function discover(conn: Connection) {
  const key = await apiKey(conn);
  const response = await remoteRequest(remoteUrl(conn, conn.models_path), { method: "GET", headers: providerHeaders(conn, key) });
  if (!response.ok) throw new Error("Model discovery returned HTTP " + response.status);
  const raw = await response.json() as Dict;
  const rows = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  return rows.map((x: Dict) => typeof x.id === "string" ? x.id : typeof x.name === "string" ? x.name.replace(/^models\//, "") : "").filter((x: string) => modelPattern.test(x)).slice(0, 100);
}
type Message = { role: string; content: string };
async function complete(conn: Connection, model: string, messages: Message[], maxTokens = 48): Promise<string> {
  const key = await apiKey(conn);
  const headers = { ...providerHeaders(conn, key), "Content-Type": "application/json" };
  let path = conn.chat_path;
  let payload: Dict;
  if (conn.protocol === "anthropic_messages") {
    const system = messages.filter(x => x.role === "system").map(x => x.content).join("\n");
    payload = { model, max_tokens: maxTokens, messages: messages.filter(x => x.role !== "system").map(x => ({ role: x.role, content: x.content })) };
    if (system) payload.system = system;
  } else if (conn.protocol === "gemini_generate") {
    path = path.replace("{model}", encodeURIComponent(model));
    payload = { contents: messages.filter(x => x.role !== "system").map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] })), generationConfig: { maxOutputTokens: maxTokens } };
    const system = messages.filter(x => x.role === "system").map(x => x.content).join("\n");
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
  } else {
    payload = { model, messages, max_tokens: maxTokens, stream: false };
  }
  const response = await remoteRequest(remoteUrl(conn, path), { method: "POST", headers, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error("LLM request returned HTTP " + response.status);
  const data = await response.json() as Dict;
  let answer = "";
  if (conn.protocol === "anthropic_messages") {
    answer = Array.isArray(data.content) ? data.content.map((x: Dict) => typeof x.text === "string" ? x.text : "").join("") : "";
  } else if (conn.protocol === "gemini_generate") {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const parts = (candidates[0] as Dict | undefined)?.content as Dict | undefined;
    answer = Array.isArray(parts?.parts) ? parts.parts.map((x: Dict) => typeof x.text === "string" ? x.text : "").join("") : "";
  } else {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const message = (choices[0] as Dict | undefined)?.message as Dict | undefined;
    answer = typeof message?.content === "string" ? message.content : "";
  }
  if (!answer.trim()) throw new Error("Provider returned no text content");
  return answer.slice(0, 20000);
}
async function testModel(conn: Connection, model: string) {
  if (!modelPattern.test(model)) throw new Error("Invalid model ID");
  const { data: row } = await db.from("mov_llm_connection_models").select("id").eq("connection_id", conn.id).eq("api_model", model).maybeSingle();
  if (!row) throw new Error("Add the model before testing it");
  const started = Date.now();
  try {
    const answer = await complete(conn, model, [{ role: "user", content: "Reply with the single word OK." }], 256);
    const at = new Date().toISOString();
    await db.from("mov_llm_connection_models").update({ enabled: true, last_verified_at: at, last_test_status: "ok" }).eq("id", row.id);
    await db.from("mov_llm_connections").update({ enabled: true, last_verified_at: at, last_test_status: "ok", last_error: null }).eq("id", conn.id);
    return { ok: true, model, answer: answer.slice(0, 200), latency_ms: Date.now() - started };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Connection test failed";
    await db.from("mov_llm_connection_models").update({ enabled: false, last_test_status: "error" }).eq("id", row.id);
    await db.from("mov_llm_connections").update({ last_test_status: "error", last_error: msg.slice(0, 180) }).eq("id", conn.id);
    return { ok: false, model, error: msg, latency_ms: Date.now() - started };
  }
}
Deno.serve(async (req: Request) => {
  try {
    const pathname = new URL(req.url).pathname;
    const route = pathname.split("/oloka-llm-gateway")[1] || "/";
    if (req.method === "GET" && route === "/config") return json({ url: SB_URL, anonKey: ANON_KEY, version: "1.0" });
    if (req.method === "GET" && route === "/") return json({ service: "Oloka Mov LLM Gateway", version: "1.0", auth: "Supabase user JWT + mov_admins membership" });
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (!(await adminUser(req))) return fail("Admin sign-in required", 401);
    if (route === "/api/connections" && req.method === "GET") {
      const [c, m] = await Promise.all([
        db.from("mov_llm_connections").select("*").order("created_at", { ascending: false }),
        db.from("mov_llm_connection_models").select("id,connection_id,api_model,label,enabled,last_verified_at,last_test_status").order("created_at", { ascending: true }),
      ]);
      if (c.error || m.error) return fail("Could not list connections", 500);
      return json({ connections: (c.data || []).map(safeConnection), models: m.data || [] });
    }
    if (route === "/api/connections" && req.method === "POST") {
      const b = await body(req);
      const fields = payload(b);
      const { data, error } = await db.from("mov_llm_connections").insert({ ...fields, enabled: false }).select("*").single();
      if (error) return fail("Failed to create connection", 500);
      if (typeof b.api_key === "string" && b.api_key) {
        const { error: keyError } = await db.rpc("mov_connection_key_set", { p_id: data.id, p_key: b.api_key });
        if (keyError) { await db.from("mov_llm_connections").delete().eq("id", data.id); return fail("Could not store API key securely"); }
      }
      return json({ connection: safeConnection({ ...data, vault_secret_id: b.api_key ? "stored" : null }) }, 201);
    }
    const match = /^\/api\/connections\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (!match) return fail("Endpoint not found", 404);
    const id = match[1], action = match[2] || "";
    const conn = await getConnection(id);
    if (!action && req.method === "PATCH") {
      const b = await body(req);
      const fields = payload(b, conn);
      const changed = ["protocol","base_url","models_path","chat_path"].some(k => fields[k] !== (conn as unknown as Dict)[k]);
      const { error } = await db.from("mov_llm_connections").update({ ...fields, ...(changed ? { enabled: false, last_verified_at: null, last_test_status: null, last_error: null } : {}) }).eq("id", id);
      if (error) return fail("Could not update connection", 500);
      if (changed) await db.from("mov_llm_connection_models").update({ enabled: false, last_verified_at: null, last_test_status: null }).eq("connection_id", id);
      if (typeof b.api_key === "string" && b.api_key) {
        const { error: keyError } = await db.rpc("mov_connection_key_set", { p_id: id, p_key: b.api_key });
        if (keyError) return fail("Connection updated, but API key was not saved", 500);
      }
      return json({ ok: true });
    }
    if (!action && req.method === "DELETE") {
      const { error: keyErr } = await db.rpc("mov_connection_key_delete", { p_id: id });
      if (keyErr) return fail("Could not revoke connection key", 500);
      await db.from("mov_llm_connection_models").delete().eq("connection_id", id);
      const { error } = await db.from("mov_llm_connections").delete().eq("id", id);
      if (error) return fail("Could not delete connection", 500);
      return json({ ok: true });
    }
    if (action === "models" && req.method === "POST") {
      const b = await body(req);
      const model = String(b.model || "").trim();
      if (!modelPattern.test(model)) return fail("Model ID must be 1–128 characters (letters, numbers, . _ : / -)");
      const label = String(b.label || model).trim().slice(0,100);
      const { error } = await db.from("mov_llm_connection_models").upsert({ connection_id: id, api_model: model, label, enabled: false }, { onConflict: "connection_id,api_model", ignoreDuplicates: true });
      if (error) return fail("Could not save model", 500);
      return json({ ok: true });
    }
    if (action.startsWith("models/") && req.method === "DELETE") {
      const modelId = action.slice("models/".length);
      if (!idPattern.test(modelId)) return fail("Invalid model ID");
      const { error } = await db.from("mov_llm_connection_models").delete().eq("connection_id", id).eq("id", modelId);
      if (error) return fail("Could not delete model", 500);
      return json({ ok: true });
    }
    if (action === "discover" && req.method === "POST") return json({ models: await discover(conn) });
    if (action === "test" && req.method === "POST") {
      const b = await body(req);
      return json(await testModel(conn, String(b.model || "")));
    }
    if (action === "complete" && req.method === "POST") {
      const b = await body(req);
      const model = String(b.model || "");
      if (!modelPattern.test(model)) return fail("Invalid model ID");
      const { data: chosen } = await db.from("mov_llm_connection_models").select("enabled").eq("connection_id", id).eq("api_model", model).maybeSingle();
      if (!conn.enabled || !chosen?.enabled) return fail("Test and enable this connection/model first", 409);
      const msgs = b.messages;
      if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > 24) return fail("1–24 messages required");
      let total = 0;
      const messages: Message[] = msgs.map((m: Dict) => {
        if (!m || !["system","user","assistant"].includes(String(m.role)) || typeof m.content !== "string") throw new Error("Invalid chat message");
        total += m.content.length;
        return { role: String(m.role), content: m.content };
      });
      if (total > 24000) return fail("Message size limit exceeded");
      const maxTokens = Math.min(2048, Math.max(32, Number(b.max_tokens) || 768));
      return json({ text: await complete(conn, model, messages, maxTokens), model, connection_id: id });
    }
    return fail("Endpoint not found", 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    const known = /^(Invalid|Connection not found|Unsupported|Base URL|Only public|Model|Add the model|Provider returned|LLM request|Request is too large|JSON object|Could not|Vault|Failed)/.test(msg);
    return fail(known ? msg : "Request could not be completed", known ? 400 : 500);
  }
});
