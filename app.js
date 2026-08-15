import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("TAVO-PROJEKTAS")) {
  document.body.innerHTML =
    '<p style="padding:2rem;font-family:system-ui;line-height:1.6;color:#EFE9DC">' +
    "Faile <b>config.js</b> dar neįrašyti Supabase duomenys.</p>";
  throw new Error("config.js nesukonfigūruotas");
}

const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const BUCKET = "receipts";
const APP_VERSION = "1.3";

/* =========================================================
   PAGALBINĖS
   ========================================================= */

const eur = new Intl.NumberFormat("lt-LT", {
  style: "currency", currency: "EUR", minimumFractionDigits: 2
});

const MONTHS = ["sausis","vasaris","kovas","balandis","gegužė","birželis",
                "liepa","rugpjūtis","rugsėjis","spalis","lapkritis","gruodis"];

const money = (n) => eur.format(Number(n) || 0);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const today = () => iso(new Date());

function whenText(dateStr, createdAt) {
  const t = createdAt
    ? new Date(createdAt).toLocaleTimeString("lt-LT", { hour: "2-digit", minute: "2-digit" })
    : "";
  return t ? `${dateStr} · ${t}` : dateStr;
}

function daysUntil(dateStr) {
  const a = new Date(dateStr + "T12:00:00");
  const b = new Date(today() + "T12:00:00");
  return Math.round((a - b) / 86400000);
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* =========================================================
   BŪSENA
   ========================================================= */

const state = {
  user: null,
  view: "main",
  period: null,          // { from, to, label } arba { from: null, to: null }
  tx: [],
  subs: [],
  pickedFile: null,      // naujai pasirinktas failas
  removeFile: false,     // ar trinti esamą
  editing: null,         // { kind, row }
  kind: "expense",
  detail: null
};

function thisMonth() {
  const n = new Date();
  return {
    from: iso(new Date(n.getFullYear(), n.getMonth(), 1)),
    to:   iso(new Date(n.getFullYear(), n.getMonth() + 1, 0)),
    label: `${MONTHS[n.getMonth()]} ${n.getFullYear()}`
  };
}

state.period = thisMonth();

/* =========================================================
   PRISIJUNGIMAS
   ========================================================= */

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn"), err = $("login-error");
  err.hidden = true; btn.disabled = true; btn.textContent = "Jungiamasi…";

  const { error } = await db.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-pass").value
  });

  btn.disabled = false; btn.textContent = "Prisijungti";
  if (error) {
    err.textContent = /invalid login/i.test(error.message || "")
      ? "Neteisingas el. paštas arba slaptažodis."
      : (error.message || "Nepavyko prisijungti.");
    err.hidden = false;
  }
});

$("logout").addEventListener("click", () => db.auth.signOut());

db.auth.onAuthStateChange((_e, session) => {
  state.user = session?.user || null;
  if (state.user) {
    $("login").hidden = true; $("app").hidden = false;
    refresh();
  } else {
    $("app").hidden = true; $("login").hidden = false;
  }
});

db.auth.getSession().then(({ data }) => {
  if (!data.session && $("login").hidden && $("app").hidden) $("login").hidden = false;
});

/* =========================================================
   DUOMENYS
   ========================================================= */

async function fetchAll() {
  const { from, to } = state.period;

  let q1 = db.from("transactions")
    .select("id, type, amount, date, vendor, created_at, attachments(id, storage_path, mime_type, file_name)")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });

  let q2 = db.from("subscriptions")
    .select("id, name, amount, purchase_date, next_payment_date, is_personal, created_at, attachments(id, storage_path, mime_type, file_name)")
    .order("purchase_date", { ascending: false });

  // prenumeratų netrumpinam pagal laikotarpį — jų skiltyje turi matytis visos
  if (from) q1 = q1.gte("date", from);
  if (to) q1 = q1.lte("date", to);

  const [r1, r2] = await Promise.all([q1, q2]);

  const bad = r1.error || r2.error;
  if (bad) { toast("Įkėlimas: " + (bad.message || "klaida")); return; }
  state.tx = r1.data || [];
  state.subs = r2.data || [];
}

function inPeriod(dateStr) {
  const { from, to } = state.period;
  if (!from) return true;
  return dateStr >= from && dateStr <= to;
}

async function refresh() {
  await fetchAll();
  render();
}

/* =========================================================
   VIENETŲ NORMALIZAVIMAS
   ========================================================= */

function txItem(t) {
  return {
    kind: "tx", raw: t, id: t.id,
    date: t.date, created_at: t.created_at,
    title: t.vendor || "Be pavadinimo",
    amount: Number(t.amount),
    sign: t.type === "income" ? "in" : "out",
    muted: false,
    att: (t.attachments || [])[0] || null
  };
}

function subItem(s) {
  return {
    kind: "sub", raw: s, id: s.id,
    date: s.purchase_date, created_at: s.created_at,
    title: s.name,
    amount: Number(s.amount),
    sign: s.is_personal ? "muted" : "out",
    muted: s.is_personal,
    tag: s.is_personal ? "prenumerata · asmeninės lėšos" : "prenumerata",
    end: s.next_payment_date,
    att: (s.attachments || [])[0] || null
  };
}

const byDateDesc = (a, b) =>
  b.date.localeCompare(a.date) ||
  String(b.created_at).localeCompare(String(a.created_at));

/* =========================================================
   VAIZDAS
   ========================================================= */

const TITLES = {
  main: "Pagrindinis", income: "Pajamos", expense: "Išlaidos",
  invoices: "Sąskaitos", subs: "Prenumeratos"
};

function render() {
  $("view-title").textContent = TITLES[state.view];

  // prenumeratų lange rodomos visos, todėl laikotarpis ten neaktualus
  const noPeriod = state.view === "subs";
  $("period-open").hidden = noPeriod;
  $("period-label").hidden = noPeriod;

  $("period-label").textContent = state.period.from
    ? (state.period.label || `${state.period.from} – ${state.period.to}`)
    : "Visas laikotarpis";

  document.querySelectorAll(".drawer__item").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.view === state.view));

  const txIn  = state.tx.filter((t) => t.type === "income").map(txItem);
  const txOut = state.tx.filter((t) => t.type === "expense").map(txItem);
  const subsBought = state.subs.filter((s) => inPeriod(s.purchase_date)).map(subItem);
  const subsWork = subsBought.filter((s) => !s.muted);

  const income  = txIn.reduce((s, i) => s + i.amount, 0);
  const expense = txOut.reduce((s, i) => s + i.amount, 0)
                + subsWork.reduce((s, i) => s + i.amount, 0);

  const list = $("list");
  list.textContent = "";
  $("totals-main").hidden = state.view !== "main";
  $("totals-single").hidden = !(state.view === "income" || state.view === "expense");

  if (state.view === "main") {
    const profit = income - expense;
    $("t-profit").textContent = money(profit);
    $("t-profit").classList.toggle("is-negative", profit < 0);
    $("t-expense").textContent = money(expense);
    $("t-income").textContent = money(income);
    renderEntries(list, [...txIn, ...txOut, ...subsBought].sort(byDateDesc));

  } else if (state.view === "income") {
    $("t-single-label").textContent = "Pajamos";
    $("t-single").textContent = money(income);
    renderEntries(list, txIn.sort(byDateDesc));

  } else if (state.view === "expense") {
    $("t-single-label").textContent = "Išlaidos";
    $("t-single").textContent = money(expense);
    renderEntries(list, [...txOut, ...subsWork].sort(byDateDesc));

  } else if (state.view === "invoices") {
    renderInvoices(list, txIn.filter((i) => i.att));

  } else if (state.view === "subs") {
    const shown = state.subs.map(subItem).sort((a, b) => {
      const pa = daysUntil(a.end) < 0 ? 1 : 0;
      const pb = daysUntil(b.end) < 0 ? 1 : 0;
      if (pa !== pb) return pa - pb;                  // pasibaigusios – į apačią
      return pa ? b.end.localeCompare(a.end)          // pasibaigusios: naujausios pirma
                : a.end.localeCompare(b.end);         // galiojančios: arčiausia pabaiga pirma
    });
    renderSubs(list, shown);
  }
}

function renderEntries(root, items) {
  if (!items.length) { root.append(emptyMsg("Šiuo laikotarpiu įrašų nėra.")); return; }

  for (const it of items) {
    const row = document.createElement("button");
    row.className = "entry";
    row.type = "button";
    row.addEventListener("click", () => openDetail(it));

    const when = document.createElement("span");
    when.className = "entry__when";
    when.textContent = whenText(it.date, it.created_at);

    const who = document.createElement("span");
    who.className = "entry__who";
    who.textContent = it.title;

    if (it.tag || it.att) {
      const tag = document.createElement("span");
      tag.className = "entry__tag";
      tag.textContent = [it.tag, it.att ? "su sąskaita" : null].filter(Boolean).join(" · ");
      who.append(tag);
    }

    const amt = document.createElement("span");
    amt.className = "entry__amt entry__amt--" + it.sign;
    amt.textContent = (it.sign === "in" ? "+" : "−") + money(it.amount);

    row.append(when, who, amt);
    root.append(row);
  }
}

function renderSubs(root, items) {
  if (!items.length) { root.append(emptyMsg("Prenumeratų dar nėra.")); return; }

  for (const it of items) {
    const left = daysUntil(it.end);
    const past = left < 0;
    const soon = !past && left <= 7;

    const row = document.createElement("button");
    row.className = "entry" + (past ? " is-past" : "");
    row.type = "button";
    row.addEventListener("click", () => openDetail(it));

    const when = document.createElement("span");
    when.className = "entry__due entry__due--" + (past ? "past" : soon ? "soon" : "ok");
    when.textContent = past
      ? `baigėsi ${it.end}`
      : left === 0
        ? `baigiasi šiandien · ${it.end}`
        : `iki ${it.end} · ${left} d.`;

    const who = document.createElement("span");
    who.className = "entry__who";
    who.textContent = it.title;
    if (it.muted) {
      const tag = document.createElement("span");
      tag.className = "entry__tag";
      tag.textContent = "asmeninės lėšos";
      who.append(tag);
    }

    // suma dega taip pat, kaip data: auksu kol galioja, raudonai prieš pabaigą
    const amt = document.createElement("span");
    amt.className = "entry__amt entry__amt--" +
      (past ? "muted" : soon ? "out" : "gold");
    amt.textContent = money(it.amount);

    row.append(when, who, amt);
    root.append(row);
  }
}

async function renderInvoices(root, items) {
  if (!items.length) { root.append(emptyMsg("Šiuo laikotarpiu sąskaitų nėra.")); return; }

  const grid = document.createElement("div");
  grid.className = "invoices";
  root.append(grid);

  const paths = items.map((i) => i.att.storage_path);
  const { data: signed } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
  const urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));

  for (const it of items) {
    const card = document.createElement("button");
    card.className = "inv";
    card.type = "button";
    card.addEventListener("click", () => openDetail(it));

    const isPdf = (it.att.mime_type || "").includes("pdf");
    if (isPdf) {
      const box = document.createElement("div");
      box.className = "inv__pdf";
      box.textContent = "PDF";
      card.append(box);
    } else {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = urls.get(it.att.storage_path) || "";
      card.append(img);
    }

    const meta = document.createElement("div");
    meta.className = "inv__meta";
    const who = document.createElement("div");
    who.className = "inv__who";
    who.textContent = it.title;
    const sub = document.createElement("div");
    sub.className = "inv__sub";
    sub.textContent = `${it.date} · ${money(it.amount)}`;
    meta.append(who, sub);

    card.append(meta);
    grid.append(card);
  }
}

function emptyMsg(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

/* =========================================================
   MENIU
   ========================================================= */

$("menu-open").addEventListener("click", () => { $("drawer").hidden = false; });
document.querySelectorAll("[data-close-drawer]").forEach((el) =>
  el.addEventListener("click", () => { $("drawer").hidden = true; }));

document.querySelectorAll(".drawer__item").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    $("drawer").hidden = true;
    render();
    window.scrollTo(0, 0);
  }));

/* =========================================================
   LAIKOTARPIS
   ========================================================= */

$("period-open").addEventListener("click", () => {
  $("p-from").value = state.period.from || "";
  $("p-to").value = state.period.to || "";
  $("period-sheet").hidden = false;
});

document.querySelectorAll("[data-close-period]").forEach((el) =>
  el.addEventListener("click", () => { $("period-sheet").hidden = true; }));

document.querySelectorAll("[data-preset]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const n = new Date();
    const p = btn.dataset.preset;

    if (p === "this-month") state.period = thisMonth();
    if (p === "last-month") {
      const d = new Date(n.getFullYear(), n.getMonth() - 1, 1);
      state.period = {
        from: iso(d),
        to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
        label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
      };
    }
    if (p === "this-year") state.period = {
      from: `${n.getFullYear()}-01-01`, to: `${n.getFullYear()}-12-31`,
      label: `${n.getFullYear()} metai`
    };
    if (p === "all") state.period = { from: null, to: null, label: null };

    $("period-sheet").hidden = true;
    refresh();
  }));

$("period-apply").addEventListener("click", () => {
  const from = $("p-from").value, to = $("p-to").value;
  if (!from || !to) { toast("Pasirink abi datas"); return; }
  state.period = { from, to: to < from ? from : to, label: null };
  $("period-sheet").hidden = true;
  refresh();
});

/* =========================================================
   PRIDĖJIMO FORMA
   ========================================================= */

function setKind(kind) {
  state.kind = kind;
  document.querySelectorAll(".seg__btn").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.kind === kind));

  const isSub = kind === "subscription";
  $("w-party").hidden = isSub;
  $("w-name").hidden = !isSub;
  $("w-personal").hidden = !isSub;
  $("w-end").hidden = !isSub;
  $("l-party").textContent = kind === "income" ? "Pajamų šaltinis" : "Kam sumokėta";
  $("f-party").placeholder = kind === "income" ? "pvz. UAB Klientas" : "pvz. Senukai";
}

document.querySelectorAll(".seg__btn").forEach((b) =>
  b.addEventListener("click", () => setKind(b.dataset.kind)));

function resetFile() {
  state.pickedFile = null;
  state.removeFile = false;
  $("f-file").value = "";
  $("file-name").textContent = "Nufotografuoti arba pasirinkti";
  $("file-pick").classList.remove("has-file");
  $("file-clear").hidden = true;
}

$("file-pick").addEventListener("click", () => $("f-file").click());

$("f-file").addEventListener("change", () => {
  const f = $("f-file").files[0];
  if (!f) return;
  state.pickedFile = f;
  state.removeFile = false;
  $("file-name").textContent = f.name.length > 28 ? f.name.slice(0, 26) + "…" : f.name;
  $("file-pick").classList.add("has-file");
  $("file-clear").hidden = false;
});

$("file-clear").addEventListener("click", () => {
  const had = state.editing && currentAttachment();
  resetFile();
  if (had) { state.removeFile = true; $("file-name").textContent = "Failas bus pašalintas"; }
});

function currentAttachment() {
  if (!state.editing) return null;
  return (state.editing.row.attachments || [])[0] || null;
}

function openAdd(item = null) {
  state.editing = item ? { kind: item.kind, row: item.raw } : null;
  resetFile();
  $("add-error").hidden = true;
  $("f-amount").classList.remove("invalid");
  document.querySelector(".amount").classList.remove("invalid");

  if (item) {
    $("add-title").textContent = "Koreguoti įrašą";
    $("kind-seg").hidden = true;
    const r = item.raw;
    if (item.kind === "sub") {
      setKind("subscription");
      $("f-amount").value = String(r.amount).replace(".", ",");
      $("f-date").value = r.purchase_date;
      $("f-name").value = r.name;
      $("f-personal").checked = r.is_personal;
      $("f-end").value = r.next_payment_date;
    } else {
      setKind(r.type);
      $("f-amount").value = String(r.amount).replace(".", ",");
      $("f-date").value = r.date;
      $("f-party").value = r.vendor || "";
    }
    const att = (r.attachments || [])[0];
    if (att) {
      $("file-name").textContent = att.file_name || "Pridėtas failas";
      $("file-pick").classList.add("has-file");
      $("file-clear").hidden = false;
    }
  } else {
    // kiekviename lange pliusas siūlo tik to lango tipą
    const LOCK = { income: "income", expense: "expense",
                   subs: "subscription", invoices: "income" };
    const locked = LOCK[state.view] || null;

    $("add-title").textContent = locked
      ? { income: "Naujos pajamos", expense: "Nauja išlaida",
          subscription: "Nauja prenumerata" }[locked]
      : "Naujas įrašas";

    $("kind-seg").hidden = Boolean(locked);
    setKind(locked || "expense");
    $("f-amount").value = "";
    $("f-date").value = today();
    $("f-party").value = "";
    $("f-name").value = "";
    $("f-end").value = "";
    $("f-personal").checked = false;
  }

  $("add-sheet").hidden = false;
}

$("add-open").addEventListener("click", () => openAdd());

function goto(view) {
  state.view = view;
  render();
  window.scrollTo(0, 0);
}

$("go-income").addEventListener("click", () => goto("income"));
$("go-expense").addEventListener("click", () => goto("expense"));

$("app-version").textContent = "v" + APP_VERSION;

document.querySelectorAll("[data-close-add]").forEach((el) =>
  el.addEventListener("click", () => { $("add-sheet").hidden = true; state.editing = null; }));

/* ---------- nuotraukos suspaudimas ---------- */

async function shrink(file) {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    return blob ? new File([blob], "saskaita.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function uploadPicked() {
  const file = await shrink(state.pickedFile);
  const ext = (file.type.includes("pdf") ? "pdf" : "jpg");
  const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type });
  if (error) throw error;
  return { storage_path: path, file_name: state.pickedFile.name, mime_type: file.type, size_bytes: file.size };
}

async function dropAttachment(att) {
  await db.storage.from(BUCKET).remove([att.storage_path]);
  await db.from("attachments").delete().eq("id", att.id);
}

/* ---------- išsaugojimas ---------- */

$("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("add-error");
  err.hidden = true;

  const amount = Number($("f-amount").value.replace(/\s/g, "").replace(",", "."));
  const date = $("f-date").value;
  const isSub = state.kind === "subscription";

  const problems = [];
  if (!Number.isFinite(amount) || amount <= 0) problems.push("suma");
  if (!date) problems.push("data");
  if (!isSub && !$("f-party").value.trim()) problems.push(state.kind === "income" ? "pajamų šaltinis" : "kam sumokėta");
  if (isSub && !$("f-name").value.trim()) problems.push("pavadinimas");
  if (isSub && !$("f-end").value) problems.push("pabaigos data");

  if (problems.length) {
    err.textContent = "Užpildyk: " + problems.join(", ") + ".";
    err.hidden = false;
    return;
  }

  const btn = $("save-btn");
  btn.disabled = true;
  btn.textContent = state.pickedFile ? "Keliama…" : "Saugoma…";

  try {
    let rowId, ownerCol;

    if (isSub) {
      const payload = {
        user_id: state.user.id,
        name: $("f-name").value.trim(),
        amount: amount.toFixed(2),
        purchase_date: date,
        next_payment_date: $("f-end").value,
        is_personal: $("f-personal").checked
      };
      const res = state.editing
        ? await db.from("subscriptions").update(payload).eq("id", state.editing.row.id).select("id").single()
        : await db.from("subscriptions").insert(payload).select("id").single();
      if (res.error) throw res.error;
      rowId = res.data.id;
      ownerCol = "subscription_id";
    } else {
      const payload = {
        user_id: state.user.id,
        type: state.kind,
        amount: amount.toFixed(2),
        date,
        vendor: $("f-party").value.trim()
      };
      const res = state.editing
        ? await db.from("transactions").update(payload).eq("id", state.editing.row.id).select("id").single()
        : await db.from("transactions").insert(payload).select("id").single();
      if (res.error) throw res.error;
      rowId = res.data.id;
      ownerCol = "transaction_id";
    }

    const old = currentAttachment();
    if ((state.pickedFile || state.removeFile) && old) await dropAttachment(old);

    if (state.pickedFile) {
      const meta = await uploadPicked();
      const { error } = await db.from("attachments")
        .insert({ user_id: state.user.id, [ownerCol]: rowId, ...meta });
      if (error) throw error;
    }

    $("add-sheet").hidden = true;
    state.editing = null;
    toast("Išsaugota");
    refresh();

  } catch (ex) {
    const detail = [ex?.message, ex?.details, ex?.hint, ex?.code]
      .filter(Boolean).join(" · ");
    err.textContent = detail || "Nepavyko išsaugoti.";
    err.hidden = false;
    console.error(ex);
  } finally {
    btn.disabled = false;
    btn.textContent = "Išsaugoti";
  }
});

/* =========================================================
   ĮRAŠO LANGAS
   ========================================================= */

async function openDetail(item) {
  state.detail = item;
  $("d-confirm").hidden = true;
  $("d-tools").hidden = false;

  $("d-date").textContent = whenText(item.date, item.created_at);
  $("d-amount").textContent = (item.sign === "in" ? "+" : "−") + money(item.amount);
  $("d-amount").className = "detail__amount detail__amount--" + item.sign;

  const rows = $("d-rows");
  rows.textContent = "";

  const put = (label, value) => {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrap.append(dt, dd);
    rows.append(wrap);
  };

  if (item.kind === "sub") {
    put("Tipas", "Prenumerata");
    put("Pavadinimas", item.title);
    put("Pirkta", item.date);
    put("Galioja iki", `${item.end} (${daysUntil(item.end)} d.)`);
    put("Lėšos", item.muted ? "Asmeninės" : "Darbo");
  } else {
    put("Tipas", item.sign === "in" ? "Pajamos" : "Išlaidos");
    put(item.sign === "in" ? "Pajamų šaltinis" : "Kam sumokėta", item.title);
    put("Data", item.date);
  }

  const fileBox = $("d-file");
  fileBox.textContent = "";

  if (item.att) {
    const { data } = await db.storage.from(BUCKET).createSignedUrl(item.att.storage_path, 3600);
    if (data?.signedUrl) {
      if ((item.att.mime_type || "").includes("pdf")) {
        const a = document.createElement("a");
        a.className = "detail__pdf";
        a.href = data.signedUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Atidaryti sąskaitą (PDF)";
        fileBox.append(a);
      } else {
        const a = document.createElement("a");
        a.className = "detail__file";
        a.href = data.signedUrl;
        a.target = "_blank";
        a.rel = "noopener";
        const img = document.createElement("img");
        img.src = data.signedUrl;
        img.alt = "Sąskaita";
        a.append(img);
        fileBox.append(a);
      }
    }
  }

  $("detail-sheet").hidden = false;
}

document.querySelectorAll("[data-close-detail]").forEach((el) =>
  el.addEventListener("click", () => { $("detail-sheet").hidden = true; state.detail = null; }));

$("d-edit").addEventListener("click", () => {
  const item = state.detail;
  $("detail-sheet").hidden = true;
  openAdd(item);
});

$("d-del").addEventListener("click", () => {
  $("d-confirm").hidden = false;
  $("d-tools").hidden = true;
});

$("d-cancel").addEventListener("click", () => {
  $("d-confirm").hidden = true;
  $("d-tools").hidden = false;
});

$("d-yes").addEventListener("click", async () => {
  const item = state.detail;
  if (!item) return;

  const btn = $("d-yes");
  btn.disabled = true;
  btn.textContent = "Trinama…";

  const att = (item.raw.attachments || [])[0];
  if (att) await db.storage.from(BUCKET).remove([att.storage_path]);

  const table = item.kind === "sub" ? "subscriptions" : "transactions";
  const { error } = await db.from(table).delete().eq("id", item.id);

  btn.disabled = false;
  btn.textContent = "Taip, ištrinti";

  if (error) { toast("Trynimas: " + (error.message || "klaida")); return; }

  $("detail-sheet").hidden = true;
  state.detail = null;
  toast("Ištrinta");
  refresh();
});

/* =========================================================
   PWA
   ========================================================= */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
