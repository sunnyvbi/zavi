
export const CAPABILITIES = ["payments", "payouts", "interval_overlap", "multi_step_workflow", "webhooks", "secrets", "jobs", "arbitrary_joins", "server_compute", "raw_sql"];
const ROLE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TOP = new Set(["schemaVersion", "roles", "capabilities", "collections", "actions", "aggregates", "smoke"]);
const V2_COLLECTION_KEYS = ["recipient", "unique", "states", "references"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

export function v1Projection(man) {
  const strip = (ps) => (Array.isArray(ps) ? ps.filter((p) => p !== "recipient") : ps);
  const collections = {};
  for (const [name, c] of Object.entries(man.collections ?? {})) {
    const out = {};
    for (const [k, v] of Object.entries(c)) if (!V2_COLLECTION_KEYS.includes(k)) out[k] = v;
    if (isObj(c.rules)) out.rules = Object.fromEntries(Object.entries(c.rules).map(([op, ps]) => [op, strip(ps)]));
    if (isObj(c.fields)) out.fields = Object.fromEntries(Object.entries(c.fields).map(([f, mk]) => [f, Object.fromEntries(Object.entries(mk).map(([k, ps]) => [k, strip(ps)]))]));
    collections[name] = out;
  }
  return { schemaVersion: 1, collections, ...(man.smoke !== undefined ? { smoke: man.smoke } : {}) };
}

export function lintV2(man) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });
  if (!isObj(man)) return [{ path: "", code: "invalid_manifest", message: "not an object" }];
  if (man.schemaVersion !== 2) add("schemaVersion", "invalid_version", "schemaVersion must be 2");
  for (const k of Object.keys(man)) if (!TOP.has(k)) add(k, "unknown_key", `unknown top-level key ${k}`);
  const roles = man.roles ?? [];
  if (!Array.isArray(roles) || roles.length > 8) add("roles", "invalid_roles", "at most 8 roles");
  else {
    if (new Set(roles).size !== roles.length) add("roles", "duplicate_role", "roles must be unique");
    roles.forEach((r, i) => { if (typeof r !== "string" || !ROLE_RE.test(r) || r === "admin" || r === "user") add(`roles[${i}]`, "invalid_role", `${JSON.stringify(r)} is not an allowed role name`); });
  }
  const caps = man.capabilities ?? [];
  if (!Array.isArray(caps)) add("capabilities", "invalid_capabilities", "must be an array");
  else {
    if (new Set(caps).size !== caps.length) add("capabilities", "duplicate_capability", "capabilities must be unique");
    caps.forEach((c, i) => { if (!CAPABILITIES.includes(c)) add(`capabilities[${i}]`, "unknown_capability", `${JSON.stringify(c)} is not one of ${CAPABILITIES.join(", ")}`); });
  }
  const cols = isObj(man.collections) ? man.collections : {};
  const roleSet = new Set(Array.isArray(roles) ? roles : []);
  const recipientCols = new Set(Object.entries(cols).filter(([, c]) => isObj(c?.recipient)).map(([n]) => n));

  const principals = (path, ps, { recipientOk, anyoneOk = true, onlyAdminOrRole = false }) => {
    if (!Array.isArray(ps)) return add(path, "invalid_principals", "must be an array");
    ps.forEach((p, i) => {
      const at = `${path}[${i}]`;
      if (typeof p !== "string") return add(at, "invalid_principal", "not a string");
      if (p.startsWith("role:")) { if (!roleSet.has(p.slice(5))) add(at, "role_not_allowlisted", `${p} names a role not in roles[]`); return; }
      if (onlyAdminOrRole) { if (p !== "admin") add(at, "aggregate_principal", "aggregate principals may only be admin or role:<allowlisted>"); return; }
      if (p === "recipient") { if (!recipientOk) add(at, "recipient_not_allowed", "recipient is legal only on a recipient-enabled collection, never on create"); return; }
      if (p === "anyone" && !anyoneOk) return add(at, "anyone_not_allowed", "anyone is not allowed here");
      if (!["anyone", "signed_in", "owner", "admin"].includes(p)) add(at, "unknown_principal", p);
    });
  };
  const fieldType = (c, f) => c?.schema?.properties?.[f];
  const required = (c, f) => Array.isArray(c?.schema?.required) && c.schema.required.includes(f);

  let refTotal = 0;
  const edges = new Map();
  for (const [name, c] of Object.entries(cols)) {
    const P = `collections.${name}`;
    if (!isObj(c)) continue;
    const isRec = (c.kind ?? "records") === "records";
    const rec = recipientCols.has(name);
    if (!isRec) {
      for (const k of V2_COLLECTION_KEYS) if (c[k] !== undefined) add(`${P}.${k}`, "files_v2_key", `${k} is records-only`);
      for (const [op, ps] of Object.entries(c.rules ?? {})) if ((ps ?? []).includes("recipient")) add(`${P}.rules.${op}`, "recipient_not_allowed", "files collections have no recipient");
      continue;
    }
    for (const [op, ps] of Object.entries(c.rules ?? {})) principals(`${P}.rules.${op}`, ps, { recipientOk: rec && op !== "create", anyoneOk: op !== "update" && op !== "delete" });
    for (const [f, mk] of Object.entries(c.fields ?? {})) for (const [k, ps] of Object.entries(mk ?? {})) principals(`${P}.fields.${f}.${k}`, ps, { recipientOk: rec });

    const refs = isObj(c.references) ? c.references : {};
    const refNames = Object.keys(refs);
    if (refNames.length > 4) add(`${P}.references`, "too_many_references", "at most 4 references per collection");
    refTotal += refNames.length;
    edges.set(name, []);
    for (const [f, r] of Object.entries(refs)) {
      const at = `${P}.references.${f}`;
      const t = fieldType(c, f);
      if (!t) { add(at, "undeclared_field", `${f} is not a declared field`); continue; }
      if (t.type !== "string" || t.format !== "uuid") add(at, "reference_not_uuid", "reference fields are uuid strings");
      if (!isObj(r) || !cols[r.collection] || (cols[r.collection].kind ?? "records") !== "records") add(at, "unknown_reference_target", `target ${r?.collection} is not a records collection`);
      else edges.get(name).push(r.collection);
      if (!["restrict", "cascade", "nullify"].includes(r?.on_delete)) add(at, "invalid_on_delete", "on_delete is restrict | cascade | nullify");
      if (r?.on_delete === "nullify" && required(c, f)) add(at, "nullify_required_field", "nullify needs an optional field");
    }
    if (c.recipient !== undefined) {
      const f = c.recipient?.reference;
      if (!refs[f]) add(`${P}.recipient`, "recipient_not_reference", "recipient.reference must name a declared reference");
      if (!required(c, f)) add(`${P}.recipient`, "recipient_optional", "recipient.reference must be a required field");
    }
    const uq = c.unique ?? [];
    if (!Array.isArray(uq) || uq.length > 4) add(`${P}.unique`, "too_many_unique", "at most 4 unique tuples");
    else uq.forEach((u, i) => {
      const at = `${P}.unique[${i}]`;
      if (!Array.isArray(u?.fields) || u.fields.length < 1 || u.fields.length > 4) return add(at, "invalid_unique", "1 to 4 fields");
      if (new Set(u.fields).size !== u.fields.length) add(at, "invalid_unique", "duplicate field");
      for (const f of u.fields) { const t = fieldType(c, f); if (!t) add(at, "undeclared_field", f); else if (t.type === "array") add(at, "unique_not_scalar", `${f} is an array`); }
      if (!["distinct", "not_distinct"].includes(u?.nulls)) add(at, "invalid_nulls", "nulls is distinct | not_distinct");
    });
    if (c.states !== undefined) {
      const s = c.states;
      const at = `${P}.states`;
      const t = fieldType(c, s?.field);
      const vals = Array.isArray(s?.values) ? s.values : [];
      if (!t || t.type !== "string" || !required(c, s.field) || !Array.isArray(t.enum)) add(at, "state_field", "state field must be a required string enum");
      else if (t.enum.length !== vals.length || t.enum.some((v, i) => v !== vals[i])) add(at, "state_enum_mismatch", "state field enum must exactly match values");
      if (vals.length < 1 || vals.length > 16 || new Set(vals).size !== vals.length) add(at, "invalid_state_values", "1 to 16 unique values");
      if (!vals.includes(s?.initial)) add(at, "invalid_initial", "initial must be one of values");
      const tr = Array.isArray(s?.transitions) ? s.transitions : null;
      if (!tr || tr.length > 32) add(at, "invalid_transitions", "transitions: array of at most 32");
      (tr ?? []).forEach((x, i) => {
        if (!vals.includes(x?.from) || !vals.includes(x?.to) || x.from === x.to) add(`${at}.transitions[${i}]`, "invalid_transition", "from/to must be distinct values");
        principals(`${at}.transitions[${i}].principals`, x?.principals, { recipientOk: rec, anyoneOk: false });
      });
      if (s?.read !== undefined) {
        if (!isObj(s.read)) add(`${at}.read`, "invalid_state_read", "read is {value: principals}");
        else for (const [v, ps] of Object.entries(s.read)) {
          if (!vals.includes(v)) add(`${at}.read.${v}`, "unknown_state", v);
          principals(`${at}.read.${v}`, ps, { recipientOk: rec });
        }
      }
    }
  }
  if (refTotal > 64) add("collections", "too_many_references", "at most 64 references per site");
  const depth = new Map();
  const visit = (n, stack) => {
    if (stack.includes(n)) { add(`collections.${n}.references`, "reference_cycle", `cycle ${[...stack, n].join(" -> ")}`); return 0; }
    if (depth.has(n)) return depth.get(n);
    const d = Math.max(0, ...(edges.get(n) ?? []).map((t) => 1 + visit(t, [...stack, n])));
    depth.set(n, d);
    return d;
  };
  for (const n of edges.keys()) if (visit(n, []) > 4) add(`collections.${n}.references`, "reference_too_deep", "reference depth > 4");

  const actions = isObj(man.actions) ? man.actions : {};
  const names = [];
  for (const [an, a] of Object.entries(actions)) {
    const at = `actions.${an}`;
    names.push(an);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(an)) add(at, "invalid_action_name", an);
    const tc = cols[a?.target?.collection];
    const cc = cols[a?.creates?.collection];
    if (!tc) { add(`${at}.target`, "unknown_collection", String(a?.target?.collection)); continue; }
    const counter = fieldType(tc, a.target.counter);
    if (!counter || counter.type !== "integer") add(`${at}.target.counter`, "counter_not_integer", "counter must be an integer field");
    if (!isInt(a.delta) || a.delta === 0 || Math.abs(a.delta) > 1000) add(`${at}.delta`, "invalid_delta", "non-zero integer, |delta| <= 1000");
    if (!isInt(a.initial)) add(`${at}.initial`, "invalid_initial", "integer");
    const b = a.bounds;
    if (!isObj(b) || !isInt(b.min) || (b.max === undefined) === (b.maxField === undefined)) add(`${at}.bounds`, "invalid_bounds", "{min, max} or {min, maxField}, integers");
    else if (b.max !== undefined && (!isInt(b.max) || b.max < b.min)) add(`${at}.bounds`, "invalid_bounds", "max must be an integer >= min");
    else if (b.maxField !== undefined && fieldType(tc, b.maxField)?.type !== "integer") add(`${at}.bounds.maxField`, "maxfield_not_integer", "maxField must be an integer field");
    if (!cc) add(`${at}.creates`, "unknown_collection", String(a?.creates?.collection));
    else if (cc.references?.[a.creates.targetField]?.collection !== a.target.collection) add(`${at}.creates.targetField`, "target_field_not_reference", "creates.targetField must reference the target collection");
    principals(`${at}.principals`, a.principals, { recipientOk: recipientCols.has(a.target.collection) });
    if (a.idempotency !== "required") add(`${at}.idempotency`, "idempotency_required", 'idempotency must be "required"');
    if (a.inverse !== undefined) {
      const inv = a.inverse;
      names.push(inv?.name);
      if (!isInt(inv?.delta) || inv.delta === 0 || Math.abs(inv.delta) > 1000) add(`${at}.inverse.delta`, "invalid_delta", "non-zero integer");
      const vals = cc?.states?.values ?? [];
      if (!vals.includes(inv?.transition?.from) || !vals.includes(inv?.transition?.to)) add(`${at}.inverse.transition`, "invalid_transition", "inverse transition must use the created collection's states");
      principals(`${at}.inverse.principals`, inv?.principals, { recipientOk: cc ? recipientCols.has(a.creates.collection) : false, anyoneOk: false });
      if (inv?.idempotency !== "required") add(`${at}.inverse.idempotency`, "idempotency_required", 'idempotency must be "required"');
    }
  }
  if (names.length > 16) add("actions", "too_many_actions", "at most 16 callable action names including inverses");
  if (new Set(names).size !== names.length) add("actions", "duplicate_action_name", "action and inverse names must be unique");

  const aggs = isObj(man.aggregates) ? man.aggregates : {};
  if (Object.keys(aggs).length > 8) add("aggregates", "too_many_aggregates", "at most 8");
  for (const [gn, g] of Object.entries(aggs)) {
    const at = `aggregates.${gn}`;
    const c = cols[g?.collection];
    if (!c || (c.kind ?? "records") !== "records") { add(`${at}.collection`, "unknown_collection", String(g?.collection)); continue; }
    if (!["count", "sum", "avg"].includes(g.fn)) add(`${at}.fn`, "invalid_fn", "count | sum | avg");
    if (g.fn === "count" && g.field !== undefined) add(`${at}.field`, "count_field", "count takes no field");
    if ((g.fn === "sum" || g.fn === "avg") && !(c.indexes?.[g.field]?.type === "number" && ["integer", "number"].includes(fieldType(c, g.field)?.type))) add(`${at}.field`, "field_not_numeric_indexed", "sum/avg need a numeric indexed field");
    const filters = g.filters ?? [];
    if (!Array.isArray(filters) || filters.length > 2) add(`${at}.filters`, "too_many_filters", "at most 2");
    else for (const f of filters) if (!(c.indexes?.[f]?.ops ?? []).includes("eq") && c.states?.field !== f) add(`${at}.filters`, "filter_not_indexed", `${f} needs an index with eq, or must be the state field`);
    principals(`${at}.principals`, g.principals, { onlyAdminOrRole: true });
    for (const p of g.principals ?? []) {
      const holds = (ps) => (ps ?? []).some((q) => q === p || q === "anyone" || q === "signed_in");
      if (!holds(c.rules?.list)) add(`${at}.principals`, "aggregate_without_list", `${p} cannot list ${g.collection}`);
      for (const f of [g.field, ...filters].filter(Boolean)) {
        const r = c.fields?.[f]?.read;
        if (r !== undefined && !holds(r)) add(`${at}.principals`, "aggregate_without_field_read", `${p} cannot read ${f}`);
      }
    }
  }
  return issues;
}
